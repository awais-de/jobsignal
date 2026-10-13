import { useCallback, useEffect, useMemo, useState } from "react";
import {
  adLanguage, contactsFromAd, isPersonalEmail, LINKEDIN_NOTE_LIMIT, linkedinSearch, nameFromLinkedinUrl, normLinkedin, parseConnections, pingText,
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
  deleted_at: string | null;
};
const CONTACT_COLUMNS = "id,full_name,role_title,contact_type,source,company_name,linkedin_url,email,phone,deleted_at";

export type Ping = {
  id: string;
  application_id: string | null;
  job_posting_id: string;
  contact_id: string;
  channel: Channel;
  sent_at: string;
  status: "sent" | "replied" | "no_reply";
  follow_up_due: string | null;
  followed_up_at: string | null;
  contacts?: { full_name: string; role_title: string | null } | null;
};
export const PING_COLUMNS = "id,application_id,job_posting_id,contact_id,channel,sent_at,status,follow_up_due,followed_up_at";

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

// Works before applying too: pings belong to the job, and the message changes once applied.
export default function OutreachPanel({ job, applicationId, sender }: {
  job: { id: string; title: string; company_name: string; description: string | null; named_contact: string | null };
  applicationId: string | null;
  sender: string | null;
}) {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [pings, setPings] = useState<Ping[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [lang, setLang] = useState<"de" | "en">(() => adLanguage(job.description));
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);     // candidate key

  const load = useCallback(async () => {
    const [c, p] = await Promise.all([
      // Removed contacts are loaded too: they hide the same person parsed from the job ad.
      supabase.from("contacts").select(CONTACT_COLUMNS).limit(10000),
      supabase.from("outreach").select(PING_COLUMNS + ",contacts(full_name,role_title)")
        .eq("job_posting_id", job.id).is("deleted_at", null).order("sent_at", { ascending: false }),
    ]);
    if (c.error || p.error) return setError((c.error ?? p.error)!.message);
    setContacts((c.data as Contact[]).filter((x) => sameCompany(x.company_name, job.company_name)));
    setPings(p.data as unknown as Ping[]);
  }, [job.id, job.company_name]);
  useEffect(() => { load(); }, [load]);

  const flash = (msg: string) => { setToast(msg); setTimeout(() => setToast(null), 3000); };

  const candidates = useMemo(() => {
    // The same person can come from the ad and from saved contacts: match on name or email.
    const out: Candidate[] = [];
    const removed: Candidate[] = [];
    const same = (a: Candidate, b: Omit<Candidate, "best" | "key">) =>
      (!!a.name && !!b.name && a.name.toLowerCase() === b.name.toLowerCase()) ||
      (!!a.email && !!b.email && a.email.toLowerCase() === b.email.toLowerCase());
    const put = (c: Omit<Candidate, "best" | "key">, gone = false) => {
      if (!c.name && !c.email) return;
      const list = gone ? removed : out;
      const prev = list.find((x) => same(x, c));
      if (!prev) {
        list.push({ ...c, key: c.contactId ?? (c.email ?? c.name)!.toLowerCase(), best: bestChannel(c) });
        return;
      }
      // A saved contact wins over the same person parsed from the ad; keep any detail either has.
      Object.assign(prev, Object.fromEntries(Object.entries(c).filter(([, v]) => v != null)));
      if (c.contactId) prev.key = c.contactId;
      prev.best = bestChannel(prev);
    };
    for (const c of contacts) {
      // A team inbox is saved under its address as the name.
      put({ name: c.full_name.includes("@") ? null : c.full_name, role: c.role_title,
            type: c.contact_type ?? (c.source === "connections" ? "referral" : "other"),
            source: c.source, email: c.email, phone: c.phone, linkedin: c.linkedin_url, contactId: c.id }, !!c.deleted_at);
    }
    for (const a of contactsFromAd(job.description, job.named_contact)) {
      const c = { name: a.name, role: a.role, type: a.type, source: "job_ad" as const, email: a.email, phone: a.phone, linkedin: null, contactId: null };
      if (removed.some((r) => same(r, c))) continue;          // removed by the owner
      put(c);
    }
    return out.sort((a, b) => rank(a) - rank(b));
  }, [job.description, job.named_contact, contacts]);

  const message = (c: Candidate) =>
    pingText({ name: c.name, sender: sender || "…", position: job.title, company: job.company_name, lang, applied: !!applicationId });

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
      full_name: c.name ?? c.email, role_title: c.role, contact_type: c.type,
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
      job_posting_id: job.id, application_id: applicationId, contact_id: contactId, channel, message_text: message(c),
      kind: applicationId ? "post_apply" : "pre_apply", lang,
    }).select(PING_COLUMNS + ",contacts(full_name,role_title)").single();
    if (error) return setError(error.message);
    setPings((ps) => [data as unknown as Ping, ...ps]);
    flash(`Logged. Follow-up reminder on ${fmt((data as unknown as Ping).follow_up_due!)}`);
  }

  /** Remove: saved contacts are soft-deleted; a person parsed from the ad is saved as removed, so it stays hidden. */
  async function remove(c: Candidate) {
    if (!window.confirm(`Remove ${c.name ?? c.email} from the list?`)) return;
    const now = new Date().toISOString();
    const res = c.contactId
      ? await supabase.from("contacts").update({ deleted_at: now, manually_edited: true }).eq("id", c.contactId)
          .select(CONTACT_COLUMNS).single()
      : await supabase.from("contacts").insert({
          full_name: c.name ?? c.email, role_title: c.role, contact_type: c.type, source: c.source,
          company_name: job.company_name, email: c.email, phone: c.phone, deleted_at: now,
        }).select(CONTACT_COLUMNS).single();
    if (res.error) return setError(res.error.message);
    const saved = res.data as Contact;
    setContacts((cs) => [...cs.filter((x) => x.id !== saved.id), saved]);
  }

  /** After the form saved a contact: replace it in the list. An edited ad person whose name changed
   *  also gets a removed entry under the old name, so the ad's version doesn't come back. */
  async function saved(contact: Contact, before: Candidate | null) {
    let extra: Contact | null = null;
    if (before && !before.contactId && before.name && before.name.toLowerCase() !== contact.full_name.toLowerCase()) {
      const { data } = await supabase.from("contacts").insert({
        full_name: before.name, source: "job_ad", company_name: job.company_name, deleted_at: new Date().toISOString(),
      }).select(CONTACT_COLUMNS).single();
      extra = data as Contact | null;
    }
    // A contact moved to another company drops out of this job's list.
    setContacts((cs) => [...cs.filter((x) => x.id !== contact.id), contact, ...(extra ? [extra] : [])]
      .filter((x) => sameCompany(x.company_name, job.company_name)));
    setEditing(null);
    setAdding(false);
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
                <a className="link-button small" href={mailto(c.email, job, message(c), lang, !!applicationId)}>Email</a>
              )}
              {c.best === "linkedin" && (
                <a className="link-button small" target="_blank" rel="noreferrer"
                   href={c.linkedin ?? linkedinSearch(`${c.name} ${job.company_name}`)}>
                  {c.linkedin ? "LinkedIn" : "Find on LinkedIn"}
                </a>
              )}
              <LogButton best={c.best} onLog={(ch) => log(c, ch)} />
            </div>
            <div className="row small-text">
              <button className="link" onClick={() => setEditing(editing === c.key ? null : c.key)}>{editing === c.key ? "Cancel" : "Edit"}</button>
              <button className="link danger" onClick={() => remove(c)}>Remove</button>
            </div>
            {editing === c.key && (
              <ContactForm company={job.company_name} candidate={c} onError={setError} onSaved={(x) => saved(x, c)} />
            )}
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
      {adding && <ContactForm company={job.company_name} candidate={null} onError={setError} onSaved={(x) => saved(x, null)} />}
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

/** Add a person, or edit one from the list (a person parsed from the ad is saved on first edit).
 *  A LinkedIn link fills in the name from the link itself. A link that is already saved (e.g. a
 *  connection listed at their old company) updates that contact instead of failing. */
function ContactForm({ company, candidate, onSaved, onError }: {
  company: string;
  candidate: Candidate | null;
  onSaved: (c: Contact) => void;
  onError: (msg: string) => void;
}) {
  const [f, setF] = useState({
    full_name: candidate?.name ?? "", role_title: candidate?.role ?? "", linkedin_url: candidate?.linkedin ?? "",
    email: candidate?.email ?? "", phone: candidate?.phone ?? "", company_name: company,
    contact_type: candidate?.type ?? "hiring_manager",
  });
  const [note, setNote] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });

  function onUrl(e: React.ChangeEvent<HTMLInputElement>) {
    const url = e.target.value;
    const name = nameFromLinkedinUrl(url);
    setF((x) => ({ ...x, linkedin_url: url, full_name: x.full_name.trim() ? x.full_name : name ?? x.full_name }));
  }

  async function save() {
    const url = normLinkedin(f.linkedin_url);
    if (f.linkedin_url.trim() && !url) return onError("That isn't a LinkedIn profile link (linkedin.com/in/…).");
    const fields = {
      full_name: f.full_name.trim(), role_title: f.role_title.trim() || null, contact_type: f.contact_type,
      company_name: f.company_name.trim() || company, linkedin_url: url || null, email: f.email.trim() || null,
      phone: f.phone.trim() || null, manually_edited: true, deleted_at: null,
    };
    let res = candidate?.contactId
      ? await supabase.from("contacts").update(fields).eq("id", candidate.contactId).select(CONTACT_COLUMNS).single()
      : await supabase.from("contacts").insert({ ...fields, source: candidate?.source ?? "manual" }).select(CONTACT_COLUMNS).single();
    if (res.error?.code === "23505" && url && !candidate?.contactId) {
      // Already saved under this LinkedIn link: update that contact (e.g. a connection who changed jobs).
      const old = await supabase.from("contacts").select(CONTACT_COLUMNS).eq("linkedin_url", url).single();
      res = await supabase.from("contacts").update(fields).eq("linkedin_url", url).select(CONTACT_COLUMNS).single();
      if (!res.error && old.data && !sameCompany((old.data as Contact).company_name, fields.company_name)) {
        setNote(`Already saved (at ${(old.data as Contact).company_name ?? "no company"}): updated to ${fields.company_name}.`);
      }
    } else if (res.error?.code === "23505") {
      return onError("Another contact already has that LinkedIn link.");
    }
    if (res.error) return onError(res.error.message);
    onSaved(res.data as Contact);
  }

  return (
    <div className="register">
      <div className="row">
        <input placeholder="LinkedIn profile link (fills in the name)" value={f.linkedin_url} onChange={onUrl} />
      </div>
      <div className="row">
        <input placeholder="Full name" value={f.full_name} onChange={set("full_name")} />
        <input placeholder="Role, e.g. Head of Data" value={f.role_title} onChange={set("role_title")} />
        <select value={f.contact_type} onChange={set("contact_type")} aria-label="Kind of contact">
          {Object.entries(TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </div>
      <div className="row">
        <input placeholder="Email (optional)" value={f.email} onChange={set("email")} />
        <input placeholder="Phone (optional)" value={f.phone} onChange={set("phone")} />
        <input placeholder="Company" value={f.company_name} onChange={set("company_name")} title="Change it if the person works elsewhere now" />
      </div>
      <div className="row">
        <button className="primary small" disabled={!f.full_name.trim()} onClick={save}>{candidate ? "Save" : "Add"}</button>
        {note && <span className="muted">{note}</span>}
      </div>
    </div>
  );
}

/** "Senior Data Engineer (m/w/d)" → "Data Engineer": the core of the title, for a people search. */
function shortRole(title: string): string {
  return title.replace(/\(.*?\)|\*|senior|junior|lead|principal|\bsr\.?|\bjr\.?/gi, " ").split(/[/|–,-]/)[0].replace(/\s+/g, " ").trim();
}

function mailto(email: string, job: { title: string; company_name: string }, body: string, lang: "de" | "en", applied: boolean) {
  const subject = applied
    ? (lang === "de" ? `Meine Bewerbung: ${job.title}` : `My application: ${job.title}`)
    : (lang === "de" ? `Frage zur Stelle: ${job.title}` : `Question about the ${job.title} role`);
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
      // Contacts edited in the app keep the owner's version (e.g. a connection who changed jobs).
      const edited = new Set<string>();
      for (let from = 0; ; from += 1000) {
        const { data, error } = await supabase.from("contacts").select("linkedin_url")
          .eq("manually_edited", true).not("linkedin_url", "is", null).range(from, from + 999);
        if (error) throw new Error(error.message);
        data.forEach((d) => edited.add(d.linkedin_url as string));
        if (data.length < 1000) break;
      }
      const withUrl = rows.filter((r) => r.linkedin_url && !edited.has(r.linkedin_url));
      for (let i = 0; i < withUrl.length; i += 500) {
        setStatus(`Saving ${Math.min(i + 500, withUrl.length)} of ${withUrl.length}…`);
        const chunk = withUrl.slice(i, i + 500).map((r) => ({ ...r, source: "connections", contact_type: "referral" }));
        const { error } = await supabase.from("contacts").upsert(chunk, { onConflict: "linkedin_url" });
        if (error) throw new Error(error.message);
      }
      const companies = new Set(withUrl.map((r) => r.company_name).filter(Boolean)).size;
      setStatus(`Imported ${withUrl.length} connections at ${companies} companies.` +
        (edited.size ? ` Contacts you edited in the app were kept as they are.` : "") +
        (rows.filter((r) => !r.linkedin_url).length ? ` ${rows.filter((r) => !r.linkedin_url).length} rows without a profile link were skipped.` : ""));
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
