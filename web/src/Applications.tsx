import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import EmailQueue, { gmailLink } from "./EmailQueue";
import { CoverLetter, RESUME_COLUMNS, ResumeLink, ResumePicker, ResumeText, type Resume } from "./Resumes";
import { PING_COLUMNS, type Ping } from "./Outreach";
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
  job_posting_id: string;
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
    posted_date: string | null;
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

const CLOSED = ["rejected", "withdrawn", "offer_declined", "offer_accepted", "no_response"];
const isActive = (s: string) => !CLOSED.includes(s);

/** Outreach state of one application: nobody pinged yet, a follow-up due, waiting, or replied. */
type Reach = "none" | "due" | "waiting" | "replied";
function reachOf(pings: Ping[], today: string): Reach {
  if (!pings.length) return "none";
  if (pings.some((p) => p.status === "replied")) return "replied";
  if (pings.some((p) => p.status === "sent" && !p.followed_up_at && p.follow_up_due && p.follow_up_due <= today)) return "due";
  return "waiting";
}

// Status filters test the status; the outreach ones (reach) the ping state of active applications.
const STATUS_FILTERS: { key: string; label: string; test: (s: string, r: Reach) => boolean }[] = [
  { key: "active", label: "Active", test: (s) => isActive(s) },
  { key: "reach", label: "To reach out", test: (s, r) => isActive(s) && s !== "drafted" && r === "none" },
  { key: "followup", label: "Follow up", test: (s, r) => isActive(s) && r === "due" },
  { key: "interviews", label: "Interviews", test: (s) => s.startsWith("interview") || s === "assessment_received" },
  { key: "closed", label: "Closed", test: (s) => CLOSED.includes(s) },
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
  const [pings, setPings] = useState<Ping[]>([]);
  const resumeById = useMemo(() => new Map(resumes.map((r) => [r.id, r])), [resumes]);

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from("applications")
      .select("id,job_posting_id,applied_at,created_at,notes,jd_snapshot,resume_id,cover_letter_file_id," +
              "job_postings(title,company_name,city,source,apply_url,source_url,posted_date)")
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
      const pg = await supabase.from("outreach").select(PING_COLUMNS).is("deleted_at", null)
        .in("job_posting_id", list.map((a) => a.job_posting_id));   // pings before applying count too
      if (pg.error) setError(pg.error.message);
      else setPings(pg.data as unknown as Ping[]);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const byApp = useMemo(() => {
    const m = new Map<string, Event[]>();
    for (const e of events) m.set(e.application_id, [...(m.get(e.application_id) ?? []), e]);
    return m;
  }, [events]);

  // The latest non-note event, but Draft/Applied never override a later stage (a confirmation email can
  // arrive before "Mark as applied" is clicked). Same rule as the application_status view.
  const statusOf = (id: string) => {
    const evs = (byApp.get(id) ?? []).filter((e) => e.event_type !== "note");
    return evs.find((e) => e.event_type !== "drafted" && e.event_type !== "applied") ?? evs[0];
  };
  const today = toDay(new Date().toISOString());
  const pingsByApp = useMemo(() => {
    const byJob = new Map<string, Ping[]>();
    for (const p of pings) byJob.set(p.job_posting_id, [...(byJob.get(p.job_posting_id) ?? []), p]);
    return new Map((apps ?? []).map((a) => [a.id, byJob.get(a.job_posting_id) ?? []]));
  }, [pings, apps]);
  const reach = (id: string) => reachOf(pingsByApp.get(id) ?? [], today);
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
                ...(extra.occurred_at ? { occurred_at: extra.occurred_at } : {}),
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

  // -- corrections and deletion ------------------------------------------------------
  async function savePosting(app: App, fields: Partial<Pick<App["job_postings"], "company_name" | "title" | "city" | "posted_date">>) {
    const { error } = await supabase.from("job_postings").update(fields).eq("id", app.job_posting_id);
    if (error) return setError(error.message);
    setApps((as) => as && as.map((a) => (a.id === app.id ? { ...a, job_postings: { ...a.job_postings, ...fields } } : a)));
  }

  /** New applied date: the application's date and its (first) 'Applied' event move together. */
  async function saveAppliedDate(app: App, day: string) {
    if (!day) return;
    const iso = new Date(day + "T12:00:00").toISOString();
    const { error } = await supabase.from("applications").update({ applied_at: iso }).eq("id", app.id);
    if (error) return setError(error.message);
    const applied = (byApp.get(app.id) ?? []).filter((e) => e.event_type === "applied")
      .sort((a, b) => a.occurred_at.localeCompare(b.occurred_at))[0];
    if (applied) await editEvent(applied, { occurred_at: iso });
    else await addEvent(app, "applied", { occurred_at: iso, event_type: "applied" } as Partial<Event>);
    setApps((as) => as && as.map((a) => (a.id === app.id ? { ...a, applied_at: iso } : a)));
  }

  async function editEvent(ev: Event, fields: Partial<Pick<Event, "occurred_at" | "scheduled_for" | "interview_kind">>) {
    const { error } = await supabase.from("application_events").update(fields).eq("id", ev.id);
    if (error) return setError(error.message);
    setEvents((es) => es.map((e) => (e.id === ev.id ? { ...e, ...fields } : e))
      .sort((a, b) => b.occurred_at.localeCompare(a.occurred_at)));
  }

  async function deleteApp(app: App) {
    const label = `${app.job_postings.company_name} – ${app.job_postings.title}`;
    if (!window.confirm(`Delete the application "${label}"? It disappears from the app and the job won't come back.`)) return;
    const now = new Date().toISOString();
    const a = await supabase.from("applications").update({ deleted_at: now }).eq("id", app.id);
    if (a.error) return setError(a.error.message);
    await supabase.from("job_postings").update({ deleted_at: now }).eq("id", app.job_posting_id);
    setApps((as) => as && as.filter((x) => x.id !== app.id));
    setOpen(null);
  }

  async function copyPrep(app: App) {
    try {
      // Notes fetched now: they may have been edited in a job tab since this list loaded.
      const n = await supabase.from("job_postings").select("notes").eq("id", app.job_posting_id).maybeSingle();
      const prompt = await buildPrepPrompt({
        applicationId: app.id, company: app.job_postings.company_name, title: app.job_postings.title,
        appliedAt: app.applied_at, jd: app.jd_snapshot, resumeId: app.resume_id,
        notes: (n.data as { notes: string | null } | null)?.notes ?? null,
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
  const rows = apps.filter((a) => test(statusOf(a.id)?.event_type ?? "drafted", reach(a.id)));

  return (
    <>
      <EmailQueue onAssigned={load}
                  apps={apps.map((a) => ({ id: a.id, label: `${a.job_postings.company_name} – ${a.job_postings.title}` }))} />
      <div className="tabs">
        {STATUS_FILTERS.map((f) => {
          const n = apps.filter((a) => f.test(statusOf(a.id)?.event_type ?? "drafted", reach(a.id))).length;
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
              <th>Outreach</th>
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
                    <td onClick={(e) => e.stopPropagation()}>
                      <ReachCell reach={reach(a.id)} pings={pingsByApp.get(a.id) ?? []}
                                 active={isActive(st?.event_type ?? "drafted") && st?.event_type !== "drafted"} href={`#job/${a.job_posting_id}`} />
                    </td>
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
                      <div className="row nowrap">
                        <a className="link-button small" href={`#job/${a.job_posting_id}`} title="Open the job with its notepad (Cmd-click: new browser tab)">Open</a>
                        <button className="small" title="Copy an interview-prep prompt for any LLM" onClick={() => copyPrep(a)}>
                          Prep
                        </button>
                      </div>
                    </td>
                  </tr>
                  {isOpen && (
                    <tr className="detail">
                      <td colSpan={12}>
                        <Detail app={a} events={byApp.get(a.id) ?? []} onNotes={(n) => saveNotes(a, n)}
                                onJd={(jd) => patch(a, { jd_snapshot: jd })} onEventDate={(e, iso) => editEvent(e, { occurred_at: iso })}
                                onInterview={(e, f) => editEvent(e, f)}
                                onPosting={(f) => savePosting(a, f)} onApplied={(d) => saveAppliedDate(a, d)}
                                onDelete={() => deleteApp(a)}>
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

function Detail({ app, events, onNotes, onJd, onEventDate, onInterview, onPosting, onApplied, onDelete, children }: {
  onInterview: (e: Event, f: { scheduled_for?: string | null; interview_kind?: string | null }) => void;
  app: App;
  events: Event[];
  onNotes: (n: string) => void;
  onJd: (jd: string | null) => void;
  onEventDate: (e: Event, iso: string) => void;
  onPosting: (f: Partial<Pick<App["job_postings"], "company_name" | "title" | "city" | "posted_date">>) => void;
  onApplied: (day: string) => void;
  onDelete: () => void;
  children?: React.ReactNode;
}) {
  return (
    <div className="detail-body">
      <div>
        <h3>Timeline</h3>
        <ol className="timeline">
          {events.map((e) => (
            <li key={e.id}>
              <EventDate value={e.occurred_at} onSave={(iso) => onEventDate(e, iso)} />{" "}
              <strong>{EVENT_LABELS[e.event_type] ?? e.event_type}</strong>
              {INTERVIEW_EVENTS.has(e.event_type) ? (
                <InterviewWhen e={e} onSave={(f) => onInterview(e, f)} />
              ) : (e.scheduled_for || e.interview_kind) && (
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
        <h3>Details</h3>
        <div className="details-grid">
          <label>Company<input defaultValue={app.job_postings.company_name}
            onBlur={(e) => e.target.value.trim() && e.target.value !== app.job_postings.company_name && onPosting({ company_name: e.target.value.trim() })} /></label>
          <label>Role<input defaultValue={app.job_postings.title}
            onBlur={(e) => e.target.value.trim() && e.target.value !== app.job_postings.title && onPosting({ title: e.target.value.trim() })} /></label>
          <label>Location<input defaultValue={app.job_postings.city ?? ""} placeholder="City"
            onBlur={(e) => e.target.value !== (app.job_postings.city ?? "") && onPosting({ city: e.target.value.trim() || null as unknown as string })} /></label>
          <label>Posted on<input type="date" defaultValue={app.job_postings.posted_date ?? ""} max={toDay(new Date().toISOString())}
            onChange={(e) => onPosting({ posted_date: e.target.value || null as unknown as string })} /></label>
          <label>Applied on<input type="date" defaultValue={app.applied_at ? toDay(app.applied_at) : ""} max={toDay(new Date().toISOString())}
            onChange={(e) => onApplied(e.target.value)} /></label>
        </div>
        {children}
        <h3>Application notes <a className="h3-link" href={`#job/${app.job_posting_id}`}>Job notepad →</a></h3>
        <textarea defaultValue={app.notes ?? ""} rows={3} placeholder="Contact, salary discussed, next step…"
                  onBlur={(e) => onNotes(e.target.value)} />
        <JobDescription jd={app.jd_snapshot} onSave={onJd} />
        <div className="danger-zone">
          <button className="link danger" onClick={onDelete}>Delete application</button>
        </div>
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

function ReachCell({ reach, pings, active, href }: { reach: Reach; pings: Ping[]; active: boolean; href: string }) {
  const people = new Set(pings.map((p) => p.contact_id)).size;
  const replied = new Set(pings.filter((p) => p.status === "replied").map((p) => p.contact_id)).size;
  if (reach === "none") {
    return active ? <a className="badge warn" href={href} title="Open the job to see who to ping">reach out</a> : <span className="muted">–</span>;
  }
  if (reach === "due") return <a className="status status-orange" href={href}>follow up</a>;
  // Per person: "1 of 4 replied", not just "replied".
  if (reach === "replied") return <a className="status status-green" href={href}>{replied} of {people} replied</a>;
  return <a className="muted" href={href}>{people} contacted</a>;
}

/** An interview event's time and kind, set or corrected in place (emails don't always carry the time). */
function InterviewWhen({ e, onSave }: { e: Event; onSave: (f: { scheduled_for?: string | null; interview_kind?: string | null }) => void }) {
  const [editing, setEditing] = useState(false);
  const local = (iso: string) => {
    const d = new Date(iso);
    return `${toDay(iso)}T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };
  const [when, setWhen] = useState(e.scheduled_for ? local(e.scheduled_for) : "");
  const [kind, setKind] = useState(e.interview_kind ?? "");
  if (!editing) {
    return (
      <span className="muted">
        {" "}· {[e.interview_kind && INTERVIEW_KINDS[e.interview_kind], e.scheduled_for ? `on ${fmt(e.scheduled_for, true)}` : null]
          .filter(Boolean).join(" ") || "time not set"}{" "}
        <button className="link" onClick={() => setEditing(true)}>{e.scheduled_for ? "change" : "set time"}</button>
      </span>
    );
  }
  return (
    <span className="row interview-when">
      <input type="datetime-local" value={when} onChange={(x) => setWhen(x.target.value)} aria-label="Interview date and time" />
      <select value={kind} onChange={(x) => setKind(x.target.value)} aria-label="Kind of interview">
        <option value="">Kind…</option>
        {Object.entries(INTERVIEW_KINDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
      </select>
      <button className="primary small" onClick={() => {
        onSave({ scheduled_for: when ? new Date(when).toISOString() : null, interview_kind: kind || null });
        setEditing(false);
      }}>Save</button>
      <button className="link" onClick={() => setEditing(false)}>Cancel</button>
    </span>
  );
}

/** Local YYYY-MM-DD for a date input. */
function toDay(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** An event's date: click to correct it (e.g. an import recorded the wrong day). */
function EventDate({ value, onSave }: { value: string; onSave: (iso: string) => void }) {
  const [editing, setEditing] = useState(false);
  if (!editing) {
    return <button className="link event-date" title="Click to correct the date" onClick={() => setEditing(true)}>{fmt(value, true)}</button>;
  }
  const d = new Date(value);
  const local = `${toDay(value)}T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return (
    <input type="datetime-local" autoFocus defaultValue={local}
           onBlur={(e) => { setEditing(false); if (e.target.value && e.target.value !== local) onSave(new Date(e.target.value).toISOString()); }}
           onKeyDown={(e) => { if (e.key === "Escape") setEditing(false); if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
  );
}
