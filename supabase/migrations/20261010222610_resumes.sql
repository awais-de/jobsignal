-- Resume versions (spec 6.4). Registered by hand for now (paste a Drive link);
-- Phase 8 adds automatic registration from the Drive /CVs folder and the parse check.
-- Rows are immutable: an edited CV is a new file and a new row.

create table resumes (
  id             uuid primary key default gen_random_uuid(),
  uid            text not null unique check (uid ~ '^R-\d{6}-(EN|DE)-(1C|2C)-\d{2}$'),
  label          text,
  language       text check (language in ('en','de')),
  drive_file_id  text not null unique,
  drive_url      text,
  file_name      text,
  layout         text check (layout in ('single_column','two_column')),
  parse_status   text not null default 'pending' check (parse_status in ('pending','ok','warning','failed')),
  parse_report   jsonb,
  extracted_text text,
  skills         text[],
  created_at     timestamptz not null default now(),
  deleted_at     timestamptz
);

alter table resumes enable row level security;
create policy owner_select on resumes for select to authenticated using ((select public.is_owner()));
create policy owner_insert on resumes for insert to authenticated with check ((select public.is_owner()));
-- Only soft delete or the label may change; identity columns stay as registered.
create policy owner_update on resumes for update to authenticated
  using ((select public.is_owner())) with check ((select public.is_owner()));
revoke all on resumes from anon;
grant select, insert on resumes to authenticated;
grant update (label, deleted_at) on resumes to authenticated;

-- applications.resume_id existed since Phase 2 without its FK (spec 6.0).
alter table applications add constraint applications_resume_id_fkey
  foreign key (resume_id) references resumes(id);
