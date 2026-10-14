import { useEffect, useMemo, useState } from "react";
import { anchor, readiness, TARGET } from "./skillmath";
import { useSkills } from "./skills-data";
import { supabase } from "./supabase";

// The job's skills next to your ratings, on the job page. "Presented for this job" is a bump recorded for
// this job only (owner decision 2026-10-14): it never changes your base rating, which changes only on the
// Skills page. The base rating at the time of applying is derived from the rating history.

type Level = { skill_id: string; presented: number };

/** "SQL 8/10; Databricks 4/10, presenting 7 for this job; dbt not rated": for the AI prompts. */
export type SkillLines = string;

export default function JobSkills({ jobId, must, nice, onLines }: {
  jobId: string; must: string[]; nice: string[]; onLines?: (lines: SkillLines) => void;
}) {
  const sk = useSkills(false);
  const [levels, setLevels] = useState<Map<string, number>>(new Map());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    supabase.from("job_skill_levels").select("skill_id,presented").eq("job_posting_id", jobId)
      .then(({ data }) => setLevels(new Map(((data ?? []) as Level[]).map((l) => [l.skill_id, l.presented]))));
  }, [jobId]);

  const rows = useMemo(() => {
    if (!sk.index) return [];
    const seen = new Set<string>();
    return [...must.map((r) => ({ raw: r, must: true })), ...nice.map((r) => ({ raw: r, must: false }))].flatMap((x) => {
      const s = sk.index!.match(x.raw);
      const key = s?.id ?? `raw:${x.raw.toLowerCase()}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [{ ...x, skill: s, rating: s ? sk.ratingOf(s.id) : null, presented: s ? levels.get(s.id) ?? null : null }];
    });
  }, [sk.index, must, nice, levels, sk]);

  const base = sk.index ? readiness(must, sk.index, sk.ratingOf) : null;
  const withPresented = sk.index ? readiness(must, sk.index, (id) => levels.get(id) ?? sk.ratingOf(id)) : null;

  useEffect(() => {
    if (!onLines || !rows.length) return;
    onLines(rows.map((r) => {
      const name = r.skill?.name ?? r.raw;
      const tag = r.must ? "" : " (nice to have)";
      if (r.rating == null && r.presented == null) return `${name}${tag}: not rated`;
      return `${name}${tag}: ${r.rating ?? "not rated"}/10${r.presented != null && r.presented !== r.rating ? `, presenting ${r.presented}/10 for this job` : ""}`;
    }).join("\n"));
  }, [rows, onLines]);

  async function present(skillId: string, value: string) {
    setError(null);
    if (value === "") {
      const { error } = await supabase.from("job_skill_levels").delete().eq("job_posting_id", jobId).eq("skill_id", skillId);
      if (error) return setError(error.message);
      setLevels((m) => { const n = new Map(m); n.delete(skillId); return n; });
      return;
    }
    const { error } = await supabase.from("job_skill_levels")
      .upsert({ job_posting_id: jobId, skill_id: skillId, presented: Number(value) }, { onConflict: "job_posting_id,skill_id" });
    if (error) return setError(error.message);
    setLevels((m) => new Map(m).set(skillId, Number(value)));
  }

  if (!must.length && !nice.length) return null;
  return (
    <div className="job-skills">
      <h3>Skills <a className="h3-link" href="#skills">Skills database →</a></h3>
      {base != null && (
        <div className="small-text readiness">
          Readiness <strong>{Math.round(base * 100)}%</strong>
          {withPresented != null && withPresented !== base && <> · with presented levels <strong>{Math.round(withPresented * 100)}%</strong></>}
          <span className="muted"> (must-haves at {TARGET}/10 or more = 100%)</span>
        </div>
      )}
      {error && <p className="notice">{error}</p>}
      <table className="apps mini job-skill-table">
        <thead><tr><th>Skill</th><th>You</th><th title="Recorded for this job only; your base rating stays">For this job</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.skill?.id ?? r.raw} className={r.must ? "" : "nice"}>
              <td>{r.skill?.name ?? <span title="Not in the skills catalogue yet">{r.raw} <span className="muted">(new)</span></span>}
                {!r.must && <span className="muted"> · nice</span>}</td>
              <td className={r.rating == null ? "muted" : (r.rating >= 6 ? "ok" : r.rating >= 3 ? "" : "low")}>
                {r.rating == null ? "–" : `${r.rating}/10`}<span className="muted small"> {r.rating == null ? "" : anchor(r.rating)}</span></td>
              <td>
                {r.skill ? (
                  <select value={r.presented ?? ""} onChange={(e) => present(r.skill!.id, e.target.value)} aria-label={`Presented level for ${r.skill.name}`}>
                    <option value="">–</option>
                    {Array.from({ length: 11 }, (_, i) => <option key={i} value={i}>{i}</option>)}
                  </select>
                ) : <a className="muted small" href="#skills">map it</a>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
