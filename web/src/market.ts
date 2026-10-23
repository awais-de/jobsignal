import { useEffect, useState } from "react";
import { keyOf, type Skill } from "./skillmath";
import { supabase } from "./supabase";

// Market demand (pipeline/skill_demand.py): share of companies in a job family whose postings mention a
// skill, week by week, over every posting seen (not only those that passed your filters).

export type Scope = "all" | "stable";
type Row = { week_start: string; skill: string; skill_id: string | null; generic: boolean; companies: number };
export type MarketSkill = {
  skill: string; skillId: string | null; generic: boolean;
  share: number;                                   // pooled over the recent weeks
  weekly: { week: string; share: number; total: number }[];   // every usable week, oldest first
};
export type Market = { bySkill: Map<string, MarketSkill>; companies: number; weeks: string[]; recentWeeks: number;
                       totals: Map<string, number> };

export const MIN_COMPANIES = 30;     // a week with fewer companies in the group isn't used
export const RECENT_WEEKS = 4;
export const TREND_WEEKS = 6;        // weekly points before a trend is shown

export function summarise(rows: Row[]): Market {
  const totals = new Map(rows.filter((r) => r.skill === "*").map((r) => [r.week_start, r.companies]));
  const weeks = [...totals.entries()].filter(([, n]) => n >= MIN_COMPANIES).map(([w]) => w).sort();
  const recent = new Set(weeks.slice(-RECENT_WEEKS));
  const recentTotal = [...recent].reduce((a, w) => a + (totals.get(w) ?? 0), 0);
  const bySkill = new Map<string, MarketSkill>();
  for (const r of rows) {
    if (r.skill === "*" || !totals.has(r.week_start) || (totals.get(r.week_start) ?? 0) < MIN_COMPANIES) continue;
    const m = bySkill.get(r.skill) ?? { skill: r.skill, skillId: r.skill_id, generic: r.generic, share: 0, weekly: [] };
    m.skillId = m.skillId ?? r.skill_id;
    m.weekly.push({ week: r.week_start, share: r.companies / (totals.get(r.week_start) ?? 1), total: totals.get(r.week_start) ?? 0 });
    if (recent.has(r.week_start)) m.share += r.companies / (recentTotal || 1);
    bySkill.set(r.skill, m);
  }
  for (const m of bySkill.values()) m.weekly.sort((a, b) => a.week.localeCompare(b.week));
  return { totals, bySkill, companies: [...recent].reduce((a, w) => Math.max(a, totals.get(w) ?? 0), 0), weeks, recentWeeks: recent.size };
}

/** The market figures for a catalogue skill: linked by id, or by name/alias for skills added later. */
export function marketFor(m: Market, skill: Skill): MarketSkill | undefined {
  const keys = new Set([skill.name_key, keyOf(skill.name), ...skill.aliases.map(keyOf)]);
  for (const s of m.bySkill.values()) if (s.skillId === skill.id) return s;
  for (const s of m.bySkill.values()) if (keys.has(keyOf(s.skill))) return s;
  return undefined;
}

/** In-demand market terms that match no catalogue skill (and aren't broad terms). */
export function missing(m: Market, catalog: Skill[], minShare = 0.05): MarketSkill[] {
  const keys = new Set(catalog.flatMap((s) => [s.name_key, keyOf(s.name), ...s.aliases.map(keyOf)]));
  const ids = new Set(catalog.map((s) => s.id));
  return [...m.bySkill.values()]
    .filter((s) => !s.generic && s.share >= minShare && !(s.skillId && ids.has(s.skillId)) && !keys.has(keyOf(s.skill)))
    .sort((a, b) => b.share - a.share);
}

export function useMarket(family: string | null, scope: Scope) {
  const [market, setMarket] = useState<Market | null>(null);
  useEffect(() => {
    let live = true;
    const since = new Date(Date.now() - 26 * 7 * 86400000).toISOString().slice(0, 10);
    (async () => {
      const rows: Row[] = [];
      for (let from = 0; ; from += 1000) {
        const { data, error } = await supabase.from("skill_demand_weekly").select("week_start,skill,skill_id,generic,companies")
          .eq("family", family ?? "all").eq("scope", scope).gte("week_start", since).order("week_start").range(from, from + 999);
        if (error || !data) break;
        rows.push(...(data as Row[]));
        if (data.length < 1000) break;
      }
      if (live) setMarket(summarise(rows));
    })();
    return () => { live = false; };
  }, [family, scope]);
  return market;
}

export type Mover = { skill: MarketSkill; before: number; after: number; z: number };

/** Rises and falls: the last 3 usable weeks against the 3 before, pooled; only clear changes (|z| >= 2)
 *  of skills at 5%+ in either period. Empty until there are TREND_WEEKS weeks. */
export function movers(m: Market, span = 3): Mover[] {
  if (m.weeks.length < TREND_WEEKS) return [];
  const after = new Set(m.weeks.slice(-span)), before = new Set(m.weeks.slice(-2 * span, -span));
  const sum = (ws: Set<string>) => [...ws].reduce((a, w) => a + (m.totals.get(w) ?? 0), 0);
  const nA = sum(after), nB = sum(before);
  const out: Mover[] = [];
  for (const s of m.bySkill.values()) {
    const k = (ws: Set<string>) => s.weekly.filter((x) => ws.has(x.week)).reduce((a, x) => a + x.share * x.total, 0);
    const pA = k(after) / (nA || 1), pB = k(before) / (nB || 1);
    if (Math.max(pA, pB) < 0.05) continue;
    const p = (pA * nA + pB * nB) / ((nA + nB) || 1);
    const se = Math.sqrt(p * (1 - p) * (1 / (nA || 1) + 1 / (nB || 1))) || 1;
    const z = (pA - pB) / se;
    if (Math.abs(z) >= 2) out.push({ skill: s, before: pB, after: pA, z });
  }
  return out.sort((a, b) => Math.abs(b.z) - Math.abs(a.z));
}
