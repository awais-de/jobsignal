-- Supabase grants ALL on new public tables to `authenticated` by default. The
-- baseline migration only removed that for `anon`, so the owner role had more
-- than intended (found by the resume-immutability check). RLS still limited
-- everything to the owner; these grants restore the integrity rules:
--   * application_events is append-only (spec 6.6)
--   * deletes are soft deletes (spec 6.12)
--   * resumes are immutable apart from label and soft delete (spec 6.4)

-- Future tables: nothing for `authenticated` unless a migration grants it.
alter default privileges in schema public revoke all on tables    from authenticated;
alter default privileges in schema public revoke all on sequences from authenticated;
alter default privileges in schema public revoke all on functions from authenticated;

-- Reset each owner-visible table to exactly what the app needs.
revoke all on job_postings, applications, application_events, resumes,
              pipeline_runs, source_runs, application_status from authenticated;

grant select, update            on job_postings       to authenticated;
grant select, insert, update    on applications       to authenticated;
grant select, insert            on application_events to authenticated;
grant select, insert            on resumes            to authenticated;
grant update (label, deleted_at) on resumes           to authenticated;
grant select                    on pipeline_runs, source_runs, application_status to authenticated;
