// Skills database logic (owner decisions 2026-10-14). Pure functions over the catalogue, the rating
// history and the job ads' extracted skills; no network.
//   demand: share of jobs asking for a skill, must-have = 1, nice-to-have = 0.5 (STARTING VALUE),
//           a variant also counts toward its parent (T-SQL -> SQL), default population core jobs.
//   rating: 0-10, the latest recorded; anchors 0 none · 3 basics · 5 used in a job · 7 strong · 9 expert.

export type Skill = { id: string; name: string; name_key: string; parent_id: string | null; aliases: string[]; category: string | null;
                      from_profile?: boolean };
export type Rating = { skill_id: string; rating: number; note: string | null; rated_at: string };
export type JobSkills = { id: string; must_have_skills: string[] | null; nice_to_have_skills: string[] | null;
                          lane: string | null; title_family: string | null; first_seen_at: string };

export const WEIGHT = { must: 1, nice: 0.5 };           // STARTING VALUE: to be tuned later
export const TARGET = 7;                                // "strong, works independently"
export const ANCHORS: Record<number, string> = { 0: "none", 3: "basics", 5: "used in a job", 7: "strong", 9: "expert" };
export const anchor = (r: number | null | undefined) =>
  r == null ? "not rated" : ANCHORS[[9, 7, 5, 3, 0].find((a) => r >= a) ?? 0];

export const keyOf = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Matches a skill as written in a job ad to a catalogue skill: exact name/alias first, else the longest
 *  alias appearing as a whole word ("Python 3.11" -> Python). Same rule as the pipeline's SkillIndex. */
export class SkillIndex {
  private exact = new Map<string, Skill>();
  private words: [RegExp, Skill][] = [];
  readonly byId = new Map<string, Skill>();
  constructor(catalog: Skill[]) {
    for (const s of catalog) {
      this.byId.set(s.id, s);
      for (const a of new Set([s.name_key, ...s.aliases.map(keyOf)])) if (a) this.exact.set(a, s);
    }
    this.words = [...this.exact.entries()].filter(([a]) => a.length >= 2).sort((x, y) => y[0].length - x[0].length)
      .map(([a, s]) => [new RegExp(`(?<![\\p{L}\\p{N}+#])${esc(a)}(?![\\p{L}\\p{N}+#])`, "u"), s]);
  }
  match(raw: string): Skill | null {
    const k = keyOf(raw);
    return this.exact.get(k) ?? this.words.find(([re]) => re.test(k))?.[1] ?? null;
  }
  /** A skill and its parents (a variant counts toward the parent too). */
  lineage(s: Skill): Skill[] {
    const out: Skill[] = [];
    for (let cur: Skill | undefined = s; cur && out.length < 5 && !out.includes(cur); cur = cur.parent_id ? this.byId.get(cur.parent_id) : undefined) out.push(cur);
    return out;
  }
}

export type Filter = { lane: "core" | "explore" | "all"; family: string | null; days: number };

export type Demand = { skill: Skill; jobs: number; must: number; share: number; mustShare: number; recent: number; earlier: number };

/** Demand per skill in the chosen population, plus the unmatched names (for the "new skills" queue). */
export function demand(jobs: JobSkills[], idx: SkillIndex, f: Filter, ignored: Set<string>, now = new Date()) {
  const since = now.getTime() - f.days * 86400000, half = now.getTime() - (f.days / 2) * 86400000;
  const pop = jobs.filter((j) => new Date(j.first_seen_at).getTime() >= since
    && (f.lane === "all" || (f.lane === "core" ? (j.lane ?? "core") === "core" : j.lane === "explore"))
    && (!f.family || j.title_family === f.family));
  const acc = new Map<string, { w: number; must: number; recent: number; earlier: number }>();
  const unmatched = new Map<string, { raw: string; jobs: number }>();
  for (const j of pop) {
    const per = new Map<string, number>();           // skill id -> weight in this job (max of must/nice)
    const take = (list: string[] | null, w: number) => {
      for (const raw of list ?? []) {
        const s = idx.match(raw);
        if (!s) {
          const k = keyOf(raw);
          if (k && !ignored.has(k)) { const u = unmatched.get(k) ?? { raw, jobs: 0 }; u.jobs++; unmatched.set(k, u); }
          continue;
        }
        for (const x of idx.lineage(s)) per.set(x.id, Math.max(per.get(x.id) ?? 0, w));
      }
    };
    take(j.must_have_skills, WEIGHT.must);
    take(j.nice_to_have_skills, WEIGHT.nice);
    const isRecent = new Date(j.first_seen_at).getTime() >= half;
    for (const [id, w] of per) {
      const a = acc.get(id) ?? { w: 0, must: 0, recent: 0, earlier: 0 };
      a.w += w;
      if (w === WEIGHT.must) a.must++;
      if (isRecent) a.recent += w; else a.earlier += w;
      acc.set(id, a);
    }
  }
  const n = pop.length || 1;
  const rows: Demand[] = [...acc.entries()].map(([id, a]) => ({
    skill: idx.byId.get(id)!, jobs: a.w, must: a.must, share: a.w / n, mustShare: a.must / n, recent: a.recent, earlier: a.earlier,
  })).sort((x, y) => y.share - x.share);
  return { population: pop.length, rows, unmatched: [...unmatched.values()].sort((a, b) => b.jobs - a.jobs) };
}

/** Latest rating per skill, and its previous one (for "improved from"). */
export function currentRatings(history: Rating[]) {
  const sorted = [...history].sort((a, b) => b.rated_at.localeCompare(a.rated_at));
  const cur = new Map<string, Rating>(), prev = new Map<string, Rating>();
  for (const r of sorted) {
    if (!cur.has(r.skill_id)) cur.set(r.skill_id, r);
    else if (!prev.has(r.skill_id)) prev.set(r.skill_id, r);
  }
  return { cur, prev };
}

export type Quadrant = "strength" | "learn" | "niche" | "ignore";
export const QUADRANTS: Record<Quadrant, string> = {
  strength: "Strengths", learn: "Learn next", niche: "Niche strengths", ignore: "Ignore for now",
};
/** High demand = asked for in at least `highShare` of the jobs (STARTING VALUE 15%); strong = rating >= 6. */
export function quadrant(share: number, rating: number | null, highShare = 0.15): Quadrant {
  const high = share >= highShare, strong = (rating ?? 0) >= 6;
  return high ? (strong ? "strength" : "learn") : strong ? "niche" : "ignore";
}

/** Priority to learn: demand times the distance to the target level (unrated counts as 0). */
export const priority = (share: number, rating: number | null) => share * Math.max(0, TARGET - (rating ?? 0)) / TARGET;

/** A suggestion for an unmatched name: the catalogue skill whose name or alias appears in it as a word
 *  ("Microsoft SQL Server" -> SQL), as a parent; or none. */
export function suggestParent(raw: string, catalog: Skill[]): Skill | null {
  const k = keyOf(raw);
  let best: [number, Skill] | null = null;
  for (const s of catalog) {
    for (const a of [s.name_key, ...s.aliases]) {
      if (a.length < 2 || a === k) continue;
      if (new RegExp(`(?<![\\p{L}\\p{N}+#])${esc(a)}(?![\\p{L}\\p{N}+#])`, "u").test(k) && (!best || a.length > best[0])) best = [a.length, s];
    }
  }
  return best?.[1] ?? null;
}

/** Readiness for one job: the average, over its must-have skills, of min(rating, TARGET) / TARGET. */
export function readiness(jobSkills: string[], idx: SkillIndex, ratingOf: (id: string) => number | null): number | null {
  const ids = [...new Set(jobSkills.map((r) => idx.match(r)?.id).filter((x): x is string => !!x))];
  if (!jobSkills.length) return null;
  const total = jobSkills.length;
  const sum = ids.reduce((n, id) => n + Math.min(ratingOf(id) ?? 0, TARGET) / TARGET, 0);
  return sum / total;    // unmatched must-haves count as 0 (a skill you don't have listed)
}
