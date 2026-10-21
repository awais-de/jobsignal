-- Tiers, agencies (2026-10-21): a company whose ads are mostly from a staffing firm (BA marks
-- Arbeitnehmerüberlassung / private Arbeitsvermittlung: poster_type 'agency') is an agency too, and the
-- pipeline marks companies on the agency list (sources.yaml) before scoring (mark_agencies).

create or replace function public.mark_agencies(names text[]) returns int
language sql security definer set search_path = ''
as $$
  with m as (
    update public.companies c set is_agency = true, watch = false, discovery_status = 'skipped'
    where c.deleted_at is null and not c.is_agency and not c.manually_edited
      and exists (select 1 from unnest(names) n where lower(c.name) like '%' || lower(n) || '%')
    returning 1)
  select count(*)::int from m;
$$;
revoke all on function public.mark_agencies(text[]) from public, anon, authenticated;
grant execute on function public.mark_agencies(text[]) to service_role;

create or replace function public.score_companies() returns jsonb
language sql security definer set search_path = ''
as $$
  with j as (
    select p.company_key as k,
      count(*) as jobs,
      count(*) filter (where p.poster_type = 'agency') as agency_jobs,
      count(*) filter (where p.title_family is not null and coalesce(p.lane, 'core') = 'core' and p.country = 'DE') as core_de,
      count(*) filter (where p.title_family is not null and coalesce(p.lane, 'core') = 'core' and p.country = 'DE'
                         and p.filter_status = 'passed') as passed_core,
      count(*) filter (where p.title_family is not null and p.lane = 'explore' and p.country = 'DE') as explore_de,
      count(*) filter (where p.source like 'alert%' and p.title_family is not null) as alert_rel,
      max(p.first_seen_at) filter (where p.title_family is not null) as last_relevant
    from public.job_postings p where p.deleted_at is null group by 1),
  a as (select p.company_key as k, count(*) as applied
        from public.applications x join public.job_postings p on p.id = x.job_posting_id where x.deleted_at is null group by 1),
  n as (select public.norm_company(company_name) as k, count(*) as people
        from public.contacts where deleted_at is null and company_name is not null group by 1),
  s as (
    select c.id, c.is_agency, c.manually_edited, coalesce(j.jobs, 0) jobs, coalesce(j.agency_jobs, 0) agency_jobs,
           coalesce(j.core_de, 0) core_de, coalesce(j.passed_core, 0) passed_core,
           coalesce(j.explore_de, 0) explore_de, coalesce(j.alert_rel, 0) alert_rel, coalesce(a.applied, 0) applied,
           coalesce(n.people, 0) people, j.last_relevant
    from public.companies c
    left join j on j.k = public.norm_company(c.name)
    left join a on a.k = public.norm_company(c.name)
    left join n on n.k = public.norm_company(c.name)
    where c.deleted_at is null),
  t as (
    select s.*,
      case when is_agency or (agency_jobs >= 2 and agency_jobs * 2 >= jobs and not manually_edited) then 'agency'
           when applied > 0 or passed_core >= 1 or core_de >= 2 then 'A'
           when core_de = 1 or explore_de >= 1 or (people > 0 and jobs > 0) then 'B'
           else 'C' end as tier,
      10 * applied + 5 * passed_core + 3 * least(core_de, 10) + 2 * least(alert_rel, 5) + least(explore_de, 5)
        + case when people > 0 then 3 else 0 end as score
    from s),
  upd as (
    update public.companies c set tier = t.tier, relevance_score = t.score, tiered_at = now(),
      relevance = jsonb_build_object('applied', t.applied, 'passed_core', t.passed_core, 'core_jobs', t.core_de,
                                     'explore_jobs', t.explore_de, 'alert_jobs', t.alert_rel, 'contacts', t.people,
                                     'jobs', t.jobs, 'agency_jobs', t.agency_jobs, 'last_relevant', t.last_relevant)
    from t where c.id = t.id
      and (c.tier is distinct from t.tier or c.relevance_score <> t.score or c.relevance is null
           or c.relevance->>'jobs' is distinct from t.jobs::text)
    returning c.tier)
  select coalesce(jsonb_object_agg(tier, n), '{}'::jsonb) from (select tier, count(*) n from upd group by 1) x;
$$;
