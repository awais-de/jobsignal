-- Interview booking confirmations (owner report 2026-10-13: a Microsoft Bookings confirmation was
-- filed as 'other'). New category 'interview_scheduled' -> event 'interview_scheduled'; the interview
-- time read from the email (or its calendar invite) goes to application_events.scheduled_for.
alter table inbound_emails drop constraint if exists inbound_emails_category_check;
alter table inbound_emails add constraint inbound_emails_category_check check (category in (
  'application_confirmation','rejection','interview_invitation','interview_scheduled',
  'assessment','info_request','offer','account_created','job_alert','other'));

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
    when 'interview_scheduled' then 'interview_scheduled'
    when 'assessment' then 'assessment_received'
    when 'info_request' then 'info_requested'
    when 'offer' then 'offer_received'
    else 'note' end;
  insert into public.application_events (application_id, event_type, occurred_at, source, inbound_email_id,
                                         confidence, notes, scheduled_for)
  values (p_application_id, ev, coalesce(em.received_at, now()), 'email', em.id, em.confidence,
          case when ev = 'note' then em.subject end,
          case when ev in ('interview_invited', 'interview_scheduled')
               then nullif(em.extracted->>'interview_at_utc', '')::timestamptz end);
  update public.inbound_emails
     set match_status = 'matched', application_id = p_application_id, classified_by = coalesce(classified_by, 'user'),
         processed_at = now()
   where id = p_email_id;
end;
$$;
revoke all on function assign_inbound_email(uuid, uuid) from public, anon;
grant execute on function assign_inbound_email(uuid, uuid) to authenticated;
