import { sourceLabel, type Posting } from "./supabase";

// Feed filters: what matters for deciding to apply. Work mode and agency are shown on each
// card instead of being filters.

export type Filters = {
  q: string;
  source: string;            // "" = any
  postedDays: number;        // 0 = any
  minMatch: number;          // 0 = any; share of must-haves the owner has, in %
  skills: string;            // comma-separated: the posting must ask for all of them
  maxYears: number;          // 0 = any
  level: string;             // "" = any; junior | mid | senior | lead
  german: string;            // "" = any; "none" = not required; else max CEFR level
};

export const EMPTY: Filters = { q: "", source: "", postedDays: 0, minMatch: 0, skills: "", maxYears: 0, level: "", german: "" };
const KEY = "jobsignal.feed.filters.v2";
const CEFR = ["A1", "A2", "B1", "B2", "C1", "C2"];

export function loadFilters(): Filters {
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return Object.fromEntries(Object.keys(EMPTY).map((k) => [k, stored[k] ?? EMPTY[k as keyof Filters]])) as Filters;
  } catch {
    return EMPTY;
  }
}

export function saveFilters(f: Filters): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(f));
  } catch {
    /* per-browser convenience only */
  }
}

export function isActive(f: Filters): boolean {
  return JSON.stringify(f) !== JSON.stringify(EMPTY);
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

export function applyFilters(rows: Posting[], f: Filters): Posting[] {
  const words = f.q.toLowerCase().split(/\s+/).filter(Boolean);
  const wanted = f.skills.split(",").map(norm).filter(Boolean);
  const since = f.postedDays ? Date.now() - f.postedDays * 86400000 : 0;

  return rows.filter((p) => {
    if (f.source && p.source !== f.source) return false;

    if (since) {
      const posted = p.posted_date ? new Date(p.posted_date + "T23:59:59").getTime() : new Date(p.first_seen_at).getTime();
      if (posted < since) return false;
    }

    const matched = p.rank_details?.matched ?? [];
    const missing = p.rank_details?.missing ?? [];
    if (f.minMatch) {
      const total = matched.length + missing.length;
      if (!total || (100 * matched.length) / total < f.minMatch) return false;
    }

    if (wanted.length) {
      const asked = [...(p.must_have_skills ?? []), ...(p.nice_to_have_skills ?? [])].map(norm);
      // 'dbt' matches 'dbt Cloud'; 'power bi' matches 'Microsoft Power BI'
      if (!wanted.every((w) => asked.some((a) => a === w || a.includes(w)))) return false;
    }

    if (f.maxYears && p.required_years != null && p.required_years > f.maxYears) return false;
    if (f.level && p.seniority !== f.level) return false;

    if (f.german === "none") {
      if (p.german_level !== "none") return false;
    } else if (f.german) {
      const lvl = p.german_level;
      if (lvl && lvl !== "none" && CEFR.indexOf(lvl) > CEFR.indexOf(f.german)) return false;
    }

    if (words.length) {
      const hay = `${p.title} ${p.company_name} ${p.city ?? ""} ${p.location_raw ?? ""}`.toLowerCase();
      if (!words.every((w) => hay.includes(w))) return false;
    }
    return true;
  });
}

export default function FilterBar({ value, onChange, sources, shown, total }: {
  value: Filters;
  onChange: (f: Filters) => void;
  sources: string[];
  shown: number;
  total: number;
}) {
  const set = <K extends keyof Filters>(k: K, v: Filters[K]) => onChange({ ...value, [k]: v });
  const num = (e: React.ChangeEvent<HTMLSelectElement>) => Number(e.target.value);

  return (
    <div className="filters">
      <select value={value.postedDays} onChange={(e) => set("postedDays", num(e))} aria-label="Posted">
        <option value={0}>Posted: any time</option>
        <option value={1}>Posted: last 24 h</option>
        <option value={3}>Posted: last 3 days</option>
        <option value={7}>Posted: last 7 days</option>
        <option value={14}>Posted: last 14 days</option>
      </select>
      <select value={value.minMatch} onChange={(e) => set("minMatch", num(e))} aria-label="Skill match">
        <option value={0}>Skill match: any</option>
        <option value={25}>Skill match ≥ 25%</option>
        <option value={50}>Skill match ≥ 50%</option>
        <option value={75}>Skill match ≥ 75%</option>
      </select>
      <input className="skills-input" type="search" placeholder="Skills, e.g. dbt, airflow" value={value.skills}
             onChange={(e) => set("skills", e.target.value)} aria-label="Required skills" />
      <select value={value.maxYears} onChange={(e) => set("maxYears", num(e))} aria-label="Experience required">
        <option value={0}>Experience: any</option>
        <option value={1}>≤ 1 year</option>
        <option value={2}>≤ 2 years</option>
        <option value={3}>≤ 3 years</option>
        <option value={4}>≤ 4 years</option>
      </select>
      <select value={value.level} onChange={(e) => set("level", e.target.value)} aria-label="Seniority">
        <option value="">Level: any</option>
        <option value="junior">Junior</option>
        <option value="mid">Mid</option>
        <option value="senior">Senior</option>
        <option value="lead">Lead</option>
      </select>
      <select value={value.german} onChange={(e) => set("german", e.target.value)} aria-label="German level">
        <option value="">German: any</option>
        <option value="none">German not required</option>
        <option value="B1">German up to B1</option>
        <option value="B2">German up to B2</option>
        <option value="C1">German up to C1</option>
      </select>
      <input type="search" placeholder="Search title, company, city…" value={value.q}
             onChange={(e) => set("q", e.target.value)} aria-label="Search" />
      {sources.length > 1 && (
        <select value={value.source} onChange={(e) => set("source", e.target.value)} aria-label="Source">
          <option value="">All sources</option>
          {sources.map((s) => <option key={s} value={s}>{sourceLabel(s)}</option>)}
        </select>
      )}
      <span className="filter-count">
        {isActive(value) ? `${shown} of ${total}` : `${total} jobs`}
        {isActive(value) && <button className="link" onClick={() => onChange(EMPTY)}>Clear</button>}
      </span>
    </div>
  );
}
