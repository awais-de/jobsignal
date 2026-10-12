-- Outreach before applying (owner request 2026-10-12): a ping belongs to the job; application_id is
-- filled when the job has an application. Queries go by job_posting_id so pre-apply pings stay
-- attached after applying.
alter table outreach add column job_posting_id uuid references job_postings(id);
update outreach o set job_posting_id = a.job_posting_id from applications a where a.id = o.application_id;
alter table outreach alter column job_posting_id set not null;
create index outreach_job_idx on outreach (job_posting_id) where deleted_at is null;
