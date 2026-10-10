-- Chunking Lab: core schema.
-- Everything lives in the `rag` schema so it stays isolated from other apps
-- sharing this Supabase project. The schema is not exposed through the Data API;
-- only server-side code (pipeline, Next.js route handlers) connects to it.

create extension if not exists vector with schema extensions;

create schema if not exists rag;
revoke all on schema rag from public, anon, authenticated;
grant usage on schema rag to service_role;

-- ---------------------------------------------------------------------------
-- Corpus
-- ---------------------------------------------------------------------------

create table rag.documents (
  id             uuid primary key default gen_random_uuid(),
  slug           text not null unique,
  source_url     text not null,
  title          text not null,
  publisher      text not null,
  published_at   date,
  licence        text not null,
  canonical_text text not null,
  char_count     int generated always as (char_length(canonical_text)) stored,
  sha256         text not null,
  created_at     timestamptz not null default now()
);

create table rag.sections (
  id           uuid primary key default gen_random_uuid(),
  document_id  uuid not null references rag.documents (id) on delete cascade,
  ordinal      int not null,
  heading_path text[] not null,
  level        smallint not null check (level between 1 and 6),
  start_char   int not null check (start_char >= 0),
  end_char     int not null,
  check (end_char > start_char),
  unique (document_id, ordinal)
);

create table rag.strategies (
  key         text primary key,
  label       text not null,
  description text not null,
  params      jsonb not null default '{}'::jsonb,
  is_primary  boolean not null default true,
  sort_order  int not null default 0
);

insert into rag.strategies (key, label, description, params, sort_order) values
  ('fixed',         'Fixed-size',      'Consecutive token windows, ignores structure',                         '{"size": 512}',                          1),
  ('fixed_overlap', 'Fixed + overlap', 'Token windows that overlap the previous window',                       '{"size": 512, "overlap": 128}',          2),
  ('sentence',      'Sentence',        'Whole sentences packed up to the token budget',                        '{"max": 512}',                           3),
  ('section',       'Section-aware',   'Follows the heading tree; splits long sections on paragraphs',         '{"min": 128, "max": 1024}',              4),
  ('semantic',      'Semantic',        'Breaks where adjacent-sentence embedding similarity drops',            '{"min": 128, "max": 1024, "pct": 90}',   5);

create table rag.chunks (
  id               uuid primary key default gen_random_uuid(),
  document_id      uuid not null references rag.documents (id) on delete cascade,
  strategy         text not null references rag.strategies (key),
  strategy_version text not null,
  ordinal          int not null,
  start_char       int not null check (start_char >= 0),
  end_char         int not null,
  content          text not null,
  embed_text       text not null,
  heading_path     text[] not null default '{}',
  token_count      int not null check (token_count > 0),
  embedding        extensions.vector(1024),
  tsv              tsvector generated always as (to_tsvector('english', embed_text)) stored,
  created_at       timestamptz not null default now(),
  check (end_char > start_char),
  unique (document_id, strategy, ordinal)
);

create index chunks_strategy_document_idx on rag.chunks (strategy, document_id);
create index chunks_tsv_idx on rag.chunks using gin (tsv);
-- No ANN index on purpose: exact search keeps ANN recall error out of the
-- strategy comparison (ARCHITECTURE.md, ADR-2).

-- ---------------------------------------------------------------------------
-- Golden question set
-- ---------------------------------------------------------------------------

create table rag.questions (
  id               text primary key,
  split            text not null check (split in ('dev', 'test')),
  qtype            text not null check (qtype in ('factual', 'numeric', 'synthesis', 'comparison', 'unanswerable')),
  question         text not null,
  reference_answer text,
  key_facts        jsonb not null default '[]'::jsonb,
  answerable       boolean not null,
  author           text not null,
  reviewed_by      text,
  created_at       timestamptz not null default now(),
  check (answerable = (qtype <> 'unanswerable')),
  check (answerable or reference_answer is null)
);

create table rag.gold_spans (
  id          uuid primary key default gen_random_uuid(),
  question_id text not null references rag.questions (id) on delete cascade,
  document_id uuid not null references rag.documents (id) on delete cascade,
  start_char  int not null check (start_char >= 0),
  end_char    int not null,
  quote       text not null,
  check (end_char > start_char)
);

create index gold_spans_question_idx on rag.gold_spans (question_id);

-- A gold span must quote its document exactly.
create function rag.check_gold_span() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_text text;
begin
  select canonical_text into v_text from rag.documents where id = new.document_id;
  if new.end_char > char_length(v_text) then
    raise exception 'gold span % ends past the end of document %', new.id, new.document_id;
  end if;
  if substr(v_text, new.start_char + 1, new.end_char - new.start_char) <> new.quote then
    raise exception 'gold span % quote does not match document text at [%, %)', new.id, new.start_char, new.end_char;
  end if;
  return new;
end;
$$;

create trigger gold_spans_check
  before insert or update on rag.gold_spans
  for each row execute function rag.check_gold_span();

-- Offsets are the contract between chunks and labels, so the canonical text
-- is frozen once anything points into it (ADR-3).
create function rag.freeze_canonical_text() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.canonical_text is distinct from old.canonical_text
     and (exists (select 1 from rag.gold_spans where document_id = old.id)
          or exists (select 1 from rag.chunks where document_id = old.id)) then
    raise exception 'canonical_text of document % is referenced by chunks or gold spans and cannot change', old.id;
  end if;
  return new;
end;
$$;

create trigger documents_freeze_text
  before update of canonical_text on rag.documents
  for each row execute function rag.freeze_canonical_text();

-- Post-load integrity check: returns chunks whose content does not match
-- their span in the canonical text. Expected to return zero rows.
create function rag.verify_chunks()
returns table (chunk_id uuid, strategy text, document_id uuid, problem text)
language sql
stable
set search_path = ''
as $$
  select c.id, c.strategy, c.document_id,
         case
           when c.end_char > d.char_count then 'span past end of document'
           else 'content does not match span'
         end
  from rag.chunks c
  join rag.documents d on d.id = c.document_id
  where c.end_char > d.char_count
     or substr(d.canonical_text, c.start_char + 1, c.end_char - c.start_char) <> c.content;
$$;

-- ---------------------------------------------------------------------------
-- Retrieval: one function for the live site and the evaluation harness
-- ---------------------------------------------------------------------------

create function rag.search_chunks(
  query_embedding extensions.vector(1024),
  query_text      text,
  p_strategy      text,
  p_mode          text default 'hybrid',
  p_k             int  default 10,
  p_candidates    int  default 50,
  p_rrf_k         int  default 60
)
returns table (
  chunk_id          uuid,
  score             double precision,
  vector_rank       int,
  keyword_rank      int,
  vector_similarity double precision
)
language sql
stable
set search_path = ''
as $$
  with vec as (
    select c.id,
           1 - (c.embedding operator(extensions.<=>) query_embedding) as sim,
           row_number() over (order by c.embedding operator(extensions.<=>) query_embedding, c.id)::int as rnk
    from rag.chunks c
    where p_mode in ('vector', 'hybrid')
      and query_embedding is not null
      and c.strategy = p_strategy
      and c.embedding is not null
    order by c.embedding operator(extensions.<=>) query_embedding, c.id
    limit p_candidates
  ),
  q as (
    -- OR semantics: a natural-language question rarely contains every term
    -- of a passage, so AND matching would starve keyword recall.
    select to_tsquery('english', replace(plainto_tsquery('english', coalesce(query_text, ''))::text, '&', '|')) as tsq
  ),
  kw as (
    select c.id,
           row_number() over (order by ts_rank_cd(c.tsv, q.tsq) desc, c.id)::int as rnk
    from rag.chunks c, q
    where p_mode in ('keyword', 'hybrid')
      and c.strategy = p_strategy
      and c.tsv @@ q.tsq
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
  select id, s::double precision, vr, kr, sim::double precision
  from fused
  where s is not null
  order by s desc, id
  limit p_k;
$$;

-- ---------------------------------------------------------------------------
-- Evaluation results
-- ---------------------------------------------------------------------------

create table rag.eval_runs (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  git_sha    text,
  kind       text not null check (kind in ('retrieval', 'generation', 'full')),
  split      text not null check (split in ('dev', 'test')),
  config     jsonb not null,
  status     text not null default 'running' check (status in ('running', 'complete', 'failed')),
  summary    jsonb,
  notes      text
);

create table rag.retrieval_results (
  run_id           uuid not null references rag.eval_runs (id) on delete cascade,
  question_id      text not null references rag.questions (id),
  strategy         text not null references rag.strategies (key),
  mode             text not null check (mode in ('vector', 'keyword', 'hybrid', 'hybrid_rerank')),
  ranked_chunk_ids uuid[] not null,
  first_hit_rank   int,
  metrics          jsonb not null,
  primary key (run_id, question_id, strategy, mode)
);

create table rag.answer_results (
  id            uuid primary key default gen_random_uuid(),
  run_id        uuid not null references rag.eval_runs (id) on delete cascade,
  question_id   text not null references rag.questions (id),
  strategy      text references rag.strategies (key),  -- null for closed-book / oracle baselines
  mode          text not null check (mode in ('vector', 'keyword', 'hybrid', 'hybrid_rerank', 'closed_book', 'oracle')),
  answer        jsonb,
  validation    jsonb,
  judgement     jsonb,
  latency_ms    int,
  input_tokens  int,
  output_tokens int,
  check ((strategy is null) = (mode in ('closed_book', 'oracle')))
);

create unique index answer_results_unique_idx
  on rag.answer_results (run_id, question_id, coalesce(strategy, ''), mode);

-- ---------------------------------------------------------------------------
-- Live-site operations
-- ---------------------------------------------------------------------------

create table rag.query_logs (
  id                  bigint generated always as identity primary key,
  created_at          timestamptz not null default now(),
  feature             text not null,
  query               text not null,
  strategy            text,
  mode                text,
  latency_ms          int,
  retrieved_chunk_ids uuid[],
  validation_status   text,
  ip_hash             text
);

create index query_logs_created_idx on rag.query_logs (created_at);

create table rag.answer_cache (
  cache_key  text primary key,
  question   text not null,
  strategy   text references rag.strategies (key),
  mode       text,
  response   jsonb not null,
  created_at timestamptz not null default now()
);

create table rag.rate_limits (
  ip_hash       text not null,
  window_start  timestamptz not null,
  request_count int not null default 0,
  primary key (ip_hash, window_start)
);

-- Fixed-window counter. Returns true while the caller is within the limit.
-- Use ip_hash = '__global__' for the site-wide daily cap.
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
-- Access control
-- ---------------------------------------------------------------------------

-- RLS on with no policies: anon/authenticated get nothing even if the schema
-- is ever exposed. service_role and the postgres owner bypass RLS.
alter table rag.documents         enable row level security;
alter table rag.sections          enable row level security;
alter table rag.strategies        enable row level security;
alter table rag.chunks            enable row level security;
alter table rag.questions         enable row level security;
alter table rag.gold_spans        enable row level security;
alter table rag.eval_runs         enable row level security;
alter table rag.retrieval_results enable row level security;
alter table rag.answer_results    enable row level security;
alter table rag.query_logs        enable row level security;
alter table rag.answer_cache      enable row level security;
alter table rag.rate_limits       enable row level security;

grant all on all tables in schema rag to service_role;
grant all on all sequences in schema rag to service_role;

revoke all on all functions in schema rag from public, anon, authenticated;
grant execute on all functions in schema rag to service_role;
