-- Job-alert emails as a source (spec 7.1 tier 5; owner request 2026-10-19). The pipeline parses unparsed
-- job_alert emails (sources/alerts.py) and marks them: parsed_at, and how many jobs each held.

alter table inbound_emails add column parsed_at timestamptz;
alter table inbound_emails add column parsed_jobs int;
create index inbound_emails_unparsed_alerts_idx on inbound_emails (received_at) where category = 'job_alert' and parsed_at is null;

-- {email id: number of jobs found}
create or replace function public.mark_alerts_parsed(counts jsonb) returns void
language sql security definer set search_path = ''
as $$
  update public.inbound_emails e set parsed_at = now(), parsed_jobs = (c.value)::int
  from jsonb_each_text(counts) c where e.id = c.key::uuid;
$$;
revoke all on function public.mark_alerts_parsed(jsonb) from public, anon, authenticated;
grant execute on function public.mark_alerts_parsed(jsonb) to service_role;

-- StepStone's job agent only sends jobs: its single-job emails ("Du passt perfekt: …") were filed as other.
update inbound_emails set category = 'job_alert' where from_domain = 'jobagent.stepstone.de' and category = 'other';
