-- Phase 1: feed core (spec 6.1, 6.10).
-- RLS is enabled in this same migration and nothing is granted to anon or
-- authenticated; only the service role (pipeline) can read or write until the
-- owner policies arrive in Phase 2.

create or replace function set_updated_at() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- job_postings (the hub)
-- FK columns company_id and ats exist now; their constraints are added in
-- Phases 6 and 7 when companies and ats_profiles exist (spec 6.0).
-- ---------------------------------------------------------------------------
create table job_postings (
  id                   uuid primary key default gen_random_uuid(),
  -- identity
  dedupe_hash          text not null,
  source               text not null,
  source_job_id        text,
  source_url           text,
  apply_url            text,
  company_id           uuid,
  -- raw content
  company_name         text not null,
  title                text not null,
  location_raw         text,
  city                 text,
  country              text,
  remote_policy        text check (remote_policy in ('onsite','hybrid','remote')),
  description          text,
  description_missing  boolean not null default false,
  posted_date          date,
  first_seen_at        timestamptz not null default now(),
  last_seen_at         timestamptz not null default now(),
  repost_count         int not null default 0,
  source_data          jsonb,               -- structured fields the source gave us, for later phases
  -- extraction (Phase 3)
  contract_type        text,
  seniority            text,
  required_years       numeric,
  german_level         text,
  english_level        text,
  must_have_skills     text[],
  nice_to_have_skills  text[],
  salary_text          text,
  start_date_text      text,
  reference_number     text,
  named_contact        text,
  specificity_score    int,
  evergreen_language   boolean,
  extraction_status    text not null default 'pending',
  extraction_model     text,
  -- enrichment (Phase 7)
  ats                  text,
  apply_effort         text,
  poster_type          text check (poster_type in ('employer','agency')),
  is_live              boolean,
  liveness_checked_at  timestamptz,
  ghost_score          int,
  ghost_signals        jsonb,
  ghost_bucket         text,
  -- filtering and ranking
  filter_status        text not null default 'pending' check (filter_status in ('pending','passed','rejected')),
  filter_reasons       text[],
  fit_score            numeric,
  rank_score           numeric,
  surfaced_on          date,
  -- triage (Phase 2)
  triage_status        text not null default 'new' check (triage_status in ('new','applied','skipped')),
  skip_reason          text,
  triaged_at           timestamptz,
  -- editing and deletion
  manually_edited      boolean not null default false,
  deleted_at           timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create unique index job_postings_source_job_uidx on job_postings (source, source_job_id) where source_job_id is not null;
create index job_postings_dedupe_hash_idx on job_postings (dedupe_hash);
create index job_postings_surfaced_on_idx on job_postings (surfaced_on);
create index job_postings_triage_idx on job_postings (triage_status) where deleted_at is null;

create trigger job_postings_updated_at before update on job_postings
  for each row execute function set_updated_at();

alter table job_postings enable row level security;

-- ---------------------------------------------------------------------------
-- Operational tables
-- ---------------------------------------------------------------------------
create table pipeline_runs (
  id           uuid primary key default gen_random_uuid(),
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  status       text not null default 'running' check (status in ('running','success','failed')),
  dry_run      boolean not null default false,
  stats        jsonb,
  error        text
);

create table source_runs (
  id               uuid primary key default gen_random_uuid(),
  pipeline_run_id  uuid references pipeline_runs(id),
  source           text not null,
  status           text check (status in ('success','failed','empty')),
  fetched          int,
  inserted         int,
  updated          int,
  duration_ms      int,
  error            text,
  created_at       timestamptz not null default now()
);
create index source_runs_source_idx on source_runs (source, created_at desc);

alter table pipeline_runs enable row level security;
alter table source_runs enable row level security;

-- ---------------------------------------------------------------------------
-- Pipeline helpers (service role only)
-- ---------------------------------------------------------------------------
create or replace function touch_postings(ids uuid[]) returns void
language sql
set search_path = ''
as $$
  update public.job_postings set last_seen_at = now() where id = any(ids);
$$;

create or replace function record_reposts(ids uuid[]) returns void
language sql
set search_path = ''
as $$
  update public.job_postings set repost_count = repost_count + 1 where id = any(ids);
$$;

-- ---------------------------------------------------------------------------
-- Privileges: nothing for anon or authenticated (Phase 2 adds owner policies).
-- ---------------------------------------------------------------------------
revoke all on job_postings, pipeline_runs, source_runs from anon, authenticated;
revoke all on function set_updated_at(), touch_postings(uuid[]), record_reposts(uuid[]) from public, anon, authenticated;
grant execute on function touch_postings(uuid[]), record_reposts(uuid[]) to service_role;
