import { useCallback, useEffect, useState } from "react";
import { supabase } from "./supabase";

// Company discovery (Feed → Companies; owner request 2026-10-21): how the daily run looks for employers'
// own career sites, live while it runs. Discovery probes about 50 companies per run (sources.yaml
// discovery.companies_per_run) within 5 minutes, after the jobs are saved; alert employers go first.

const PER_RUN = 50;
type Checked = { id: string; name: string; status: string; ats: string | null; notes: string | null; prioritised: boolean; checked_at: string };
type Found = {
  id: string; name: string; ats: string | null; careers_url: string | null; watch: boolean; notes: string | null; manually_edited: boolean;
  found_at: string | null; last_run_at: string | null; last_status: string | null; last_fetched: number | null; last_error: string | null;
  jobs: number; passed: number;
};
type Overview = {
  run: { started_at: string; finished_at: string | null; status: string } | null;
  counts: Record<string, number>; watched: number; queue_prioritised: number; retry_due: number; queue_relevant: number;
  tiers: Record<string, number>; tier_status: Record<string, Record<string, number>>; focus: Focus[];
  checked: Checked[]; history: { day: string; checked: number; found: number }[];
  queue: { id: string; name: string; prioritised: boolean; relevant: boolean; discovered_from: string | null }[];
  alert_not_found: { id: string; name: string; checked_at: string | null }[];
  found: Found[];
};
type Company = { id: string; name: string; discovery_status: string; ats: string | null; careers_url: string | null; watch: boolean; is_agency: boolean; priority: number; tier: string | null };
type Focus = {
  id: string; name: string; score: number; status: string; ats: string | null; careers_url: string | null; watch: boolean; manually_edited: boolean;
  relevance: { applied: number; passed_core: number; core_jobs: number; explore_jobs: number; alert_jobs: number; contacts: number; jobs: number; last_relevant: string | null } | null;
};
const TIER_TEXT: Record<string, string> = {
  A: "Focus: applied there, a job passed your filters, or 2+ jobs in your core directions. Career site read daily.",
  B: "Worth watching: one core-direction job, Explore-direction jobs, or a contact there. Read weekly.",
  C: "Not relevant: never posted in your directions. Never checked; moves up by itself if it does.",
  agency: "Staffing firms: never checked or watched.",
};

const ATS_LABEL: Record<string, string> = {
  personio: "Personio", greenhouse: "Greenhouse", lever: "Lever", recruitee: "Recruitee", ashby: "Ashby", smartrecruiters: "SmartRecruiters",
  workable: "Workable", join: "JOIN", softgarden: "softgarden", jsonld: "career page", sitemap: "career page (sitemap)",
};
const atsLabel = (a: string | null) => (a ? ATS_LABEL[a] ?? a : "–");
const time = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
const day = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short" });

export default function Companies() {
  const [o, setO] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await supabase.rpc("discovery_overview");
    if (error) return setError(error.message);
    setO(data as Overview);
  }, []);
  useEffect(() => { load(); }, [load]);
  // Live while the daily run is going (discovery is its last few minutes).
  const running = o?.run?.status === "running";
  useEffect(() => {
    if (!running) return;
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, [running, load]);

  async function act(id: string, action: string, value?: Record<string, string>, done?: string) {
    const { error } = await supabase.rpc("company_action", { p_id: id, p_action: action, p_value: value ?? null });
    if (error) return setError(error.message);
    setFlash(done ?? "Done");
    setTimeout(() => setFlash(null), 3000);
    load();
  }

  if (!o) return <p className="empty">{error ?? "Loading…"}</p>;
  const c = o.counts ?? {};
  const pending = o.queue_relevant ?? 0;
  const week = o.history.filter((h) => new Date(h.day) > new Date(Date.now() - 7 * 86400000));
  const checked7 = week.reduce((n, h) => n + h.checked, 0), found7 = week.reduce((n, h) => n + h.found, 0);
  const lastFound = o.checked.filter((x) => x.status === "found").length;

  return (
    <div className="companies">
      {error && <p className="notice">{error} <button className="link" onClick={() => setError(null)}>×</button></p>}
      <section className="card">
        <div className="control-bar">
          <h2>{running ? <span className="dot dot-amber pulse" /> : <span className="dot dot-green" />} Company discovery</h2>
          <span className="muted small">
            {running ? `Today's run is going (since ${time(o.run!.started_at)}): discovery is its last few minutes, this page updates itself.`
              : o.run ? `Last run ${day(o.run.started_at)} ${time(o.run.started_at)}; discovery runs at its end. Next run: tomorrow morning.` : ""}
          </span>
          <button className="small" onClick={load}>Refresh</button>
        </div>
        <p className="muted small">
          Each daily run checks about {PER_RUN} employers seen in job ads for a career site it can read (Personio, Greenhouse, a page with job
          listings…). Found ones are watched: their jobs come straight from the employer, with descriptions. Employers of StepStone jobs without a
          description are checked first.
        </p>
        <div className="dash-tiles">
          <Tile v={o.watched} label="Career sites watched" hint={`${c.found ?? 0} found in total`} />
          <Tile v={pending} label="Relevant, still to check" hint={`groups A and B · ${(o.tiers?.C ?? 0).toLocaleString("en-GB")} not relevant, never checked`} />
          <Tile v={c.not_found ?? 0} label="No readable site" hint={`${o.retry_due} due for a retry`} />
          <Tile v={checked7 ? Math.round((100 * found7) / checked7) : 0} label="Hit rate, 7 days (%)" hint={`${found7} of ${checked7} checked`} />
        </div>
      </section>

      <section className="card">
        <h3>{running ? "Checking now" : "Last run"} <span className="muted small">· {o.checked.length} checked, {lastFound} found</span></h3>
        {o.checked.length === 0 ? <p className="muted small">{running ? "Discovery starts after the jobs are saved." : "Nothing checked in the last run."}</p> : (
          <ul className="disc-list">
            {o.checked.map((x) => (
              <li key={x.id}>
                <span className="muted small">{time(x.checked_at)}</span>
                <span className="disc-name">{x.name}</span>
                {x.prioritised && <span className="badge" title="Employer of a StepStone job without a description">alert</span>}
                {x.status === "found"
                  ? <span className="status status-green">found · {atsLabel(x.ats)}</span>
                  : <span className="status status-grey">{x.status === "not_found" ? "no readable site" : x.status}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <h3>Relevance groups <span className="muted small">· every company sorted by what it posted in Germany, re-sorted daily</span></h3>
        <div className="tier-grid">
          {(["A", "B", "C", "agency"] as const).map((t) => {
            const st = o.tier_status?.[t] ?? {};
            return (
              <div key={t} className={`tier-box tier-${t}`}>
                <div><strong>{t === "agency" ? "Agencies" : `Group ${t}`}</strong> <span className="dash-value-sm">{(o.tiers?.[t] ?? 0).toLocaleString("en-GB")}</span></div>
                <p className="muted small">{TIER_TEXT[t]}</p>
                {t !== "agency" && <p className="small">{st.found ?? 0} with a readable site · {st.not_found ?? 0} none · {st.pending ?? 0} unchecked</p>}
              </div>
            );
          })}
        </div>
      </section>

      <FocusList focus={o.focus ?? []} act={act} />

      <section className="card">
        <h3>StepStone employers without a readable site <span className="muted small">· {o.alert_not_found.length}</span></h3>
        <p className="muted small">If you know one's careers page, add it: its jobs then come with descriptions and replace the StepStone cards.</p>
        <ul className="disc-list">
          {o.alert_not_found.map((x) => <li key={x.id}><span className="disc-name">{x.name}</span><AddCareers onAdd={(url, pattern) => act(x.id, "careers", { url, pattern }, `${x.name}: career page added, read from the next run`)} /></li>)}
        </ul>
      </section>

      <div className="companies-grid">
        <section className="card">
          <h3>Next in line <span className="muted small">· {pending} waiting</span></h3>
          <ol className="disc-list numbered">
            {o.queue.map((q) => (
              <li key={q.id}>
                <span className="disc-name">{q.name}</span>
                {q.prioritised ? <span className="badge">first</span>
                  : <button className="link small" onClick={() => act(q.id, "prioritise", undefined, `${q.name} moves to the front`)}>move to front</button>}
              </li>
            ))}
          </ol>
        </section>
        <section className="card">
          <HistoryChart history={o.history} />
        </section>
      </div>

      <section className="card">
        <h3>Watched career sites <span className="muted small">· jobs in the last 30 days</span></h3>
        <div className="table-wrap">
          <table className="apps">
            <thead><tr><th>Company</th><th>System</th><th>Jobs</th><th>Passed</th><th>Last check</th><th></th></tr></thead>
            <tbody>
              {o.found.map((f) => (
                <tr key={f.id} className={f.watch ? "" : "off"}>
                  <td className="strong">{f.careers_url ? <a href={f.careers_url} target="_blank" rel="noreferrer">{f.name}</a> : f.name}
                    {f.manually_edited && <span className="badge">by hand</span>}</td>
                  <td className="muted">{atsLabel(f.ats)}</td>
                  <td>{f.jobs}</td>
                  <td>{f.passed}</td>
                  <td className="muted small">{f.last_run_at ? `${day(f.last_run_at)} · ${f.last_status === "failed" ? `failed (${f.last_error ?? "error"})` : `${f.last_fetched ?? 0} listed`}` : "not yet"}</td>
                  <td>{f.watch
                    ? <button className="link small" onClick={() => act(f.id, "unwatch", undefined, `${f.name} no longer watched`)}>stop watching</button>
                    : <button className="link small" onClick={() => act(f.id, "watch", undefined, `${f.name} watched again`)}>watch</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <Search act={act} />
      {flash && <div className="toast">{flash}</div>}
    </div>
  );
}

function Tile({ v, label, hint }: { v: number; label: string; hint: string }) {
  return <div className="card dash-tile"><span className="dash-value">{v}</span><span className="dash-label">{label}</span><span className="muted small">{hint}</span></div>;
}

function AddCareers({ onAdd }: { onAdd: (url: string, pattern: string) => void }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [pattern, setPattern] = useState("");
  if (!open) return <button className="link small" onClick={() => setOpen(true)}>add careers page</button>;
  return (
    <form className="row add-careers" onSubmit={(e) => { e.preventDefault(); if (/^https?:\/\//.test(url.trim())) { onAdd(url.trim(), pattern.trim()); setOpen(false); } }}>
      <input type="url" value={url} placeholder="https://beispiel.de/karriere" onChange={(e) => setUrl(e.target.value)} aria-label="Careers page" />
      <input value={pattern} placeholder="job link pattern (optional)" title="A part of the job links' address, e.g. /stellenangebote/ (regular expression)" onChange={(e) => setPattern(e.target.value)} />
      <button className="small primary" disabled={!/^https?:\/\//.test(url.trim())}>Add</button>
      <button type="button" className="link small" onClick={() => setOpen(false)}>Cancel</button>
    </form>
  );
}

/** Any company by name, with what can be done to it. */
function Search({ act }: { act: (id: string, action: string, value?: Record<string, string>, done?: string) => void }) {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<Company[]>([]);
  useEffect(() => {
    if (q.trim().length < 2) { setRows([]); return; }
    const t = setTimeout(async () => {
      const { data } = await supabase.from("companies").select("id,name,discovery_status,ats,careers_url,watch,is_agency,priority,tier")
        .is("deleted_at", null).ilike("name", `%${q.trim()}%`).order("relevance_score", { ascending: false }).limit(20);
      setRows((data ?? []) as Company[]);
    }, 250);
    return () => clearTimeout(t);
  }, [q]);
  const label = (r: Company) => r.is_agency ? "agency (not checked)" : r.discovery_status === "found" ? `found · ${atsLabel(r.ats)}${r.watch ? "" : " · not watched"}`
    : r.discovery_status === "not_found" ? "no readable site" : r.discovery_status === "pending" ? (r.priority > 0 ? "waiting · first in line" : "waiting") : r.discovery_status;
  return (
    <section className="card">
      <h3>Find a company</h3>
      <input className="wide-input" value={q} placeholder="Company name" onChange={(e) => setQ(e.target.value)} aria-label="Find a company" />
      <ul className="disc-list">
        {rows.map((r) => (
          <li key={r.id}>
            <span className="disc-name">{r.name}</span>
            {r.tier && r.tier !== "agency" && <span className={`badge tier-badge tier-${r.tier}`}>{r.tier}</span>}
            <span className="muted small">{label(r)}</span>
            <span className="mcv-tools">
              {r.discovery_status === "pending" && r.priority === 0 && !r.is_agency && <button className="link small" onClick={() => act(r.id, "prioritise", undefined, `${r.name} moves to the front`)}>move to front</button>}
              {(r.discovery_status === "not_found" || r.discovery_status === "skipped") && !r.is_agency && <button className="link small" onClick={() => act(r.id, "retry", undefined, `${r.name} is checked again next run`)}>check again</button>}
              {!r.is_agency && <button className="link small" onClick={() => act(r.id, "agency", undefined, `${r.name} marked as an agency`)}>it's an agency</button>}
              {r.discovery_status !== "found" && <AddCareers onAdd={(url, pattern) => act(r.id, "careers", { url, pattern }, `${r.name}: career page added`)} />}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Companies checked per day (bar height), split into found and no readable site: one stacked bar per day. */
function HistoryChart({ history }: { history: { day: string; checked: number; found: number }[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);
  // Every one of the last 14 days gets a slot, oldest left; a day without checks is an empty slot.
  const byDay = new Map(history.map((h) => [h.day.slice(0, 10), h]));
  const days = Array.from({ length: 14 }, (_, i) => {
    const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - (13 - i));
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const h = byDay.get(key);
    return { key, date: d, checked: h?.checked ?? 0, found: h?.found ?? 0 };
  });
  const peak = Math.max(10, ...days.map((d) => d.checked));
  const max = Math.ceil(peak / 10) * 10;
  const H = 140;
  const px = (v: number) => (v / max) * H;
  const label = (d: Date) => d.toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short" });
  const shown = hover != null ? days[hover] : null;

  return (
    <div className="disc-chart">
      <div className="disc-chart-head">
        <h3>Last 14 days</h3>
        <button className="link small" onClick={() => setAsTable((t) => !t)}>{asTable ? "Show as chart" : "Show as table"}</button>
      </div>
      <div className="disc-legend small">
        <span><i className="sw found" /> Found</span>
        <span><i className="sw rest" /> No readable site</span>
        <span className="muted">bar height = companies checked</span>
      </div>
      {asTable ? (
        <table className="apps mini">
          <thead><tr><th>Day</th><th>Checked</th><th>Found</th></tr></thead>
          <tbody>{[...days].reverse().map((d) => <tr key={d.key}><td>{label(d.date)}</td><td>{d.checked}</td><td>{d.found}</td></tr>)}</tbody>
        </table>
      ) : (
        <div className="disc-plot" style={{ height: H + 22 }} onMouseLeave={() => setHover(null)}>
          {[0, max / 2, max].map((v) => (
            <div key={v} className="disc-grid" style={{ bottom: 22 + px(v) }}><span>{v}</span></div>
          ))}
          <div className="disc-bars">
            {days.map((d, i) => {
              const rest = d.checked - d.found;
              return (
                <div key={d.key} className={`disc-col${hover === i ? " on" : ""}`} tabIndex={0} role="img"
                     aria-label={`${label(d.date)}: ${d.checked} checked, ${d.found} found`}
                     onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(null)}>
                  <div className="disc-bar" style={{ height: H }}>
                    {rest > 0 && <div className="seg rest" style={{ height: px(rest) }} />}
                    {d.found > 0 && <div className={`seg found${rest > 0 ? "" : " top"}`} style={{ height: px(d.found) }} />}
                  </div>
                  <span className="disc-x">{d.date.getDate()}</span>
                </div>
              );
            })}
          </div>
          {shown && (
            <div className="disc-tip" style={{
              left: `calc(28px + (100% - 28px) * ${(hover! + 0.5) / 14})`,
              transform: `translateX(${hover! < 2 ? "-15%" : hover! > 11 ? "-85%" : "-50%"})`,   // stays inside the card at the edges
            }}>
              <strong>{label(shown.date)}</strong>
              <span>{shown.checked} checked</span>
              <span><i className="sw found" /> {shown.found} found{shown.checked ? ` (${Math.round((100 * shown.found) / shown.checked)}%)` : ""}</span>
              <span><i className="sw rest" /> {shown.checked - shown.found} no readable site</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Group A, ranked: the companies to focus the search on. */
function FocusList({ focus, act }: { focus: Focus[]; act: (id: string, action: string, value?: Record<string, string>, done?: string) => void }) {
  const [filter, setFilter] = useState<"all" | "watched" | "none" | "unchecked">("all");
  const [showAll, setShowAll] = useState(false);
  const is = (f: Focus) => (f.status === "found" ? "watched" : f.status === "not_found" ? "none" : "unchecked");
  const rows = focus.filter((f) => filter === "all" || is(f) === filter);
  const shown = showAll ? rows : rows.slice(0, 40);
  const count = (k: string) => focus.filter((f) => is(f) === k).length;
  return (
    <section className="card">
      <h3>Your focus companies <span className="muted small">· group A, {focus.length}, ranked by relevance</span></h3>
      <p className="muted small">Score: 10 per application, 5 per job that passed your filters, 3 per core-direction job (up to 10), 2 per StepStone alert job,
        1 per Explore job, 3 if you have a contact there.</p>
      <div className="tabs">
        {([["all", `All ${focus.length}`], ["watched", `Career site read ${count("watched")}`], ["none", `No readable site ${count("none")}`], ["unchecked", `Unchecked ${count("unchecked")}`]] as const).map(([k, l]) => (
          <button key={k} className={filter === k ? "active" : ""} onClick={() => setFilter(k)}>{l}</button>
        ))}
      </div>
      <div className="table-wrap">
        <table className="apps">
          <thead><tr><th>#</th><th>Company</th><th title="Relevance score">Score</th><th title="Jobs in your core directions (Germany)">Core jobs</th><th title="Passed your filters">Passed</th><th>Applied</th><th>Contacts</th><th>Career site</th></tr></thead>
          <tbody>
            {shown.map((f, i) => {
              const r = f.relevance;
              return (
                <tr key={f.id}>
                  <td className="muted">{i + 1}</td>
                  <td className="strong">{f.careers_url ? <a href={f.careers_url} target="_blank" rel="noreferrer">{f.name}</a> : f.name}</td>
                  <td>{f.score}</td>
                  <td>{r?.core_jobs ?? 0}</td>
                  <td>{r?.passed_core ?? 0}</td>
                  <td>{r?.applied ? <span className="badge">applied {r.applied}</span> : <span className="muted">–</span>}</td>
                  <td>{r?.contacts ? <a href="#people" title="Your LinkedIn contacts there (People)">{r.contacts}</a> : <span className="muted">–</span>}</td>
                  <td className="small">
                    {f.status === "found" ? <span className="status status-green">{atsLabel(f.ats)}{f.watch ? "" : " · off"}</span>
                      : f.status === "not_found" ? <><span className="muted">none readable</span> <AddCareers onAdd={(url, pattern) => act(f.id, "careers", { url, pattern }, `${f.name}: career page added`)} /></>
                      : <span className="muted">to check</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {rows.length > 40 && <button className="link small" onClick={() => setShowAll((x) => !x)}>{showAll ? "Show the top 40" : `Show all ${rows.length}`}</button>}
    </section>
  );
}

