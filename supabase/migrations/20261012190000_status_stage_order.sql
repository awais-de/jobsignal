-- Status = the latest non-note event, except that 'drafted' and 'applied' never override a later stage
-- (owner report 2026-10-12: the confirmation email arrived a minute before the owner clicked
-- "Mark as applied", so the application showed 'Applied' instead of 'Confirmed').
-- Keep in sync with statusOf in web/src/Applications.tsx.
create or replace view application_status with (security_invoker = true) as
select distinct on (application_id)
  application_id,
  event_type  as status,
  occurred_at as status_at
from application_events
where event_type <> 'note'
order by application_id,
         (event_type in ('drafted', 'applied')),     -- false (a later stage) sorts first
         occurred_at desc, created_at desc;
