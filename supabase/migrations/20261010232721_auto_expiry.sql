-- Auto-expiry (spec 10.6): an application whose latest event is 'applied' or
-- 'confirmation_received' and older than p_days gets a 'no_response' event.
-- A later email still matches and writes a new event normally.

create or replace function expire_stale_applications(p_days int)
returns int
language sql
set search_path = ''
as $$
  with stale as (
    insert into public.application_events (application_id, event_type, source, occurred_at, notes)
    select s.application_id, 'no_response', 'system', now(), format('No update for %s days', p_days)
    from public.application_status s
    join public.applications a on a.id = s.application_id
    where a.deleted_at is null
      and s.status in ('applied', 'confirmation_received')
      and s.status_at < now() - make_interval(days => p_days)
    returning 1
  )
  select count(*)::int from stale;
$$;

revoke all on function expire_stale_applications(int) from public, anon, authenticated;
grant execute on function expire_stale_applications(int) to service_role;
