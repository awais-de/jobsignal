-- Skills database (owner decisions 2026-10-14): a catalogue of skills (canonical name, aliases, optional
-- parent: T-SQL counts toward SQL), the owner's self-ratings 0-10 with history (a base rating changes only
-- by recording an improvement), skill names from job ads the owner chose to ignore, and per-job
-- "presented levels" (a bump for one job only, never the base). Demand is computed from the job ads'
-- extracted skills. Ranking is unchanged (decision 6). Owner-only; the catalogue is filled from the app.

create table skills (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  name_key    text not null unique,            -- lower(trim(name))
  parent_id   uuid references skills(id),
  aliases     text[] not null default '{}',     -- lower-case variants as written in job ads
  category    text,
  created_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

-- Append-only: the current rating is the latest row; the history shows progress.
create table skill_ratings (
  id        uuid primary key default gen_random_uuid(),
  skill_id  uuid not null references skills(id),
  rating    int not null check (rating between 0 and 10),
  note      text,
  rated_at  timestamptz not null default now()
);
create index skill_ratings_skill_idx on skill_ratings (skill_id, rated_at desc);

create table skill_ignores (
  raw_key     text primary key,                 -- lower(trim(skill as written in the ad))
  created_at  timestamptz not null default now()
);

create table job_skill_levels (
  job_posting_id  uuid not null references job_postings(id),
  skill_id        uuid not null references skills(id),
  presented       int not null check (presented between 0 and 10),
  updated_at      timestamptz not null default now(),
  primary key (job_posting_id, skill_id)
);
create trigger job_skill_levels_updated_at before update on job_skill_levels for each row execute function set_updated_at();

alter table skills enable row level security;
alter table skill_ratings enable row level security;
alter table skill_ignores enable row level security;
alter table job_skill_levels enable row level security;
create policy owner_all on skills for all to authenticated using ((select public.is_owner())) with check ((select public.is_owner()));
create policy owner_all on skill_ratings for all to authenticated using ((select public.is_owner())) with check ((select public.is_owner()));
create policy owner_all on skill_ignores for all to authenticated using ((select public.is_owner())) with check ((select public.is_owner()));
create policy owner_all on job_skill_levels for all to authenticated using ((select public.is_owner())) with check ((select public.is_owner()));
revoke all on skills, skill_ratings, skill_ignores, job_skill_levels from anon, authenticated;
grant select, insert, update on skills to authenticated;
grant select, insert on skill_ratings to authenticated;                 -- history: never edited
grant select, insert, delete on skill_ignores to authenticated;         -- delete = un-ignore
grant select, insert, update, delete on job_skill_levels to authenticated;
