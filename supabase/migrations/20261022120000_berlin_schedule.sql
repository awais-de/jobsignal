-- Schedules in German time (owner request 2026-10-21: UTC times were confusing). Supabase's pg_cron runs in UTC
-- and its timezone can't be changed on a hosted project, so each job is scheduled for both UTC hours it can
-- fall on (summer: UTC+2, winter: UTC+1) and a guard lets only the run at the intended Berlin time through.
--   07:07 control snapshot, 07:17 daily run, every 30 min 07:00–22:30 fast lane, 06:40 slimming.

create or replace function public.berlin_now() returns timestamp
language sql stable set search_path = '' as $$ select now() at time zone 'Europe/Berlin' $$;

create or replace function public.cron_at_berlin(p_hour int, p_job text) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  -- Only the start that falls on the intended Berlin hour runs; the other one (the wrong UTC offset) does nothing.
  if extract(hour from public.berlin_now()) <> p_hour then return; end if;
  if p_job = 'daily' then perform public.trigger_daily_run();
  elsif p_job = 'snapshot' then perform public.take_control_snapshot();
  elsif p_job = 'slim' then perform public.slim_old_postings();
  else raise exception 'unknown job %', p_job; end if;
end $$;
revoke all on function public.cron_at_berlin(int, text) from public, anon, authenticated;

create or replace function public.cron_fast_berlin() returns void
language plpgsql security definer set search_path = ''
as $$
declare t time := public.berlin_now()::time;
begin
  if t >= time '07:00' and t < time '22:31' then perform public.trigger_fast_run(); end if;
end $$;
revoke all on function public.cron_fast_berlin() from public, anon, authenticated;

select cron.unschedule('jobsignal-control-snapshot');
select cron.unschedule('jobsignal-daily');
select cron.unschedule('jobsignal-fast');
select cron.unschedule('jobsignal-slim');
select cron.schedule('jobsignal-control-snapshot', '7 5,6 * * *',  $c$select public.cron_at_berlin(7, 'snapshot')$c$);
select cron.schedule('jobsignal-daily',            '17 5,6 * * *', $c$select public.cron_at_berlin(7, 'daily')$c$);
select cron.schedule('jobsignal-slim',             '40 4,5 * * *', $c$select public.cron_at_berlin(6, 'slim')$c$);
select cron.schedule('jobsignal-fast',             '*/30 4-21 * * *', $c$select public.cron_fast_berlin()$c$);
