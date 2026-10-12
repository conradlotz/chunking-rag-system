-- Search quality fixes from a live test.
-- * Skip heading-only fragments (under 16 tokens, about 2% of passages): results that read only "ITEM 7A."
--   or "Human Capital Resources" answer nothing.
-- * Keyword matching requires all of the question's words (was: any word, which let generic "cost" and
--   "margin" text in and took 3-4 s to score).
-- * lab_search also returns each company's sector.

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
  with plan as (
    -- Small sets (the hosted corpus is about 60,000 passages) are searched exactly: comparing every
    -- vector takes well under a second, finds the true nearest passages, and avoids the approximate
    -- index's filtered scan, which was several times slower at this size.
    select p_exact or coalesce((select e.unit_count from rag.embedding_sets e where e.id = p_embedding_set_id), 0)
                      <= 200000 as exact
  ),
  scope as (
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
      and not (select exact from plan)
      and query_embedding is not null
      and u.embedding_set_id = p_embedding_set_id
      and u.embedding is not null
      and u.token_count >= 16
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
      and (select exact from plan)
      and query_embedding is not null
      and u.embedding_set_id = p_embedding_set_id
      and u.embedding is not null
      and u.token_count >= 16
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
    -- A passage must contain every word of the question (after spelling correction and stemming). Matching any
    -- word pulled in generic "cost" and "margin" text and meant scoring ~15,000 passages per search (3-4 s);
    -- all-words matching returns tens of passages in milliseconds. Meaning search covers the rest.
    select plainto_tsquery('english', rag.correct_query(coalesce(query_text, ''))) as tsq
  ),
  kw as (
    select u.id,
           row_number() over (order by ts_rank_cd(u.tsv, q.tsq) desc, u.id)::int as rnk
    from rag.units u, q
    where p_mode in ('keyword', 'hybrid')
      and u.embedding_set_id = p_embedding_set_id
      and u.tsv @@ q.tsq
      and u.token_count >= 16
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


create or replace function public.lab_search(
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
      'ticker', c.ticker, 'company', c.name, 'sector', rag.sic_division(c.sic), 'fiscal_year', f.fiscal_year, 'item', u.item,
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

