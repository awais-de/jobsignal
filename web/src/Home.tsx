import { useEffect, useState } from "react";
import Control from "./Control";
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
      <div id="control" className="home-control">
        <Control />
      </div>
    </div>
  );
}
