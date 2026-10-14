-- Skills database as the single source of truth (owner decision 2026-10-14): ranking and the CV's skills
-- section read it; the profile's skill list stays only as the pipeline's fallback.
--   from_profile: the skill came from the profile; unrated, it still counts as the owner's (so ranking
--                 doesn't change until the owner rates). Rated: 3+ counts as the owner's.
--   updated_at:   with the rating history, tells the pipeline that skills changed (re-rank).
--   skill_categories: the CV label of each category, German and English, and the row order on the CV.

alter table skills add column from_profile boolean not null default false;
alter table skills add column updated_at timestamptz not null default now();
create trigger skills_updated_at before update on skills for each row execute function set_updated_at();
-- The catalogue was seeded from the profile in one batch.
update skills set from_profile = true where created_at <= (select min(created_at) from skills) + interval '1 minute';

create table skill_categories (
  category  text primary key,
  label_de  text,
  label_en  text,
  cv_order  int not null default 100
);
alter table skill_categories enable row level security;
create policy owner_all on skill_categories for all to authenticated using ((select public.is_owner())) with check ((select public.is_owner()));
revoke all on skill_categories from anon, authenticated;
grant select, insert, update on skill_categories to authenticated;

-- Pipeline: the skills that count as the owner's, with their aliases and the latest rating.
create or replace function public.ranking_skills() returns table (name text, category text, aliases text[], rating int, from_profile boolean, stamp timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  with latest as (
    select distinct on (skill_id) skill_id, rating, rated_at from public.skill_ratings order by skill_id, rated_at desc
  )
  select s.name, coalesce(s.category, 'other'), s.aliases, l.rating, s.from_profile,
         greatest((select max(updated_at) from public.skills), (select max(rated_at) from public.skill_ratings))
  from public.skills s left join latest l on l.skill_id = s.id
  where s.deleted_at is null and (l.rating >= 3 or (l.rating is null and s.from_profile));
$$;
revoke all on function public.ranking_skills() from public, anon, authenticated;
grant execute on function public.ranking_skills() to service_role;
