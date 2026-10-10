-- Let the data loader (a login without ownership of the stats views) refresh them.
-- Applied on the hosted project together with the rag_loader login (see docs/DEPLOY.md).
alter function rag.refresh_stats() security definer;
revoke execute on function rag.refresh_stats() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke execute on function rag.refresh_stats() from anon, authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'rag_loader') then
    execute 'grant execute on function rag.refresh_stats() to rag_loader';
  end if;
end $$;
