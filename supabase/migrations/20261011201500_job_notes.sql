-- Per-job notepad (owner request 2026-10-11): achievements, keywords, gaps and resume changes for
-- one job, kept on the posting so it exists before and after applying. The web app edits it as
-- separate fields and stores them here as labelled text ("## Relevant achievements" ...).
alter table job_postings add column notes text;

-- Writing notes is not a content edit: it must not set manually_edited (same list as before + notes).
create or replace function flag_manual_edit() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  ignored text[] := array['triage_status','skip_reason','triaged_at','deleted_at','updated_at',
                          'manually_edited','last_seen_at','is_live','liveness_checked_at',
                          'surfaced_on','repost_count','notes'];
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
revoke all on function flag_manual_edit() from public, anon;
