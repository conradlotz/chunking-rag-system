-- Guest mode: anyone can use the app without signing in.
-- Every lab_* function is read-only (lab_context only fills a temporary table), and the corpus is public SEC
-- filings, so visitors get the same read access as the allow-listed owner. Turn it off with
--   update rag.app_settings set value = 'false' where key = 'guest_mode';

create table if not exists rag.app_settings (
  key   text primary key,
  value jsonb not null
);
alter table rag.app_settings enable row level security;
insert into rag.app_settings (key, value) values ('guest_mode', 'true')
on conflict (key) do update set value = excluded.value;

create or replace function rag.is_allowed_user() returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from rag.app_users where user_id = (select auth.uid()))
      or coalesce((select s.value = 'true'::jsonb from rag.app_settings s where s.key = 'guest_mode'), false);
$$;

-- Anonymous requests (the public anon key, no user) may call the read-only lab_* functions.
do $$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'lab\_%'
  loop
    execute format('grant execute on function %s to anon', f.sig);
  end loop;
end;
$$;
