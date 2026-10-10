-- Phase 5: inbox automation (spec 6.7, 6.9, 10).

create table inbound_emails (
  id                uuid primary key default gen_random_uuid(),
  gmail_message_id  text not null unique,          -- idempotency key
  gmail_thread_id   text,
  from_address      text,
  from_name         text,
  from_domain       text,
  to_address        text,
  subject           text,
  received_at       timestamptz,
  body_text         text,                          -- truncated by the bridge; nulled after 12 months
  category          text check (category in ('application_confirmation','rejection','interview_invitation',
                      'assessment','info_request','offer','account_created','job_alert','other')),
  classified_by     text check (classified_by in ('rules','llm','user')),
  confidence        numeric,
  extracted         jsonb,                         -- company, role title, reference number, dates
  match_status      text not null default 'pending'
                    check (match_status in ('pending','matched','unmatched','ignored','auto_created')),
  application_id    uuid references applications(id),
  processed_at      timestamptz,
  created_at        timestamptz not null default now()
);
create index inbound_emails_thread_idx on inbound_emails (gmail_thread_id);
create index inbound_emails_queue_idx on inbound_emails (match_status) where match_status = 'unmatched';

create table portal_accounts (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid,                              -- FK once companies exists (Phase 6)
  company_name  text not null,
  portal_url    text,
  portal_domain text,
  ats           text,                              -- FK once ats_profiles exists (Phase 7)
  login_email   text not null,
  username      text,
  origin        text not null default 'email' check (origin in ('email','manual','backfill')),
  notes         text,
  deleted_at    timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (portal_domain, login_email)
);
create trigger portal_accounts_updated_at before update on portal_accounts
  for each row execute function set_updated_at();

-- FKs that waited for these tables (spec 6.0).
alter table applications add constraint applications_portal_account_id_fkey
  foreign key (portal_account_id) references portal_accounts(id);
alter table application_events add constraint application_events_inbound_email_id_fkey
  foreign key (inbound_email_id) references inbound_emails(id);

-- RLS and grants: the owner reads both, edits portal accounts, and resolves the email queue
-- only through assign_inbound_email(). Never any passwords in portal_accounts (spec 6.7).
alter table inbound_emails enable row level security;
alter table portal_accounts enable row level security;
create policy owner_select on inbound_emails for select to authenticated using ((select public.is_owner()));
create policy owner_all on portal_accounts for all to authenticated
  using ((select public.is_owner())) with check ((select public.is_owner()));
revoke all on inbound_emails, portal_accounts from anon, authenticated;
grant select on inbound_emails to authenticated;
grant select, insert, update on portal_accounts to authenticated;

-- One-click queue resolution (spec 9.5): assign an unmatched email to an application
-- (writes the matching event) or ignore it (p_application_id null).
create or replace function assign_inbound_email(p_email_id uuid, p_application_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  em public.inbound_emails%rowtype;
  ev text;
begin
  if not public.is_owner() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into em from public.inbound_emails where id = p_email_id;
  if not found then
    raise exception 'email not found' using errcode = 'P0002';
  end if;
  if p_application_id is null then
    update public.inbound_emails set match_status = 'ignored', processed_at = now() where id = p_email_id;
    return;
  end if;
  ev := case em.category
    when 'application_confirmation' then 'confirmation_received'
    when 'rejection' then 'rejected'
    when 'interview_invitation' then 'interview_invited'
    when 'assessment' then 'assessment_received'
    when 'info_request' then 'info_requested'
    when 'offer' then 'offer_received'
    else 'note' end;
  insert into public.application_events (application_id, event_type, occurred_at, source, inbound_email_id, confidence, notes)
  values (p_application_id, ev, coalesce(em.received_at, now()), 'email', em.id, em.confidence,
          case when ev = 'note' then em.subject end);
  update public.inbound_emails
     set match_status = 'matched', application_id = p_application_id, classified_by = coalesce(classified_by, 'user'),
         processed_at = now()
   where id = p_email_id;
end;
$$;
revoke all on function assign_inbound_email(uuid, uuid) from public, anon;
grant execute on function assign_inbound_email(uuid, uuid) to authenticated;

-- Retention (spec 13): email bodies are kept for 12 months.
create or replace function purge_old_email_bodies(p_months int default 12)
returns int
language sql
set search_path = ''
as $$
  with purged as (
    update public.inbound_emails set body_text = null
     where body_text is not null and received_at < now() - make_interval(months => p_months)
    returning 1
  )
  select count(*)::int from purged;
$$;
revoke all on function purge_old_email_bodies(int) from public, anon, authenticated;
grant execute on function purge_old_email_bodies(int) to service_role;
