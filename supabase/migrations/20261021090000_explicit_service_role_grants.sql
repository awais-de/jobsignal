-- Explicit server-key grants (Supabase notice, 2026-10-20): from 30 Oct 2026 Supabase no longer grants Data
-- API access automatically to new tables in "public". Until now service_role (the pipeline, the Edge
-- Functions) reached every table through those automatic grants; this writes them down, so that a rebuild
-- from these migrations works and nothing depends on the old default. No access changes today.
--
-- Rule from here on (CLAUDE.md, tests/test_migration_grants.py): every migration that creates a table or
-- view grants service_role in the same file; access for authenticated stays explicit as before; anon gets
-- nothing.

grant select, insert, update, delete on table
  public.app_owner, public.application_events, public.applications, public.base_cvs, public.companies,
  public.contacts, public.control_snapshots, public.cv_builds, public.cv_drafts, public.cv_items,
  public.inbound_emails, public.job_postings, public.job_skill_levels, public.llm_cache, public.llm_usage,
  public.outreach, public.owner_profile, public.pipeline_runs, public.portal_accounts, public.resumes,
  public.skill_categories, public.skill_ignores, public.skill_ratings, public.skills, public.source_runs,
  public.used_action_tokens
to service_role;

grant select on table public.application_status, public.weekly_precision to service_role;
