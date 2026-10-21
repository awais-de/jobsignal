-- Companies panel: the focus list says which unreadable companies are covered by the Arbeitsagentur employer watch.

create or replace function public.discovery_overview() returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  run record;
  since timestamptz;
  result jsonb;
begin
  if not public.is_owner() then raise exception 'forbidden' using errcode = '42501'; end if;
  select id, started_at, finished_at, status into run from public.pipeline_runs where not dry_run and kind = 'daily' order by started_at desc limit 1;
  since := coalesce(run.started_at, now() - interval '1 day');

  select jsonb_build_object(
    'run', case when run.id is null then null else jsonb_build_object('started_at', run.started_at, 'finished_at', run.finished_at, 'status', run.status) end,
    'counts', (select jsonb_object_agg(s, n) from (select discovery_status s, count(*) n from public.companies where deleted_at is null group by 1) x),
    'watched', (select count(*) from public.companies where deleted_at is null and watch and discovery_status = 'found'
                and coalesce(tier, 'A') in ('A', 'B')),
    -- Relevance groups (score_companies): counts, and the focus list (group A) ranked.
    'tiers', (select jsonb_object_agg(t, n) from (select coalesce(tier, 'new') t, count(*) n from public.companies
              where deleted_at is null group by 1) x),
    'tier_status', (select jsonb_object_agg(t, s) from (select coalesce(tier, 'new') t, jsonb_object_agg(discovery_status, n) s
              from (select tier, discovery_status, count(*) n from public.companies where deleted_at is null group by 1, 2) y group by 1) x),
    'focus', coalesce((select jsonb_agg(f order by f.score desc, f.name) from (
        select id, name, relevance_score as score, discovery_status as status, ats, careers_url, watch, relevance, manually_edited, ba_watch
        from public.companies where deleted_at is null and tier = 'A') f), '[]'::jsonb),
    'queue_relevant', (select count(*) from public.companies where deleted_at is null and discovery_status = 'pending'
                       and not is_agency and coalesce(tier, 'A') in ('A', 'B')),
    'queue_prioritised', (select count(*) from public.companies where deleted_at is null and discovery_status = 'pending' and priority > 0 and not is_agency),
    'retry_due', (select count(*) from public.companies where deleted_at is null and discovery_status = 'not_found' and next_check_at <= now() and not is_agency),
    -- The latest run's checks (live while it runs).
    'checked', coalesce((select jsonb_agg(c order by c.checked_at desc) from (
        select id, name, discovery_status as status, ats, notes, priority > 0 as prioritised, discovery_checked_at as checked_at
        from public.companies where deleted_at is null and discovery_checked_at >= since) c), '[]'::jsonb),
    -- The last 14 days: companies checked per day, and how many of them have a readable career site now.
    'history', coalesce((select jsonb_agg(h order by h.day desc) from (
        select discovery_checked_at::date as day, count(*) as checked, count(*) filter (where discovery_status = 'found') as found
        from public.companies where deleted_at is null and discovery_checked_at > now() - interval '14 days'
        group by 1) h), '[]'::jsonb),
    -- What the pipeline probes next, in its order (pipeline/db.py companies_to_probe).
    'queue', coalesce((select jsonb_agg(q) from (
        select id, name, priority > 0 as prioritised, relevant, discovered_from, tier
        from public.companies where deleted_at is null and discovery_status = 'pending' and not is_agency
          and coalesce(tier, 'A') in ('A', 'B')
        order by priority desc, tier nulls first, relevance_score desc, created_at limit 25) q), '[]'::jsonb),
    -- Employers of alert jobs that have no readable career site: the ones worth adding by hand.
    'alert_not_found', coalesce((select jsonb_agg(a order by a.name) from (
        select id, name, discovery_checked_at as checked_at
        from public.companies where deleted_at is null and discovery_status = 'not_found' and priority > 0) a), '[]'::jsonb),
    -- Watched career sites with their last check and the jobs they brought (30 days).
    'found', coalesce((select jsonb_agg(f order by f.passed desc, f.name) from (
        select c.id, c.name, c.ats, c.careers_url, c.watch, c.notes, c.manually_edited, c.discovery_checked_at as found_at,
               sr.created_at as last_run_at, sr.status as last_status, sr.fetched as last_fetched, sr.error as last_error,
               (select count(*) from public.job_postings p where p.source = 'careers' and p.company_key = public.norm_company(c.name)
                  and p.first_seen_at > now() - interval '30 days') as jobs,
               (select count(*) from public.job_postings p where p.source = 'careers' and p.company_key = public.norm_company(c.name)
                  and p.filter_status = 'passed' and p.first_seen_at > now() - interval '30 days') as passed
        from public.companies c
        left join lateral (select r.created_at, r.status, r.fetched, r.error from public.source_runs r
                           where r.source = 'careers:' || c.name order by r.created_at desc limit 1) sr on true
        where c.deleted_at is null and c.discovery_status = 'found') f), '[]'::jsonb)
  ) into result;
  return result;
end $$;
