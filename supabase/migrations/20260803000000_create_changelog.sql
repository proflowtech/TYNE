-- public.changelog already existed with:
--   id, title, version, description, is_published, created_at, published_at
-- Ensure service_role can insert compile rows (RLS is bypassed by service_role,
-- but table grants are still required). Drop the broad SELECT policy if present.

grant select, insert on public.changelog to service_role;
grant usage on schema public to service_role;

drop policy if exists "Anyone can read changelog" on public.changelog;
