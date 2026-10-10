-- Phase 2: owner access, edit protection, triage, minimal applications (spec 6.0, 6.5, 6.6, 6.11, 7.10, 7.11).

-- ---------------------------------------------------------------------------
-- Owner. The user id is inserted outside git (it is personal), so the repo
-- never contains it. RLS on, no policies: only the service role can see it.
-- ---------------------------------------------------------------------------
create table app_owner (
  user_id uuid primary key
);
alter table app_owner enable row level security;
revoke all on app_owner from anon, authenticated;

create or replace function is_owner() returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.app_owner where user_id = (select auth.uid()));
$$;
revoke all on function is_owner() from public, anon;
grant execute on function is_owner() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Edit protection (6.11): a non-service session changing a content column
-- marks the row as manually edited. Triage, delete and pipeline bookkeeping
-- columns are excluded.
-- ---------------------------------------------------------------------------
create or replace function flag_manual_edit() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  ignored text[] := array['triage_status','skip_reason','triaged_at','deleted_at','updated_at',
                          'manually_edited','last_seen_at','is_live','liveness_checked_at',
                          'surfaced_on','repost_count'];
begin
  if current_user in ('service_role', 'postgres', 'supabase_admin') then
    return new;
  end if;
  if (to_jsonb(new) - ignored) is distinct from (to_jsonb(old) - ignored) then
    new.manually_edited := true;
  end if;
  return new;
end;
$$;

create trigger job_postings_manual_edit before update on job_postings
  for each row execute function flag_manual_edit();

-- ---------------------------------------------------------------------------
-- Skip reasons (7.11)
-- ---------------------------------------------------------------------------
alter table job_postings add constraint job_postings_skip_reason_check
  check (skip_reason is null or skip_reason in
    ('too_senior','wrong_stack','language','location','contract_type','not_interesting','looks_fake','other'));

-- ---------------------------------------------------------------------------
-- Minimal applications + events (6.5, 6.6). Phase 4 adds the status view and UI.
-- resume_id / portal_account_id / inbound_email_id get their FKs in Phases 8 / 5 / 5.
-- ---------------------------------------------------------------------------
create table applications (
  id                    uuid primary key default gen_random_uuid(),
  job_posting_id        uuid not null unique references job_postings(id),
  resume_id             uuid,
  cover_letter_file_id  text,
  portal_account_id     uuid,
  channel               text,
  applied_at            timestamptz,
  jd_snapshot           text,
  origin                text not null default 'feed' check (origin in ('feed','manual','email_inferred')),
  notes                 text,
  deleted_at            timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create trigger applications_updated_at before update on applications
  for each row execute function set_updated_at();

create table application_events (
  id                uuid primary key default gen_random_uuid(),
  application_id    uuid not null references applications(id),
  event_type        text not null check (event_type in (
                      'drafted','applied','confirmation_received','info_requested','assessment_received',
                      'interview_invited','interview_scheduled','interview_completed','offer_received',
                      'offer_accepted','offer_declined','rejected','withdrawn','no_response','note')),
  occurred_at       timestamptz not null default now(),
  source            text not null check (source in ('user','email','system')),
  inbound_email_id  uuid,
  confidence        numeric,
  notes             text,
  created_at        timestamptz not null default now()
);
create index application_events_app_idx on application_events (application_id, occurred_at desc);

alter table applications enable row level security;
alter table application_events enable row level security;

-- ---------------------------------------------------------------------------
-- Single-use action tokens (6.10, 7.10)
-- ---------------------------------------------------------------------------
create table used_action_tokens (
  token_hash  text primary key,
  posting_id  uuid not null,
  action      text not null,
  used_at     timestamptz not null default now()
);
alter table used_action_tokens enable row level security;
revoke all on used_action_tokens from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Triage (7.11). One function for the web app (owner, under RLS) and the
-- action-link Edge Function (service role).
-- ---------------------------------------------------------------------------
create or replace function triage_posting(p_posting_id uuid, p_action text, p_reason text default null)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  posting public.job_postings%rowtype;
  app_id uuid;
begin
  select * into posting from public.job_postings where id = p_posting_id and deleted_at is null;
  if not found then
    raise exception 'posting not found' using errcode = 'P0002';
  end if;

  if p_action = 'apply' then
    update public.job_postings
       set triage_status = 'applied', skip_reason = null, triaged_at = now()
     where id = p_posting_id;
    insert into public.applications (job_posting_id, jd_snapshot, origin)
    values (p_posting_id, posting.description, 'feed')
    on conflict (job_posting_id) do nothing
    returning id into app_id;
    if app_id is not null then
      insert into public.application_events (application_id, event_type, source)
      values (app_id, 'drafted', 'user');
    end if;
  elsif p_action = 'skip' then
    if posting.triage_status = 'applied' then
      raise exception 'already applied' using errcode = 'P0001';
    end if;
    update public.job_postings
       set triage_status = 'skipped', skip_reason = coalesce(p_reason, 'other'), triaged_at = now()
     where id = p_posting_id;
  elsif p_action = 'reset' then
    if posting.triage_status = 'applied' then
      raise exception 'already applied' using errcode = 'P0001';
    end if;
    update public.job_postings
       set triage_status = 'new', skip_reason = null, triaged_at = null
     where id = p_posting_id;
  else
    raise exception 'unknown action %', p_action using errcode = '22023';
  end if;

  select * into posting from public.job_postings where id = p_posting_id;
  return jsonb_build_object(
    'id', posting.id, 'triage_status', posting.triage_status, 'skip_reason', posting.skip_reason,
    'url', coalesce(posting.apply_url, posting.source_url));
end;
$$;

-- ---------------------------------------------------------------------------
-- Owner policies and grants. anon still gets nothing.
-- ---------------------------------------------------------------------------
create policy owner_select on job_postings for select to authenticated using ((select public.is_owner()));
create policy owner_update on job_postings for update to authenticated
  using ((select public.is_owner())) with check ((select public.is_owner()));

create policy owner_all on applications for all to authenticated
  using ((select public.is_owner())) with check ((select public.is_owner()));
create policy owner_all on application_events for all to authenticated
  using ((select public.is_owner())) with check ((select public.is_owner()));

create policy owner_select on pipeline_runs for select to authenticated using ((select public.is_owner()));
create policy owner_select on source_runs for select to authenticated using ((select public.is_owner()));

grant select, update on job_postings to authenticated;
grant select, insert, update on applications, application_events to authenticated;
grant select on pipeline_runs, source_runs to authenticated;

revoke all on applications, application_events from anon;
revoke all on function flag_manual_edit(), triage_posting(uuid, text, text) from public, anon;
grant execute on function triage_posting(uuid, text, text) to authenticated, service_role;
