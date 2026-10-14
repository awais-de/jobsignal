-- On-time daily run (owner decision 2026-10-14): GitHub's scheduled runs start hours late, so Supabase's
-- scheduler starts the run instead, through the trigger-run function (which starts the GitHub workflow,
-- marked "scheduled": it does nothing if today's run already succeeded). GitHub's crons stay as fallback.
-- The function URL and the shared CRON_SECRET are read from Vault (set outside this public repo).
-- Undo: select cron.unschedule('jobsignal-daily');

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

-- Calls trigger-run. Secrets come from Vault: 'jobsignal_functions_url', 'jobsignal_cron_secret'.
create or replace function public.trigger_daily_run() returns bigint
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
    url := fn_url || '/trigger-run',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', secret),
    body := '{}'::jsonb,
    timeout_milliseconds := 20000);
end;
$$;
revoke all on function public.trigger_daily_run() from public, anon, authenticated;
grant execute on function public.trigger_daily_run() to service_role;

-- Sets the two Vault secrets (called once with the service key; values never appear in the repo).
create or replace function public.set_daily_cron_secrets(p_functions_url text, p_secret text) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing uuid;
begin
  for existing in select id from vault.secrets where name in ('jobsignal_functions_url', 'jobsignal_cron_secret') loop
    delete from vault.secrets where id = existing;
  end loop;
  perform vault.create_secret(p_functions_url, 'jobsignal_functions_url', 'trigger-run base URL for the daily cron');
  perform vault.create_secret(p_secret, 'jobsignal_cron_secret', 'shared secret: daily cron -> trigger-run');
end;
$$;
revoke all on function public.set_daily_cron_secrets(text, text) from public, anon, authenticated;
grant execute on function public.set_daily_cron_secrets(text, text) to service_role;

-- 05:17 UTC every day (07:17 German summer time, 06:17 winter time).
select cron.schedule('jobsignal-daily', '17 5 * * *', 'select public.trigger_daily_run()');
