import { useEffect, useMemo, useState } from "react";
import { classify, MODE_LABELS, skillOverlap, type Family, type FamilyMode } from "./families";
import { loadProfile, saveProfile, type StoredProfile } from "./profileStore";
import { sourceLabel, supabase } from "./supabase";
import UsageMeter from "./UsageMeter";

// Title lab: try a direction (title patterns + a search term) before switching it on, and see how each
// title family is doing. Everything here reads stored jobs or makes one live Arbeitsagentur search;
// nothing changes until "Add to family and save".

type Row = {
  id: string; title: string; company_name: string; source: string; filter_status: string;
  filter_reasons: string[] | null; lane: string | null; title_family: string | null; first_seen_at: string;
  triage_status: string; skip_reason: string | null;
};
const ROW_COLUMNS = "id,title,company_name,source,filter_status,filter_reasons,lane,title_family,first_seen_at,triage_status,skip_reason";

async function fetchAll<T>(build: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data as T[]));
    if ((data as T[]).length < 1000) return out;
  }
}

const since = (days: number) => new Date(Date.now() - days * 86400000).toISOString();
const rx = (p: string) => { try { return new RegExp(p, "i"); } catch { return null; } };

export default function Lab() {
  const [profile, setProfile] = useState<StoredProfile | null>(null);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadProfile().then((r) => setProfile(r?.profile ?? null)).catch((e) => setError(e.message));
    fetchAll<Row>((a, b) => supabase.from("job_postings").select(ROW_COLUMNS).is("deleted_at", null)
      .gte("first_seen_at", since(60)).order("id").range(a, b))
      .then(setRows).catch((e) => setError(e.message));
  }, []);

  if (error) return <p className="notice">{error}</p>;
  if (!profile || !rows) return <p className="empty">Loading…</p>;
  const families = profile.families ?? [];

  return (
    <div className="lab">
      <h2>Title lab</h2>
      <p className="muted">
        Try a direction before switching it on: which stored jobs it would have caught, how many the Arbeitsagentur has
        right now, and how well they fit your skills. Nothing changes until you add it to a family.
      </p>
      <UsageMeter />
      {families.length === 0 && <p className="notice">Your profile has no title families yet.</p>}
      <Scoreboard rows={rows} families={families} />
      <Tryout rows={rows} profile={profile} onSaved={setProfile} />
    </div>
  );
}

// -- scoreboard -------------------------------------------------------------------------------
function Scoreboard({ rows, families }: { rows: Row[]; families: Family[] }) {
  const [statuses, setStatuses] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    (async () => {
      const apps = await fetchAll<{ id: string; job_posting_id: string }>((a, b) =>
        supabase.from("applications").select("id,job_posting_id").is("deleted_at", null).range(a, b));
      const st = await fetchAll<{ application_id: string; status: string }>((a, b) =>
        supabase.from("application_status").select("application_id,status").range(a, b));
      const byApp = new Map(st.map((s) => [s.application_id, s.status]));
      setStatuses(new Map(apps.map((a) => [a.job_posting_id, byApp.get(a.id) ?? "applied"])));
    })().catch(() => setStatuses(new Map()));
  }, []);

  const table = useMemo(() => {
    const keyOf = (r: Row) => r.title_family ?? classify(r.title, families)?.key ?? "_other";
    const by = new Map<string, { jobs: number; applied: number; skipped: Map<string, number>; interviews: number; offers: number; rejected: number }>();
    for (const r of rows) {
      if (r.filter_status !== "passed" && !statuses.has(r.id)) continue;
      const k = keyOf(r);
      const s = by.get(k) ?? { jobs: 0, applied: 0, skipped: new Map(), interviews: 0, offers: 0, rejected: 0 };
      s.jobs++;
      if (r.triage_status === "skipped") s.skipped.set(r.skip_reason ?? "other", (s.skipped.get(r.skip_reason ?? "other") ?? 0) + 1);
      const st = statuses.get(r.id);
      if (st) {
        s.applied++;
        if (st.startsWith("interview") || st === "assessment_received") s.interviews++;
        if (st.startsWith("offer")) s.offers++;
        if (st === "rejected") s.rejected++;
      }
      by.set(k, s);
    }
    const order = [...families.map((f) => f.key), "_other"];
    return order.filter((k) => by.has(k) || families.some((f) => f.key === k)).map((k) => ({
      key: k, family: families.find((f) => f.key === k), ...(by.get(k) ?? { jobs: 0, applied: 0, skipped: new Map(), interviews: 0, offers: 0, rejected: 0 }),
    }));
  }, [rows, families, statuses]);

  return (
    <section className="card">
      <h3>How each direction is doing <span className="muted small">(jobs shown in the last 60 days)</span></h3>
      <div className="table-wrap">
        <table className="apps">
          <thead>
            <tr><th>Family</th><th>Mode</th><th>Jobs</th><th>Applied</th><th>Skipped (top reason)</th><th>Interviews</th><th>Offers</th><th>Rejected</th></tr>
          </thead>
          <tbody>
            {table.map((t) => {
              const skips = [...t.skipped.entries()].sort((a, b) => b[1] - a[1]);
              const nSkip = skips.reduce((n, [, c]) => n + c, 0);
              return (
                <tr key={t.key}>
                  <td className="strong">{t.family?.label ?? "No family (watched companies, older jobs)"}</td>
                  <td>{t.family ? MODE_LABELS[t.family.mode] : "–"}</td>
                  <td>{t.jobs}</td>
                  <td>{t.applied}</td>
                  <td>{nSkip ? `${nSkip}${skips[0] ? ` (${skips[0][0].replace("_", " ")})` : ""}` : "0"}</td>
                  <td>{t.interviews}</td>
                  <td>{t.offers}</td>
                  <td>{t.rejected}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// -- try a direction ----------------------------------------------------------------------------
type Live = { term: string; days: number; total: number; items: { title: string; company: string; city: string | null; posted: string | null; url: string | null }[] };

function Tryout({ rows, profile, onSaved }: { rows: Row[]; profile: StoredProfile; onSaved: (p: StoredProfile) => void }) {
  const families = profile.families ?? [];
  const [patternText, setPatternText] = useState("");
  const [term, setTerm] = useState("");
  const [base, setBase] = useState("");
  const [fit, setFit] = useState<{ id: string; skills: string[] }[] | null>(null);
  const [live, setLive] = useState<Live | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [target, setTarget] = useState("");
  const [mode, setMode] = useState<FamilyMode>("explore");

  const patterns = useMemo(() => patternText.split("\n").map((s) => s.trim()).filter(Boolean), [patternText]);
  const bad = patterns.filter((p) => !rx(p));
  const block = (profile.titles.block ?? []).map(rx).filter(Boolean) as RegExp[];

  function pickBase(key: string) {
    setBase(key);
    const f = families.find((x) => x.key === key);
    if (f) { setPatternText(f.titles.join("\n")); setTerm(f.search_terms[0] ?? ""); setTarget(f.key); setMode(f.mode === "off" ? "explore" : f.mode); }
    setFit(null);
  }

  // History: jobs of the last 30 days whose title the patterns match (global exclusions applied).
  const history = useMemo(() => {
    const res = patterns.map(rx).filter(Boolean) as RegExp[];
    if (!res.length) return null;
    const cutoff = since(30);
    const hits = rows.filter((r) => r.first_seen_at >= cutoff && res.some((p) => p.test(r.title)) && !block.some((p) => p.test(r.title)));
    const gain = hits.filter((r) => r.filter_status === "rejected" && r.filter_reasons?.[0] === "title_not_allowed");
    const passing = hits.filter((r) => r.filter_status === "passed");
    const other = hits.filter((r) => r.filter_status === "rejected" && r.filter_reasons?.[0] !== "title_not_allowed");
    const reasons = new Map<string, number>();
    other.forEach((r) => reasons.set(r.filter_reasons?.[0] ?? "?", (reasons.get(r.filter_reasons?.[0] ?? "?") ?? 0) + 1));
    return { hits, gain, passing, other, reasons, companies: new Set(hits.map((r) => r.company_name)).size };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patterns, rows]);

  async function checkFit() {
    if (!history) return;
    setBusy("fit");
    const ids = [...history.gain, ...history.passing].slice(0, 150).map((r) => r.id);
    const out: { id: string; skills: string[] }[] = [];
    for (let i = 0; i < ids.length; i += 50) {
      const { data } = await supabase.from("job_postings").select("id,description").in("id", ids.slice(i, i + 50));
      for (const d of (data ?? []) as { id: string; description: string | null }[]) {
        if (d.description) out.push({ id: d.id, skills: skillOverlap(d.description, profile.skills ?? {}) });
      }
    }
    setFit(out.sort((a, b) => b.skills.length - a.skills.length));
    setBusy(null);
  }

  async function searchLive() {
    if (!term.trim()) return;
    setBusy("live");
    const { data, error } = await supabase.functions.invoke("lab-search", { body: { term: term.trim(), days: 7 } });
    setBusy(null);
    if (error) return setMsg("The Arbeitsagentur search didn't work. Try again in a moment.");
    setLive(data as Live);
  }

  async function promote() {
    if (!patterns.length || bad.length) return;
    let key = target;
    let next = [...families];
    if (!key) {
      const label = window.prompt("Name of the new family");
      if (!label?.trim()) return;
      key = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
      if (!next.some((f) => f.key === key)) next.push({ key, label: label.trim(), mode, titles: [], exclude: [], search_terms: [] });
    }
    next = next.map((f) => f.key !== key ? f : {
      ...f, mode,
      titles: [...new Set([...f.titles, ...patterns])],
      search_terms: term.trim() ? [...new Set([...f.search_terms, term.trim()])] : f.search_terms,
    });
    setBusy("save");
    try {
      const r = await saveProfile({ ...profile, families: next });
      onSaved(r.profile);
      setMsg(r.note);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Saving failed.");
    }
    setBusy(null);
  }

  const byId = new Map(rows.map((r) => [r.id, r]));
  const avg = fit?.length ? fit.reduce((n, f) => n + f.skills.length, 0) / fit.length : 0;

  return (
    <section className="card">
      <h3>Try a direction</h3>
      <div className="row">
        <label className="lab-label">Start from
          <select value={base} onChange={(e) => pickBase(e.target.value)}>
            <option value="">Blank</option>
            {families.map((f) => <option key={f.key} value={f.key}>{f.label} ({MODE_LABELS[f.mode]})</option>)}
          </select>
        </label>
        <label className="lab-label">Search term (Arbeitsagentur)
          <input value={term} placeholder="e.g. Datenbankadministrator" onChange={(e) => { setTerm(e.target.value); setLive(null); }} />
        </label>
      </div>
      <label className="lab-label">Title patterns, one per line (plain words or regular expressions)
        <textarea rows={4} value={patternText} placeholder={"datenbank\n\\bdba\\b\ndatabase"}
                  onChange={(e) => { setPatternText(e.target.value); setFit(null); }} />
      </label>
      {bad.length > 0 && <p className="notice">Invalid pattern: {bad.join(", ")}</p>}

      {history && (
        <div className="lab-result">
          <h4>Last 30 days in your data</h4>
          <p>
            <strong>{history.hits.length}</strong> jobs at {history.companies} companies match.{" "}
            <strong>{history.gain.length}</strong> were dropped only because of the title (you'd have gained these),{" "}
            {history.passing.length} already pass, {history.other.length} failed other filters
            {history.reasons.size > 0 && ` (${[...history.reasons.entries()].map(([k, v]) => `${k.replace(/_/g, " ")}: ${v}`).join(", ")})`}.
          </p>
          <p className="muted small">
            Your data only holds what the current search terms fetched, plus every job from watched companies and Arbeitnow.
            A new search term finds jobs not in here: use the live search for that.
          </p>
          <div className="row">
            <button className="small" disabled={busy === "fit" || !(history.gain.length + history.passing.length)} onClick={checkFit}>
              {busy === "fit" ? "Checking…" : "Check skill fit"}
            </button>
          </div>
          {fit && (
            <p>
              Of {fit.length} jobs with a description, they mention on average <strong>{avg.toFixed(1)}</strong> of your skills;{" "}
              <strong>{fit.filter((f) => f.skills.length >= 3).length}</strong> mention 3 or more.
            </p>
          )}
          <ul className="lab-list">
            {(fit ? fit.map((f) => byId.get(f.id)!).filter(Boolean) : [...history.gain, ...history.passing]).slice(0, 25).map((r) => {
              const skills = fit?.find((f) => f.id === r.id)?.skills;
              return (
                <li key={r.id}>
                  <a href={`#job/${r.id}`}>{r.title}</a> <span className="muted">· {r.company_name} · {sourceLabel(r.source)}</span>
                  {r.filter_status === "passed" ? <span className="badge">passes now</span> : <span className="badge lane-explore">would gain</span>}
                  {skills && skills.length > 0 && <div className="muted small">{skills.slice(0, 8).join(", ")}</div>}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div className="row">
        <button className="small" disabled={!term.trim() || busy === "live"} onClick={searchLive}>
          {busy === "live" ? "Searching…" : "Search the Arbeitsagentur now (last 7 days)"}
        </button>
      </div>
      {live && (
        <div className="lab-result">
          <h4>Arbeitsagentur, “{live.term}”, full-time, last {live.days} days</h4>
          <p><strong>{live.total}</strong> jobs. The first {live.items.length}, with ✓ where your patterns match the title:</p>
          <ul className="lab-list">
            {live.items.map((it, i) => {
              const ok = patterns.some((p) => rx(p)?.test(it.title)) && !block.some((p) => p.test(it.title));
              return (
                <li key={i}>
                  <span className={ok ? "ok" : "muted"}>{ok ? "✓" : "–"}</span>{" "}
                  {it.url ? <a href={it.url} target="_blank" rel="noreferrer">{it.title}</a> : it.title}
                  <span className="muted"> · {it.company}{it.city ? ` · ${it.city}` : ""}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div className="lab-promote">
        <h4>Switch it on</h4>
        <div className="row">
          <select value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Family">
            <option value="">New family…</option>
            {families.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
          </select>
          <select value={mode} onChange={(e) => setMode(e.target.value as FamilyMode)} aria-label="Mode">
            <option value="explore">Explore (app only)</option>
            <option value="core">Core (digest + feed)</option>
            <option value="off">Off</option>
          </select>
          <button className="primary small" disabled={!patterns.length || bad.length > 0 || busy === "save"} onClick={promote}>
            Add to family and save
          </button>
        </div>
        <p className="muted small">Adds the patterns and the search term to the family. Jobs from the last two weeks are re-checked within about a minute; new searches start with the next run.</p>
        {msg && <p className="notice">{msg}</p>}
      </div>
    </section>
  );
}
