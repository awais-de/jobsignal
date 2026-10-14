// Control panel warnings (owner request 2026-10-14): one place for the rules, used by the panel and,
// through the 05:07 snapshot, by the daily digest. Pure: takes the gathered status, returns warnings.

export type Level = "red" | "amber";
export type Warning = { level: Level; area: string; text: string };

/** Free-plan limits the app depends on. VERIFY: from the providers' pricing pages as of 2026-10. */
export const FREE_LIMITS = {
  supabase_db_bytes: 500 * 1024 * 1024,
  supabase_storage_bytes: 1024 * 1024 * 1024,
};

/** Bump together with BRIDGE_VERSION in apps-script/Code.gs. */
export const EXPECTED_BRIDGE_VERSION = "2026-10-14";

export type Status = {
  db: {
    checked_at: string; db_bytes: number;
    storage: { bucket: string; files: number; bytes: number }[];
    cron: { jobname: string; status: string; start_time: string; message: string | null }[];
    http: { status_code: number | null; created: string; error: string }[];
    runs: { started_at: string; finished_at: string | null; status: string; error: string }[];
    sources: { source: string; failed: number; runs: number; last_ok: string | null; last3: string[] }[];
    inbox: { last_at: string | null; total: number; unmatched: number; bridge_version: string | null };
    backlog: { core: number; explore: number };
  };
  github: { configured: boolean; ok: boolean; error?: string; token_expires?: string | null;
            workflows: { name: string; status: string; conclusion: string | null; created_at: string; url: string }[];
            failures_24h: { name: string; created_at: string; url: string }[] };
  drive: { configured: boolean; ok?: boolean; error?: string | null; version?: string; folder?: string | null; folder_error?: string | null };
  llm: { rate_limited_days: number };
  healthchecks?: { configured: boolean; checks?: { name: string; status: string; last_ping: string | null }[]; error?: string };
  project?: { configured: boolean; status?: string; error?: string };
};

const hoursSince = (iso: string | null | undefined, now: Date) => (iso ? (now.getTime() - new Date(iso).getTime()) / 3600_000 : Infinity);
const utcDay = (d: Date) => d.toISOString().slice(0, 10);

export function warnings(s: Status, now = new Date()): Warning[] {
  const w: Warning[] = [];
  const add = (level: Level, area: string, text: string) => w.push({ level, area, text });
  const today = utcDay(now);
  const minutesUtc = now.getUTCHours() * 60 + now.getUTCMinutes();

  // Pipeline: today's run (after 07:30 UTC there should be one), and the last run's result.
  const runs = s.db.runs ?? [];
  if (minutesUtc > 7 * 60 + 30 && !runs.some((r) => r.status === "success" && r.started_at.slice(0, 10) === today)) {
    add("red", "Pipeline", "No successful daily run today.");
  }
  if (runs[0]?.status === "failed") add("red", "Pipeline", `The last run failed: ${runs[0].error || "no error message"}.`);
  for (const src of s.db.sources ?? []) {
    if (src.last3?.length === 3 && src.last3.every((x) => x === "failed")) {
      add("amber", "Sources", `${src.source.replace(/^careers:/, "Company site: ")} failed its last 3 runs.`);
    }
  }

  // Supabase scheduler: did the 05:17 start happen today, and did GitHub accept it?
  const daily = (s.db.cron ?? []).filter((c) => c.jobname === "jobsignal-daily" && c.start_time.slice(0, 10) === today);
  if (minutesUtc > 5 * 60 + 30 && !daily.length) add("amber", "Scheduler", "Supabase's scheduler didn't start today's run (GitHub's fallback may start it late).");
  if (daily[0] && daily[0].status !== "succeeded") add("amber", "Scheduler", `Today's scheduled start failed: ${daily[0].message ?? daily[0].status}.`);
  const http = (s.db.http ?? [])[0];
  if (http && http.status_code !== null && http.status_code >= 300 && hoursSince(http.created, now) < 24) {
    add("amber", "Scheduler", `The last scheduled call got HTTP ${http.status_code}.`);
  }

  // GitHub: the token behind Run now and the scheduler, and failed workflows.
  if (!s.github.configured) add("red", "GitHub", "No GitHub token: Run now and the on-time daily start can't work.");
  else if (!s.github.ok) add("red", "GitHub", `GitHub refused the token (${s.github.error ?? "error"}): it may have expired.`);
  if (s.github.token_expires) {
    const days = (new Date(s.github.token_expires).getTime() - now.getTime()) / 86400_000;
    if (days < 3) add("red", "GitHub", `The GitHub token expires in ${Math.max(0, Math.floor(days))} day(s): create a new one.`);
    else if (days < 14) add("amber", "GitHub", `The GitHub token expires in ${Math.floor(days)} days.`);
  }
  // Only a workflow whose most recent run failed: a failure already followed by a success is history.
  const latest = new Map((s.github.workflows ?? []).map((x) => [x.name, x.conclusion]));
  for (const name of new Set((s.github.failures_24h ?? []).map((f) => f.name))) {
    if (name === "daily-pipeline" || latest.get(name) !== "failure") continue;
    const f = (s.github.failures_24h ?? []).find((x) => x.name === name)!;
    add("amber", "GitHub", `Workflow "${name}" failed on its last run (${f.created_at.slice(11, 16)} UTC).`);
  }

  // Email bridge: silent, outdated, or emails waiting.
  const inbox = s.db.inbox;
  if (inbox.total > 0 && hoursSince(inbox.last_at, now) > 24) {
    add("amber", "Email bridge", `No email received for ${Math.floor(hoursSince(inbox.last_at, now))} hours: is the Apps Script bridge running?`);
  }
  if (inbox.total > 0 && (inbox.bridge_version ?? "") < EXPECTED_BRIDGE_VERSION && hoursSince(inbox.last_at, now) < 72) {
    add("amber", "Email bridge", `The Apps Script bridge runs an older version (${inbox.bridge_version ?? "before versions"}): paste the new apps-script/Code.gs.`);
  }
  if (inbox.unmatched > 0) add("amber", "Email bridge", `${inbox.unmatched} email(s) wait in the review queue (Applications).`);

  // AI.
  if (s.llm.rate_limited_days >= 2) add("amber", "AI", `Groq rate limits were hit on ${s.llm.rate_limited_days} of the last 7 days.`);
  if (s.db.backlog.core > 20) add("amber", "AI", `${s.db.backlog.core} core jobs wait for analysis.`);
  if (s.db.backlog.explore > 60) add("amber", "AI", `${s.db.backlog.explore} explore jobs wait for analysis.`);

  // Supabase free limits.
  const dbPct = s.db.db_bytes / FREE_LIMITS.supabase_db_bytes;
  if (dbPct > 0.9) add("red", "Supabase", `Database at ${Math.round(dbPct * 100)}% of the free 500 MB.`);
  else if (dbPct > 0.7) add("amber", "Supabase", `Database at ${Math.round(dbPct * 100)}% of the free 500 MB.`);
  const stPct = (s.db.storage ?? []).reduce((n, b) => n + Number(b.bytes), 0) / FREE_LIMITS.supabase_storage_bytes;
  if (stPct > 0.7) add(stPct > 0.9 ? "red" : "amber", "Supabase", `File storage at ${Math.round(stPct * 100)}% of the free 1 GB.`);
  if (s.project?.configured && s.project.status && s.project.status !== "ACTIVE_HEALTHY") {
    add("red", "Supabase", `The Supabase project reports "${s.project.status}".`);
  }

  // Drive (CV saving).
  if (!s.drive.configured) add("amber", "Drive", "Saving CVs to Drive isn't set up (Apps Script web app URL).");
  else if (!s.drive.ok) add("red", "Drive", `The Apps Script web app didn't answer: ${s.drive.error ?? "error"}.`);
  else if (s.drive.folder_error) add("red", "Drive", `The Resumes folder wasn't found: ${s.drive.folder_error}`);

  // Healthchecks (optional).
  for (const c of s.healthchecks?.checks ?? []) {
    if (c.status === "down") add("red", "Healthchecks", `Healthchecks reports "${c.name}" as down.`);
  }
  return w.sort((a, b) => (a.level === b.level ? 0 : a.level === "red" ? -1 : 1));
}
