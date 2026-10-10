-- Phase 3: LLM cache and metering (spec 6.10, 8.4), ranking details, weekly precision (7.11).

create table llm_cache (
  cache_key   text primary key,          -- sha256(stage + prompt_version + content hash)
  stage       text not null,
  result      jsonb not null,
  created_at  timestamptz not null default now()
);

create table llm_usage (
  id             uuid primary key default gen_random_uuid(),
  stage          text not null,
  provider       text not null,
  model          text not null,
  input_tokens   int,
  output_tokens  int,
  success        boolean not null,
  error          text,
  created_at     timestamptz not null default now()
);
create index llm_usage_created_idx on llm_usage (created_at desc);

alter table llm_cache enable row level security;
alter table llm_usage enable row level security;
-- Pipeline only (service role). The owner may read usage to watch free-tier headroom.
create policy owner_select on llm_usage for select to authenticated using ((select public.is_owner()));
grant select on llm_usage to authenticated;

-- Why a posting ranked where it did: matched / missing must-have skills, bonuses, best CV track.
alter table job_postings add column rank_details jsonb;
create index job_postings_rank_idx on job_postings (rank_score desc nulls last) where filter_status = 'passed';

-- Precision@N per ISO week: of the jobs surfaced in digests, how many were applied to.
create view weekly_precision with (security_invoker = true) as
select
  date_trunc('week', surfaced_on)::date                       as week,
  count(*)                                                     as surfaced,
  count(*) filter (where triage_status = 'applied')            as applied,
  count(*) filter (where triage_status = 'skipped')            as skipped,
  count(*) filter (where triage_status = 'new')                as untriaged,
  round(count(*) filter (where triage_status = 'applied')::numeric
        / nullif(count(*) filter (where triage_status <> 'new'), 0), 3) as precision_triaged
from job_postings
where surfaced_on is not null and deleted_at is null and source <> 'sample'
group by 1;

grant select on weekly_precision to authenticated;
