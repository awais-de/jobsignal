-- Company discovery panel (Feed → Companies; owner request 2026-10-21): one read for the whole panel, and
-- the owner's actions on a company. Discovery itself is unchanged (pipeline/run.py _discover).

create or replace function public.discovery_overview() returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  run record;
  since timestamptz;
  result jsonb;
begin
  if not public.is_owner() then raise exception 'forbidden' using errcode = '42501'; end if;
  select id, started_at, finished_at, status into run from public.pipeline_runs where not dry_run order by started_at desc limit 1;
  since := coalesce(run.started_at, now() - interval '1 day');

  select jsonb_build_object(
    'run', case when run.id is null then null else jsonb_build_object('started_at', run.started_at, 'finished_at', run.finished_at, 'status', run.status) end,
    'counts', (select jsonb_object_agg(s, n) from (select discovery_status s, count(*) n from public.companies where deleted_at is null group by 1) x),
    'watched', (select count(*) from public.companies where deleted_at is null and watch and discovery_status = 'found'),
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
        select id, name, priority > 0 as prioritised, relevant, discovered_from
        from public.companies where deleted_at is null and discovery_status = 'pending' and not is_agency
        order by priority desc, relevant desc, created_at limit 25) q), '[]'::jsonb),
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
revoke all on function public.discovery_overview() from public, anon;
grant execute on function public.discovery_overview() to authenticated, service_role;

-- The owner's actions: prioritise (probe next), retry (probe again now), agency (never probe or watch),
-- watch / unwatch, careers (a career page added by hand: p_value = {"url": …, "pattern": …}).
create or replace function public.company_action(p_id uuid, p_action text, p_value jsonb default null) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if not public.is_owner() then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_action = 'prioritise' then
    update public.companies set priority = 2 where id = p_id and discovery_status = 'pending';
  elsif p_action = 'retry' then
    update public.companies set discovery_status = 'pending', priority = 2, next_check_at = null
     where id = p_id and discovery_status in ('not_found', 'skipped') and not is_agency;
  elsif p_action = 'agency' then
    update public.companies set is_agency = true, discovery_status = 'skipped', watch = false, manually_edited = true where id = p_id;
  elsif p_action = 'watch' then
    update public.companies set watch = true where id = p_id and discovery_status = 'found';
  elsif p_action = 'unwatch' then
    update public.companies set watch = false where id = p_id;
  elsif p_action = 'careers' then
    if coalesce(p_value->>'url', '') !~ '^https?://' then raise exception 'a careers page URL (https://…) is needed'; end if;
    update public.companies set discovery_status = 'found', ats = 'jsonld', feed_type = 'jsonld', watch = true,
           careers_url = p_value->>'url',
           ats_token = coalesce(nullif(p_value->>'pattern', ''), '/(jobs?|stellen[a-z-]*|karriere|careers?|vacanc[a-z]*|positions?|job-offers?)/'),
           is_agency = false, manually_edited = true, discovery_checked_at = now(), notes = 'career page added by hand'
     where id = p_id;
  else
    raise exception 'unknown action %', p_action;
  end if;
end $$;
revoke all on function public.company_action(uuid, text, jsonb) from public, anon;
grant execute on function public.company_action(uuid, text, jsonb) to authenticated;
