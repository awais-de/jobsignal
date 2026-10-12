import { useCallback, useEffect, useMemo, useState } from "react";
import {
  adLanguage, contactsFromAd, isPersonalEmail, LINKEDIN_NOTE_LIMIT, linkedinSearch, parseConnections, pingText,
  sameCompany, type ContactType,
} from "./contactfinder";
import { supabase } from "./supabase";

// "Reach out" panel on the job page (applied jobs): who to ping, a one-tap ping text, and the
// log of pings with a follow-up reminder. Spec 6.8 / 11.5.

export type Contact = {
  id: string;
  full_name: string;
  role_title: string | null;
  contact_type: ContactType | null;
  source: "job_ad" | "connections" | "manual" | "email";
  company_name: string | null;
  linkedin_url: string | null;
  email: string | null;
  phone: string | null;
};
const CONTACT_COLUMNS = "id,full_name,role_title,contact_type,source,company_name,linkedin_url,email,phone";

export type Ping = {
  id: string;
  application_id: string | null;
  contact_id: string;
  channel: Channel;
  sent_at: string;
  status: "sent" | "replied" | "no_reply";
  follow_up_due: string | null;
  followed_up_at: string | null;
  contacts?: { full_name: string; role_title: string | null } | null;
};
export const PING_COLUMNS = "id,application_id,contact_id,channel,sent_at,status,follow_up_due,followed_up_at";

type Channel = "linkedin" | "email" | "phone" | "other";
const CHANNELS: Record<Channel, string> = { linkedin: "LinkedIn", email: "Email", phone: "Phone", other: "Other" };
const TYPES: Record<string, string> = {
  recruiter: "Recruiter", hiring_manager: "Hiring manager", team_member: "Team member", referral: "Referral", other: "Contact",
};
const SOURCES: Record<string, string> = { job_ad: "named in the job ad", connections: "your connection", manual: "added by you", email: "from an email" };

/** One person (or team inbox) worth pinging, from any source; saved as a contact when first pinged. */
type Candidate = {
  key: string;
  name: string | null;
  role: string | null;
  type: ContactType;
  source: Contact["source"];
  email: string | null;
  phone: string | null;
  linkedin: string | null;
  contactId: string | null;
  best: Channel;
};

function bestChannel(c: Omit<Candidate, "best" | "key">): Channel {
  if (isPersonalEmail(c.email)) return "email";
  if (c.linkedin || c.name) return "linkedin";
  if (c.email) return "email";
  return c.phone ? "phone" : "other";
}

const rank = (c: Candidate) =>
  (c.source === "connections" ? 0 : 2) + (c.name ? 0 : 4) + (c.type === "hiring_manager" ? 0 : c.type === "recruiter" ? 1 : 2) +
  (isPersonalEmail(c.email) ? 0 : 1);

export default function OutreachPanel({ job, applicationId, sender }: {
  job: { id: string; title: string; company_name: string; description: string | null; named_contact: string | null };
  applicationId: string;
  sender: string | null;
}) {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [pings, setPings] = useState<Ping[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [lang, setLang] = useState<"de" | "en">(() => adLanguage(job.description));
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    const [c, p] = await Promise.all([
      supabase.from("contacts").select(CONTACT_COLUMNS).is("deleted_at", null).limit(10000),
      supabase.from("outreach").select(PING_COLUMNS + ",contacts(full_name,role_title)")
        .eq("application_id", applicationId).is("deleted_at", null).order("sent_at", { ascending: false }),
    ]);
    if (c.error || p.error) return setError((c.error ?? p.error)!.message);
    setContacts((c.data as Contact[]).filter((x) => sameCompany(x.company_name, job.company_name)));
    setPings(p.data as unknown as Ping[]);
  }, [applicationId, job.company_name]);
  useEffect(() => { load(); }, [load]);

  const flash = (msg: string) => { setToast(msg); setTimeout(() => setToast(null), 3000); };

  const candidates = useMemo(() => {
    const out = new Map<string, Candidate>();
    const put = (c: Omit<Candidate, "best" | "key">) => {
      const key = (c.name ?? c.email ?? "").toLowerCase();
      if (!key) return;
      const prev = out.get(key);
      // A saved contact wins over the same person parsed from the ad; keep any detail either has.
      const merged = prev ? {
        ...prev, ...Object.fromEntries(Object.entries(c).filter(([, v]) => v != null)),
        contactId: prev.contactId ?? c.contactId, source: prev.contactId ? prev.source : c.source,
      } as Candidate : { ...c, key, best: "other" as Channel };
      merged.best = bestChannel(merged);
      out.set(key, merged);
    };
    for (const a of contactsFromAd(job.description, job.named_contact)) {
      put({ name: a.name, role: a.role, type: a.type, source: "job_ad", email: a.email, phone: a.phone, linkedin: null, contactId: null });
    }
    for (const c of contacts) {
      put({ name: c.full_name, role: c.role_title, type: c.contact_type ?? (c.source === "connections" ? "referral" : "other"),
            source: c.source, email: c.email, phone: c.phone, linkedin: c.linkedin_url, contactId: c.id });
    }
    return [...out.values()].sort((a, b) => rank(a) - rank(b));
  }, [job.description, job.named_contact, contacts]);

  const message = (c: Candidate) =>
    pingText({ name: c.name, sender: sender || "…", position: job.title, company: job.company_name, lang });

  async function copy(c: Candidate) {
    try {
      await navigator.clipboard.writeText(message(c));
      flash(sender ? "Ping copied" : "Ping copied. Add your name on the Profile page to sign it.");
    } catch {
      flash("Couldn't copy to the clipboard");
    }
  }

  async function ensureContact(c: Candidate): Promise<string | null> {
    if (c.contactId) return c.contactId;
    const { data, error } = await supabase.from("contacts").insert({
      full_name: c.name ?? `${job.company_name} recruiting (${c.email})`, role_title: c.role, contact_type: c.type,
      source: c.source, company_name: job.company_name, email: c.email, phone: c.phone, linkedin_url: c.linkedin,
    }).select(CONTACT_COLUMNS).single();
    if (error) { setError(error.message); return null; }
    setContacts((cs) => [...cs, data as Contact]);
    return (data as Contact).id;
  }

  async function log(c: Candidate, channel: Channel) {
    const contactId = await ensureContact(c);
    if (!contactId) return;
    const { data, error } = await supabase.from("outreach").insert({
      application_id: applicationId, contact_id: contactId, channel, message_text: message(c),
    }).select(PING_COLUMNS + ",contacts(full_name,role_title)").single();
    if (error) return setError(error.message);
    setPings((ps) => [data as unknown as Ping, ...ps]);
    flash(`Logged. Follow-up reminder on ${fmt((data as unknown as Ping).follow_up_due!)}`);
  }

  async function update(p: Ping, fields: Partial<Ping>) {
    const { error } = await supabase.from("outreach").update(fields).eq("id", p.id);
    if (error) return setError(error.message);
    setPings((ps) => ps.map((x) => (x.id === p.id ? { ...x, ...fields } : x)));
  }

  const pinged = new Set(pings.map((p) => p.contact_id));
  const today = new Date().toISOString().slice(0, 10);

  return (
    <section className="outreach">
      <div className="notepad-head">
        <h2>Reach out</h2>
        <span className="muted">{pings.length ? `${pings.length} ping${pings.length > 1 ? "s" : ""} sent` : "Nobody contacted yet"}</span>
        <select value={lang} onChange={(e) => setLang(e.target.value as "de" | "en")} aria-label="Message language">
          <option value="de">Deutsch</option>
          <option value="en">English</option>
        </select>
      </div>
      {error && <p className="notice">{error}</p>}

      {pings.length > 0 && (
        <ul className="pings">
          {pings.map((p) => {
            const due = p.status === "sent" && p.follow_up_due && p.follow_up_due <= today && !p.followed_up_at;
            return (
              <li key={p.id} className={due ? "due" : ""}>
                <div>
                  <strong>{p.contacts?.full_name ?? "Contact"}</strong>
                  <span className="muted"> · {CHANNELS[p.channel]} · {fmt(p.sent_at)}</span>
                  {p.status === "replied" && <span className="status status-green">replied</span>}
                  {p.status === "no_reply" && <span className="status status-grey">no reply</span>}
                  {p.status === "sent" && p.followed_up_at && <span className="muted"> · followed up {fmt(p.followed_up_at)}</span>}
                  {p.status === "sent" && !p.followed_up_at && p.follow_up_due && (
                    <span className={due ? "status status-orange" : "muted"}>{due ? "follow up today" : ` · follow up ${fmt(p.follow_up_due)}`}</span>
                  )}
                </div>
                {p.status === "sent" && (
                  <div className="row">
                    <button className="small" onClick={() => update(p, { status: "replied", replied_at: new Date().toISOString() } as Partial<Ping>)}>Replied</button>
                    {!p.followed_up_at && <button className="small" onClick={() => update(p, { followed_up_at: new Date().toISOString(), follow_up_due: null })}>Followed up</button>}
                    <button className="link" onClick={() => update(p, { status: "no_reply", follow_up_due: null })}>No reply</button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {candidates.length === 0 && (
        <p className="muted small-text">The job ad names nobody, and none of your connections works here. Try the search links below.</p>
      )}
      <ul className="candidates">
        {candidates.map((c) => (
          <li key={c.key}>
            <div className="cand-head">
              <strong>{c.name ?? c.email}</strong>
              {pinged.has(c.contactId ?? "") && <span className="badge">pinged</span>}
              <div className="muted small-text">
                {[c.role, c.role ? null : TYPES[c.type], SOURCES[c.source]].filter(Boolean).join(" · ")}
              </div>
              <div className="small-text">
                {c.email && <a href={`mailto:${c.email}`}>{c.email}</a>}
                {c.email && c.phone && " · "}
                {c.phone && <a href={`tel:${c.phone.replace(/[^\d+]/g, "")}`}>{c.phone}</a>}
              </div>
            </div>
            <div className="row">
              <button className="small primary" onClick={() => copy(c)} title={message(c)}>Copy ping</button>
              {c.best === "email" && c.email && (
                <a className="link-button small" href={mailto(c.email, job, message(c), lang)}>Email</a>
              )}
              {c.best === "linkedin" && (
                <a className="link-button small" target="_blank" rel="noreferrer"
                   href={c.linkedin ?? linkedinSearch(`${c.name} ${job.company_name}`)}>
                  {c.linkedin ? "LinkedIn" : "Find on LinkedIn"}
                </a>
              )}
              <LogButton best={c.best} onLog={(ch) => log(c, ch)} />
            </div>
            {c.best === "linkedin" && !c.linkedin && message(c).length > LINKEDIN_NOTE_LIMIT && (
              <div className="muted small-text">
                The ping is {message(c).length} characters: too long for a connection-request note ({LINKEDIN_NOTE_LIMIT}). Send it as a message once connected.
              </div>
            )}
          </li>
        ))}
      </ul>

      <div className="search-links small-text">
        <span className="muted">Look for more people:</span>
        <a href={linkedinSearch(`${job.company_name} recruiter`)} target="_blank" rel="noreferrer">Recruiters</a>
        <a href={linkedinSearch(`${job.company_name} talent acquisition`)} target="_blank" rel="noreferrer">Talent acquisition</a>
        <a href={linkedinSearch(`${job.company_name} head of data`)} target="_blank" rel="noreferrer">Data leads</a>
        <a href={linkedinSearch(`${job.company_name} ${shortRole(job.title)}`)} target="_blank" rel="noreferrer">People in this role</a>
        <button className="link" onClick={() => setAdding((a) => !a)}>{adding ? "Cancel" : "+ Add a person"}</button>
      </div>
      {adding && <AddContact company={job.company_name} onError={setError}
                             onAdded={(c) => { setContacts((cs) => [...cs, c]); setAdding(false); }} />}
      {toast && <div className="toast">{toast}</div>}
    </section>
  );
}

function LogButton({ best, onLog }: { best: Channel; onLog: (c: Channel) => void }) {
  const [channel, setChannel] = useState<Channel>(best);
  useEffect(() => setChannel(best), [best]);
  return (
    <span className="log-ping">
      <select value={channel} onChange={(e) => setChannel(e.target.value as Channel)} aria-label="Channel">
        {Object.entries(CHANNELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
      </select>
      <button className="small" onClick={() => onLog(channel)} title="Record that you sent the ping (sets a 7-day follow-up)">Log ping</button>
    </span>
  );
}

function AddContact({ company, onAdded, onError }: {
  company: string;
  onAdded: (c: Contact) => void;
  onError: (msg: string) => void;
}) {
  const [f, setF] = useState({ full_name: "", role_title: "", linkedin_url: "", email: "", contact_type: "hiring_manager" });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  async function save() {
    const url = f.linkedin_url.trim();
    if (url && !/^https:\/\/([a-z]{2,3}\.)?linkedin\.com\/in\//.test(url)) return onError("That isn't a LinkedIn profile link (linkedin.com/in/…).");
    const { data, error } = await supabase.from("contacts").insert({
      full_name: f.full_name.trim(), role_title: f.role_title.trim() || null, contact_type: f.contact_type, source: "manual",
      company_name: company, linkedin_url: url || null, email: f.email.trim() || null,
    }).select(CONTACT_COLUMNS).single();
    if (error) return onError(error.code === "23505" ? "That LinkedIn profile is already saved as a contact." : error.message);
    onAdded(data as Contact);
  }
  return (
    <div className="register">
      <div className="row">
        <input placeholder="Full name" value={f.full_name} onChange={set("full_name")} />
        <input placeholder="Role, e.g. Head of Data" value={f.role_title} onChange={set("role_title")} />
        <select value={f.contact_type} onChange={set("contact_type")} aria-label="Kind of contact">
          {Object.entries(TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </div>
      <div className="row">
        <input placeholder="LinkedIn profile link (optional)" value={f.linkedin_url} onChange={set("linkedin_url")} />
        <input placeholder="Email (optional)" value={f.email} onChange={set("email")} />
        <button className="primary small" disabled={!f.full_name.trim()} onClick={save}>Add</button>
      </div>
    </div>
  );
}

/** "Senior Data Engineer (m/w/d)" → "Data Engineer": the core of the title, for a people search. */
function shortRole(title: string): string {
  return title.replace(/\(.*?\)|\*|senior|junior|lead|principal|\bsr\.?|\bjr\.?/gi, " ").split(/[/|–,-]/)[0].replace(/\s+/g, " ").trim();
}

function mailto(email: string, job: { title: string; company_name: string }, body: string, lang: "de" | "en") {
  const subject = lang === "de" ? `Meine Bewerbung: ${job.title}` : `My application: ${job.title}`;
  return `mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

function fmt(iso: string): string {
  return new Date(iso.length === 10 ? iso + "T00:00:00" : iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
}

/** Profile page: upload LinkedIn's Connections.csv; contacts are upserted by profile URL. */
export function ConnectionsImport() {
  const [count, setCount] = useState<number | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const { count } = await supabase.from("contacts").select("id", { count: "exact", head: true })
      .eq("source", "connections").is("deleted_at", null);
    setCount(count ?? 0);
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  async function onFile(file: File) {
    setBusy(true);
    setStatus("Reading…");
    try {
      const rows = parseConnections(await file.text());
      const withUrl = rows.filter((r) => r.linkedin_url);
      for (let i = 0; i < withUrl.length; i += 500) {
        setStatus(`Saving ${Math.min(i + 500, withUrl.length)} of ${withUrl.length}…`);
        const chunk = withUrl.slice(i, i + 500).map((r) => ({ ...r, source: "connections", contact_type: "referral" }));
        const { error } = await supabase.from("contacts").upsert(chunk, { onConflict: "linkedin_url" });
        if (error) throw new Error(error.message);
      }
      const companies = new Set(withUrl.map((r) => r.company_name).filter(Boolean)).size;
      setStatus(`Imported ${withUrl.length} connections at ${companies} companies.` +
        (rows.length > withUrl.length ? ` ${rows.length - withUrl.length} rows without a profile link were skipped.` : ""));
      refresh();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Import failed.");
    }
    setBusy(false);
  }

  return (
    <section className="card">
      <h3>LinkedIn connections</h3>
      <p className="muted">
        Upload <strong>Connections.csv</strong> from your LinkedIn data archive. Applied jobs then show who you know at
        that company. Re-upload any time: existing connections are updated, not duplicated.
        {count !== null && <> Stored now: <strong>{count}</strong>.</>}
      </p>
      <input type="file" accept=".csv,text/csv" disabled={busy}
             onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ""; }} />
      {status && <p className="notice">{status}</p>}
    </section>
  );
}
