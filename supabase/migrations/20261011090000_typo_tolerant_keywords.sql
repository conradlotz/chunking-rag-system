-- Typo-tolerant keyword search.
--
-- rag.lexicon holds every word in the searchable chunks with the number of chunks containing it.
-- rag.correct_query() replaces a query word the corpus (almost) never uses with a close, common
-- corpus word, so "tarrifs" searches for "tariffs". Words the corpus uses are never changed.
-- The vector half of hybrid search is unaffected.

create extension if not exists pg_trgm with schema extensions;
create extension if not exists fuzzystrmatch with schema extensions;

-- Load pgvector in this session so its hnsw.* settings exist before search_units declares one.
select extensions.vector_dims('[1,2]'::extensions.vector);

create table if not exists rag.lexicon (
  word text primary key,
  ndoc int  not null
);
alter table rag.lexicon enable row level security;
create index if not exists lexicon_trgm_idx on rag.lexicon using gin (word extensions.gin_trgm_ops);

create or replace function rag.rebuild_lexicon() returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  n int;
begin
  -- Whole words (no stemming), as they appear in the indexed chunks.
  delete from rag.lexicon;
  insert into rag.lexicon (word, ndoc)
  select word, ndoc from ts_stat($q$
      select to_tsvector('simple', substr(d.text, u.start_char + 1, u.end_char - u.start_char))
      from rag.units u join rag.canonical_documents d on d.id = u.canonical_document_id
      where u.embedding_set_id = (select e.id from rag.embedding_sets e where e.status = 'ready'
                                  order by (e.retention = 'production') desc, e.created_at desc limit 1)
    $q$)
  where length(word) between 3 and 40 and word ~ '^[a-z]+$';
  get diagnostics n = row_count;
  return n;
end;
$$;

-- Levenshtein distance that counts swapping two adjacent letters ("chian" -> "chain") as one edit.
create or replace function rag.edit_distance(a text, b text) returns int
language sql
immutable
set search_path = ''
as $$
  select case
    when length(a) = length(b) and exists (
      select 1 from generate_series(1, length(a) - 1) i
      where overlay(a placing substr(a, i + 1, 1) || substr(a, i, 1) from i for 2) = b)
    then 1
    else extensions.levenshtein(a, b)
  end;
$$;

create or replace function rag.correct_query(p_query text) returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  w       text;
  best    text;
  own     int;
  out_txt text := coalesce(p_query, '');
begin
  for w in select distinct m[1] from regexp_matches(lower(coalesce(p_query, '')), '([a-z]{4,})', 'g') as m loop
    -- Known words stay. A word seen in only one or two chunks is treated as a probable typo when a
    -- similar word is at least ten times as common ("tarrif" in one filing vs "tariff" in hundreds).
    select coalesce(max(l.ndoc), 0) into own from rag.lexicon l where l.word = w;
    continue when own >= 3;
    best := null;
    -- Same first letter, within 1 edit (short words) or 2 edits; rank by edit distance discounted by
    -- how common the word is, so "chian" becomes the everyday "chain" rather than the rare "chan".
    select l.word into best
    from rag.lexicon l
    where l.ndoc >= greatest(3, own * 10)
      and l.word <> w
      and left(l.word, 1) = left(w, 1)
      and abs(length(l.word) - length(w)) <= 2
      and extensions.levenshtein(l.word, w) <= case when length(w) <= 4 then 1 else 2 end
    order by rag.edit_distance(l.word, w) - 0.5 * log(l.ndoc), l.word
    limit 1;
    if best is not null then
      out_txt := regexp_replace(out_txt, '\m' || w || '\M', best, 'gi');
    end if;
  end loop;
  return out_txt;
end;
$$;

create or replace function rag.refresh_stats() returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  refresh materialized view rag.corpus_stats;
  refresh materialized view concurrently rag.layout_stats;
  perform rag.rebuild_lexicon();
end;
$$;
revoke execute on function rag.refresh_stats() from public;
revoke execute on function rag.rebuild_lexicon() from public;

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

-- The query the keyword search actually ran, for the UI ("searched for: tariff").
create or replace function public.lab_correct_query(p_query text) returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform rag.require_allowed();
  return rag.correct_query(p_query);
end;
$$;
revoke execute on function public.lab_correct_query(text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke execute on function public.lab_correct_query(text) from anon';
    execute 'grant execute on function public.lab_correct_query(text) to authenticated';
    execute 'revoke execute on function rag.refresh_stats() from anon, authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'rag_loader') then
    execute 'grant execute on function rag.refresh_stats() to rag_loader';
  end if;
end $$;

select rag.rebuild_lexicon();
