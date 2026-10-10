import { sourceLabel, type Posting } from "./supabase";

export type Filters = {
  q: string;
  source: string;                             // "" = any
  remote: "" | "remote" | "hybrid" | "onsite";
  agency: "show" | "hide" | "only";
  salary: boolean;                            // only jobs that state a salary
};

export const EMPTY: Filters = { q: "", source: "", remote: "", agency: "show", salary: false };
const KEY = "jobsignal.feed.filters";

export function loadFilters(): Filters {
  try {
    return { ...EMPTY, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
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

export function applyFilters(rows: Posting[], f: Filters): Posting[] {
  const words = f.q.toLowerCase().split(/\s+/).filter(Boolean);
  return rows.filter((p) => {
    if (f.source && p.source !== f.source) return false;
    if (f.remote && p.remote_policy !== f.remote) return false;
    if (f.agency === "hide" && p.poster_type === "agency") return false;
    if (f.agency === "only" && p.poster_type !== "agency") return false;
    if (f.salary && !p.salary_text) return false;
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

  return (
    <div className="filters">
      <input
        type="search"
        placeholder="Search title, company, city…"
        value={value.q}
        onChange={(e) => set("q", e.target.value)}
        aria-label="Search"
      />
      <select value={value.source} onChange={(e) => set("source", e.target.value)} aria-label="Source">
        <option value="">All sources</option>
        {sources.map((s) => <option key={s} value={s}>{sourceLabel(s)}</option>)}
      </select>
      <select value={value.remote} onChange={(e) => set("remote", e.target.value as Filters["remote"])}
              aria-label="Work mode">
        <option value="">Any work mode</option>
        <option value="remote">Remote</option>
        <option value="hybrid">Hybrid</option>
        <option value="onsite">On-site</option>
      </select>
      <select value={value.agency} onChange={(e) => set("agency", e.target.value as Filters["agency"])}
              aria-label="Agencies">
        <option value="show">Agencies: show</option>
        <option value="hide">Agencies: hide</option>
        <option value="only">Agencies only</option>
      </select>
      <label className="check">
        <input type="checkbox" checked={value.salary} onChange={(e) => set("salary", e.target.checked)} />
        Salary given
      </label>
      <span className="filter-count">
        {isActive(value) ? `${shown} of ${total}` : `${total} jobs`}
        {isActive(value) && <button className="link" onClick={() => onChange(EMPTY)}>Clear</button>}
      </span>
    </div>
  );
}
