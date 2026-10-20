-- Discovery priority (owner request 2026-10-20): companies of StepStone alert jobs that came without a
-- description are probed first, so their employer listing (with the description) is found within days.

alter table companies add column priority int not null default 0;
create index companies_probe_idx on companies (discovery_status, priority desc, relevant desc, created_at);

-- The alert jobs already in the feed without a description.
update companies c set priority = 1
where c.deleted_at is null and c.discovery_status in ('pending', 'not_found') and exists (
  select 1 from job_postings p
  where p.source like 'alert%' and p.filter_status = 'passed' and p.description is null
    and public.norm_company(p.company_name) = public.norm_company(c.name));
