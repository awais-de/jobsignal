import { useCallback, useEffect, useMemo, useState } from "react";
import { currentRatings, SkillIndex, type JobSkills, type Rating, type Skill } from "./skillmath";
import { supabase } from "./supabase";

// Loading the skills database (catalogue, rating history, ignores), shared by the Skills page, the job
// page panel and the CV builder. `withJobs` also loads the analysed job ads for demand.

const SKILL_COLUMNS = "id,name,name_key,parent_id,aliases,category,from_profile";

async function fetchAll<T>(build: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data as T[]));
    if ((data as T[]).length < 1000) return out;
  }
}

// Ranking reads the skills database, so changes there re-rank the jobs: one re-rank about a minute after
// the last change, not one per click (the re-rank workflow shares the daily run's queue).
let rerankTimer: ReturnType<typeof setTimeout> | undefined;
const rerankListeners = new Set<(pending: boolean) => void>();
export function scheduleRerank() {
  clearTimeout(rerankTimer);
  rerankListeners.forEach((f) => f(true));
  rerankTimer = setTimeout(async () => {
    rerankTimer = undefined;
    await supabase.functions.invoke("trigger-run", { body: { workflow: "rerank" } });
    rerankListeners.forEach((f) => f(false));
  }, 60_000);
}
export function useRerankPending() {
  const [pending, setPending] = useState(!!rerankTimer);
  useEffect(() => { rerankListeners.add(setPending); return () => { rerankListeners.delete(setPending); }; }, []);
  return pending;
}

export type Category = { category: string; label_de: string | null; label_en: string | null; cv_order: number };

export function useSkills(withJobs = false) {
  const [catalog, setCatalog] = useState<Skill[] | null>(null);
  const [history, setHistory] = useState<Rating[]>([]);
  const [ignored, setIgnored] = useState<Set<string>>(new Set());
  const [jobs, setJobs] = useState<JobSkills[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const since = new Date(Date.now() - 365 * 86400000).toISOString();
      const [c, h, i, j, cats] = await Promise.all([
        fetchAll<Skill>((a, b) => supabase.from("skills").select(SKILL_COLUMNS).is("deleted_at", null).order("name").range(a, b)),
        fetchAll<Rating>((a, b) => supabase.from("skill_ratings").select("skill_id,rating,note,rated_at").order("rated_at").range(a, b)),
        fetchAll<{ raw_key: string }>((a, b) => supabase.from("skill_ignores").select("raw_key").range(a, b)),
        withJobs ? fetchAll<JobSkills>((a, b) => supabase.from("job_postings")
          .select("id,must_have_skills,nice_to_have_skills,lane,title_family,first_seen_at")
          .eq("filter_status", "passed").eq("extraction_status", "done").is("deleted_at", null).gte("first_seen_at", since).range(a, b))
          : Promise.resolve([] as JobSkills[]),
        fetchAll<Category>((a, b) => supabase.from("skill_categories").select("category,label_de,label_en,cv_order").range(a, b)),
      ]);
      setCatalog(c); setHistory(h); setIgnored(new Set(i.map((x) => x.raw_key))); setJobs(j); setCategories(cats);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load skills.");
    }
  }, [withJobs]);
  useEffect(() => { load(); }, [load]);

  const index = useMemo(() => (catalog ? new SkillIndex(catalog) : null), [catalog]);
  const ratings = useMemo(() => currentRatings(history), [history]);
  const ratingOf = useCallback((id: string) => ratings.cur.get(id)?.rating ?? null, [ratings]);
  /** Counts as the owner's skill (ranking, CV): rated 3+, or unrated but from the profile. Same rule as ranking_skills(). */
  const isMine = useCallback((s: { id: string; from_profile?: boolean }) => {
    const r = ratings.cur.get(s.id)?.rating;
    return r == null ? !!s.from_profile : r >= 3;
  }, [ratings]);
  return { catalog, history, ignored, jobs, categories, error, index, ratings, ratingOf, isMine, reload: load,
           setCatalog, setHistory, setIgnored, setCategories };
}
