-- Hybrid search: weight keyword ranks 1.5x in reciprocal-rank fusion (was 1x).
-- With gte-small, vector similarities are compressed (about 0.80-0.85 for most passages), so a passage
-- that merely sounds similar could tie with one that contains the question's terms. Equal-weight
-- fusion interleaved the two lists; this weighting puts term matches first unless both lists agree.

-- Load pgvector in this session so its hnsw.* settings exist before search_units declares one.
select extensions.vector_dims('[1,2]'::extensions.vector);

create or replace function rag.search_units(
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
    -- OR semantics: a question rarely contains every term of its answer. Misspelled words are corrected
    -- against the corpus vocabulary first (rag.correct_query).
    select to_tsquery('english', replace(plainto_tsquery('english', rag.correct_query(coalesce(query_text, '')))::text, '&', '|')) as tsq
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
             -- Keyword matches weigh 1.5x: a passage containing the question's words outranks one the
             -- small embedding model only finds similar, unless both rankings agree.
             else coalesce(1.0 / (p_rrf_k + v.rnk), 0) + coalesce(1.5 / (p_rrf_k + k.rnk), 0)
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

-- Versions are immutable: the new fusion is retriever hybrid-rrf@1.1.0, and retrieval configurations
-- built on 1.0.0 move to it (search_units implements only the current fusion).
insert into rag.component_versions (id, component, name, version, params)
values ('retriever/hybrid-rrf@1.1.0', 'retriever', 'hybrid-rrf', '1.1.0', '{"rrf_k": 60, "keyword_weight": 1.5}')
on conflict (id) do nothing;
update rag.retrieval_configs set retriever_version_id = 'retriever/hybrid-rrf@1.1.0'
where retriever_version_id = 'retriever/hybrid-rrf@1.0.0';
