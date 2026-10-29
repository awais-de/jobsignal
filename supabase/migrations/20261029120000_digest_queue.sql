-- No instant emails (owner decision 2026-10-29): the fast lane keeps fetching every 30 minutes, so new jobs
-- are on the portal within ~30 minutes, but instead of emailing them it queues them for the next daily
-- digest. The digest then lists the queued jobs the owner hasn't triaged yet next to its own new ones.

alter table job_postings add column digest_queued_at timestamptz;
create index job_postings_digest_queue_idx on job_postings (digest_queued_at)
  where digest_queued_at is not null and surfaced_on is null;
comment on column job_postings.digest_queued_at is
  'Set by the fast lane for a job it would have shown in the email; the next daily digest lists it (if still untriaged) and clears it.';

-- Time to apply: with the portal as the instant view, the steps are posted → on the portal → applied.
create or replace function public.time_to_apply(p_days int default 60) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare result jsonb;
begin
  if not public.is_owner() then raise exception 'forbidden' using errcode = '42501'; end if;
  with a as (
    select a.applied_at, p.first_seen_at,
           case when p.source in ('ba_api', 'careers') and p.posted_date is not null then p.posted_date::timestamptz end as published
    from public.applications a join public.job_postings p on p.id = a.job_posting_id
    where a.deleted_at is null and a.applied_at is not null and a.applied_at > now() - make_interval(days => p_days)
      and p.source <> 'manual' and a.applied_at >= p.first_seen_at - interval '1 hour'),
  h as (
    select extract(epoch from (first_seen_at - published)) / 3600 as pub_to_seen,
           extract(epoch from (applied_at - first_seen_at)) / 3600 as seen_to_applied,
           extract(epoch from (applied_at - coalesce(published, first_seen_at))) / 3600 as total
    from a)
  select jsonb_build_object(
    'applications', (select count(*) from a),
    'median_hours', jsonb_build_object(
      'published_to_seen', (select round(percentile_cont(0.5) within group (order by pub_to_seen)::numeric, 1) from h where pub_to_seen is not null),
      'seen_to_applied', (select round(percentile_cont(0.5) within group (order by greatest(seen_to_applied, 0))::numeric, 1) from h),
      'total', (select round(percentile_cont(0.5) within group (order by total)::numeric, 1) from h)),
    'last_applied_at', (select max(applied_at) from a),
    -- What waits for the owner: core jobs that passed, not triaged, from the last 14 days.
    'backlog', (select jsonb_build_object('count', count(*),
                  'median_age_hours', round((percentile_cont(0.5) within group (order by extract(epoch from (now() - first_seen_at)) / 3600))::numeric, 0))
                from public.job_postings where filter_status = 'passed' and triage_status = 'new' and deleted_at is null
                  and coalesce(lane, 'core') = 'core' and first_seen_at > now() - interval '14 days'),
    -- The fast lane today: its checks and the jobs it put on the portal (queued for the next digest).
    'fast_today', (select jsonb_build_object('runs', count(*), 'last', max(started_at),
                     'queued', coalesce(sum(coalesce((stats->>'queued')::int, (stats->>'alerted')::int)), 0))
                   from public.pipeline_runs where kind = 'fast' and status = 'success' and started_at > date_trunc('day', now()))
  ) into result;
  return result;
end $$;
revoke all on function public.time_to_apply(int) from public, anon;
grant execute on function public.time_to_apply(int) to authenticated, service_role;
