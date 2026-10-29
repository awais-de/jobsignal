import { useEffect, useState } from "react";
import Control from "./Control";
import SkillsMarket from "./SkillsMarket";
import { supabase } from "./supabase";

// Home (opened from the brand): an overview first, the control panel below it.
// The dashboard is a starter set of counts, each linking to where to act; its final content is open.

const CLOSED = ["rejected", "withdrawn", "offer_declined", "offer_accepted", "no_response"];

type Counts = { newJobs: number; active: number; interviews: number; followUps: number };

const localDay = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

async function loadCounts(): Promise<Counts> {
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  const [jobs, apps, statuses, interviews, follow] = await Promise.all([
    supabase.from("job_postings").select("id", { count: "exact", head: true })
      .eq("filter_status", "passed").eq("triage_status", "new").is("deleted_at", null)
      .or("lane.is.null,lane.eq.core").gte("first_seen_at", midnight.toISOString()),
    supabase.from("applications").select("id").is("deleted_at", null),
    supabase.from("application_status").select("application_id,status"),
    supabase.from("application_events").select("application_id")
      .eq("event_type", "interview_scheduled").gte("scheduled_for", new Date().toISOString()),
    supabase.from("outreach").select("id", { count: "exact", head: true }).is("deleted_at", null)
      .eq("status", "sent").is("followed_up_at", null).lte("follow_up_due", localDay()),
  ]);
  const err = [jobs, apps, statuses, interviews, follow].find((r) => r.error)?.error;
  if (err) throw new Error(err.message);
  const live = new Set(((apps.data ?? []) as { id: string }[]).map((a) => a.id));
  const statusOf = new Map(((statuses.data ?? []) as { application_id: string; status: string }[]).map((s) => [s.application_id, s.status]));
  return {
    newJobs: jobs.count ?? 0,
    active: [...live].filter((id) => !CLOSED.includes(statusOf.get(id) ?? "drafted")).length,
    interviews: new Set(((interviews.data ?? []) as { application_id: string }[])
      .map((e) => e.application_id).filter((id) => live.has(id))).size,
    followUps: follow.count ?? 0,
  };
}

type Tta = {
  applications: number;
  median_hours: { published_to_seen: number | null; seen_to_applied: number | null; total: number | null };
  last_applied_at: string | null;
  backlog: { count: number; median_age_hours: number | null };
  fast_today: { runs: number; last: string | null; queued: number };
};
const dur = (h: number | null | undefined) =>
  h == null ? "–" : h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : h < 48 ? `${Math.round(h)} h` : `${(h / 24).toFixed(1)} days`;

/** The app's goal (owner, 2026-10-21): the time from a job being posted to the application. */
function TimeToApply() {
  const [t, setT] = useState<Tta | null>(null);
  useEffect(() => { supabase.rpc("time_to_apply", { p_days: 60 }).then(({ data }) => data && setT(data as Tta)); }, []);
  if (!t) return null;
  const m = t.median_hours;
  const steps: [string, number | null, string][] = [
    ["Posted → on the portal", m.published_to_seen, "the system: how long a new job takes to reach jobsignal"],
    ["On the portal → applied", m.seen_to_applied, "you"],
  ];
  return (
    <section className="card tta">
      <h3>Time to apply <span className="muted small">· median over your last {t.applications} application{t.applications === 1 ? "" : "s"} (60 days)</span></h3>
      <div className="tta-row">
        {steps.map(([label, h, hint], i) => (
          <div key={label} className="tta-step" title={hint}>
            <span className="muted small">{label}</span>
            <strong>{dur(h)}</strong>
            {i < steps.length - 1 && <span className="tta-arrow" aria-hidden>→</span>}
          </div>
        ))}
        <div className="tta-step total"><span className="muted small">Posted → applied</span><strong>{dur(m.total)}</strong></div>
      </div>
      <p className="small">
        <span className={t.backlog.count > 20 ? "warn-text" : ""}>{t.backlog.count} matching job{t.backlog.count === 1 ? "" : "s"} waiting for you</span>
        {t.backlog.median_age_hours != null && <span className="muted"> (typically {dur(t.backlog.median_age_hours)} old)</span>}
        {" · "}<span className="muted">fast lane today: {t.fast_today.runs} check{t.fast_today.runs === 1 ? "" : "s"}, {t.fast_today.queued} new match{t.fast_today.queued === 1 ? "" : "es"} on the portal
        {t.fast_today.last ? `, last ${new Date(t.fast_today.last).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}` : ""}</span>
        {t.last_applied_at && <span className="muted"> · last application {new Date(t.last_applied_at).toLocaleDateString("en-GB", { day: "2-digit", month: "short" })}</span>}
      </p>
    </section>
  );
}

export default function Home() {
  const [c, setC] = useState<Counts | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadCounts().then(setC, (e) => setError(e instanceof Error ? e.message : "Couldn't load the overview."));
    // Old #control links: jump to the control panel.
    if (window.location.hash === "#control") document.getElementById("control")?.scrollIntoView();
  }, []);

  const tiles: { label: string; value: number | undefined; href: string; hint: string }[] = [
    { label: "New jobs today", value: c?.newJobs, href: "#feed", hint: "Not triaged yet" },
    { label: "Active applications", value: c?.active, href: "#applications", hint: "Not closed" },
    { label: "Upcoming interviews", value: c?.interviews, href: "#applications", hint: "Scheduled from now on" },
    { label: "Follow-ups due", value: c?.followUps, href: "#responses", hint: "Pings waiting for a nudge" },
  ];

  return (
    <div className="home">
      <h2>Overview</h2>
      <TimeToApply />
      {error && <p className="notice">{error}</p>}
      <div className="dash-tiles">
        {tiles.map((t) => (
          <a key={t.label} className="card dash-tile" href={t.href}>
            <span className="dash-value">{t.value ?? "–"}</span>
            <span className="dash-label">{t.label}</span>
            <span className="muted small">{t.hint}</span>
          </a>
        ))}
      </div>
      <SkillsMarket />
      <div id="control" className="home-control">
        <Control />
      </div>
    </div>
  );
}
