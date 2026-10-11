-- The owner's profile (skills, target roles, dealbreakers, watchlist), editable in the app.
-- Single row. The pipeline prefers it over the PROFILE_YAML secret, which stays as a fallback.
-- Personal data: RLS owner-only, never in the public repo.

create table owner_profile (
  id          int primary key default 1 check (id = 1),
  profile     jsonb not null,
  version     int not null default 1,              -- bumped on every save; drives re-ranking
  updated_at  timestamptz not null default now()
);

create or replace function bump_profile_version() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.version := old.version + 1;
  new.updated_at := now();
  return new;
end;
$$;
create trigger owner_profile_version before update on owner_profile
  for each row execute function bump_profile_version();

alter table owner_profile enable row level security;
create policy owner_select on owner_profile for select to authenticated using ((select public.is_owner()));
create policy owner_update on owner_profile for update to authenticated
  using ((select public.is_owner())) with check ((select public.is_owner()));
revoke all on owner_profile from anon, authenticated;
grant select on owner_profile to authenticated;
grant update (profile) on owner_profile to authenticated;
revoke all on function bump_profile_version() from public, anon, authenticated;
