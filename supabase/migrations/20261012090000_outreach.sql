-- Outreach (spec 6.8, 11.5): people to ping after applying, and the pings sent.
-- Contacts come from job ads (named contact), the owner's LinkedIn connections export, or by hand.
-- Personal data of third parties: RLS owner-only, nothing for anon, never in the public repo.

create table contacts (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid references companies(id),
  company_name  text,                  -- as written in the source; matched to jobs by normalised name
  full_name     text not null,
  role_title    text,
  contact_type  text check (contact_type in ('recruiter','hiring_manager','team_member','referral','other')),
  source        text not null default 'manual' check (source in ('job_ad','connections','manual','email')),
  linkedin_url  text unique,           -- connections import upserts on this
  email         text,
  phone         text,
  connected_on  date,                  -- LinkedIn connection date (connections import)
  notes         text,
  deleted_at    timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index contacts_company_idx on contacts (lower(company_name)) where deleted_at is null;
create trigger contacts_updated_at before update on contacts
  for each row execute function set_updated_at();

create table outreach (
  id              uuid primary key default gen_random_uuid(),
  application_id  uuid references applications(id),
  contact_id      uuid not null references contacts(id),
  channel         text not null check (channel in ('linkedin','email','phone','other')),
  sent_at         timestamptz not null default now(),
  message_text    text,
  status          text not null default 'sent' check (status in ('sent','replied','no_reply')),
  follow_up_due   date default ((now() at time zone 'Europe/Berlin')::date + 7),
  followed_up_at  timestamptz,
  replied_at      timestamptz,
  deleted_at      timestamptz,
  created_at      timestamptz not null default now()
);
create index outreach_application_idx on outreach (application_id) where deleted_at is null;
create index outreach_follow_up_idx on outreach (follow_up_due) where deleted_at is null and status = 'sent';

alter table contacts enable row level security;
alter table outreach enable row level security;
create policy owner_all on contacts for all to authenticated
  using ((select public.is_owner())) with check ((select public.is_owner()));
create policy owner_all on outreach for all to authenticated
  using ((select public.is_owner())) with check ((select public.is_owner()));
revoke all on contacts, outreach from anon, authenticated;
grant select, insert, update on contacts, outreach to authenticated;
