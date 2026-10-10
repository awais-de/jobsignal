-- Current application status, derived from the latest non-note event (spec 6.6).
-- security_invoker so the view runs under the caller's RLS, never the owner's (spec 6.0).

create view application_status with (security_invoker = true) as
select distinct on (application_id)
  application_id,
  event_type  as status,
  occurred_at as status_at
from application_events
where event_type <> 'note'
order by application_id, occurred_at desc, created_at desc;

revoke all on application_status from anon;
grant select on application_status to authenticated;

-- 'sample' rows are demo data created by hand, not from a pipeline source.
comment on column job_postings.source is
  'Where the posting came from: ba_api, manual, sample (demo data), and later ATS/alert sources.';
