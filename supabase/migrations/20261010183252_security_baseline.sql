-- Security baseline (spec 6.0, 13.1).
-- The repo and web app are public, so the publishable (anon) key is public too.
-- Objects created from here on get no default grants to anon. Each table still
-- enables RLS in the migration that creates it; access for the owner comes
-- through `authenticated` + is_owner() policies in Phase 2.

alter default privileges in schema public revoke all on tables    from anon;
alter default privileges in schema public revoke all on sequences from anon;
alter default privileges in schema public revoke all on functions from anon;
alter default privileges in schema public revoke execute on functions from public;
