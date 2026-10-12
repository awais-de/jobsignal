import { useEffect, useMemo, useState } from "react";
import { supabase } from "./supabase";

// AI usage meter: calls and tokens per model today and over the last 7 days, the limits Groq
// reports with each response, and the jobs still waiting for analysis.

type Usage = {
  created_at: string; stage: string; provider: string; model: string; success: boolean; error: string | null;
  input_tokens: number | null; output_tokens: number | null; cached_tokens: number | null;
  limits: Record<string, string | number> | null;
};

const utcDay = (iso: string) => iso.slice(0, 10);
const n = (v: number) => v.toLocaleString("en-GB");
const num = (v: unknown) => (v == null || v === "" ? null : Number(v));

export default function UsageMeter() {
  const [rows, setRows] = useState<Usage[] | null>(null);
  const [pending, setPending] = useState<{ core: number; explore: number } | null>(null);
  const [saved, setSaved] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const since = new Date(Date.now() - 7 * 86400000).toISOString();
    (async () => {
      const out: Usage[] = [];
      for (let from = 0; ; from += 1000) {
        const { data, error } = await supabase.from("llm_usage")
          .select("created_at,stage,provider,model,success,error,input_tokens,output_tokens,cached_tokens,limits")
          .gte("created_at", since).order("created_at", { ascending: false }).range(from, from + 999);
        if (error) throw new Error(error.message);
        out.push(...(data as Usage[]));
        if (data.length < 1000) break;
      }
      setRows(out);
      const waiting = (lane: "core" | "explore") => {
        let q = supabase.from("job_postings").select("id", { count: "exact", head: true })
          .eq("filter_status", "passed").in("extraction_status", ["pending", "failed"]).not("description", "is", null)
          .is("deleted_at", null);
        q = lane === "explore" ? q.eq("lane", "explore") : q.or("lane.is.null,lane.eq.core");
        return q.then(({ count }) => count ?? 0);
      };
      const [core, explore] = await Promise.all([waiting("core"), waiting("explore")]);
      setPending({ core, explore });
      const runs = await supabase.from("pipeline_runs").select("stats").gte("started_at", since);
      setSaved(((runs.data ?? []) as { stats: Record<string, unknown> | null }[])
        .reduce((s, r) => s + (Number(r.stats?.llm_saved_by_code) || 0), 0));
    })().catch((e) => setError(e instanceof Error ? e.message : "Couldn't load usage."));
  }, []);

  const today = utcDay(new Date().toISOString());
  const view = useMemo(() => {
    if (!rows) return null;
    const models = new Map<string, { ok: number; failed: number; limited: number; tokens: number; cached: number;
                                     limits: Usage["limits"]; hit: Usage["limits"] }>();
    for (const r of rows) {
      const key = `${r.provider} · ${r.model}`;
      const m = models.get(key) ?? { ok: 0, failed: 0, limited: 0, tokens: 0, cached: 0, limits: null, hit: null };
      // Newest first: the first row with limits carries the latest figures.
      if (!m.limits && r.limits && r.success) m.limits = r.limits;
      if (!m.hit && r.limits?.hit) m.hit = r.limits;
      if (utcDay(r.created_at) === today) {
        if (r.success) m.ok++;
        else if (r.error === "rate_limited") m.limited++;
        else m.failed++;
        m.tokens += (r.input_tokens ?? 0) + (r.output_tokens ?? 0);
        m.cached += r.cached_tokens ?? 0;
      }
      models.set(key, m);
    }
    const days = new Map<string, { calls: number; tokens: number; limited: number }>();
    for (const r of rows) {
      const d = days.get(utcDay(r.created_at)) ?? { calls: 0, tokens: 0, limited: 0 };
      d.calls++;
      d.tokens += (r.input_tokens ?? 0) + (r.output_tokens ?? 0);
      if (r.error === "rate_limited") d.limited++;
      days.set(utcDay(r.created_at), d);
    }
    const ok = rows.filter((r) => r.success && r.stage === "jd_extraction");
    const perJob = ok.length ? ok.reduce((s, r) => s + (r.input_tokens ?? 0) + (r.output_tokens ?? 0), 0) / ok.length : null;
    return { models: [...models.entries()], days: [...days.entries()].sort(([a], [b]) => b.localeCompare(a)), perJob };
  }, [rows, today]);

  if (error) return <section className="card"><h3>AI usage</h3><p className="notice">{error}</p></section>;
  if (!view) return <section className="card"><h3>AI usage</h3><p className="muted">Loading…</p></section>;

  return (
    <section className="card usage">
      <h3>AI usage <span className="muted small">(today = UTC day, as the provider counts)</span></h3>
      <div className="usage-tiles">
        <div><strong>{pending ? n(pending.core) : "–"}</strong><span>core jobs waiting for analysis</span></div>
        <div><strong>{pending ? n(pending.explore) : "–"}</strong><span>explore jobs waiting</span></div>
        <div><strong>{view.perJob ? n(Math.round(view.perJob)) : "–"}</strong><span>tokens per job analysis (avg, 7 days)</span></div>
        <div><strong>{saved ?? "–"}</strong><span>calls saved by code checks (7 days)</span></div>
      </div>

      {view.models.length === 0 && <p className="muted">No AI calls in the last 7 days.</p>}
      {view.models.map(([key, m]) => {
        const rpd = num(m.limits?.["x-ratelimit-limit-requests"]);
        const rpdLeft = num(m.limits?.["x-ratelimit-remaining-requests"]);
        const tpm = num(m.limits?.["x-ratelimit-limit-tokens"]);
        const tpd = m.hit?.hit === "TPD" ? num(m.hit.hit_limit) : null;
        const pct = tpd ? Math.min(100, (100 * m.tokens) / tpd) : null;
        return (
          <div key={key} className="usage-model">
            <div className="row">
              <strong>{key}</strong>
              <span className="muted">
                today: {m.ok} calls{m.limited ? `, ${m.limited} rate-limited` : ""}{m.failed ? `, ${m.failed} failed` : ""} · {n(m.tokens)} tokens
                {m.cached ? ` (${n(m.cached)} prompt tokens from cache)` : ""}
              </span>
            </div>
            {pct !== null && (
              <div className="meter" title={`${n(m.tokens)} of ${n(tpd!)} tokens per day`}>
                <div className={`meter-fill${pct > 85 ? " high" : ""}`} style={{ width: `${pct}%` }} />
              </div>
            )}
            <div className="muted small">
              {[
                tpd ? `daily token limit ${n(tpd)}` : "daily token limit: not reported yet (Groq names it once it is reached)",
                rpd ? `requests/day ${n(rpd)}${rpdLeft != null ? ` (${n(rpdLeft)} left at the last call)` : ""}` : null,
                tpm ? `tokens/minute ${n(tpm)}` : null,
                m.hit ? `last limit hit: ${m.hit.hit}${m.hit.hit_used ? ` at ${n(Number(m.hit.hit_used))} used` : ""}` : null,
              ].filter(Boolean).join(" · ")}
            </div>
          </div>
        );
      })}

      {view.days.length > 0 && (
        <table className="apps usage-days">
          <thead><tr><th>Day</th><th>Calls</th><th>Tokens</th><th>Rate-limited</th></tr></thead>
          <tbody>
            {view.days.map(([d, v]) => (
              <tr key={d}><td>{d}</td><td>{v.calls}</td><td>{n(v.tokens)}</td><td>{v.limited || ""}</td></tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
