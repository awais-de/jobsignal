-- Fast lane (owner request 2026-10-21: "notify the moment a new job lands"). Every 30 minutes during the day
-- (05:00-20:30 UTC = 07:00-22:30 German time) a fast run reads the quick sources (Arbeitsagentur published
-- today, Arbeitnow, StepStone alerts, group-A career sites), analyses what's new and sends an instant email.
-- The daily run keeps everything else. Runs get a kind, so the daily run's "already ran today" check and
-- the panels that show "the last run" only look at daily runs.
--   job_postings.notified_at: when the owner was told about the job (instant alert or digest): the
--   time-to-apply funnel on Home measures from it.

alter table pipeline_runs add column kind text not null default 'daily' check (kind in ('daily', 'fast'));
create index pipeline_runs_kind_idx on pipeline_runs (kind, started_at desc);
alter table job_postings add column notified_at timestamptz;

create or replace function public.trigger_fast_run() returns bigint
language plpgsql security definer set search_path = ''
as $$
declare
  fn_url text := (select decrypted_secret from vault.decrypted_secrets where name = 'jobsignal_functions_url');
  secret text := (select decrypted_secret from vault.decrypted_secrets where name = 'jobsignal_cron_secret');
begin
  if fn_url is null or secret is null then raise exception 'jobsignal cron secrets are not set in Vault'; end if;
  return net.http_post(url := fn_url || '/trigger-run',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', secret),
    body := '{"workflow": "fast"}'::jsonb, timeout_milliseconds := 20000);
end $$;
revoke all on function public.trigger_fast_run() from public, anon, authenticated;
grant execute on function public.trigger_fast_run() to service_role;
select cron.schedule('jobsignal-fast', '*/30 5-20 * * *', $c$select public.trigger_fast_run()$c$);

-- Time to apply (Home): per application, published → seen → notified → applied, and the untriaged backlog.
-- Published counts only dates a repost can't reset (BA's first publication; a company site's own date).
create or replace function public.time_to_apply(p_days int default 60) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare result jsonb;
begin
  if not public.is_owner() then raise exception 'forbidden' using errcode = '42501'; end if;
  with a as (
    select p.company_name, p.title, p.source, a.applied_at, p.first_seen_at, p.notified_at,
           case when p.source in ('ba_api', 'careers') and p.posted_date is not null then p.posted_date::timestamptz end as published
    from public.applications a join public.job_postings p on p.id = a.job_posting_id
    where a.deleted_at is null and a.applied_at is not null and a.applied_at > now() - make_interval(days => p_days)
      and p.source <> 'manual' and a.applied_at >= p.first_seen_at - interval '1 hour'),
  h as (
    select extract(epoch from (first_seen_at - published)) / 3600 as pub_to_seen,
           extract(epoch from (notified_at - first_seen_at)) / 3600 as seen_to_notified,
           extract(epoch from (applied_at - coalesce(notified_at, first_seen_at))) / 3600 as notified_to_applied,
           extract(epoch from (applied_at - coalesce(published, first_seen_at))) / 3600 as total
    from a)
  select jsonb_build_object(
    'applications', (select count(*) from a),
    'median_hours', jsonb_build_object(
      'published_to_seen', (select round(percentile_cont(0.5) within group (order by pub_to_seen)::numeric, 1) from h where pub_to_seen is not null),
      'seen_to_notified', (select round(percentile_cont(0.5) within group (order by seen_to_notified)::numeric, 1) from h where seen_to_notified is not null),
      'notified_to_applied', (select round(percentile_cont(0.5) within group (order by notified_to_applied)::numeric, 1) from h),
      'total', (select round(percentile_cont(0.5) within group (order by total)::numeric, 1) from h)),
    'last_applied_at', (select max(applied_at) from a),
    -- What waits for the owner: core jobs that passed, not triaged, from the last 14 days.
    'backlog', (select jsonb_build_object('count', count(*),
                  'median_age_hours', round((percentile_cont(0.5) within group (order by extract(epoch from (now() - first_seen_at)) / 3600))::numeric, 0))
                from public.job_postings where filter_status = 'passed' and triage_status = 'new' and deleted_at is null
                  and coalesce(lane, 'core') = 'core' and first_seen_at > now() - interval '14 days'),
    -- The fast lane today: instant alerts and how quickly they followed the first sighting.
    'fast_today', (select jsonb_build_object('runs', count(*), 'last', max(started_at),
                     'alerted', coalesce(sum((stats->>'alerted')::int), 0))
                   from public.pipeline_runs where kind = 'fast' and status = 'success' and started_at > date_trunc('day', now())),
    'notified_today', (select count(*) from public.job_postings where notified_at > date_trunc('day', now()))
  ) into result;
  return result;
end $$;
revoke all on function public.time_to_apply(int) from public, anon;
grant execute on function public.time_to_apply(int) to authenticated, service_role;

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
        select id, name, relevance_score as score, discovery_status as status, ats, careers_url, watch, relevance, manually_edited
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
