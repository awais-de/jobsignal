-- Ghost-job history (owner decision 2026-10-19). Old postings are kept for ghost detection, but slimmed:
-- after their window their description goes (a fingerprint stays), so a row shrinks from ~3.7 KB to
-- ~0.4 KB. Sightings are counted, so a job that vanishes and comes back is visible.
--
--   company_key / family_key: the same role at the same company, whatever the city, source or id
--                             (normalised like pipeline/normalize.py; computed here so old rows have it)
--   description_hash:         fingerprint of the normalised description; survives slimming
--   seen_days:                days on which a source listed it
--   reappear_count:           times it came back after 7+ days unseen (BA: republished; career page: relisted)
--   slimmed_at:               when its description was dropped

-- -- normalisation -----------------------------------------------------------------------------------
create or replace function public.norm_company(name text) returns text
language sql immutable parallel safe set search_path = ''
as $$
  select btrim(regexp_replace(regexp_replace(
    regexp_replace(regexp_replace(
      regexp_replace(lower(coalesce(name, '')), '\y(niederlassung|standort|zweigniederlassung|filiale|branch)\y.*$', ''),
      '(^|[\s,])(gmbh & co\. kgaa|gmbh & co\. kg|gmbh & co kg|ag & co\. kg|se & co\. kg|gmbh|mbh|kgaa|ag|se|kg|ug \(haftungsbeschränkt\)|ug|ohg|gbr|e\.v\.|ev|e\.g\.|eg|inc\.|inc|ltd\.|ltd|llc|b\.v\.|bv|s\.a\.|sa|plc|corp\.|corp|co\.)(?=$|[\s,])', ' ', 'g'),
      '(^|[\s,])(gmbh|mbh|ag|se|kg|co\.|ug)(?=$|[\s,])', ' ', 'g'),
    '[^a-z0-9äöüß]+', ' ', 'g'), '\s+', ' ', 'g'));
$$;

create or replace function public.norm_title(title text) returns text
language sql immutable parallel safe set search_path = ''
as $$
  select btrim(regexp_replace(regexp_replace(
    regexp_replace(regexp_replace(regexp_replace(regexp_replace(lower(coalesce(title, '')),
      '\(\s*([mwfdxi]\s*[/|,\s]\s*){1,3}[mwfdxi]\s*\)', ' ', 'g'),
      '\(\s*(all genders?|gn|d)\s*\)', ' ', 'g'),
      '(\*|:|/-?|_)in(nen)?\y', ' ', 'g'),
      '\y(ref(erenz)?([\s.-]*(nr|no|nummer)\y)?|job[- ]?id|kennziffer)\.?\s*[:#]?\s*[a-z0-9-]*[0-9][a-z0-9-]*', ' ', 'g'),
    '[^a-z0-9äöüß]+', ' ', 'g'), '\s+', ' ', 'g'));
$$;

create or replace function public.norm_text_hash(t text) returns text
language sql immutable parallel safe set search_path = ''
as $$
  select case when t is null or btrim(t) = '' then null
              else md5(btrim(regexp_replace(lower(t), '[^a-z0-9äöüß]+', ' ', 'g'))) end;
$$;

-- -- columns ------------------------------------------------------------------------------------------
alter table job_postings
  add column company_key text generated always as (public.norm_company(company_name)) stored,
  add column family_key  text generated always as (md5(public.norm_company(company_name) || '|' || public.norm_title(title))) stored,
  add column description_hash text,
  add column seen_days int not null default 1,
  add column reappear_count int not null default 0,
  add column slimmed_at timestamptz;
create index job_postings_family_idx on job_postings (family_key);
create index job_postings_company_key_idx on job_postings (company_key);

-- The fingerprint is taken whenever a description is written, before slimming can drop it.
create or replace function public.set_description_hash() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if new.description is not null then new.description_hash := public.norm_text_hash(new.description); end if;
  return new;
end $$;
create trigger job_postings_description_hash before insert or update of description on job_postings
  for each row execute function public.set_description_hash();
update job_postings set description_hash = public.norm_text_hash(description) where description is not null;

-- Rows we have seen on more than one day already (history before this migration).
update job_postings set seen_days = greatest(1, (last_seen_at::date - first_seen_at::date) + 1)
  where last_seen_at::date > first_seen_at::date and source = 'careers';

-- -- sightings ------------------------------------------------------------------------------------------
create or replace function public.touch_postings(ids uuid[]) returns void
language sql set search_path = ''
as $$
  update public.job_postings set
    reappear_count = reappear_count + (last_seen_at < now() - interval '7 days')::int,
    seen_days      = seen_days + (last_seen_at::date < current_date)::int,
    last_seen_at   = now()
  where id = any(ids);
$$;

-- -- slimming (daily, pg_cron) -------------------------------------------------------------------------
-- Kept whole: applied jobs, jobs with notes, rejected jobs for 14 days (the title re-check reads them),
-- passed jobs until 90 days after they were last seen.
create or replace function public.slim_old_postings() returns int
language sql security definer set search_path = ''
as $$
  with slimmed as (
    update public.job_postings p set description = null, slimmed_at = now()
    where p.description is not null and p.notes is null and p.triage_status <> 'applied'
      and not exists (select 1 from public.applications a where a.job_posting_id = p.id)
      and ((p.filter_status <> 'passed' and p.first_seen_at < now() - interval '14 days')
        or (p.filter_status = 'passed' and p.last_seen_at < now() - interval '90 days'))
    returning 1)
  select count(*)::int from slimmed;
$$;
revoke all on function public.slim_old_postings() from public, anon, authenticated;
grant execute on function public.slim_old_postings() to service_role;
select cron.schedule('jobsignal-slim', '40 4 * * *', $$select public.slim_old_postings()$$);

-- -- history for the ghost rules ---------------------------------------------------------------------
-- Per posting: what its family (same company, same role), its company and the owner's applications say.
-- Dates trusted for age: first sightings, and BA's first publication date (posted_date for ba_api).
create or replace function public.ghost_context(ids uuid[])
returns table (
  id uuid, family_first_seen timestamptz, family_first_published date, family_rows int,
  family_gap_reposts int, family_text_reused boolean, family_live_cities int,
  company_reposting_roles int, company_silent_apps int
)
language sql stable security definer set search_path = ''
as $$
  with target as (
    select p.id, p.family_key, p.company_key, p.description_hash, p.first_seen_at
    from public.job_postings p where p.id = any(ids)
  ),
  -- Listings of the same role coming back 14+ days after the previous one (new ids each time).
  gaps as (
    select g.family_key, (count(*) filter (where g.gap > interval '14 days'))::int as gap_reposts
    from (select f.family_key, f.first_seen_at - lag(f.first_seen_at) over (partition by f.family_key order by f.first_seen_at) as gap
          from public.job_postings f where f.family_key in (select family_key from target)) g
    group by g.family_key
  ),
  fam as (
    select t.id,
           min(f.first_seen_at) as first_seen,
           min(f.posted_date) filter (where f.source = 'ba_api') as first_published,
           count(*)::int as n,
           coalesce(bool_or(f.id <> t.id and t.description_hash is not null and f.description_hash = t.description_hash
                            and abs(extract(epoch from f.first_seen_at - t.first_seen_at)) > 14 * 86400), false) as text_reused,
           (count(distinct lower(coalesce(f.city, ''))) filter (where f.last_seen_at > now() - interval '14 days'))::int as live_cities
    from target t join public.job_postings f on f.family_key = t.family_key
    group by t.id
  ),
  comp as (
    select t.id,
           (select count(*)::int from (
              select f.family_key from public.job_postings f
              where f.company_key = t.company_key and f.first_seen_at > now() - interval '120 days'
              group by f.family_key
              having max(f.repost_count) > 0 or max(f.reappear_count) > 0
                  or max(f.first_seen_at) - min(f.first_seen_at) > interval '14 days') r) as reposting_roles,
           (select count(*)::int from public.applications a
              join public.job_postings f on f.id = a.job_posting_id
              left join public.application_status s on s.application_id = a.id
              where f.company_key = t.company_key and a.deleted_at is null
                and a.applied_at < now() - interval '30 days'
                and coalesce(s.status, 'applied') in ('applied', 'confirmation_received', 'no_response')) as silent_apps
    from target t
  )
  select t.id, fam.first_seen, fam.first_published, fam.n, coalesce(gaps.gap_reposts, 0), fam.text_reused, fam.live_cities,
         comp.reposting_roles, comp.silent_apps
  from target t join fam on fam.id = t.id join comp on comp.id = t.id left join gaps on gaps.family_key = t.family_key;
$$;
revoke all on function public.ghost_context(uuid[]) from public, anon, authenticated;
grant execute on function public.ghost_context(uuid[]) to service_role;

-- Ghost scores written in one call per batch: [{id, ghost_score, ghost_bucket, ghost_signals}, …].
create or replace function public.set_ghost_scores(rows jsonb) returns void
language sql security definer set search_path = ''
as $$
  update public.job_postings p set ghost_score = r.ghost_score, ghost_bucket = r.ghost_bucket, ghost_signals = r.ghost_signals
  from jsonb_to_recordset(rows) as r(id uuid, ghost_score int, ghost_bucket text, ghost_signals jsonb)
  where p.id = r.id;
$$;
revoke all on function public.set_ghost_scores(jsonb) from public, anon, authenticated;
grant execute on function public.set_ghost_scores(jsonb) to service_role;
