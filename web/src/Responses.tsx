import { useCallback, useEffect, useMemo, useState } from "react";
import { adLanguage } from "./contactfinder";
import { supabase } from "./supabase";

// Responses: every ping by person, the replies, and what gets replies. Search a name (or company)
// to see which jobs you messaged that person about and what you wrote; log their reply and its outcome.

type Ping = {
  id: string; sent_at: string; channel: string; status: "sent" | "replied" | "no_reply";
  message_text: string | null; reply_text: string | null; reply_outcome: string | null; replied_at: string | null;
  follow_up_due: string | null; followed_up_at: string | null; kind: string | null; lang: string | null;
  job_posting_id: string; application_id: string | null;
  contacts: { id: string; full_name: string; company_name: string | null; role_title: string | null;
              contact_type: string | null; source: string; linkedin_url: string | null; email: string | null } | null;
  job_postings: { id: string; title: string; company_name: string } | null;
};
const COLUMNS = "id,sent_at,channel,status,message_text,reply_text,reply_outcome,replied_at,follow_up_due,followed_up_at," +
  "kind,lang,job_posting_id,application_id," +
  "contacts(id,full_name,company_name,role_title,contact_type,source,linkedin_url,email),job_postings(id,title,company_name)";

export const OUTCOMES: Record<string, string> = {
  positive: "Positive", asked_for_info: "Asked for CV / info", interview: "Interview", referred: "Referred to someone",
  neutral: "Neutral", not_interested: "Not interested",
};
const KINDS: Record<string, string> = { pre_apply: "Before applying", post_apply: "After applying", other: "Other" };
const CHANNELS: Record<string, string> = { linkedin: "LinkedIn", email: "Email", phone: "Phone", other: "Other" };
const TYPES: Record<string, string> = {
  recruiter: "Recruiter", hiring_manager: "Hiring manager", team_member: "Team member", referral: "Connection", other: "Other",
};
const FILTERS = [
  { key: "all", label: "All" },
  { key: "waiting", label: "Awaiting reply" },
  { key: "replied", label: "Replied" },
  { key: "due", label: "Follow up" },
] as const;

const fmt = (iso: string) => new Date(iso.length === 10 ? iso + "T00:00:00" : iso)
  .toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
const today = () => new Date().toISOString().slice(0, 10);

export default function Responses() {
  const [pings, setPings] = useState<Ping[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["key"]>("all");
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await supabase.from("outreach").select(COLUMNS).is("deleted_at", null)
      .order("sent_at", { ascending: false }).limit(5000);
    if (error) return setError(error.message);
    setPings(data as unknown as Ping[]);
  }, []);
  useEffect(() => { load(); }, [load]);

  const replace = (p: Ping) => setPings((ps) => ps && ps.map((x) => (x.id === p.id ? p : x)));

  // Grouped by person, filtered by the search (name, company or job title) and the status chip.
  const people = useMemo(() => {
    if (!pings) return [];
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const due = (p: Ping) => p.status === "sent" && !p.followed_up_at && !!p.follow_up_due && p.follow_up_due <= today();
    const keep = (p: Ping) => {
      const hay = `${p.contacts?.full_name ?? ""} ${p.contacts?.company_name ?? ""} ${p.job_postings?.title ?? ""} ${p.job_postings?.company_name ?? ""}`.toLowerCase();
      if (!words.every((w) => hay.includes(w))) return false;
      if (filter === "waiting") return p.status === "sent";
      if (filter === "replied") return p.status === "replied";
      if (filter === "due") return due(p);
      return true;
    };
    const by = new Map<string, Ping[]>();
    for (const p of pings.filter(keep)) {
      const k = p.contacts?.id ?? p.id;
      by.set(k, [...(by.get(k) ?? []), p]);
    }
    return [...by.values()];
  }, [pings, q, filter]);

  if (error) return <p className="notice">{error}</p>;
  if (!pings) return <p className="empty">Loading…</p>;

  return (
    <div className="responses">
      <div className="responses-bar">
        <h2>Responses</h2>
        <input className="search" autoFocus placeholder="Search a person, company or job…" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="small" onClick={() => setAdding((a) => !a)}>{adding ? "Cancel" : "+ Log a message sent elsewhere"}</button>
      </div>
      {adding && <LogElsewhere onError={setError} onSaved={() => { setAdding(false); load(); }} />}
      <div className="tabs">
        {FILTERS.map((f) => (
          <button key={f.key} className={filter === f.key ? "active" : ""} onClick={() => setFilter(f.key)}>{f.label}</button>
        ))}
      </div>

      {people.length === 0 ? (
        <p className="empty">{pings.length ? "Nobody matches." : "No pings logged yet. Use “Log ping” on a job, or log a message sent elsewhere."}</p>
      ) : people.map((ps) => <Person key={ps[0].contacts?.id ?? ps[0].id} pings={ps} onChange={replace} onError={setError} />)}

      <WhatWorks pings={pings} />
    </div>
  );
}

function Person({ pings, onChange, onError }: { pings: Ping[]; onChange: (p: Ping) => void; onError: (m: string) => void }) {
  const c = pings[0].contacts;
  return (
    <section className="card person">
      <div className="person-head">
        <strong>{c?.full_name ?? "Unknown contact"}</strong>
        <span className="muted">
          {[c?.role_title, c?.company_name, c?.contact_type ? TYPES[c.contact_type] : null].filter(Boolean).join(" · ")}
        </span>
        {c?.linkedin_url && <a href={c.linkedin_url} target="_blank" rel="noreferrer">LinkedIn ↗</a>}
        {c?.email && <a href={`mailto:${c.email}`}>{c.email}</a>}
      </div>
      <ul className="person-pings">
        {pings.map((p) => <PingRow key={p.id} p={p} onChange={onChange} onError={onError} />)}
      </ul>
    </section>
  );
}

function PingRow({ p, onChange, onError }: { p: Ping; onChange: (p: Ping) => void; onError: (m: string) => void }) {
  const [open, setOpen] = useState(false);
  const [replying, setReplying] = useState(false);
  const [reply, setReply] = useState(p.reply_text ?? "");
  const [outcome, setOutcome] = useState(p.reply_outcome ?? "positive");
  const [day, setDay] = useState((p.replied_at ?? new Date().toISOString()).slice(0, 10));

  async function save(fields: Partial<Ping>) {
    const { data, error } = await supabase.from("outreach").update(fields).eq("id", p.id).select(COLUMNS).single();
    if (error) return onError(error.message);
    onChange(data as unknown as Ping);
    setReplying(false);
  }

  return (
    <li>
      <div className="ping-line">
        {p.job_postings ? <a href={`#job/${p.job_posting_id}`}>{p.job_postings.title}</a> : <span className="muted">Job removed</span>}
        <span className="muted"> · {p.job_postings?.company_name} · {fmt(p.sent_at)} · {CHANNELS[p.channel] ?? p.channel}
          {p.kind && p.kind !== "other" ? ` · ${KINDS[p.kind]}` : ""}</span>
        {p.status === "replied" && <span className="status status-green">{p.reply_outcome ? OUTCOMES[p.reply_outcome] : "Replied"}</span>}
        {p.status === "no_reply" && <span className="status status-grey">No reply</span>}
        {p.status === "sent" && <span className="status status-blue">Awaiting reply</span>}
      </div>
      <div className="row small-text">
        <button className="link" onClick={() => setOpen((o) => !o)}>{open ? "Hide message" : "Show message"}</button>
        <button className="link" onClick={() => setReplying((r) => !r)}>{p.status === "replied" ? "Edit reply" : "Log reply"}</button>
        {p.status === "sent" && <button className="link" onClick={() => save({ status: "no_reply", follow_up_due: null })}>No reply</button>}
        {p.status !== "sent" && <button className="link" onClick={() => save({ status: "sent", reply_outcome: null, replied_at: null })}>Reset</button>}
      </div>
      {open && <blockquote className="sent-message">{p.message_text ?? "(the text wasn't recorded)"}</blockquote>}
      {p.reply_text && !replying && <blockquote className="reply-message">{p.reply_text}</blockquote>}
      {replying && (
        <div className="register">
          <textarea rows={4} placeholder="Paste their reply (optional, but it shows later what worked)" value={reply}
                    onChange={(e) => setReply(e.target.value)} />
          <div className="row">
            <select value={outcome} onChange={(e) => setOutcome(e.target.value)} aria-label="Outcome">
              {Object.entries(OUTCOMES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <input type="date" value={day} max={today()} onChange={(e) => setDay(e.target.value)} aria-label="Reply date" />
            <button className="primary small" onClick={() => save({
              status: "replied", reply_text: reply.trim() || null, reply_outcome: outcome,
              replied_at: new Date(day + "T12:00:00").toISOString(), follow_up_due: null,
            })}>Save reply</button>
          </div>
        </div>
      )}
    </li>
  );
}

/** A ping sent without the panel: pick or name the person, pick the job, paste what you wrote. */
function LogElsewhere({ onSaved, onError }: { onSaved: () => void; onError: (m: string) => void }) {
  const [name, setName] = useState("");
  const [company, setCompany] = useState("");
  const [jobQ, setJobQ] = useState("");
  const [jobs, setJobs] = useState<{ id: string; title: string; company_name: string; applied: boolean }[]>([]);
  const [job, setJob] = useState<{ id: string; title: string; company_name: string; applied: boolean } | null>(null);
  const [channel, setChannel] = useState("linkedin");
  const [day, setDay] = useState(today());
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const w = jobQ.trim();
    if (w.length < 2 || job) { setJobs([]); return; }
    const t = setTimeout(async () => {
      const like = `%${w.replace(/[%_,()]/g, " ")}%`;
      const { data } = await supabase.from("job_postings").select("id,title,company_name,triage_status")
        .is("deleted_at", null).or(`title.ilike.${like},company_name.ilike.${like}`)
        .order("first_seen_at", { ascending: false }).limit(12);
      setJobs(((data ?? []) as { id: string; title: string; company_name: string; triage_status: string }[])
        .map((j) => ({ ...j, applied: j.triage_status === "applied" })));
    }, 250);
    return () => clearTimeout(t);
  }, [jobQ, job]);

  async function save() {
    if (!name.trim() || !job) return;
    setBusy(true);
    // Reuse a saved contact with the same name at the same company; otherwise add one.
    const co = company.trim() || job.company_name;
    const { data: found } = await supabase.from("contacts").select("id,company_name").ilike("full_name", name.trim()).is("deleted_at", null);
    let contactId = ((found ?? []) as { id: string; company_name: string | null }[])
      .find((c) => (c.company_name ?? "").toLowerCase().includes(co.toLowerCase().split(" ")[0]))?.id;
    if (!contactId) {
      const { data, error } = await supabase.from("contacts").insert({ full_name: name.trim(), company_name: co, source: "manual" })
        .select("id").single();
      if (error) { setBusy(false); return onError(error.message); }
      contactId = data.id;
    }
    const app = await supabase.from("applications").select("id").eq("job_posting_id", job.id).is("deleted_at", null).maybeSingle();
    const sent = new Date(day + "T12:00:00");
    const { error } = await supabase.from("outreach").insert({
      job_posting_id: job.id, application_id: (app.data as { id: string } | null)?.id ?? null, contact_id: contactId,
      channel, sent_at: sent.toISOString(), message_text: text.trim() || null,
      follow_up_due: new Date(sent.getTime() + 7 * 86400000).toISOString().slice(0, 10),
      kind: app.data ? "post_apply" : "pre_apply", lang: text.trim() ? adLanguage(text) : null,
    });
    setBusy(false);
    if (error) return onError(error.message);
    onSaved();
  }

  return (
    <div className="register">
      <div className="row">
        <input placeholder="Person's full name" value={name} onChange={(e) => setName(e.target.value)} />
        <input placeholder="Company (optional, defaults to the job's)" value={company} onChange={(e) => setCompany(e.target.value)} />
      </div>
      <div className="row">
        {job ? (
          <span>Job: <strong>{job.title}</strong> · {job.company_name} <button className="link" onClick={() => setJob(null)}>change</button></span>
        ) : (
          <input placeholder="Find the job: title or company" value={jobQ} onChange={(e) => setJobQ(e.target.value)} />
        )}
      </div>
      {!job && jobs.length > 0 && (
        <ul className="job-picks">
          {jobs.map((j) => (
            <li key={j.id}><button className="link" onClick={() => setJob(j)}>{j.title} · {j.company_name}{j.applied ? " (applied)" : ""}</button></li>
          ))}
        </ul>
      )}
      <div className="row">
        <select value={channel} onChange={(e) => setChannel(e.target.value)} aria-label="Channel">
          {Object.entries(CHANNELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <input type="date" value={day} max={today()} onChange={(e) => setDay(e.target.value)} aria-label="Sent on" />
      </div>
      <textarea rows={3} placeholder="What you wrote (paste it: it shows later which messages get replies)" value={text}
                onChange={(e) => setText(e.target.value)} />
      <div className="row">
        <button className="primary small" disabled={!name.trim() || !job || busy} onClick={save}>Save</button>
      </div>
    </div>
  );
}

/** Reply rates by message variant, channel, kind of contact and language. */
function WhatWorks({ pings }: { pings: Ping[] }) {
  // A ping counts once it had a chance: replied, marked no reply, or sent 7+ days ago.
  const cutoff = new Date(Date.now() - 7 * 86400000).toISOString();
  const judged = pings.filter((p) => p.status !== "sent" || p.sent_at <= cutoff);
  const dims: [string, (p: Ping) => string][] = [
    ["Message", (p) => KINDS[p.kind ?? "other"] ?? "Other"],
    ["Channel", (p) => CHANNELS[p.channel] ?? p.channel],
    ["Contact", (p) => TYPES[p.contacts?.contact_type ?? "other"] ?? "Other"],
    ["Language", (p) => (p.lang === "de" ? "German" : p.lang === "en" ? "English" : "Unknown")],
  ];
  const outcomes = new Map<string, number>();
  pings.filter((p) => p.status === "replied").forEach((p) => outcomes.set(p.reply_outcome ?? "unspecified", (outcomes.get(p.reply_outcome ?? "unspecified") ?? 0) + 1));

  return (
    <section className="card">
      <h3>What works</h3>
      <p className="muted small">
        Reply rate per group, counting pings that got a reply, were marked "no reply", or are 7+ days old ({judged.length} of {pings.length} so far).
        With few pings, treat differences as hints, not proof.
      </p>
      <div className="works">
        {dims.map(([label, key]) => {
          const g = new Map<string, { n: number; r: number }>();
          for (const p of judged) {
            const k = key(p);
            const v = g.get(k) ?? { n: 0, r: 0 };
            v.n++;
            if (p.status === "replied") v.r++;
            g.set(k, v);
          }
          return (
            <table key={label} className="apps">
              <thead><tr><th>{label}</th><th>Sent</th><th>Replied</th><th>Rate</th></tr></thead>
              <tbody>
                {[...g.entries()].sort((a, b) => b[1].n - a[1].n).map(([k, v]) => (
                  <tr key={k}><td>{k}</td><td>{v.n}</td><td>{v.r}</td><td>{v.n ? `${Math.round((100 * v.r) / v.n)}%` : "–"}</td></tr>
                ))}
                {g.size === 0 && <tr><td colSpan={4} className="muted">Not enough data yet</td></tr>}
              </tbody>
            </table>
          );
        })}
      </div>
      {outcomes.size > 0 && (
        <p className="small">Replies so far: {[...outcomes.entries()].map(([k, v]) => `${OUTCOMES[k] ?? "Not specified"} ${v}`).join(" · ")}</p>
      )}
    </section>
  );
}
