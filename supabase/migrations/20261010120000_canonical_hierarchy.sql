-- Chunking Lab v2: canonical hierarchical representation of SEC filings.
--
-- Replaces the v1 rag schema (which held no data). Source filings stay at the
-- SEC; this schema stores the canonical text and document tree derived from
-- each filing, chunking strategies as span layouts over that text, search
-- units, question sets and benchmark results.
--
-- Isolated in the `rag` schema, not exposed through the Data API; accessed only
-- by server-side code.

create extension if not exists vector with schema extensions;

drop schema if exists rag cascade;
create schema rag;
revoke all on schema rag from public, anon, authenticated;
grant usage on schema rag to service_role;

-- ---------------------------------------------------------------------------
-- Corpus: companies, filings, canonical document tree
-- ---------------------------------------------------------------------------

create table rag.companies (
  cik             text primary key check (cik ~ '^\d{10}$'),
  ticker          text not null,
  name            text not null,
  sic             text,
  sic_description text,
  updated_at      timestamptz not null default now()
);

create index companies_ticker_idx on rag.companies (ticker);

create table rag.filings (
  id               uuid primary key default gen_random_uuid(),
  accession_no     text not null unique check (accession_no ~ '^\d{10}-\d{2}-\d{6}$'),
  cik              text not null references rag.companies (cik),
  form             text not null check (form in ('10-K')),
  fiscal_year      int not null,
  period_of_report date not null,
  filed_at         date not null,
  source_url       text not null check (source_url like 'https://www.sec.gov/%'),
  source_sha256    text not null,
  source_bytes     int not null check (source_bytes > 0),
  parser_version   text not null,
  canonical_text   text not null,
  canonical_sha256 text not null,
  char_count       int generated always as (char_length(canonical_text)) stored,
  token_count      int not null check (token_count > 0),
  items            text[] not null,
  ingested_at      timestamptz not null default now(),
  unique (cik, form, fiscal_year)
);

create index filings_fiscal_year_idx on rag.filings (fiscal_year);

-- Document tree. Leaf blocks carry sentence boundaries as an offset array
-- instead of one row per sentence.
create table rag.nodes (
  id              bigint generated always as identity primary key,
  filing_id       uuid not null references rag.filings (id) on delete cascade,
  parent_id       bigint references rag.nodes (id) on delete cascade,
  ordinal         int not null,
  depth           smallint not null check (depth >= 0),
  node_type       text not null check (node_type in ('document', 'item', 'section', 'paragraph', 'table', 'list')),
  item            text,
  heading         text,
  heading_path    text[] not null default '{}',
  start_char      int not null check (start_char >= 0),
  end_char        int not null,
  token_count     int not null check (token_count >= 0),
  sentence_starts int[],
  check (end_char > start_char),
  check ((node_type = 'document') = (parent_id is null)),
  check (node_type in ('paragraph', 'table', 'list') or sentence_starts is null),
  unique (filing_id, ordinal)
);

create index nodes_parent_idx on rag.nodes (parent_id);
create index nodes_filing_start_idx on rag.nodes (filing_id, start_char);

-- ---------------------------------------------------------------------------
-- Chunking strategies, layouts and search units
-- ---------------------------------------------------------------------------

create table rag.strategies (
  key         text primary key,
  label       text not null,
  family      text not null check (family in ('static', 'hierarchical')),
  description text not null,
  params      jsonb not null default '{}'::jsonb,
  version     text not null,
  serving     boolean not null default false,
  sort_order  int not null default 0
);

insert into rag.strategies (key, label, family, description, params, version, serving, sort_order) values
  ('fixed',         'Fixed-size',      'static',       'Consecutive 480-token windows; ignores structure',                                                       '{"size": 480}',                                          'v1', false, 1),
  ('fixed_overlap', 'Fixed + overlap', 'static',       '480-token windows, each overlapping the previous by 120 tokens',                                         '{"size": 480, "overlap": 120}',                          'v1', false, 2),
  ('sentence',      'Sentence',        'static',       'Whole sentences packed up to 480 tokens',                                                                '{"max": 480}',                                           'v1', false, 3),
  ('structural',    'Structure-aware', 'static',       'Follows items, sections and blocks; packs small sibling blocks, splits long blocks on sentences',       '{"min": 64, "max": 480}',                                'v1', false, 4),
  ('semantic',      'Semantic',        'static',       'New chunk where adjacent-sentence similarity drops below the 90th-percentile breakpoint',               '{"min": 64, "max": 480, "breakpoint_percentile": 90}',   'v1', false, 5),
  ('hierarchical',  'Hierarchical',    'hierarchical', 'Small structure-aligned units, expanded through the document tree within a token budget at query time', '{"unit_target": 256, "unit_max": 480}',                  'v1', true,  6);

-- One row per filing x strategy: the strategy's chunk boundaries as offset
-- arrays into the canonical text. Text is never copied.
create table rag.chunk_layouts (
  filing_id        uuid not null references rag.filings (id) on delete cascade,
  strategy         text not null references rag.strategies (key),
  strategy_version text not null,
  starts           int[] not null,
  ends             int[] not null,
  token_counts     int[] not null,
  chunk_count      int generated always as (cardinality(starts)) stored,
  total_tokens     int not null,
  created_at       timestamptz not null default now(),
  primary key (filing_id, strategy),
  check (cardinality(starts) = cardinality(ends) and cardinality(ends) = cardinality(token_counts)),
  check (cardinality(starts) > 0)
);

-- Search units: the spans that are embedded and keyword-indexed. In the
-- benchmark database every strategy has units; on the hosted database only
-- strategies flagged `serving` carry embeddings.
create table rag.chunks (
  id          bigint generated always as identity primary key,
  filing_id   uuid not null references rag.filings (id) on delete cascade,
  strategy    text not null references rag.strategies (key),
  ordinal     int not null,
  start_char  int not null check (start_char >= 0),
  end_char    int not null,
  token_count int not null check (token_count > 0),
  node_id     bigint references rag.nodes (id) on delete cascade,
  item        text,
  embedding   extensions.halfvec(384),
  tsv         tsvector,
  check (end_char > start_char),
  unique (filing_id, strategy, ordinal)
);

create index chunks_strategy_filing_idx on rag.chunks (strategy, filing_id);
create index chunks_node_idx on rag.chunks (node_id);
create index chunks_tsv_idx on rag.chunks using gin (tsv);
-- The binary-quantised HNSW index for serving strategies is created after the
-- bulk load (see pipeline/chunking_lab/load), e.g.:
--   create index chunks_bq_hnsw_hierarchical on rag.chunks
--     using hnsw ((extensions.binary_quantize(embedding)::bit(384)) extensions.bit_hamming_ops)
--     where strategy = 'hierarchical';

-- ---------------------------------------------------------------------------
-- Question sets and gold evidence
-- ---------------------------------------------------------------------------

create table rag.questions (
  id               text primary key,
  tier             text not null check (tier in ('gold', 'silver')),
  split            text not null check (split in ('dev', 'test')),
  qtype            text not null check (qtype in ('factual', 'numeric', 'multi_span', 'synthesis', 'comparison', 'unanswerable')),
  question         text not null,
  reference_answer text,
  key_facts        jsonb not null default '[]'::jsonb,
  answerable       boolean not null,
  origin           text not null check (origin in ('human', 'xbrl', 'llm_assisted')),
  author           text not null,
  reviewed_by      text,
  metadata         jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now(),
  check (answerable = (qtype <> 'unanswerable'))
);

create table rag.gold_spans (
  id             uuid primary key default gen_random_uuid(),
  question_id    text not null references rag.questions (id) on delete cascade,
  filing_id      uuid not null references rag.filings (id) on delete cascade,
  start_char     int not null check (start_char >= 0),
  end_char       int not null,
  quote          text not null,
  parser_version text not null,
  check (end_char > start_char)
);

create index gold_spans_question_idx on rag.gold_spans (question_id);

-- A gold span must quote its filing's canonical text exactly, for the same
-- parser version.
create function rag.check_gold_span() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_text    text;
  v_version text;
begin
  select canonical_text, parser_version into v_text, v_version
  from rag.filings where id = new.filing_id;
  if new.parser_version <> v_version then
    raise exception 'gold span % was labelled on parser %, filing is on %', new.id, new.parser_version, v_version;
  end if;
  if new.end_char > char_length(v_text) then
    raise exception 'gold span % ends past the end of filing %', new.id, new.filing_id;
  end if;
  if substr(v_text, new.start_char + 1, new.end_char - new.start_char) <> new.quote then
    raise exception 'gold span % quote does not match canonical text at [%, %)', new.id, new.start_char, new.end_char;
  end if;
  return new;
end;
$$;

create trigger gold_spans_check
  before insert or update on rag.gold_spans
  for each row execute function rag.check_gold_span();

-- Offsets are the contract between layouts, units and labels, so the
-- canonical text is frozen once anything points into it.
create function rag.freeze_canonical_text() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.canonical_text is distinct from old.canonical_text
     and (exists (select 1 from rag.nodes where filing_id = old.id)
          or exists (select 1 from rag.chunk_layouts where filing_id = old.id)
          or exists (select 1 from rag.gold_spans where filing_id = old.id)) then
    raise exception 'canonical_text of filing % is referenced and cannot change; ingest a new parser version instead', old.id;
  end if;
  return new;
end;
$$;

create trigger filings_freeze_text
  before update of canonical_text on rag.filings
  for each row execute function rag.freeze_canonical_text();

-- Post-load integrity check. Expected to return zero rows.
create function rag.verify_corpus()
returns table (kind text, ref text, problem text)
language sql
stable
set search_path = ''
as $$
  select 'node', n.id::text, 'span outside filing or parent'
  from rag.nodes n
  join rag.filings f on f.id = n.filing_id
  left join rag.nodes p on p.id = n.parent_id
  where n.end_char > f.char_count
     or (p.id is not null and (n.start_char < p.start_char or n.end_char > p.end_char))
  union all
  select 'chunk', c.id::text, 'span outside its node'
  from rag.chunks c
  join rag.nodes n on n.id = c.node_id
  where c.start_char < n.start_char or c.end_char > n.end_char
  union all
  select 'layout', l.filing_id::text || '/' || l.strategy, 'span outside filing'
  from rag.chunk_layouts l
  join rag.filings f on f.id = l.filing_id
  where l.ends[cardinality(l.ends)] > f.char_count;
$$;

-- ---------------------------------------------------------------------------
-- Retrieval
-- ---------------------------------------------------------------------------

-- One function for the live site and the benchmarks.
--   exact = true : full cosine scan (benchmarks; no ANN error)
--   exact = false: binary-quantised candidates (HNSW when indexed), re-ranked
--                  by exact cosine (live)
create function rag.search_chunks(
  query_embedding extensions.halfvec(384),
  query_text      text,
  p_strategy      text,
  p_mode          text    default 'hybrid',
  p_k             int     default 20,
  p_tickers       text[]  default null,
  p_fiscal_years  int[]   default null,
  p_items         text[]  default null,
  p_exact         boolean default false,
  p_candidates    int     default 100,
  p_oversample    int     default 4,
  p_rrf_k         int     default 60
)
returns table (
  chunk_id          bigint,
  filing_id         uuid,
  node_id           bigint,
  start_char        int,
  end_char          int,
  token_count       int,
  score             double precision,
  vector_rank       int,
  keyword_rank      int,
  vector_similarity double precision
)
language sql
stable
set search_path = ''
set hnsw.iterative_scan = 'relaxed_order'
as $$
  with scope as (
    select f.id
    from rag.filings f
    join rag.companies co on co.cik = f.cik
    where (p_tickers is null or co.ticker = any (p_tickers))
      and (p_fiscal_years is null or f.fiscal_year = any (p_fiscal_years))
  ),
  vec_approx as (
    select c.id, c.embedding
    from rag.chunks c
    where p_mode in ('vector', 'hybrid')
      and not p_exact
      and query_embedding is not null
      and c.strategy = p_strategy
      and c.embedding is not null
      and c.filing_id in (select id from scope)
      and (p_items is null or c.item = any (p_items))
    order by extensions.binary_quantize(c.embedding)::bit(384)
             operator(extensions.<~>) extensions.binary_quantize(query_embedding)::bit(384)
    limit p_candidates * p_oversample
  ),
  vec_exact as (
    select c.id, c.embedding
    from rag.chunks c
    where p_mode in ('vector', 'hybrid')
      and p_exact
      and query_embedding is not null
      and c.strategy = p_strategy
      and c.embedding is not null
      and c.filing_id in (select id from scope)
      and (p_items is null or c.item = any (p_items))
    order by c.embedding operator(extensions.<=>) query_embedding, c.id
    limit p_candidates
  ),
  vec as (
    select u.id,
           1 - (u.embedding operator(extensions.<=>) query_embedding) as sim,
           row_number() over (order by u.embedding operator(extensions.<=>) query_embedding, u.id)::int as rnk
    from (select * from vec_approx union all select * from vec_exact) u
    order by rnk
    limit p_candidates
  ),
  q as (
    -- OR semantics: a question rarely contains every term of its answer.
    select to_tsquery('english', replace(plainto_tsquery('english', coalesce(query_text, ''))::text, '&', '|')) as tsq
  ),
  kw as (
    select c.id,
           row_number() over (order by ts_rank_cd(c.tsv, q.tsq) desc, c.id)::int as rnk
    from rag.chunks c, q
    where p_mode in ('keyword', 'hybrid')
      and c.strategy = p_strategy
      and c.tsv @@ q.tsq
      and c.filing_id in (select id from scope)
      and (p_items is null or c.item = any (p_items))
    order by ts_rank_cd(c.tsv, q.tsq) desc, c.id
    limit p_candidates
  ),
  fused as (
    select coalesce(v.id, k.id) as id,
           v.rnk as vr,
           k.rnk as kr,
           v.sim,
           case p_mode
             when 'vector'  then 1.0 / (p_rrf_k + v.rnk)
             when 'keyword' then 1.0 / (p_rrf_k + k.rnk)
             else coalesce(1.0 / (p_rrf_k + v.rnk), 0) + coalesce(1.0 / (p_rrf_k + k.rnk), 0)
           end as s
    from vec v
    full outer join kw k on k.id = v.id
  )
  select c.id, c.filing_id, c.node_id, c.start_char, c.end_char, c.token_count,
         fu.s::double precision, fu.vr, fu.kr, fu.sim::double precision
  from fused fu
  join rag.chunks c on c.id = fu.id
  where fu.s is not null
  order by fu.s desc, c.id
  limit p_k;
$$;

-- ---------------------------------------------------------------------------
-- Benchmarks
-- ---------------------------------------------------------------------------

create table rag.benchmark_runs (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null check (kind in ('chunking', 'retrieval', 'answer', 'ann_recall', 'embedding_parity', 'serving_parity')),
  environment text not null check (environment in ('benchmark', 'hosted')),
  created_at  timestamptz not null default now(),
  git_sha     text,
  corpus      jsonb not null,
  config      jsonb not null,
  status      text not null default 'running' check (status in ('running', 'complete', 'failed')),
  summary     jsonb,
  notes       text
);

create table rag.chunking_results (
  run_id        uuid not null references rag.benchmark_runs (id) on delete cascade,
  strategy      text not null references rag.strategies (key),
  metrics       jsonb not null,
  distributions jsonb not null default '{}'::jsonb,
  primary key (run_id, strategy)
);

create table rag.retrieval_results (
  run_id           uuid not null references rag.benchmark_runs (id) on delete cascade,
  question_id      text not null references rag.questions (id),
  config_key       text not null,
  strategy         text not null references rag.strategies (key),
  mode             text not null check (mode in ('keyword', 'vector', 'hybrid', 'hybrid_rerank')),
  context_policy   text not null check (context_policy in ('static', 'parent', 'window', 'dynamic')),
  budget_tokens    int not null check (budget_tokens > 0),
  ranked_chunk_ids bigint[] not null,
  context_spans    jsonb not null,
  metrics          jsonb not null,
  latency_ms       numeric,
  primary key (run_id, question_id, config_key)
);

create table rag.answer_results (
  id            uuid primary key default gen_random_uuid(),
  run_id        uuid not null references rag.benchmark_runs (id) on delete cascade,
  question_id   text not null references rag.questions (id),
  config_key    text not null,
  answer        jsonb,
  validation    jsonb,
  judgement     jsonb,
  latency_ms    int,
  input_tokens  int,
  output_tokens int,
  unique (run_id, question_id, config_key)
);

-- ---------------------------------------------------------------------------
-- Operations
-- ---------------------------------------------------------------------------

create table rag.ingest_jobs (
  accession_no text primary key,
  cik          text not null,
  stage        text not null default 'discovered'
               check (stage in ('discovered', 'fetched', 'parsed', 'canonicalised', 'chunked', 'embedded', 'loaded', 'failed', 'skipped')),
  attempts     int not null default 0,
  last_error   text,
  metrics      jsonb not null default '{}'::jsonb,
  updated_at   timestamptz not null default now()
);

create index ingest_jobs_stage_idx on rag.ingest_jobs (stage);

create table rag.query_logs (
  id                bigint generated always as identity primary key,
  created_at        timestamptz not null default now(),
  feature           text not null,
  query             text not null,
  config            jsonb,
  latency_ms        jsonb,
  ranked_chunk_ids  bigint[],
  validation_status text,
  ip_hash           text
);

create index query_logs_created_idx on rag.query_logs (created_at);

create table rag.answer_cache (
  cache_key  text primary key,
  question   text not null,
  config     jsonb not null,
  response   jsonb not null,
  created_at timestamptz not null default now()
);

create table rag.rate_limits (
  ip_hash       text not null,
  window_start  timestamptz not null,
  request_count int not null default 0,
  primary key (ip_hash, window_start)
);

-- Fixed-window counter; true while within the limit. Use '__global__' for the
-- site-wide daily cap.
create function rag.check_rate_limit(p_ip_hash text, p_limit int, p_window_seconds int)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_window timestamptz := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  v_count  int;
begin
  insert into rag.rate_limits as r (ip_hash, window_start, request_count)
  values (p_ip_hash, v_window, 1)
  on conflict (ip_hash, window_start)
  do update set request_count = r.request_count + 1
  returning r.request_count into v_count;
  return v_count <= p_limit;
end;
$$;

-- ---------------------------------------------------------------------------
-- Statistics for the UI (refreshed after each load)
-- ---------------------------------------------------------------------------

create materialized view rag.corpus_stats as
select count(*)::int                              as filings,
       count(distinct f.cik)::int                 as companies,
       min(f.fiscal_year)                         as min_fiscal_year,
       max(f.fiscal_year)                         as max_fiscal_year,
       coalesce(sum(f.token_count), 0)::bigint    as tokens,
       coalesce(sum(f.char_count), 0)::bigint     as chars,
       (select count(*) from rag.nodes)::bigint   as nodes,
       (select count(*) from rag.nodes where node_type in ('paragraph', 'table', 'list'))::bigint as blocks,
       (select coalesce(sum(cardinality(sentence_starts)), 0) from rag.nodes)::bigint as sentences,
       max(f.ingested_at)                         as last_ingested_at
from rag.filings f;

create materialized view rag.strategy_stats as
select s.key                                         as strategy,
       s.label,
       s.family,
       s.serving,
       s.sort_order,
       count(l.filing_id)::int                       as filings,
       coalesce(sum(l.chunk_count), 0)::bigint       as chunks,
       coalesce(sum(l.total_tokens), 0)::bigint      as tokens,
       case when sum(l.chunk_count) > 0
            then round(sum(l.total_tokens)::numeric / sum(l.chunk_count), 1) end as avg_tokens,
       (select count(*) from rag.chunks c where c.strategy = s.key and c.embedding is not null)::bigint as embedded_units
from rag.strategies s
left join rag.chunk_layouts l on l.strategy = s.key
group by s.key, s.label, s.family, s.serving, s.sort_order;

create unique index strategy_stats_strategy_idx on rag.strategy_stats (strategy);

create function rag.refresh_stats() returns void
language sql
set search_path = ''
as $$
  refresh materialized view rag.corpus_stats;
  refresh materialized view concurrently rag.strategy_stats;
$$;

-- ---------------------------------------------------------------------------
-- Access control
-- ---------------------------------------------------------------------------

-- RLS on with no policies: anon/authenticated get nothing even if the schema
-- is ever exposed. service_role and the owner bypass RLS.
alter table rag.companies         enable row level security;
alter table rag.filings           enable row level security;
alter table rag.nodes             enable row level security;
alter table rag.strategies        enable row level security;
alter table rag.chunk_layouts     enable row level security;
alter table rag.chunks            enable row level security;
alter table rag.questions         enable row level security;
alter table rag.gold_spans        enable row level security;
alter table rag.benchmark_runs    enable row level security;
alter table rag.chunking_results  enable row level security;
alter table rag.retrieval_results enable row level security;
alter table rag.answer_results    enable row level security;
alter table rag.ingest_jobs       enable row level security;
alter table rag.query_logs        enable row level security;
alter table rag.answer_cache      enable row level security;
alter table rag.rate_limits       enable row level security;

grant all on all tables in schema rag to service_role;
grant all on all sequences in schema rag to service_role;

revoke all on all functions in schema rag from public, anon, authenticated;
grant execute on all functions in schema rag to service_role;
