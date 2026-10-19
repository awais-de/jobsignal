-- Ad-hoc CVs (owner request 2026-10-19): the CV generator without a job, for CVs made whenever needed
-- ("General DE", "Research EN"). Such a draft has a name instead of a job; its builds point at it.

alter table cv_drafts alter column job_posting_id drop not null;
alter table cv_drafts add column name text;
alter table cv_drafts add constraint cv_drafts_job_or_name check (job_posting_id is not null or name is not null);

alter table cv_builds add column cv_draft_id uuid references cv_drafts(id) on delete set null;
create index cv_builds_draft_idx on cv_builds (cv_draft_id, created_at desc);
