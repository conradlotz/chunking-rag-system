-- Local-only stand-in for Supabase's auth schema, so migrations and tests can run on a plain
-- Postgres + pgvector. Never applied to hosted Supabase (which provides the real auth.uid()).
create schema if not exists auth;
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
do $$ begin create role service_role nologin bypassrls; exception when duplicate_object then null; end $$;
grant usage on schema auth to anon, authenticated;
grant usage on schema public to anon, authenticated;
