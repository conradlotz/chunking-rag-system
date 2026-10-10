-- Web app API: access control, context construction and read-only functions.
--
-- The project's Supabase Auth is shared with another app, so "authenticated" is NOT
-- enough to read research data. Every function here first checks that the caller's
-- user id is in rag.app_users (the allow-list). The rag schema itself stays
-- unexposed; the web app reaches it only through these public.lab_* functions, which are
-- read-only, security definer, and executable by `authenticated` only (never `anon`).

-- Re-runnable: dropping the rag schema (in the earlier migration) leaves public.lab_* functions behind.
do $$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'lab\_%'
  loop
    execute format('drop function %s', f.sig);
  end loop;
end;
$$;

-- ===========================================================================
-- Access control
-- ===========================================================================

create table if not exists rag.app_users (
  user_id  uuid primary key,
  email    text not null unique,
  added_at timestamptz not null default now()
);
alter table rag.app_users enable row level security;
grant all on rag.app_users to service_role;

create or replace function rag.is_allowed_user() returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from rag.app_users where user_id = (select auth.uid()));
$$;

create or replace function rag.require_allowed() returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not rag.is_allowed_user() then
    raise exception 'not authorised' using errcode = '42501';
  end if;
end;
$$;

-- ===========================================================================
-- Context construction (second half of retrieval)
-- ===========================================================================
-- Turns ranked search units into the context given to the model, within a token
-- budget. Policies:
--   static : hits in rank order until the budget is reached
--   expand : each hit plus p_neighbor leaf blocks either side (same item) and up to
--            p_parent levels of enclosing section, as far as the budget allows
-- Spans never overlap: a span already covered is skipped, and a parent span replaces
-- the hits and neighbours it contains. Deterministic for equal inputs.

create or replace function rag.build_context(
  p_unit_ids bigint[],
  p_budget   int,
  p_policy   text default 'static',
  p_neighbor int  default 0,
  p_parent   int  default 0
)
returns table (
  ord                   int,
  canonical_document_id uuid,
  start_char            int,
  end_char              int,
  token_count           int,
  role                  text,
  source_unit_id        bigint,
  hit_rank              int
)
language plpgsql
set search_path = ''
as $$
declare
  h       record;
  nb      record;
  anc     record;
  cur     bigint;
  d       int;
  v_used  int;
  v_gain  int;
begin
  if p_policy not in ('static', 'expand') then
    raise exception 'unknown context policy %', p_policy;
  end if;

  drop table if exists pg_temp.ctx_spans;
  create temp table ctx_spans (
    doc uuid not null, s int not null, e int not null, tok int not null,
    role text not null, src bigint not null, rnk int not null
  ) on commit drop;

  for h in
    select t.uid, t.r, u.canonical_document_id as doc, u.start_char as s, u.end_char as e,
           u.token_count as tok, u.node_id, u.item
    from unnest(p_unit_ids) with ordinality as t(uid, r)
    join rag.units u on u.id = t.uid
    order by t.r
  loop
    -- already inside a span we hold
    if exists (select 1 from pg_temp.ctx_spans c where c.doc = h.doc and c.s <= h.s and c.e >= h.e) then
      continue;
    end if;
    select coalesce(sum(tok), 0) into v_used from pg_temp.ctx_spans;
    if v_used + h.tok > p_budget then
      continue;
    end if;
    insert into pg_temp.ctx_spans values (h.doc, h.s, h.e, h.tok, 'hit', h.uid, h.r);

    if p_policy = 'expand' then
      for d in 1..greatest(p_neighbor, 0) loop
        -- previous then next leaf block, nearest first
        for nb in
          (select n.start_char as s, n.end_char as e, n.token_count as tok
             from rag.nodes n
            where n.canonical_document_id = h.doc and n.node_type in ('paragraph', 'table', 'list')
              and n.end_char <= h.s and n.item is not distinct from h.item
            order by n.end_char desc offset d - 1 limit 1)
          union all
          (select n.start_char, n.end_char, n.token_count
             from rag.nodes n
            where n.canonical_document_id = h.doc and n.node_type in ('paragraph', 'table', 'list')
              and n.start_char >= h.e and n.item is not distinct from h.item
            order by n.start_char offset d - 1 limit 1)
        loop
          select coalesce(sum(tok), 0) into v_used from pg_temp.ctx_spans;
          if v_used + nb.tok <= p_budget
             and not exists (select 1 from pg_temp.ctx_spans c
                             where c.doc = h.doc and c.s <= nb.s and c.e >= nb.e) then
            insert into pg_temp.ctx_spans values (h.doc, nb.s, nb.e, nb.tok, 'neighbor', h.uid, h.r);
          end if;
        end loop;
      end loop;

      cur := h.node_id;
      for d in 1..greatest(p_parent, 0) loop
        select a.id, a.parent_id, a.node_type, a.start_char, a.end_char, a.token_count
          into anc
          from rag.nodes n
          join rag.nodes a on a.id = n.parent_id
         where n.id = cur;
        exit when not found;
        exit when anc.node_type = 'document';
        cur := anc.id;
        select anc.token_count - coalesce(sum(c.tok), 0) into v_gain
          from pg_temp.ctx_spans c
         where c.doc = h.doc and c.s >= anc.start_char and c.e <= anc.end_char;
        select coalesce(sum(tok), 0) into v_used from pg_temp.ctx_spans;
        exit when v_used + v_gain > p_budget;
        delete from pg_temp.ctx_spans c
         where c.doc = h.doc and c.s >= anc.start_char and c.e <= anc.end_char;
        insert into pg_temp.ctx_spans values (h.doc, anc.start_char, anc.end_char, anc.token_count, 'parent', h.uid, h.r);
      end loop;
    end if;
  end loop;

  return query
    select (row_number() over (order by m.first_rank, c.s))::int,
           c.doc, c.s, c.e, c.tok, c.role, c.src, c.rnk
    from pg_temp.ctx_spans c
    join (select doc, min(rnk) as first_rank from pg_temp.ctx_spans group by doc) m on m.doc = c.doc
    order by m.first_rank, c.s;
end;
$$;

-- ===========================================================================
-- Read-only API for the web app (public.lab_*)
-- ===========================================================================

-- Lets the app ask "may this user see anything?" without catching an error.
create function public.lab_is_allowed() returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select rag.is_allowed_user();
$$;

create function public.lab_overview() returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v jsonb;
begin
  perform rag.require_allowed();
  select jsonb_build_object(
    'corpus',   (select to_jsonb(c) from rag.corpus_stats c),
    'layouts',  coalesce((select jsonb_agg(to_jsonb(l) order by (select st.sort_order from rag.strategies st where st.key = l.strategy), l.chunker_version_id) from rag.layout_stats l), '[]'),
    'embedding_sets', coalesce((select jsonb_agg(jsonb_build_object(
        'id', e.id, 'chunker_version_id', e.chunker_version_id, 'embedder_version_id', e.embedder_version_id,
        'status', e.status, 'retention', e.retention, 'unit_count', e.unit_count,
        'tokens_embedded', e.tokens_embedded, 'index_bytes', e.index_bytes) order by e.created_at)
        from rag.embedding_sets e), '[]'),
    'production', (select jsonb_build_object('retrieval_config_id', p.retrieval_config_id, 'activated_at', p.activated_at,
                          'notes', p.notes) from rag.production_config p),
    'ingest', coalesce((select jsonb_object_agg(stage, n) from
        (select stage, count(*) as n from rag.ingest_jobs group by stage) s), '{}'),
    'questions', (select jsonb_build_object('total', count(*), 'gold', count(*) filter (where tier = 'gold'),
                          'silver', count(*) filter (where tier = 'silver')) from rag.questions)
  ) into v;
  return v;
end;
$$;

create function public.lab_resource_usage() returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform rag.require_allowed();
  return coalesce((select jsonb_agg(to_jsonb(r) order by r.category, r.subject, r.unit) from rag.resource_usage r), '[]');
end;
$$;

create function public.lab_ingest_stats() returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform rag.require_allowed();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'stage', stage, 'events', n, 'failed', failed, 'skipped', skipped,
      'wall_ms_total', wall_total, 'wall_ms_p50', p50, 'wall_ms_p95', p95, 'cpu_ms_total', cpu_total,
      'bytes_in', bytes_in, 'bytes_out', bytes_out) order by array_position(
        array['discover','fetch','parse','normalize','tokenize','chunk','embed','load','verify'], stage))
    from (
      select stage, count(*) as n, count(*) filter (where status = 'failed') as failed,
             count(*) filter (where status = 'skipped') as skipped,
             sum(wall_ms) as wall_total, percentile_cont(0.5) within group (order by wall_ms) as p50,
             percentile_cont(0.95) within group (order by wall_ms) as p95,
             sum(cpu_ms) as cpu_total, sum(bytes_in) as bytes_in, sum(bytes_out) as bytes_out
      from rag.ingest_events group by stage
    ) t), '[]');
end;
$$;

create function public.lab_storage() returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform rag.require_allowed();
  return coalesce((
    select jsonb_agg(to_jsonb(s) order by s.total_bytes desc)
    from rag.storage_snapshots s
    where s.taken_at = (select max(taken_at) from rag.storage_snapshots)), '[]');
end;
$$;

create function public.lab_filings(p_query text default null, p_limit int default 50, p_offset int default 0)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_total int;
  v_rows  jsonb;
begin
  perform rag.require_allowed();
  select count(*) into v_total
    from rag.canonical_documents d join rag.filings f on f.id = d.filing_id join rag.companies c on c.cik = f.cik
   where p_query is null or c.ticker ilike p_query || '%' or c.name ilike '%' || p_query || '%';
  select coalesce(jsonb_agg(r), '[]') into v_rows from (
    select d.id as canonical_document_id, f.id as filing_id, f.accession_no, c.ticker, c.name, f.fiscal_year,
           f.period_of_report, f.source_url, d.token_count, d.char_count, d.items
      from rag.canonical_documents d join rag.filings f on f.id = d.filing_id join rag.companies c on c.cik = f.cik
     where p_query is null or c.ticker ilike p_query || '%' or c.name ilike '%' || p_query || '%'
     order by c.ticker, f.fiscal_year desc
     limit least(p_limit, 200) offset greatest(p_offset, 0)) r;
  return jsonb_build_object('total', v_total, 'rows', v_rows);
end;
$$;

create function public.lab_document(p_doc uuid) returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v jsonb;
begin
  perform rag.require_allowed();
  select jsonb_build_object(
    'id', d.id, 'accession_no', f.accession_no, 'ticker', c.ticker, 'company', c.name, 'fiscal_year', f.fiscal_year,
    'period_of_report', f.period_of_report, 'source_url', f.source_url, 'source_sha256', f.source_sha256,
    'text_sha256', d.text_sha256, 'char_count', d.char_count, 'token_count', d.token_count, 'items', d.items,
    'parser_version', d.parser_version_id, 'normalizer_version', d.normalizer_version_id,
    'tokenizer_version', d.tokenizer_version_id,
    'nodes', coalesce((select jsonb_agg(jsonb_build_object(
        'o', n.ordinal, 'p', (select pn.ordinal from rag.nodes pn where pn.id = n.parent_id), 'd', n.depth,
        't', n.node_type, 'i', n.item, 'h', n.heading, 's', n.start_char, 'e', n.end_char, 'k', n.token_count)
        order by n.ordinal) from rag.nodes n where n.canonical_document_id = d.id), '[]'),
    'layouts', coalesce((select jsonb_agg(jsonb_build_object(
        'chunker_version_id', l.chunker_version_id, 'strategy', cv.strategy, 'params', cv.params,
        'chunks', l.chunk_count, 'tokens', l.total_tokens) order by cv.strategy, l.chunker_version_id)
        from rag.chunk_layouts l join rag.component_versions cv on cv.id = l.chunker_version_id
       where l.canonical_document_id = d.id), '[]'))
  into v
  from rag.canonical_documents d join rag.filings f on f.id = d.filing_id join rag.companies c on c.cik = f.cik
  where d.id = p_doc;
  return v;
end;
$$;

create function public.lab_document_text(p_doc uuid, p_start int default 0, p_len int default 600000) returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform rag.require_allowed();
  return (select substr(d.text, greatest(p_start, 0) + 1, least(p_len, 600000))
            from rag.canonical_documents d where d.id = p_doc);
end;
$$;

create function public.lab_layout(p_doc uuid, p_chunker text) returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform rag.require_allowed();
  return (select jsonb_build_object('chunker_version_id', l.chunker_version_id, 'starts', l.starts, 'ends', l.ends,
                                    'token_counts', l.token_counts, 'node_ids', l.node_ids)
            from rag.chunk_layouts l where l.canonical_document_id = p_doc and l.chunker_version_id = p_chunker);
end;
$$;

-- Answer spans labelled in one filing, for overlay in the Explorer.
create function public.lab_gold_spans(p_doc uuid) returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform rag.require_allowed();
  return coalesce((
    select jsonb_agg(jsonb_build_object('question_id', q.id, 'qtype', q.qtype, 'question', q.question, 'tier', q.tier,
                                        'start', g.start_char, 'end', g.end_char) order by g.start_char)
    from rag.gold_spans g join rag.questions q on q.id = g.question_id
    where g.canonical_document_id = p_doc), '[]');
end;
$$;

create function public.lab_configs() returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform rag.require_allowed();
  return jsonb_build_object(
    'chunkers', coalesce((select jsonb_agg(jsonb_build_object('id', cv.id, 'name', cv.name, 'strategy', cv.strategy,
        'params', cv.params, 'label', s.label, 'family', s.family) order by s.sort_order, cv.name)
        from rag.component_versions cv join rag.strategies s on s.key = cv.strategy
       where cv.component = 'chunker'), '[]'),
    'embedding_sets', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'chunker_version_id', e.chunker_version_id,
        'embedder_version_id', e.embedder_version_id, 'status', e.status, 'retention', e.retention,
        'unit_count', e.unit_count) order by e.created_at) from rag.embedding_sets e where e.status = 'ready'), '[]'),
    'retrieval_configs', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'embedding_set_id', r.embedding_set_id,
        'budget_tokens', r.budget_tokens, 'params', r.params)) from rag.retrieval_configs r), '[]'),
    'production', (select retrieval_config_id from rag.production_config),
    'companies', coalesce((select jsonb_agg(jsonb_build_object('ticker', c.ticker, 'name', c.name) order by c.ticker)
        from rag.companies c where exists (select 1 from rag.filings f where f.cik = c.cik)), '[]'),
    'fiscal_years', coalesce((select jsonb_agg(distinct f.fiscal_year order by f.fiscal_year) from rag.filings f), '[]'));
end;
$$;

-- Search one embedding set and return the hits with their text, metadata and tree position.
create function public.lab_search(
  p_query_embedding  text,
  p_query_text       text,
  p_embedding_set_id uuid,
  p_mode             text    default 'hybrid',
  p_k                int     default 10,
  p_tickers          text[]  default null,
  p_fiscal_years     int[]   default null,
  p_items            text[]  default null,
  p_exact            boolean default false
) returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_emb extensions.halfvec(384);
begin
  perform rag.require_allowed();
  if p_mode not in ('keyword', 'vector', 'hybrid') then
    raise exception 'unknown mode %', p_mode;
  end if;
  if p_query_embedding is not null then
    v_emb := p_query_embedding::extensions.halfvec(384);
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'unit_id', r.unit_id, 'canonical_document_id', r.canonical_document_id, 'node_id', r.node_id,
      'start', r.start_char, 'end', r.end_char, 'tokens', r.token_count, 'score', r.score,
      'vector_rank', r.vector_rank, 'keyword_rank', r.keyword_rank, 'similarity', r.vector_similarity,
      'ticker', c.ticker, 'company', c.name, 'fiscal_year', f.fiscal_year, 'item', u.item,
      'heading', (select n.heading_path[cardinality(n.heading_path)] from rag.nodes n where n.id = r.node_id),
      'text', substr(d.text, r.start_char + 1, least(r.end_char - r.start_char, 6000))) order by r.score desc, r.unit_id)
    from rag.search_units(v_emb, p_query_text, p_embedding_set_id, p_mode, p_k, p_tickers, p_fiscal_years, p_items,
                          p_exact) r
    join rag.units u on u.id = r.unit_id
    join rag.canonical_documents d on d.id = r.canonical_document_id
    join rag.filings f on f.id = d.filing_id
    join rag.companies c on c.cik = f.cik), '[]');
end;
$$;

-- Build the context for ranked unit ids and return its spans with their text.
create function public.lab_context(
  p_unit_ids bigint[],
  p_budget   int,
  p_policy   text default 'static',
  p_neighbor int  default 0,
  p_parent   int  default 0
) returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform rag.require_allowed();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'ord', x.ord, 'canonical_document_id', x.canonical_document_id, 'start', x.start_char, 'end', x.end_char,
      'tokens', x.token_count, 'role', x.role, 'source_unit_id', x.source_unit_id, 'hit_rank', x.hit_rank,
      'ticker', c.ticker, 'fiscal_year', f.fiscal_year,
      'text', substr(d.text, x.start_char + 1, least(x.end_char - x.start_char, 20000))) order by x.ord)
    from rag.build_context(p_unit_ids, p_budget, p_policy, p_neighbor, p_parent) x
    join rag.canonical_documents d on d.id = x.canonical_document_id
    join rag.filings f on f.id = d.filing_id
    join rag.companies c on c.cik = f.cik), '[]');
end;
$$;

create function public.lab_benchmarks() returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform rag.require_allowed();
  return jsonb_build_object(
    'experiments', coalesce((select jsonb_agg(to_jsonb(e) order by e.is_primary desc, e.id) from rag.experiments e), '[]'),
    'points', coalesce((select jsonb_agg(to_jsonb(p) order by p.experiment_id, p.id) from rag.sweep_points p), '[]'),
    'runs', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'kind', r.kind, 'environment', r.environment,
        'created_at', r.created_at, 'status', r.status, 'summary', r.summary) order by r.created_at desc)
        from rag.benchmark_runs r), '[]'));
end;
$$;

create function public.lab_pareto(p_experiment text, p_quality text, p_cost text, p_stage text default null) returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform rag.require_allowed();
  return coalesce((select jsonb_agg(jsonb_build_object('point_id', f.point_id, 'quality', f.quality, 'cost', f.cost))
                     from rag.pareto_frontier(p_experiment, p_quality, p_cost, p_stage) f), '[]');
end;
$$;

-- ===========================================================================
-- Privileges: lab_* functions are for `authenticated` only (and still allow-list checked)
-- ===========================================================================

do $$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'lab\_%'
  loop
    execute format('revoke all on function %s from public, anon', f.sig);
    execute format('grant execute on function %s to authenticated', f.sig);
  end loop;
end;
$$;

-- rag.* functions created above stay service_role-only (security-definer lab_* functions run as owner).
revoke all on all functions in schema rag from public, anon, authenticated;
grant execute on all functions in schema rag to service_role;
