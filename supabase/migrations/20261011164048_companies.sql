-- Phase 6: company registry and discovery (spec 6.2, 7.2).

create table companies (
  id                    uuid primary key default gen_random_uuid(),
  name                  text not null,
  name_normalized       text not null unique,
  website               text,
  careers_url           text,
  ats                   text,                 -- FK to ats_profiles in Phase 7
  ats_token             text,                 -- slug / board token on that ATS
  feed_type             text check (feed_type in ('ats_feed','jsonld','page_diff','none')),
  is_agency             boolean not null default false,
  watch                 boolean not null default false,
  filter_mode           text not null default 'all' check (filter_mode in ('all','watch','none')),
  -- discovery state (spec 7.2)
  discovery_status      text not null default 'pending'
                        check (discovery_status in ('pending','found','not_found','skipped')),
  discovery_checked_at  timestamptz,
  next_check_at         timestamptz,
  verified_name         text,                 -- the name the ATS itself shows (identity check)
  relevant              boolean not null default false,   -- had a posting that passed the filters
  discovered_from       text,                 -- source that first surfaced this employer
  notes                 text,
  manually_edited       boolean not null default false,
  deleted_at            timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index companies_discovery_idx on companies (discovery_status, relevant desc, created_at);
create index companies_watch_idx on companies (watch) where watch and deleted_at is null;
create trigger companies_updated_at before update on companies
  for each row execute function set_updated_at();

-- job_postings.company_id existed since Phase 1 without its FK (spec 6.0).
alter table job_postings add constraint job_postings_company_id_fkey
  foreign key (company_id) references companies(id);

alter table companies enable row level security;
create policy owner_select on companies for select to authenticated using ((select public.is_owner()));
create policy owner_update on companies for update to authenticated
  using ((select public.is_owner())) with check ((select public.is_owner()));
revoke all on companies from anon, authenticated;
grant select on companies to authenticated;
grant update (watch, filter_mode, notes, deleted_at) on companies to authenticated;
