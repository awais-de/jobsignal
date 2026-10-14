import { useCallback, useEffect, useMemo, useState } from "react";
import { currentRatings, SkillIndex, type JobSkills, type Rating, type Skill } from "./skillmath";
import { supabase } from "./supabase";

// Loading the skills database (catalogue, rating history, ignores), shared by the Skills page, the job
// page panel and the CV builder. `withJobs` also loads the analysed job ads for demand.

const SKILL_COLUMNS = "id,name,name_key,parent_id,aliases,category";

async function fetchAll<T>(build: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data as T[]));
    if ((data as T[]).length < 1000) return out;
  }
}

export function useSkills(withJobs = false) {
  const [catalog, setCatalog] = useState<Skill[] | null>(null);
  const [history, setHistory] = useState<Rating[]>([]);
  const [ignored, setIgnored] = useState<Set<string>>(new Set());
  const [jobs, setJobs] = useState<JobSkills[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const since = new Date(Date.now() - 365 * 86400000).toISOString();
      const [c, h, i, j] = await Promise.all([
        fetchAll<Skill>((a, b) => supabase.from("skills").select(SKILL_COLUMNS).is("deleted_at", null).order("name").range(a, b)),
        fetchAll<Rating>((a, b) => supabase.from("skill_ratings").select("skill_id,rating,note,rated_at").order("rated_at").range(a, b)),
        fetchAll<{ raw_key: string }>((a, b) => supabase.from("skill_ignores").select("raw_key").range(a, b)),
        withJobs ? fetchAll<JobSkills>((a, b) => supabase.from("job_postings")
          .select("id,must_have_skills,nice_to_have_skills,lane,title_family,first_seen_at")
          .eq("filter_status", "passed").eq("extraction_status", "done").is("deleted_at", null).gte("first_seen_at", since).range(a, b))
          : Promise.resolve([] as JobSkills[]),
      ]);
      setCatalog(c); setHistory(h); setIgnored(new Set(i.map((x) => x.raw_key))); setJobs(j);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load skills.");
    }
  }, [withJobs]);
  useEffect(() => { load(); }, [load]);

  const index = useMemo(() => (catalog ? new SkillIndex(catalog) : null), [catalog]);
  const ratings = useMemo(() => currentRatings(history), [history]);
  const ratingOf = useCallback((id: string) => ratings.cur.get(id)?.rating ?? null, [ratings]);
  return { catalog, history, ignored, jobs, error, index, ratings, ratingOf, reload: load, setCatalog, setHistory, setIgnored };
}
