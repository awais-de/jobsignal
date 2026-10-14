import { useCallback, useEffect, useState } from "react";
import { supabase } from "./supabase";
import UsageMeter from "./UsageMeter";

// Control panel: the app's own health (not the job search). Status of every service the app depends
// on, usage against the free limits, warnings (also in the digest), and upkeep buttons. The data comes
// from the `control` Edge Function, which also stores a snapshot (taken daily at 05:07 UTC).

type Warning = { level: "red" | "amber"; area: string; text: string };
type Snapshot = { created_at?: string; status: any; warnings: Warning[] };   // eslint-disable-line @typescript-eslint/no-explicit-any

const MB = 1024 * 1024;
const fmtBytes = (b: number) => (b >= 1024 * MB ? `${(b / 1024 / MB).toFixed(2)} GB` : `${(b / MB).toFixed(1)} MB`);
const ago = (iso: string | null | undefined) => {
  if (!iso) return "never";
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
};
const when = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "–";

export default function Control() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase.functions.invoke("control", { body: {} });
    setLoading(false);
    if (error || !data?.status) return setError("The status check didn't answer. Try again in a moment.");
    setError(null);
    setSnap({ ...data, created_at: new Date().toISOString() });
  }, []);

  // The latest snapshot shows at once; a fresh check follows when it's older than 10 minutes.
  useEffect(() => {
    supabase.from("control_snapshots").select("created_at,status,warnings").order("created_at", { ascending: false }).limit(1)
      .then(({ data }) => {
        const last = (data?.[0] ?? null) as Snapshot | null;
        if (last) setSnap(last);
        if (!last || Date.now() - new Date(last.created_at!).getTime() > 10 * 60000) refresh();
      });
  }, [refresh]);

  async function run(workflow: string, label: string) {
    const { error } = await supabase.functions.invoke("trigger-run", { body: workflow === "daily" ? {} : { workflow } });
    setNote(error ? `${label}: couldn't start.` : `${label}: started (see GitHub below in a minute).`);
  }
  async function purge() {
    if (!window.confirm("Delete compiled CV PDFs older than 14 days that were never saved to Drive?")) return;
    const { data, error } = await supabase.functions.invoke("control", { body: { action: "purge_cv" } });
    setNote(error ? "Clean-up failed." : `Deleted ${data?.deleted ?? 0} old PDF(s).`);
  }

  if (!snap) return <p className="empty">{error ?? "Checking every service…"}</p>;
  const s = snap.status;
  const w = snap.warnings ?? [];
  const overall = w.some((x) => x.level === "red") ? "red" : w.length ? "amber" : "green";
  const area = (name: string) => w.filter((x) => x.area === name);

  return (
    <div className="control">
      <div className="control-bar">
        <h2><span className={`dot dot-${overall}`} /> Control panel</h2>
        <span className="muted small">
          {overall === "green" ? "Everything is working." : `${w.length} warning${w.length === 1 ? "" : "s"}`} · checked {ago(snap.created_at)}
        </span>
        <button className="small" disabled={loading} onClick={refresh}>{loading ? "Checking…" : "Refresh"}</button>
      </div>
      {error && <p className="notice">{error}</p>}
      {note && <p className="notice">{note} <button className="link" onClick={() => setNote(null)}>×</button></p>}

      {w.length > 0 && (
        <section className="card warnings">
          <h3>Warnings <span className="muted small">(also at the top of the daily digest)</span></h3>
          <ul>
            {w.map((x, i) => <li key={i}><span className={`status status-${x.level === "red" ? "red" : "orange"}`}>{x.area}</span> {x.text}</li>)}
          </ul>
        </section>
      )}

      <div className="control-grid">
        <Card title="Pipeline" warn={area("Pipeline").concat(area("Sources"))}>
          <Kv k="Last run" v={s.db.runs?.[0] ? `${when(s.db.runs[0].started_at)} · ${s.db.runs[0].status}` : "none"} />
          <table className="apps mini"><thead><tr><th>Started</th><th>Status</th><th>Fetched</th><th>Passed</th><th>Emailed</th></tr></thead>
            <tbody>{(s.db.runs ?? []).slice(0, 5).map((r: any) => (   // eslint-disable-line @typescript-eslint/no-explicit-any
              <tr key={r.started_at}><td>{when(r.started_at)}</td><td>{r.status}</td><td>{r.fetched ?? "–"}</td>
                <td>{r.passed ?? "–"}{r.passed_explore ? ` (+${r.passed_explore} explore)` : ""}</td><td>{r.surfaced ?? "–"}</td></tr>
            ))}</tbody></table>
          <Kv k="Job sources (7 days)" v={`${(s.db.sources ?? []).length} active · ${(s.db.sources ?? []).filter((x: any) => x.failed).length} with failures`} />  {/* eslint-disable-line @typescript-eslint/no-explicit-any */}
          <Kv k="Company discovery" v={Object.entries(s.db.discovery ?? {}).map(([k, v]) => `${k.replace("_", " ")} ${v}`).join(" · ")} />
        </Card>

        <Card title="Scheduler (Supabase)" warn={area("Scheduler")}>
          {(s.db.cron_jobs ?? []).map((j: any) => <Kv key={j.name} k={j.name.replace("jobsignal-", "")} v={`${j.schedule} UTC ${j.active ? "" : "(paused)"}`} />)}  {/* eslint-disable-line @typescript-eslint/no-explicit-any */}
          <Kv k="Last starts" v={(s.db.cron ?? []).slice(0, 3).map((c: any) => `${c.jobname.replace("jobsignal-", "")} ${when(c.start_time)} ${c.status}`).join(" · ") || "none yet"} />  {/* eslint-disable-line @typescript-eslint/no-explicit-any */}
          <Kv k="Last call to GitHub" v={s.db.http?.[0] ? `HTTP ${s.db.http[0].status_code ?? "?"} · ${when(s.db.http[0].created)}` : "none in the last hours"} />
          <p className="muted small">GitHub's own schedules (05:17, 06:47, 08:17 UTC) stay as a late fallback; the first start of the day does the work.</p>
        </Card>

        <Card title="GitHub" warn={area("GitHub")}>
          <Kv k="Token" v={!s.github.configured ? "missing" : s.github.ok ? "works" : `refused (${s.github.error})`} />
          <Kv k="Token expires" v={s.github.token_expires ? `${when(s.github.token_expires)} (${Math.floor((new Date(s.github.token_expires).getTime() - Date.now()) / 86400000)} days)` : "no expiry date reported"} />
          <table className="apps mini"><thead><tr><th>Workflow</th><th>Last run</th><th>Result</th></tr></thead>
            <tbody>{(s.github.workflows ?? []).map((x: any) => (   // eslint-disable-line @typescript-eslint/no-explicit-any
              <tr key={x.name}><td><a href={x.url} target="_blank" rel="noreferrer">{x.name}</a></td><td>{when(x.created_at)}</td>
                <td>{x.conclusion ?? x.status}</td></tr>
            ))}</tbody></table>
          <p className="muted small">Public repository: Actions minutes are free and unlimited.</p>
        </Card>

        <Card title="Email bridge (Apps Script)" warn={area("Email bridge")}>
          <Kv k="Last email received" v={ago(s.db.inbox.last_at)} />
          <Kv k="Bridge version" v={`${s.db.inbox.bridge_version ?? "before versions"} (current: ${s.expected_bridge_version})`} />
          <Kv k="Review queue" v={`${s.db.inbox.unmatched} waiting`} />
          <Kv k="Today" v={Object.entries(s.db.inbox.today ?? {}).map(([k, v]) => `${String(k).replace(/_/g, " ")} ${v}`).join(" · ") || "no emails yet"} />
          <p className="muted small">Checks the job-search inbox every 15 minutes, saves CVs to Drive, adds interview events to the calendar.</p>
        </Card>

        <Card title="Supabase" warn={area("Supabase")}>
          <Bar label="Database" used={s.db.db_bytes} limit={s.limits.supabase_db_bytes} />
          <Bar label="File storage" used={(s.db.storage ?? []).reduce((n: number, b: any) => n + Number(b.bytes), 0)} limit={s.limits.supabase_storage_bytes} />  {/* eslint-disable-line @typescript-eslint/no-explicit-any */}
          <Kv k="Biggest tables" v={(s.db.tables ?? []).slice(0, 4).map((t: any) => `${t.name} ${fmtBytes(t.bytes)}`).join(" · ")} />  {/* eslint-disable-line @typescript-eslint/no-explicit-any */}
          <Kv k="Records" v={Object.entries(s.db.counts ?? {}).map(([k, v]) => `${k} ${Number(v).toLocaleString("en-GB")}`).join(" · ")} />
          <Kv k="Project status" v={s.project?.configured ? (s.project.status ?? s.project.error) : "add SUPABASE_ACCESS_TOKEN to show (optional)"} />
          <p className="muted small">Free projects pause after 7 days without activity; the daily run keeps this one active.</p>
        </Card>

        <Card title="Drive (CV saving)" warn={area("Drive")}>
          <Kv k="Set up" v={s.drive.configured ? "yes" : "no: deploy the Apps Script web app and set APPS_SCRIPT_URL"} />
          {s.drive.configured && <Kv k="Web app" v={s.drive.ok ? `answers (version ${s.drive.version})` : `no answer: ${s.drive.error}`} />}
          {s.drive.ok && <Kv k="Resumes folder" v={s.drive.folder ?? s.drive.folder_error ?? "–"} />}
          <Kv k="CV builds" v={Object.entries(s.db.cv_builds ?? {}).map(([k, v]) => `${k} ${v}`).join(" · ") || "none yet"} />
          <Kv k="Last CV saved" v={ago(s.db.cv_last_saved)} />
        </Card>

        <Card title="Digest and web app" warn={[]}>
          <Kv k="Last digest" v={s.db.runs?.[0]?.status === "success" ? `sent ${when(s.db.runs[0].finished_at)} (${s.db.runs[0].surfaced ?? 0} jobs)` : "last run didn't finish"} />
          {/* The build can't see its commit on Cloudflare, so build time is compared with the latest commit's time. */}
          <Kv k="Web app" v={`built ${when(__BUILD_TIME__)}` + (s.github.latest_commit_at
            ? (new Date(__BUILD_TIME__).getTime() + 5 * 60000 >= new Date(s.github.latest_commit_at).getTime()
                ? " (latest)" : ` (a newer change from ${when(s.github.latest_commit_at)} is deploying: reload in a minute)`) : "")} />
          <Kv k="Healthchecks.io" v={s.healthchecks?.configured
            ? (s.healthchecks.checks ?? []).map((c: any) => `${c.name}: ${c.status}`).join(" · ") || s.healthchecks.error  // eslint-disable-line @typescript-eslint/no-explicit-any
            : "add HEALTHCHECKS_API_KEY to show (optional)"} />
          <Kv k="Profile" v={`version ${s.db.profile_version}`} />
        </Card>

        <Card title="Configuration" warn={[]}>
          <table className="apps mini"><tbody>
            {Object.entries(s.config ?? {}).map(([k, v]) => (
              <tr key={k}><td><code>{k}</code></td><td>{v ? "✓ set" : /HEALTHCHECKS|ACCESS_TOKEN/.test(k) ? "optional, not set" : "✗ missing"}</td></tr>
            ))}
          </tbody></table>
          <p className="muted small">Only whether each secret exists is shown, never its value. Groq and Gmail keys live in GitHub's secrets; failures there show up as failed runs.</p>
        </Card>
      </div>

      <UsageMeter />

      <section className="card">
        <h3>Free limits</h3>
        <table className="apps mini">
          <thead><tr><th>Service</th><th>Free limit</th><th>Used</th></tr></thead>
          <tbody>
            <tr><td>Supabase database</td><td>500 MB</td><td>{fmtBytes(s.db.db_bytes)}</td></tr>
            <tr><td>Supabase file storage</td><td>1 GB</td><td>{fmtBytes((s.db.storage ?? []).reduce((n: number, b: any) => n + Number(b.bytes), 0))}</td></tr>  {/* eslint-disable-line @typescript-eslint/no-explicit-any */}
            <tr><td>Supabase function calls</td><td>500,000 / month</td><td className="muted">a few hundred a day</td></tr>
            <tr><td>GitHub Actions</td><td>unlimited (public repo)</td><td className="muted">–</td></tr>
            <tr><td>Groq (gpt-oss-120b)</td><td>1,000 requests / day, 8,000 tokens / min</td><td className="muted">see AI usage above</td></tr>
            <tr><td>Apps Script</td><td>~20,000 web calls / day, ~90 min of triggers / day</td><td className="muted">~100 short runs / day</td></tr>
            <tr><td>Gmail sending</td><td>~500 / day</td><td className="muted">1–3 / day</td></tr>
            <tr><td>Cloudflare Workers</td><td>100,000 requests / day</td><td className="muted">a few hundred / day</td></tr>
          </tbody>
        </table>
        <p className="muted small">Limits as published by each provider (checked October 2026); they can change.</p>
      </section>

      <section className="card">
        <h3>Upkeep</h3>
        <div className="row">
          <button className="small" onClick={() => run("daily", "Daily run")}>Run now</button>
          <button className="small" onClick={() => run("rerank", "Re-rank")}>Re-rank jobs</button>
          <button className="small" onClick={() => run("backlog", "AI backlog")}>Process AI backlog</button>
          <button className="small" onClick={() => run("smtp", "Test email")}>Send a test email</button>
          <button className="small" onClick={purge}>Delete old unsaved CV PDFs</button>
        </div>
      </section>

      <section className="card">
        <h3>Optional extras</h3>
        <p className="muted small">Each switches on a line above once its key is set (read-only keys). In the jobsignal folder:</p>
        <ul className="small">
          <li><strong>Healthchecks status</strong>: healthchecks.io → project → Settings → API keys → create a <em>read-only</em> key, then
            <pre>read -s "K?Healthchecks read-only key: " && supabase secrets set HEALTHCHECKS_API_KEY="$K"; unset K</pre></li>
          <li><strong>Supabase project status</strong>: supabase.com → Account → Access tokens → generate, then
            <pre>read -s "K?Supabase access token: " && supabase secrets set SUPABASE_ACCESS_TOKEN="$K"; unset K</pre></li>
        </ul>
      </section>
    </div>
  );
}

function Card({ title, warn, children }: { title: string; warn: Warning[]; children: React.ReactNode }) {
  const level = warn.some((x) => x.level === "red") ? "red" : warn.length ? "amber" : "green";
  return (
    <section className="card control-card">
      <h3><span className={`dot dot-${level}`} /> {title}</h3>
      {children}
    </section>
  );
}

const Kv = ({ k, v }: { k: string; v: React.ReactNode }) => (
  <div className="kv"><span className="muted">{k}</span><span>{v}</span></div>
);

function Bar({ label, used, limit }: { label: string; used: number; limit: number }) {
  const pct = Math.min(100, (100 * used) / limit);
  return (
    <div className="kv-bar">
      <div className="kv"><span className="muted">{label}</span><span>{fmtBytes(used)} of {fmtBytes(limit)} ({pct.toFixed(pct < 10 ? 1 : 0)}%)</span></div>
      <div className="meter"><div className={`meter-fill${pct > 70 ? " high" : ""}`} style={{ width: `${pct}%` }} /></div>
    </div>
  );
}
