-- Master CV (owner decision 2026-10-14): the uploaded LaTeX is only the format; the content lives here as
-- structured records, every text in German and English ({"de": …, "en": …}).
--   cv_items:  one row per record. section = experience, education, certifications, … ; kind = what the
--              row is within it (company → role → bullet, education → course/thesis/bullet, …).
--              data holds the fields (schema in web/src/cvschema.ts).
--   cv_drafts: the generator's state for one job and format: ticks, copied and edited texts. Never
--              written back to the master.
-- CV content is personal: RLS owner-only, nothing for anon, never in the public repo.

create table cv_items (
  id          uuid primary key default gen_random_uuid(),
  section     text not null,
  kind        text not null,
  parent_id   uuid references cv_items(id) on delete cascade,
  sort        int not null default 0,
  data        jsonb not null default '{}'::jsonb,
  deleted_at  timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index cv_items_section_idx on cv_items (section, sort);
create index cv_items_parent_idx on cv_items (parent_id);
create trigger cv_items_updated_at before update on cv_items for each row execute function set_updated_at();

create table cv_drafts (
  id              uuid primary key default gen_random_uuid(),
  job_posting_id  uuid not null references job_postings(id) on delete cascade,
  base_cv_id      uuid not null references base_cvs(id),
  data            jsonb not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (job_posting_id, base_cv_id)
);
create trigger cv_drafts_updated_at before update on cv_drafts for each row execute function set_updated_at();

alter table cv_items enable row level security;
alter table cv_drafts enable row level security;
create policy owner_all on cv_items for all to authenticated
  using ((select public.is_owner())) with check ((select public.is_owner()));
create policy owner_all on cv_drafts for all to authenticated
  using ((select public.is_owner())) with check ((select public.is_owner()));
revoke all on cv_items, cv_drafts from anon, authenticated;
grant select, insert, update, delete on cv_items, cv_drafts to authenticated;

comment on column base_cvs.tex_source is 'The uploaded LaTeX: the format (layout, section order and styles). Content comes from cv_items.';
