-- What was claimed, and why it was declined (owner request 2026-10-21), stored with each application.
--   claimed_german:   the German level the application stated. New applications start with the level in the
--                     master CV (languages, German); editable in the tracker. Skills claimed per job are the
--                     job_skill_levels rows (the job page's "For this job" levels) and are shown alongside.
--   rejection_reason: why the employer declined, as a category; rejection_detail: their sentence. Filled from
--                     the rejection email by the inbox rules (extracted.rejection_reason / rejection_detail),
--                     editable in the tracker.

alter table applications
  add column claimed_german text check (claimed_german in ('A1','A2','B1','B2','C1','C2','native')),
  add column rejection_reason text check (rejection_reason in
    ('german_language','experience','overqualified','profile_fit','other_candidates','position_filled',
     'location_permit','salary','not_given','other')),
  add column rejection_detail text;

-- The German level in the master CV: the CEFR level of the German language record ('B2, working toward C1' → B2).
create or replace function public.master_cv_german() returns text
language sql stable security definer set search_path = ''
as $$
  select case when lv ~* 'mutter|native' then 'native' else upper((regexp_match(lv, '([ABCabc][12])'))[1]) end
  from (select coalesce(i.data->'level'->>'en', i.data->'level'->>'de', '') as lv
        from public.cv_items i
        where i.kind = 'language' and i.deleted_at is null
          and (i.data->'language'->>'en' ilike 'german' or i.data->'language'->>'de' ilike 'deutsch')
        limit 1) g;
$$;
revoke all on function public.master_cv_german() from public, anon, authenticated;

create or replace function public.default_claimed_german() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.claimed_german is null then new.claimed_german := public.master_cv_german(); end if;
  return new;
end $$;
create trigger applications_claimed_german before insert on applications
  for each row execute function public.default_claimed_german();

-- The rejection reason from the email, onto its application (only when none is set: the owner's edit wins).
create or replace function public.apply_rejection_reason(p_email_id uuid) returns void
language sql security definer set search_path = ''
as $$
  update public.applications a
     set rejection_reason = e.extracted->>'rejection_reason',
         rejection_detail = nullif(e.extracted->>'rejection_detail', '')
    from public.inbound_emails e
   where e.id = p_email_id and e.category = 'rejection' and e.application_id = a.id
     and a.rejection_reason is null and coalesce(e.extracted->>'rejection_reason', '') <> '';
$$;
revoke all on function public.apply_rejection_reason(uuid) from public, anon, authenticated;

-- Two paths: the inbox function saves the email's facts after linking it (update), the review queue links an
-- email whose facts are already saved (event insert).
create or replace function public.rejection_reason_from_email() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if tg_table_name = 'inbound_emails' then
    if new.application_id is not null and new.category = 'rejection' then perform public.apply_rejection_reason(new.id); end if;
  elsif new.event_type = 'rejected' and new.inbound_email_id is not null then
    perform public.apply_rejection_reason(new.inbound_email_id);
  end if;
  return null;
end $$;
create trigger inbound_emails_rejection_reason after update of extracted, application_id, category on inbound_emails
  for each row execute function public.rejection_reason_from_email();
create trigger application_events_rejection_reason after insert on application_events
  for each row execute function public.rejection_reason_from_email();
