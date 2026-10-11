import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import EmailQueue, { gmailLink } from "./EmailQueue";
import { CoverLetter, RESUME_COLUMNS, ResumeLink, ResumePicker, ResumeText, type Resume } from "./Resumes";
import { buildPrepPrompt, INTERVIEW_KINDS } from "./prep";
import { sourceLabel, supabase } from "./supabase";

// Applications table (spec 9.2). Status is never stored: it is the latest
// non-note event, so changing status means adding an event (one tap).

type Event = {
  id: string;
  application_id: string;
  event_type: string;
  occurred_at: string;
  source: string;
  notes: string | null;
  scheduled_for?: string | null;
  interview_kind?: string | null;
  inbound_emails?: { gmail_message_id: string } | null;
};

// Interview events open a small form for date/time and kind (used by the prep prompt).
const INTERVIEW_EVENTS = new Set(["interview_invited", "interview_scheduled"]);
const EVENT_COLUMNS = "id,application_id,event_type,occurred_at,source,notes,scheduled_for,interview_kind";

type App = {
  id: string;
  applied_at: string | null;
  created_at: string;
  notes: string | null;
  jd_snapshot: string | null;
  resume_id: string | null;
  cover_letter_file_id: string | null;
  job_postings: {
    title: string;
    company_name: string;
    city: string | null;
    source: string;
    apply_url: string | null;
    source_url: string | null;
  };
};

export const EVENT_LABELS: Record<string, string> = {
  drafted: "Draft",
  applied: "Applied",
  confirmation_received: "Confirmed",
  info_requested: "Info requested",
  assessment_received: "Assessment",
  interview_invited: "Interview invited",
  interview_scheduled: "Interview scheduled",
  interview_completed: "Interview done",
  offer_received: "Offer",
  offer_accepted: "Offer accepted",
  offer_declined: "Offer declined",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
  no_response: "No response",
  note: "Note",
};

// Events the owner can add by hand (email automation adds the rest in Phase 5).
const ADDABLE = [
  "applied", "confirmation_received", "info_requested", "assessment_received",
  "interview_invited", "interview_scheduled", "interview_completed",
  "offer_received", "offer_accepted", "offer_declined", "rejected", "withdrawn", "note",
];

function tone(status: string): string {
  if (status === "drafted" || status === "withdrawn" || status === "no_response") return "grey";
  if (status === "rejected" || status === "offer_declined") return "red";
  if (status.startsWith("offer")) return "green";
  if (status.startsWith("interview") || status === "assessment_received" || status === "info_requested") return "orange";
  return "blue";
}

const STATUS_FILTERS: { key: string; label: string; test: (s: string) => boolean }[] = [
  { key: "active", label: "Active", test: (s) => !["rejected", "withdrawn", "offer_declined", "offer_accepted", "no_response"].includes(s) },
  { key: "interviews", label: "Interviews", test: (s) => s.startsWith("interview") || s === "assessment_received" },
  { key: "closed", label: "Closed", test: (s) => ["rejected", "withdrawn", "offer_declined", "offer_accepted", "no_response"].includes(s) },
  { key: "all", label: "All", test: () => true },
];

export default function Applications() {
  const [apps, setApps] = useState<App[] | null>(null);
  const [events, setEvents] = useState<Event[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [filter, setFilter] = useState("active");
  const [error, setError] = useState<string | null>(null);
  const [resumes, setResumes] = useState<Resume[]>([]);
  const [scheduling, setScheduling] = useState<{ appId: string; type: string } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const resumeById = useMemo(() => new Map(resumes.map((r) => [r.id, r])), [resumes]);

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from("applications")
      .select("id,applied_at,created_at,notes,jd_snapshot,resume_id,cover_letter_file_id," +
              "job_postings(title,company_name,city,source,apply_url,source_url)")
      .is("deleted_at", null)
      .order("created_at", { ascending: false });
    if (error) return setError(error.message);
    const rs = await supabase.from("resumes").select(RESUME_COLUMNS).is("deleted_at", null)
      .order("created_at", { ascending: false });
    if (rs.error) setError(rs.error.message);
    else setResumes(rs.data as Resume[]);
    const list = data as unknown as App[];
    setApps(list);
    if (list.length) {
      const ev = await supabase
        .from("application_events")
        .select(EVENT_COLUMNS + ",inbound_emails(gmail_message_id)")
        .in("application_id", list.map((a) => a.id))
        .order("occurred_at", { ascending: false })
        .order("created_at", { ascending: false });
      if (ev.error) setError(ev.error.message);
      else setEvents(ev.data as unknown as Event[]);   // inbound_emails is many-to-one: an object, not a list
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const byApp = useMemo(() => {
    const m = new Map<string, Event[]>();
    for (const e of events) m.set(e.application_id, [...(m.get(e.application_id) ?? []), e]);
    return m;
  }, [events]);

  const statusOf = (id: string) => (byApp.get(id) ?? []).find((e) => e.event_type !== "note");
  const lastEvent = (id: string) => (byApp.get(id) ?? [])[0];

  async function addEvent(app: App, type: string, extra: Partial<Event> = {}) {
    if (INTERVIEW_EVENTS.has(type) && !extra.event_type) {
      setOpen(app.id);
      setScheduling({ appId: app.id, type });
      return;
    }
    let notes: string | null = extra.notes ?? null;
    if (type === "note") {
      notes = window.prompt("Note");
      if (!notes) return;
    }
    const { data, error } = await supabase.from("application_events")
      .insert({ application_id: app.id, event_type: type, source: "user", notes,
                scheduled_for: extra.scheduled_for ?? null, interview_kind: extra.interview_kind ?? null })
      .select(EVENT_COLUMNS).single();
    if (error) return setError(error.message);
    setEvents((es) => [data as Event, ...es]);
    if (type === "applied" && !app.applied_at) {
      const now = (data as Event).occurred_at;
      await supabase.from("applications").update({ applied_at: now }).eq("id", app.id);
      setApps((as) => as && as.map((a) => (a.id === app.id ? { ...a, applied_at: now } : a)));
    }
  }

  async function copyPrep(app: App) {
    try {
      const prompt = await buildPrepPrompt({
        applicationId: app.id, company: app.job_postings.company_name, title: app.job_postings.title,
        appliedAt: app.applied_at, jd: app.jd_snapshot, resumeId: app.resume_id,
      });
      await navigator.clipboard.writeText(prompt);
      setToast(`Interview-prep prompt for ${app.job_postings.company_name} copied`);
    } catch {
      setToast("Couldn't copy to the clipboard");
    }
    setTimeout(() => setToast(null), 3000);
  }

  async function patch(app: App, fields: Partial<Pick<App, "resume_id" | "cover_letter_file_id" | "jd_snapshot">>) {
    const { error } = await supabase.from("applications").update(fields).eq("id", app.id);
    if (error) return setError(error.message);
    setApps((as) => as && as.map((a) => (a.id === app.id ? { ...a, ...fields } : a)));
  }

  async function saveNotes(app: App, notes: string) {
    const v = notes.trim() || null;
    if (v === app.notes) return;
    const { error } = await supabase.from("applications").update({ notes: v }).eq("id", app.id);
    if (error) return setError(error.message);
    setApps((as) => as && as.map((a) => (a.id === app.id ? { ...a, notes: v } : a)));
  }

  if (apps === null) return <p className="empty">{error ?? "Loading…"}</p>;
  if (apps.length === 0) return <p className="empty">No applications yet. Tap Apply on a job in the feed.</p>;

  const test = STATUS_FILTERS.find((f) => f.key === filter)!.test;
  const rows = apps.filter((a) => test(statusOf(a.id)?.event_type ?? "drafted"));

  return (
    <>
      <EmailQueue onAssigned={load}
                  apps={apps.map((a) => ({ id: a.id, label: `${a.job_postings.company_name} – ${a.job_postings.title}` }))} />
      <div className="tabs">
        {STATUS_FILTERS.map((f) => {
          const n = apps.filter((a) => f.test(statusOf(a.id)?.event_type ?? "drafted")).length;
          return (
            <button key={f.key} className={filter === f.key ? "active" : ""} onClick={() => setFilter(f.key)}>
              {f.label} <span className="day-count">{n}</span>
            </button>
          );
        })}
      </div>
      {error && <p className="notice">{error}</p>}
      <div className="table-wrap">
        <table className="apps">
          <thead>
            <tr>
              <th>Company</th>
              <th>Role</th>
              <th>Location</th>
              <th>Status</th>
              <th>Applied</th>
              <th>Last update</th>
              <th>Resume</th>
              <th>JD</th>
              <th>Source</th>
              <th>Add event</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => {
              const p = a.job_postings;
              const st = statusOf(a.id);
              const last = lastEvent(a.id);
              const url = p.apply_url ?? p.source_url ?? undefined;
              const isOpen = open === a.id;
              return (
                <Fragment key={a.id}>
                  <tr className={isOpen ? "open" : ""} onClick={() => setOpen(isOpen ? null : a.id)}>
                    <td className="strong">{p.company_name}</td>
                    <td>
                      {p.title}
                      {url && <> <a href={url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>↗</a></>}
                    </td>
                    <td className="muted">{p.city ?? "–"}</td>
                    <td>
                      <span className={`status status-${tone(st?.event_type ?? "drafted")}`}>
                        {EVENT_LABELS[st?.event_type ?? "drafted"]}
                      </span>
                    </td>
                    <td className="muted">{a.applied_at ? fmt(a.applied_at) : "–"}</td>
                    <td className="muted">{last ? ago(last.occurred_at) : "–"}</td>
                    <td>
                      <ResumeLink r={a.resume_id ? resumeById.get(a.resume_id) : undefined} />
                      {a.cover_letter_file_id && <span className="badge" title="Cover letter sent">+CL</span>}
                    </td>
                    <td>{a.jd_snapshot ? <span title="Job description stored">✓</span>
                                       : <span className="badge warn" title="Open the row to paste it">missing</span>}</td>
                    <td><span className={`source source-${p.source}`}>{sourceLabel(p.source)}</span></td>
                    <td onClick={(e) => e.stopPropagation()}>
                      {st?.event_type === "drafted" ? (
                        <button className="primary small" onClick={() => addEvent(a, "applied")}>Mark as applied</button>
                      ) : (
                        <select value="" aria-label="Add event"
                                onChange={(e) => e.target.value && addEvent(a, e.target.value)}>
                          <option value="">+ Event…</option>
                          {ADDABLE.map((t) => <option key={t} value={t}>{EVENT_LABELS[t]}</option>)}
                        </select>
                      )}
                    </td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <button className="small" title="Copy an interview-prep prompt for any LLM" onClick={() => copyPrep(a)}>
                        Prep
                      </button>
                    </td>
                  </tr>
                  {isOpen && (
                    <tr className="detail">
                      <td colSpan={11}>
                        <Detail app={a} events={byApp.get(a.id) ?? []} onNotes={(n) => saveNotes(a, n)}
                                onJd={(jd) => patch(a, { jd_snapshot: jd })}>
                          {scheduling?.appId === a.id && (
                            <InterviewForm type={scheduling.type} onCancel={() => setScheduling(null)}
                              onSave={(f) => { setScheduling(null); addEvent(a, scheduling.type, { ...f, event_type: scheduling.type }); }} />
                          )}
                          <h3>Documents sent</h3>
                          <div className="doc-row">
                            <span className="muted">Resume</span>
                            <ResumePicker resumes={resumes} value={a.resume_id} onError={setError}
                                          onPick={(id) => patch(a, { resume_id: id })}
                                          onCreated={(r) => setResumes((rs) => [r, ...rs])} />
                          </div>
                          {a.resume_id && resumeById.get(a.resume_id) && !resumeById.get(a.resume_id)!.extracted_text && (
                            <ResumeText resume={resumeById.get(a.resume_id)!} onError={setError}
                              onSaved={(r) => setResumes((rs) => rs.map((x) => (x.id === r.id ? r : x)))} />
                          )}
                          <div className="doc-row">
                            <span className="muted">Cover letter</span>
                            <CoverLetter fileId={a.cover_letter_file_id}
                                         onSave={(id) => patch(a, { cover_letter_file_id: id })} />
                          </div>
                        </Detail>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      {rows.length === 0 && <p className="empty">Nothing in this group.</p>}
      {toast && <div className="toast">{toast}</div>}
    </>
  );
}

function Detail({ app, events, onNotes, onJd, children }: {
  app: App;
  events: Event[];
  onNotes: (n: string) => void;
  onJd: (jd: string | null) => void;
  children?: React.ReactNode;
}) {
  return (
    <div className="detail-body">
      <div>
        <h3>Timeline</h3>
        <ol className="timeline">
          {events.map((e) => (
            <li key={e.id}>
              <span className="muted">{fmt(e.occurred_at, true)}</span>{" "}
              <strong>{EVENT_LABELS[e.event_type] ?? e.event_type}</strong>
              {(e.scheduled_for || e.interview_kind) && (
                <span className="muted">
                  {" "}· {[e.interview_kind && INTERVIEW_KINDS[e.interview_kind],
                          e.scheduled_for && `on ${fmt(e.scheduled_for, true)}`].filter(Boolean).join(" ")}
                </span>
              )}
              {e.source !== "user" && <span className="badge">{e.source}</span>}
              {e.inbound_emails && (
                <> <a href={gmailLink(e.inbound_emails.gmail_message_id)} target="_blank" rel="noreferrer">email ↗</a></>
              )}
              {e.notes && <div className="muted">{e.notes}</div>}
            </li>
          ))}
        </ol>
      </div>
      <div>
        {children}
        <h3>Notes</h3>
        <textarea defaultValue={app.notes ?? ""} rows={3} placeholder="Contact, salary discussed, next step…"
                  onBlur={(e) => onNotes(e.target.value)} />
        <JobDescription jd={app.jd_snapshot} onSave={onJd} />
      </div>
    </div>
  );
}

function fmt(iso: string, withTime = false): string {
  const d = new Date(iso);
  const date = d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
  return withTime ? `${date} ${d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}` : date;
}

function ago(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  return days <= 0 ? "today" : days === 1 ? "1 day ago" : `${days} days ago`;
}

/** The job description saved with the application: links get taken down, this copy stays. */
function JobDescription({ jd, onSave }: { jd: string | null; onSave: (jd: string | null) => void }) {
  const [editing, setEditing] = useState(!jd);
  const [draft, setDraft] = useState(jd ?? "");
  const [expanded, setExpanded] = useState(false);
  useEffect(() => { setDraft(jd ?? ""); setEditing(!jd); }, [jd]);

  return (
    <>
      <h3>Job description</h3>
      {editing ? (
        <>
          <textarea rows={6} value={draft} onChange={(e) => setDraft(e.target.value)}
                    placeholder="Paste the job description here: postings get taken down, this copy stays." />
          <div className="row">
            <button className="primary small" disabled={!draft.trim()} onClick={() => onSave(draft.trim())}>Save</button>
            {jd && <button className="link" onClick={() => { setDraft(jd); setEditing(false); }}>Cancel</button>}
          </div>
        </>
      ) : (
        <>
          <div className={`jd${expanded ? "" : " clamped"}`}>{jd}</div>
          <div className="row">
            <button className="link" onClick={() => setExpanded((x) => !x)}>{expanded ? "Show less" : "Show all"}</button>
            <button className="link" onClick={() => setEditing(true)}>Edit</button>
            <button className="link" onClick={() => navigator.clipboard.writeText(jd ?? "")}>Copy</button>
          </div>
        </>
      )}
    </>
  );
}

/** Date/time and kind for an interview event. */
function InterviewForm({ type, onSave, onCancel }: {
  type: string;
  onSave: (f: { scheduled_for: string | null; interview_kind: string; notes: string | null }) => void;
  onCancel: () => void;
}) {
  const [when, setWhen] = useState("");
  const [kind, setKind] = useState("phone_screen");
  const [notes, setNotes] = useState("");
  return (
    <div className="interview-form">
      <h3>{EVENT_LABELS[type]}</h3>
      <div className="row">
        <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} aria-label="Date and time" />
        <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Kind of interview">
          {Object.entries(INTERVIEW_KINDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </div>
      <input className="wide-input" placeholder="Notes (optional): interviewers, format, link…" value={notes}
             onChange={(e) => setNotes(e.target.value)} />
      <div className="row">
        <button className="primary small" onClick={() => onSave({
          scheduled_for: when ? new Date(when).toISOString() : null, interview_kind: kind, notes: notes.trim() || null,
        })}>Add</button>
        <button className="link" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
