-- Control panel (owner request 2026-10-14): the app's own health, separate from the job search.
-- control_status(): database-side facts (sizes, scheduler, runs, sources, inbox, backlog), for the
-- `control` Edge Function, which adds GitHub, Drive and configuration, computes the warnings and stores
-- a snapshot. A cron job takes a snapshot at 05:07 UTC so the 05:17 digest can carry the warnings.

create table control_snapshots (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  status      jsonb not null,           -- everything the panel shows
  warnings    jsonb not null            -- [{level: 'red'|'amber', area, text}]
);
create index control_snapshots_created_idx on control_snapshots (created_at desc);
alter table control_snapshots enable row level security;
create policy owner_select on control_snapshots for select to authenticated using ((select public.is_owner()));
revoke all on control_snapshots from anon, authenticated;
grant select on control_snapshots to authenticated;

-- The email bridge reports its version with every message (apps-script/Code.gs BRIDGE_VERSION).
alter table inbound_emails add column bridge_version text;

create or replace function public.control_status() returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  result jsonb;
begin
  if not (public.is_owner() or (select auth.role()) = 'service_role') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select jsonb_build_object(
    'checked_at', now(),
    'db_bytes', pg_database_size(current_database()),
    'tables', (select coalesce(jsonb_agg(t order by t.bytes desc), '[]') from (
        select c.relname as name, pg_total_relation_size(c.oid) as bytes, c.reltuples::bigint as rows
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r' order by 2 desc limit 8) t),
    'storage', (select coalesce(jsonb_agg(s), '[]') from (
        select bucket_id as bucket, count(*) as files, coalesce(sum((metadata->>'size')::bigint), 0) as bytes
        from storage.objects group by bucket_id) s),
    'cron', (select coalesce(jsonb_agg(r order by r.start_time desc), '[]') from (
        select j.jobname, d.status, d.start_time, d.end_time, left(d.return_message, 200) as message
        from cron.job_run_details d join cron.job j on j.jobid = d.jobid
        where d.start_time > now() - interval '3 days' order by d.start_time desc limit 12) r),
    'cron_jobs', (select coalesce(jsonb_agg(jsonb_build_object('name', jobname, 'schedule', schedule, 'active', active)), '[]')
                  from cron.job),
    'http', (select coalesce(jsonb_agg(h order by h.created desc), '[]') from (
        select status_code, created, left(coalesce(error_msg, ''), 200) as error
        from net._http_response order by created desc limit 5) h),
    'runs', (select coalesce(jsonb_agg(r order by r.started_at desc), '[]') from (
        select started_at, finished_at, status, left(coalesce(error, ''), 300) as error,
               stats->'fetched' as fetched, stats->'passed' as passed, stats->'passed_explore' as passed_explore,
               stats->'surfaced' as surfaced, stats->'llm_calls' as llm_calls, stats->'failed_sources' as failed_sources
        from public.pipeline_runs where not dry_run order by started_at desc limit 10) r),
    'sources', (select coalesce(jsonb_agg(s), '[]') from (
        select source, count(*) filter (where status = 'failed') as failed, count(*) as runs,
               max(created_at) filter (where status <> 'failed') as last_ok,
               (array_agg(status order by created_at desc))[1:3] as last3
        from public.source_runs where created_at > now() - interval '7 days' group by source) s),
    'inbox', jsonb_build_object(
        'last_at', (select max(created_at) from public.inbound_emails),
        'total', (select count(*) from public.inbound_emails),
        'unmatched', (select count(*) from public.inbound_emails where match_status = 'unmatched'),
        'today', (select coalesce(jsonb_object_agg(category, n), '{}') from (
            select category, count(*) n from public.inbound_emails
            where created_at > date_trunc('day', now()) group by category) c),
        'bridge_version', (select bridge_version from public.inbound_emails where bridge_version is not null
                           order by created_at desc limit 1)),
    'backlog', jsonb_build_object(
        'core', (select count(*) from public.job_postings where filter_status = 'passed' and deleted_at is null
                 and extraction_status in ('pending','failed') and description is not null and coalesce(lane,'core') = 'core'),
        'explore', (select count(*) from public.job_postings where filter_status = 'passed' and deleted_at is null
                 and extraction_status in ('pending','failed') and description is not null and lane = 'explore')),
    'discovery', (select coalesce(jsonb_object_agg(discovery_status, n), '{}') from (
        select discovery_status, count(*) n from public.companies where deleted_at is null group by 1) d),
    'cv_builds', (select coalesce(jsonb_object_agg(status, n), '{}') from (
        select status, count(*) n from public.cv_builds group by 1) b),
    'cv_last_saved', (select max(created_at) from public.resumes where tex_source is not null),
    'counts', jsonb_build_object(
        'jobs', (select count(*) from public.job_postings),
        'applications', (select count(*) from public.applications where deleted_at is null),
        'contacts', (select count(*) from public.contacts where deleted_at is null),
        'emails', (select count(*) from public.inbound_emails)),
    'profile_version', (select version from public.owner_profile where id = 1)
  ) into result;
  return result;
end;
$$;
revoke all on function public.control_status() from public, anon;
grant execute on function public.control_status() to authenticated, service_role;

-- Old compiled CV PDFs that were never saved to Drive (the panel's clean-up button).
create or replace function public.unsaved_cv_pdfs(p_days int default 14) returns table (id uuid, pdf_path text)
language sql
stable
security definer
set search_path = ''
as $$
  select id, pdf_path from public.cv_builds
  where status in ('compiled', 'failed') and pdf_path is not null and created_at < now() - make_interval(days => p_days);
$$;
revoke all on function public.unsaved_cv_pdfs(int) from public, anon, authenticated;
grant execute on function public.unsaved_cv_pdfs(int) to service_role;

-- Snapshot before the digest: 05:07 UTC, ten minutes before the daily run.
create or replace function public.take_control_snapshot() returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  fn_url text := (select decrypted_secret from vault.decrypted_secrets where name = 'jobsignal_functions_url');
  secret text := (select decrypted_secret from vault.decrypted_secrets where name = 'jobsignal_cron_secret');
begin
  if fn_url is null or secret is null then
    raise exception 'jobsignal cron secrets are not set in Vault';
  end if;
  return net.http_post(
    url := fn_url || '/control',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', secret),
    body := '{"action":"snapshot"}'::jsonb,
    timeout_milliseconds := 30000);
end;
$$;
revoke all on function public.take_control_snapshot() from public, anon, authenticated;
grant execute on function public.take_control_snapshot() to service_role;
select cron.schedule('jobsignal-control-snapshot', '7 5 * * *', 'select public.take_control_snapshot()');
