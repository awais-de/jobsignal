import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
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
};

type App = {
  id: string;
  applied_at: string | null;
  created_at: string;
  notes: string | null;
  jd_snapshot: string | null;
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

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from("applications")
      .select("id,applied_at,created_at,notes,jd_snapshot,job_postings(title,company_name,city,source,apply_url,source_url)")
      .is("deleted_at", null)
      .order("created_at", { ascending: false });
    if (error) return setError(error.message);
    const list = data as unknown as App[];
    setApps(list);
    if (list.length) {
      const ev = await supabase
        .from("application_events")
        .select("id,application_id,event_type,occurred_at,source,notes")
        .in("application_id", list.map((a) => a.id))
        .order("occurred_at", { ascending: false })
        .order("created_at", { ascending: false });
      if (ev.error) setError(ev.error.message);
      else setEvents(ev.data as Event[]);
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

  async function addEvent(app: App, type: string) {
    let notes: string | null = null;
    if (type === "note") {
      notes = window.prompt("Note");
      if (!notes) return;
    }
    const { data, error } = await supabase.from("application_events")
      .insert({ application_id: app.id, event_type: type, source: "user", notes })
      .select("id,application_id,event_type,occurred_at,source,notes").single();
    if (error) return setError(error.message);
    setEvents((es) => [data as Event, ...es]);
    if (type === "applied" && !app.applied_at) {
      const now = (data as Event).occurred_at;
      await supabase.from("applications").update({ applied_at: now }).eq("id", app.id);
      setApps((as) => as && as.map((a) => (a.id === app.id ? { ...a, applied_at: now } : a)));
    }
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
              <th>Status</th>
              <th>Applied</th>
              <th>Last update</th>
              <th>Source</th>
              <th>Add event</th>
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
                    <td>
                      <span className={`status status-${tone(st?.event_type ?? "drafted")}`}>
                        {EVENT_LABELS[st?.event_type ?? "drafted"]}
                      </span>
                    </td>
                    <td className="muted">{a.applied_at ? fmt(a.applied_at) : "–"}</td>
                    <td className="muted">{last ? ago(last.occurred_at) : "–"}</td>
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
                  </tr>
                  {isOpen && (
                    <tr className="detail">
                      <td colSpan={7}>
                        <Detail app={a} events={byApp.get(a.id) ?? []} onNotes={(n) => saveNotes(a, n)} />
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
    </>
  );
}

function Detail({ app, events, onNotes }: { app: App; events: Event[]; onNotes: (n: string) => void }) {
  const [showJd, setShowJd] = useState(false);
  return (
    <div className="detail-body">
      <div>
        <h3>Timeline</h3>
        <ol className="timeline">
          {events.map((e) => (
            <li key={e.id}>
              <span className="muted">{fmt(e.occurred_at, true)}</span>{" "}
              <strong>{EVENT_LABELS[e.event_type] ?? e.event_type}</strong>
              {e.source !== "user" && <span className="badge">{e.source}</span>}
              {e.notes && <div className="muted">{e.notes}</div>}
            </li>
          ))}
        </ol>
      </div>
      <div>
        <h3>Notes</h3>
        <textarea defaultValue={app.notes ?? ""} rows={3} placeholder="Contact, salary discussed, next step…"
                  onBlur={(e) => onNotes(e.target.value)} />
        {app.jd_snapshot && (
          <>
            <button className="link" onClick={() => setShowJd((s) => !s)}>
              {showJd ? "Hide" : "Show"} job description (saved when you applied)
            </button>
            {showJd && <div className="jd">{app.jd_snapshot}</div>}
          </>
        )}
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
