-- When jobs arrive (owner request 2026-10-29), for the Home dashboard:
--   weekday: postings by their posted date, over the last 8 complete weeks (Monday to Sunday, German time)
--   hour:    new jobs by the hour they first reached jobsignal (German time), over the last 28 days, counted
--            only since the fast lane checks every 30 minutes (before that a job's hour was the daily run's)
-- p_scope 'families' = postings in the owner's job families; 'matches' = core jobs that passed the filters.
-- A watched company's first load is left out (its jobs aren't new, only new to jobsignal).

create or replace function public.arrival_pattern(p_scope text default 'families') returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  week_start date := date_trunc('week', public.berlin_now())::date;
  data_from date;
  hours_from timestamptz;
  result jsonb;
begin
  if not public.is_owner() then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_scope not in ('families', 'matches') then raise exception 'bad scope' using errcode = '22023'; end if;
  -- Posted dates before jobsignal started are only the postings still online then (survivors): left out,
  -- and counting starts on the first full week, so every weekday is counted equally often.
  select date_trunc('week', (min(first_seen_at) at time zone 'Europe/Berlin')::date + 8)::date into data_from
    from public.job_postings where source not in ('sample', 'manual');
  select greatest(now() - interval '28 days', min(started_at)) into hours_from
    from public.pipeline_runs where kind = 'fast' and status = 'success';

  with p as (
    select posted_date, first_seen_at, source
    from public.job_postings
    where deleted_at is null and source not in ('sample', 'manual')
      and coalesce(source_data->>'initial_load', 'false') <> 'true'
      and case when p_scope = 'families' then title_family is not null
               else filter_status = 'passed' and coalesce(lane, 'core') = 'core' end),
  days as (
    select extract(isodow from posted_date)::int as d, count(*) as n
    from p where source in ('ba_api', 'careers', 'arbeitnow') and posted_date >= greatest(data_from, week_start - 56)
      and posted_date < week_start
    group by 1),
  hrs as (
    select extract(hour from first_seen_at at time zone 'Europe/Berlin')::int as h, count(*) as n
    from p where hours_from is not null and first_seen_at >= hours_from
    group by 1)
  select jsonb_build_object(
    'scope', p_scope,
    'weekday', (select jsonb_agg(coalesce((select n from days where d = i), 0) order by i) from generate_series(1, 7) i),
    'hour', (select jsonb_agg(coalesce((select n from hrs where h = i), 0) order by i) from generate_series(0, 23) i),
    'weeks', greatest(0, (week_start - greatest(data_from, week_start - 56)) / 7),
    'hours_since', hours_from
  ) into result;
  return result;
end $$;
revoke all on function public.arrival_pattern(text) from public, anon;
grant execute on function public.arrival_pattern(text) to authenticated, service_role;
