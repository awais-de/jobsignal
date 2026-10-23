-- Market demand per skill, week by week (owner request 2026-10-23): how many companies in each job family
-- mention a skill in the job part of their postings (tasks and profile). Computed by the daily run while the
-- texts still exist (rejected postings lose their text after 14 days), so the history builds up from here.
--   scope 'all'    every source
--   scope 'stable' Arbeitsagentur + Arbeitnow only: coverage that doesn't grow as discovery adds career sites
--   family 'all'   all job families together
--   skill '*'      the totals row (companies and postings in that week, scope and family)

create table skill_demand_weekly (
  week_start  date not null,              -- Monday
  scope       text not null check (scope in ('all', 'stable')),
  family      text not null,
  skill       text not null,
  skill_id    uuid references skills(id) on delete set null,
  generic     boolean not null default false,   -- a broad term (cloud, reporting, APIs): shown, not suggested
  companies   integer not null,
  postings    integer not null,
  computed_at timestamptz not null default now(),
  primary key (week_start, scope, family, skill)
);
create index skill_demand_weekly_family_idx on skill_demand_weekly (family, scope, week_start);

alter table skill_demand_weekly enable row level security;
create policy owner_read on skill_demand_weekly for select to authenticated using ((select public.is_owner()));
revoke all on skill_demand_weekly from anon, authenticated;
grant select on skill_demand_weekly to authenticated;
grant select, insert, update, delete on skill_demand_weekly to service_role;
