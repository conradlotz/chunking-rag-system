-- Chunking Lab v2: layered, versioned schema for SEC filings.
--
-- Replaces the v1 rag schema (which held no data). Layers are kept separate:
--
--   registry     component_versions       every parser / normaliser / tokenizer /
--                                          chunker / embedder / analyzer /
--                                          retriever / context-builder version
--   source       companies, filings       where each filing lives at the SEC
--                                          (source documents are never stored)
--   canonical    canonical_documents,     derived text + document tree, per
--                nodes                     (parser, normaliser) version
--   boundaries   chunk_layouts            chunk spans over a canonical document,
--                                          per chunker version (no text copies)
--   artifacts    embedding_sets, units    embeddings + keyword vectors derived
--                                          from one layout, per embedder version
--   retrieval    retrieval_configs,       a complete, versioned retrieval
--                production_config         configuration; the one that is live
--   evaluation   questions, gold_spans, benchmark_runs, *_results
--   telemetry    ingest_runs, ingest_events, storage_snapshots, ingest_jobs
--
-- The same migration runs on the benchmark database (all configurations) and
-- on hosted Supabase (only the production configuration's artifacts).
-- Isolated in the `rag` schema, not exposed through the Data API.

create extension if not exists vector with schema extensions;

drop schema if exists rag cascade;
create schema rag;
revoke all on schema rag from public, anon, authenticated;
grant usage on schema rag to service_role;

-- ===========================================================================
-- Registry
-- ===========================================================================
-- A strategy is a family. Each parameter combination is a separate chunker
-- *configuration*, registered as its own immutable component version, e.g.
-- 'chunker/fixed.s512.o15@1.0.0' (size 512, 15% overlap). Parameters that change
-- the chunks (index-time) need their own embedding set; parameters applied at
-- query time (k, budget, expansion) live on retrieval_configs and need none.

create table rag.strategies (
  key         text primary key,
  label       text not null,
  family      text not null check (family in ('static', 'hierarchical')),
  description text not null,
  sort_order  int not null default 0
);

insert into rag.strategies (key, label, family, description, sort_order) values
  ('fixed',        'Fixed-size',      'static',       'Token windows of a given size and overlap; ignores structure',                                    1),
  ('recursive',    'Recursive',       'static',       'Splits on paragraph, then sentence, then token boundaries to a target size, with overlap',        2),
  ('sentence',     'Sentence',        'static',       'Whole sentences packed up to a token limit',                                                      3),
  ('structural',   'Structure-aware', 'static',       'Follows items, sections and blocks; never crosses a section; packs blocks, splits on sentences',  4),
  ('semantic',     'Semantic',        'static',       'New chunk where adjacent-sentence similarity drops past a percentile or absolute threshold',      5),
  ('hierarchical', 'Hierarchical',    'hierarchical', 'Small structure-aligned units, expanded through the document tree at query time',                 6);

-- Every component that changes results has an explicit, immutable version.
-- id convention: '<component>/<name>@<version>', e.g. 'chunker/structural.max480@1.0.0'.
create table rag.component_versions (
  id         text primary key,
  component  text not null check (component in ('parser', 'normalizer', 'tokenizer', 'chunker', 'embedder',
                                                'keyword_analyzer', 'retriever', 'context_builder')),
  name       text not null,
  version    text not null,
  strategy   text references rag.strategies (key),
  params     jsonb not null default '{}'::jsonb,
  code_sha   text,
  created_at timestamptz not null default now(),
  unique (component, name, version),
  check (id = component || '/' || name || '@' || version),
  check ((component = 'chunker') = (strategy is not null))
);

create function rag.forbid_version_update() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'component version % is immutable; register a new version instead', old.id;
end;
$$;

create trigger component_versions_immutable
  before update on rag.component_versions
  for each row execute function rag.forbid_version_update();

-- ===========================================================================
-- Source layer (references to remote SEC documents)
-- ===========================================================================

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
  primary_document text not null,
  source_url       text not null check (source_url like 'https://www.sec.gov/%'),
  source_sha256    text not null,
  source_bytes     int not null check (source_bytes > 0),
  fetched_at       timestamptz not null,
  unique (cik, form, period_of_report)
);

create index filings_fiscal_year_idx on rag.filings (fiscal_year);

-- ===========================================================================
-- Canonical layer (derived structure, versioned by parser + normaliser)
-- ===========================================================================

create table rag.canonical_documents (
  id                    uuid primary key default gen_random_uuid(),
  filing_id             uuid not null references rag.filings (id) on delete cascade,
  parser_version_id     text not null references rag.component_versions (id),
  normalizer_version_id text not null references rag.component_versions (id),
  tokenizer_version_id  text not null references rag.component_versions (id),
  text                  text not null,
  text_sha256           text not null,
  char_count            int generated always as (char_length(text)) stored,
  token_count           int not null check (token_count > 0),
  items                 text[] not null,
  created_at            timestamptz not null default now(),
  unique (filing_id, parser_version_id, normalizer_version_id)
);

-- Document tree. Leaf blocks carry sentence boundaries as an offset array.
create table rag.nodes (
  id                    bigint generated always as identity primary key,
  canonical_document_id uuid not null references rag.canonical_documents (id) on delete cascade,
  parent_id             bigint references rag.nodes (id) on delete cascade,
  ordinal               int not null,
  depth                 smallint not null check (depth >= 0),
  node_type             text not null check (node_type in ('document', 'item', 'section', 'paragraph', 'table', 'list')),
  item                  text,
  heading               text,
  heading_path          text[] not null default '{}',
  start_char            int not null check (start_char >= 0),
  end_char              int not null,
  token_count           int not null check (token_count >= 0),
  sentence_starts       int[],
  check (end_char > start_char),
  check ((node_type = 'document') = (parent_id is null)),
  check (node_type in ('paragraph', 'table', 'list') or sentence_starts is null),
  unique (canonical_document_id, ordinal)
);

create index nodes_parent_idx on rag.nodes (parent_id);
create index nodes_doc_start_idx on rag.nodes (canonical_document_id, start_char);

-- Offsets are the contract for every later layer: canonical text never changes.
create function rag.forbid_canonical_text_update() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.text is distinct from old.text then
    raise exception 'canonical document % is immutable; produce a new parser or normaliser version instead', old.id;
  end if;
  return new;
end;
$$;

create trigger canonical_documents_immutable
  before update of text on rag.canonical_documents
  for each row execute function rag.forbid_canonical_text_update();

-- ===========================================================================
-- Boundary layer (chunk spans, versioned by chunker)
-- ===========================================================================

create table rag.chunk_layouts (
  canonical_document_id uuid not null references rag.canonical_documents (id) on delete cascade,
  chunker_version_id    text not null references rag.component_versions (id),
  starts                int[] not null,
  ends                  int[] not null,
  token_counts          int[] not null,
  node_ids              bigint[] not null,
  chunk_count           int generated always as (cardinality(starts)) stored,
  total_tokens          int not null,
  created_at            timestamptz not null default now(),
  primary key (canonical_document_id, chunker_version_id),
  check (cardinality(starts) > 0),
  check (cardinality(starts) = cardinality(ends)
         and cardinality(ends) = cardinality(token_counts)
         and cardinality(token_counts) = cardinality(node_ids))
);

-- ===========================================================================
-- Derived artifact layer (embeddings + keyword vectors for one layout)
-- ===========================================================================

create table rag.embedding_sets (
  id                          uuid primary key default gen_random_uuid(),
  chunker_version_id          text not null references rag.component_versions (id),
  embedder_version_id         text not null references rag.component_versions (id),
  keyword_analyzer_version_id text not null references rag.component_versions (id),
  status                      text not null default 'building' check (status in ('building', 'ready', 'retired')),
  retention                   text not null default 'ephemeral' check (retention in ('ephemeral', 'retained', 'production')),
  unit_count                  int,
  tokens_embedded             bigint,
  index_bytes                 bigint,
  build_seconds               numeric,
  created_at                  timestamptz not null default now(),
  unique (chunker_version_id, embedder_version_id, keyword_analyzer_version_id)
);

-- Search units: one per layout chunk (same ordinal), plus derived vectors.
create table rag.units (
  id                    bigint generated always as identity primary key,
  embedding_set_id      uuid not null references rag.embedding_sets (id) on delete cascade,
  canonical_document_id uuid not null references rag.canonical_documents (id) on delete cascade,
  ordinal               int not null,
  start_char            int not null check (start_char >= 0),
  end_char              int not null,
  token_count           int not null check (token_count > 0),
  node_id               bigint not null references rag.nodes (id) on delete cascade,
  item                  text,
  embedding             extensions.halfvec(384),
  tsv                   tsvector,
  check (end_char > start_char),
  unique (embedding_set_id, canonical_document_id, ordinal)
);

create index units_set_doc_idx on rag.units (embedding_set_id, canonical_document_id);
create index units_node_idx on rag.units (node_id);
create index units_tsv_idx on rag.units using gin (tsv);
-- Per-set binary-quantised HNSW indexes are created after bulk load, e.g.:
--   create index units_bq_hnsw_<set> on rag.units
--     using hnsw ((extensions.binary_quantize(embedding)::bit(384)) extensions.bit_hamming_ops)
--     where embedding_set_id = '<set uuid>';

-- ===========================================================================
-- Retrieval configuration
-- ===========================================================================

-- Query-time configuration: params holds k, mode, parent_expansion, neighbor_expansion, ...
create table rag.retrieval_configs (
  id                         text primary key,
  embedding_set_id           uuid not null references rag.embedding_sets (id) on delete cascade,
  retriever_version_id       text not null references rag.component_versions (id),
  context_builder_version_id text not null references rag.component_versions (id),
  budget_tokens              int not null check (budget_tokens > 0),
  params                     jsonb not null default '{}'::jsonb,
  created_at                 timestamptz not null default now(),
  unique (embedding_set_id, retriever_version_id, context_builder_version_id, budget_tokens, params)
);

-- The single configuration served live. Hosted Supabase holds the artifacts
-- for this configuration only.
create table rag.production_config (
  singleton           boolean primary key default true check (singleton),
  retrieval_config_id text not null references rag.retrieval_configs (id),
  benchmark_run_id    uuid,
  activated_at        timestamptz not null default now(),
  notes               text
);

-- ===========================================================================
-- Evaluation
-- ===========================================================================

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

-- Gold evidence is anchored to a specific canonical document version.
create table rag.gold_spans (
  id                    uuid primary key default gen_random_uuid(),
  question_id           text not null references rag.questions (id) on delete cascade,
  canonical_document_id uuid not null references rag.canonical_documents (id) on delete cascade,
  start_char            int not null check (start_char >= 0),
  end_char              int not null,
  quote                 text not null,
  check (end_char > start_char)
);

create index gold_spans_question_idx on rag.gold_spans (question_id);

create function rag.check_gold_span() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_text text;
begin
  select text into v_text from rag.canonical_documents where id = new.canonical_document_id;
  if new.end_char > char_length(v_text) then
    raise exception 'gold span % ends past the end of canonical document %', new.id, new.canonical_document_id;
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

create table rag.benchmark_runs (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null check (kind in ('chunking', 'retrieval', 'answer', 'ann_recall', 'embedding_parity', 'serving_parity')),
  environment text not null check (environment in ('benchmark', 'hosted')),
  created_at  timestamptz not null default now(),
  git_sha     text,
  corpus      jsonb not null,
  versions    jsonb not null,
  config      jsonb not null,
  status      text not null default 'running' check (status in ('running', 'complete', 'failed')),
  summary     jsonb,
  notes       text
);

create table rag.chunking_results (
  run_id             uuid not null references rag.benchmark_runs (id) on delete cascade,
  chunker_version_id text not null references rag.component_versions (id),
  metrics            jsonb not null,
  distributions      jsonb not null default '{}'::jsonb,
  primary key (run_id, chunker_version_id)
);

create table rag.retrieval_results (
  run_id              uuid not null references rag.benchmark_runs (id) on delete cascade,
  question_id         text not null references rag.questions (id),
  retrieval_config_id text not null references rag.retrieval_configs (id),
  ranked_unit_ids     bigint[] not null,
  context_spans       jsonb not null,
  metrics             jsonb not null,
  latency_ms          numeric,
  primary key (run_id, question_id, retrieval_config_id)
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

-- ===========================================================================
-- Tuning experiments (parameter sweeps)
-- ===========================================================================

create table rag.experiments (
  id         text primary key,
  name       text not null,
  strategy   text references rag.strategies (key),
  hypothesis text,
  axes       jsonb not null,
  stage      text not null check (stage in ('intrinsic', 'screening', 'full')),
  -- primary experiments stay inside the embedder's native window; the long-chunk /
  -- multi-window experiment is secondary and never mixed into primary curves or frontiers
  is_primary boolean not null default true,
  status     text not null default 'planned' check (status in ('planned', 'running', 'complete')),
  created_at timestamptz not null default now()
);

-- One row per (configuration, stage) measured: quality on one side, cost on the other.
create table rag.sweep_points (
  id                     bigint generated always as identity primary key,
  experiment_id          text not null references rag.experiments (id) on delete cascade,
  run_id                 uuid references rag.benchmark_runs (id) on delete set null,
  chunker_version_id     text not null references rag.component_versions (id),
  retrieval_config_id    text references rag.retrieval_configs (id),
  params                 jsonb not null,
  stage                  text not null check (stage in ('intrinsic', 'screening', 'full')),
  -- quality
  recall_at_5            numeric,
  mrr                    numeric,
  answer_span_containment numeric,
  full_evidence_rate     numeric,
  answer_accuracy        numeric,
  -- cost
  chunks                 bigint,
  tokens_embedded        bigint,
  index_bytes            bigint,
  context_tokens_mean    numeric,
  retrieval_p95_ms       numeric,
  answer_p95_ms          numeric,
  extra                  jsonb not null default '{}'::jsonb,
  measured_at            timestamptz not null default now()
);

create index sweep_points_experiment_idx on rag.sweep_points (experiment_id, stage);

-- Pareto frontier of an experiment: points for which no other point has
-- >= quality and <= cost with at least one strict improvement.
-- p_quality (higher is better) and p_cost (lower is better) name sweep_points columns.
create function rag.pareto_frontier(p_experiment text, p_quality text, p_cost text, p_stage text default null)
returns table (point_id bigint, quality numeric, cost numeric)
language sql
stable
set search_path = ''
as $$
  with pts as (
    select id, (to_jsonb(sp) ->> p_quality)::numeric as q, (to_jsonb(sp) ->> p_cost)::numeric as c
    from rag.sweep_points sp
    where experiment_id = p_experiment and (p_stage is null or stage = p_stage)
  ), valid as (
    select * from pts where q is not null and c is not null
  )
  select a.id, a.q, a.c
  from valid a
  where not exists (
    select 1 from valid b
    where b.id <> a.id and b.q >= a.q and b.c <= a.c and (b.q > a.q or b.c < a.c)
  )
  order by a.c, a.q desc;
$$;

-- ===========================================================================
-- Telemetry
-- ===========================================================================

create table rag.ingest_runs (
  id          uuid primary key default gen_random_uuid(),
  environment text not null check (environment in ('benchmark', 'hosted')),
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  git_sha     text,
  host        jsonb not null default '{}'::jsonb,
  versions    jsonb not null,
  config      jsonb not null,
  status      text not null default 'running' check (status in ('running', 'complete', 'failed', 'aborted')),
  summary     jsonb
);

-- One row per filing per stage, from the first filing onwards.
create table rag.ingest_events (
  id           bigint generated always as identity primary key,
  run_id       uuid not null references rag.ingest_runs (id) on delete cascade,
  accession_no text not null,
  stage        text not null check (stage in ('discover', 'fetch', 'parse', 'normalize', 'tokenize', 'chunk',
                                              'embed', 'load', 'verify')),
  started_at   timestamptz not null,
  wall_ms      numeric not null,
  cpu_ms       numeric,
  bytes_in     bigint,
  bytes_out    bigint,
  counts       jsonb not null default '{}'::jsonb,
  status       text not null check (status in ('ok', 'failed', 'skipped')),
  error        text
);

create index ingest_events_run_stage_idx on rag.ingest_events (run_id, stage);

-- Point-in-time size of every relation in the rag schema.
create table rag.storage_snapshots (
  id             bigint generated always as identity primary key,
  run_id         uuid references rag.ingest_runs (id) on delete cascade,
  taken_at       timestamptz not null default now(),
  label          text not null,
  filings_loaded int not null,
  relation       text not null,
  relkind        text not null,
  row_estimate   bigint not null,
  table_bytes    bigint not null,
  toast_bytes    bigint not null,
  index_bytes    bigint not null,
  total_bytes    bigint not null
);

create index storage_snapshots_run_idx on rag.storage_snapshots (run_id, label);

create function rag.snapshot_storage(p_run_id uuid, p_label text, p_filings int)
returns int
language plpgsql
set search_path = ''
as $$
declare
  v_rows int;
begin
  insert into rag.storage_snapshots
    (run_id, label, filings_loaded, relation, relkind, row_estimate, table_bytes, toast_bytes, index_bytes, total_bytes)
  select p_run_id, p_label, p_filings, c.relname,
         case c.relkind when 'r' then 'table' when 'm' then 'matview' else c.relkind::text end,
         greatest(c.reltuples, 0)::bigint,
         pg_relation_size(c.oid),
         coalesce(pg_total_relation_size(nullif(c.reltoastrelid, 0)), 0),
         pg_indexes_size(c.oid),
         pg_total_relation_size(c.oid)
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'rag' and c.relkind in ('r', 'm');
  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

-- Resumable pipeline state, one row per filing.
create table rag.ingest_jobs (
  accession_no text primary key,
  cik          text not null,
  stage        text not null default 'discovered'
               check (stage in ('discovered', 'fetched', 'parsed', 'canonicalised', 'chunked', 'embedded',
                                'loaded', 'failed', 'skipped')),
  attempts     int not null default 0,
  last_error   text,
  updated_at   timestamptz not null default now()
);

create index ingest_jobs_stage_idx on rag.ingest_jobs (stage);

-- ===========================================================================
-- Resource accounting: four different costs, never added together
-- ===========================================================================
--   bandwidth          bytes / requests downloaded (e.g. from the SEC)
--   embedding_compute  tokens / seconds of the LOCAL embedding model (no billing)
--   llm                tokens / dollars billed by a paid generation API
--   storage            bytes held in a database (read from storage_snapshots, see the view)

create table rag.usage_ledger (
  id                bigint generated always as identity primary key,
  recorded_at       timestamptz not null default now(),
  category          text not null check (category in ('bandwidth', 'embedding_compute', 'llm')),
  subject           text not null,
  unit              text not null,
  quantity          numeric not null check (quantity >= 0),
  cost_usd          numeric check (cost_usd >= 0),
  ingest_run_id     uuid references rag.ingest_runs (id) on delete set null,
  benchmark_run_id  uuid references rag.benchmark_runs (id) on delete set null,
  accession_no      text,
  meta              jsonb not null default '{}'::jsonb,
  -- each category has its own units: embedding tokens can never be recorded as LLM tokens
  check ((category = 'bandwidth' and unit in ('bytes', 'requests'))
      or (category = 'embedding_compute' and unit in ('tokens', 'seconds'))
      or (category = 'llm' and unit in ('tokens', 'usd'))),
  -- only paid generation carries a dollar cost
  check (cost_usd is null or category = 'llm')
);

create index usage_ledger_category_idx on rag.usage_ledger (category, subject);
create index usage_ledger_run_idx on rag.usage_ledger (ingest_run_id, benchmark_run_id);

create view rag.resource_usage with (security_invoker = true) as
select category, subject, unit, sum(quantity) as quantity, sum(cost_usd) as cost_usd, count(*)::int as entries
from rag.usage_ledger
group by category, subject, unit
union all
select 'storage', s.relation, 'bytes', s.total_bytes::numeric, null::numeric, 1
from rag.storage_snapshots s
where s.taken_at = (select max(taken_at) from rag.storage_snapshots);

-- ===========================================================================
-- Integrity
-- ===========================================================================

-- Post-load check; expected to return zero rows.
create function rag.verify_corpus()
returns table (kind text, ref text, problem text)
language sql
stable
set search_path = ''
as $$
  select 'node', n.id::text, 'span outside document or parent'
  from rag.nodes n
  join rag.canonical_documents d on d.id = n.canonical_document_id
  left join rag.nodes p on p.id = n.parent_id
  where n.end_char > d.char_count
     or (p.id is not null and (n.start_char < p.start_char or n.end_char > p.end_char))
  union all
  select 'layout', l.canonical_document_id::text || '/' || l.chunker_version_id, 'span outside document'
  from rag.chunk_layouts l
  join rag.canonical_documents d on d.id = l.canonical_document_id
  where l.ends[cardinality(l.ends)] > d.char_count
  union all
  select 'unit', u.id::text, 'span outside its node'
  from rag.units u
  join rag.nodes n on n.id = u.node_id
  where u.start_char < n.start_char or u.end_char > n.end_char
  union all
  select 'unit', u.id::text, 'does not match its layout'
  from rag.units u
  join rag.embedding_sets s on s.id = u.embedding_set_id
  join rag.chunk_layouts l on l.canonical_document_id = u.canonical_document_id
                          and l.chunker_version_id = s.chunker_version_id
  where u.start_char <> l.starts[u.ordinal + 1] or u.end_char <> l.ends[u.ordinal + 1];
$$;

-- ===========================================================================
-- Retrieval
-- ===========================================================================

-- One function for live serving and benchmarks.
--   exact = true : full cosine scan (benchmarks; no ANN error)
--   exact = false: binary-quantised candidates (HNSW when indexed), re-ranked
--                  by exact cosine (live)
create function rag.search_units(
  query_embedding    extensions.halfvec(384),
  query_text         text,
  p_embedding_set_id uuid,
  p_mode             text    default 'hybrid',
  p_k                int     default 20,
  p_tickers          text[]  default null,
  p_fiscal_years     int[]   default null,
  p_items            text[]  default null,
  p_exact            boolean default false,
  p_candidates       int     default 100,
  p_oversample       int     default 4,
  p_rrf_k            int     default 60
)
returns table (
  unit_id               bigint,
  canonical_document_id uuid,
  node_id               bigint,
  start_char            int,
  end_char              int,
  token_count           int,
  score                 double precision,
  vector_rank           int,
  keyword_rank          int,
  vector_similarity     double precision
)
language sql
stable
set search_path = ''
set hnsw.iterative_scan = 'relaxed_order'
as $$
  with scope as (
    select d.id
    from rag.canonical_documents d
    join rag.filings f on f.id = d.filing_id
    join rag.companies co on co.cik = f.cik
    where (p_tickers is null or co.ticker = any (p_tickers))
      and (p_fiscal_years is null or f.fiscal_year = any (p_fiscal_years))
  ),
  vec_approx as (
    select u.id, u.embedding
    from rag.units u
    where p_mode in ('vector', 'hybrid')
      and not p_exact
      and query_embedding is not null
      and u.embedding_set_id = p_embedding_set_id
      and u.embedding is not null
      and u.canonical_document_id in (select id from scope)
      and (p_items is null or u.item = any (p_items))
    order by extensions.binary_quantize(u.embedding)::bit(384)
             operator(extensions.<~>) extensions.binary_quantize(query_embedding)::bit(384)
    limit p_candidates * p_oversample
  ),
  vec_exact as (
    select u.id, u.embedding
    from rag.units u
    where p_mode in ('vector', 'hybrid')
      and p_exact
      and query_embedding is not null
      and u.embedding_set_id = p_embedding_set_id
      and u.embedding is not null
      and u.canonical_document_id in (select id from scope)
      and (p_items is null or u.item = any (p_items))
    order by u.embedding operator(extensions.<=>) query_embedding, u.id
    limit p_candidates
  ),
  vec as (
    select v.id,
           1 - (v.embedding operator(extensions.<=>) query_embedding) as sim,
           row_number() over (order by v.embedding operator(extensions.<=>) query_embedding, v.id)::int as rnk
    from (select * from vec_approx union all select * from vec_exact) v
    order by rnk
    limit p_candidates
  ),
  q as (
    -- OR semantics: a question rarely contains every term of its answer.
    select to_tsquery('english', replace(plainto_tsquery('english', coalesce(query_text, ''))::text, '&', '|')) as tsq
  ),
  kw as (
    select u.id,
           row_number() over (order by ts_rank_cd(u.tsv, q.tsq) desc, u.id)::int as rnk
    from rag.units u, q
    where p_mode in ('keyword', 'hybrid')
      and u.embedding_set_id = p_embedding_set_id
      and u.tsv @@ q.tsq
      and u.canonical_document_id in (select id from scope)
      and (p_items is null or u.item = any (p_items))
    order by ts_rank_cd(u.tsv, q.tsq) desc, u.id
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
  select u.id, u.canonical_document_id, u.node_id, u.start_char, u.end_char, u.token_count,
         fu.s::double precision, fu.vr, fu.kr, fu.sim::double precision
  from fused fu
  join rag.units u on u.id = fu.id
  where fu.s is not null
  order by fu.s desc, u.id
  limit p_k;
$$;

-- ===========================================================================
-- Operations
-- ===========================================================================

create table rag.query_logs (
  id                  bigint generated always as identity primary key,
  created_at          timestamptz not null default now(),
  feature             text not null,
  query               text not null,
  retrieval_config_id text,
  latency_ms          jsonb,
  ranked_unit_ids     bigint[],
  validation_status   text,
  ip_hash             text
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

-- ===========================================================================
-- Statistics for the UI (refreshed after each load)
-- ===========================================================================

create materialized view rag.corpus_stats as
select (select count(*) from rag.filings)::int                               as filings,
       (select count(distinct cik) from rag.filings)::int                    as companies,
       (select min(fiscal_year) from rag.filings)                            as min_fiscal_year,
       (select max(fiscal_year) from rag.filings)                            as max_fiscal_year,
       (select coalesce(sum(source_bytes), 0) from rag.filings)::bigint      as source_bytes,
       (select count(*) from rag.canonical_documents)::int                   as canonical_documents,
       (select coalesce(sum(token_count), 0) from rag.canonical_documents)::bigint as tokens,
       (select coalesce(sum(char_count), 0) from rag.canonical_documents)::bigint  as chars,
       (select count(*) from rag.nodes)::bigint                              as nodes,
       (select count(*) from rag.nodes where node_type in ('paragraph', 'table', 'list'))::bigint as blocks,
       (select coalesce(sum(cardinality(sentence_starts)), 0) from rag.nodes)::bigint as sentences;

create materialized view rag.layout_stats as
select cv.id                                     as chunker_version_id,
       cv.strategy,
       s.label,
       s.family,
       count(l.canonical_document_id)::int       as documents,
       coalesce(sum(l.chunk_count), 0)::bigint   as chunks,
       coalesce(sum(l.total_tokens), 0)::bigint  as tokens,
       case when sum(l.chunk_count) > 0
            then round(sum(l.total_tokens)::numeric / sum(l.chunk_count), 1) end as avg_tokens
from rag.component_versions cv
join rag.strategies s on s.key = cv.strategy
left join rag.chunk_layouts l on l.chunker_version_id = cv.id
where cv.component = 'chunker'
group by cv.id, cv.strategy, s.label, s.family;

create unique index layout_stats_idx on rag.layout_stats (chunker_version_id);

create function rag.refresh_stats() returns void
language sql
set search_path = ''
as $$
  refresh materialized view rag.corpus_stats;
  refresh materialized view concurrently rag.layout_stats;
$$;

-- ===========================================================================
-- Access control
-- ===========================================================================

-- RLS on with no policies: anon/authenticated get nothing even if the schema
-- is ever exposed. service_role and the owner bypass RLS.
do $$
declare
  t record;
begin
  for t in select tablename from pg_tables where schemaname = 'rag' loop
    execute format('alter table rag.%I enable row level security', t.tablename);
  end loop;
end;
$$;

grant all on all tables in schema rag to service_role;
grant all on all sequences in schema rag to service_role;

revoke all on all functions in schema rag from public, anon, authenticated;
grant execute on all functions in schema rag to service_role;
