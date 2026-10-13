-- CV builder (owner request 2026-10-13): base CV versions (uploaded LaTeX, EN/DE), per-job builds
-- compiled to PDF in GitHub Actions, saved to Drive and registered as resume versions.
-- CV content is personal: RLS owner-only, nothing for anon, never in the public repo.

create table base_cvs (
  id          uuid primary key default gen_random_uuid(),
  lang        text not null check (lang in ('de','en')),
  version     int not null,                      -- 1, 2, ... per language
  label       text,
  tex_source  text not null,                     -- the uploaded LaTeX, kept verbatim (also the layout)
  notes       text,
  deleted_at  timestamptz,
  created_at  timestamptz not null default now(),
  unique (lang, version)
);

create table cv_builds (
  id              uuid primary key default gen_random_uuid(),
  job_posting_id  uuid references job_postings(id),
  base_cv_id      uuid references base_cvs(id),
  lang            text not null check (lang in ('de','en')),
  tex_source      text not null,
  plain_text      text,                          -- the CV's text, for prompts and keyword checks
  file_name       text not null,                 -- portal-friendly name, e.g. Lebenslauf_Name_Company.pdf
  status          text not null default 'queued'
                  check (status in ('queued','compiling','compiled','failed','saved')),
  pages           int,
  error           text,                          -- the LaTeX error, private (never in the public logs)
  pdf_path        text,                          -- in the private storage bucket cv-pdfs
  resume_id       uuid references resumes(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index cv_builds_job_idx on cv_builds (job_posting_id, created_at desc);
create trigger cv_builds_updated_at before update on cv_builds for each row execute function set_updated_at();

-- A resume version made by the builder knows its job, base version and source.
alter table resumes add column job_posting_id uuid references job_postings(id);
alter table resumes add column base_cv_id uuid references base_cvs(id);
alter table resumes add column tex_source text;

alter table base_cvs enable row level security;
alter table cv_builds enable row level security;
create policy owner_all on base_cvs for all to authenticated
  using ((select public.is_owner())) with check ((select public.is_owner()));
create policy owner_all on cv_builds for all to authenticated
  using ((select public.is_owner())) with check ((select public.is_owner()));
revoke all on base_cvs, cv_builds from anon, authenticated;
grant select, insert on base_cvs, cv_builds to authenticated;
grant update (label, notes, deleted_at) on base_cvs to authenticated;

-- Compiled PDFs: a private bucket; the owner reads (signed download links), the pipeline writes.
insert into storage.buckets (id, name, public) values ('cv-pdfs', 'cv-pdfs', false) on conflict (id) do nothing;
create policy cv_pdfs_owner_read on storage.objects for select to authenticated
  using (bucket_id = 'cv-pdfs' and (select public.is_owner()));
