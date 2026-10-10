-- Schema smoke test. Runs every layer end to end inside one transaction and
-- rolls back, so it never leaves data behind:
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/schema_smoke.sql
-- Any failed assertion aborts with an error.

begin;

-- Registry ------------------------------------------------------------------
insert into rag.component_versions (id, component, name, version, strategy, params) values
  ('parser/test-parser@0.0.0',              'parser',           'test-parser', '0.0.0', null,         '{}'),
  ('normalizer/test-norm@0.0.0',            'normalizer',       'test-norm',   '0.0.0', null,         '{}'),
  ('tokenizer/test-tok@0.0.0',              'tokenizer',        'test-tok',    '0.0.0', null,         '{}'),
  ('chunker/structural@0.0.0',              'chunker',          'structural',  '0.0.0', 'structural', '{"max": 480}'),
  ('embedder/test-emb@0.0.0',               'embedder',         'test-emb',    '0.0.0', null,         '{"dims": 384}'),
  ('keyword_analyzer/english@0.0.0',        'keyword_analyzer', 'english',     '0.0.0', null,         '{}'),
  ('retriever/hybrid@0.0.0',                'retriever',        'hybrid',      '0.0.0', null,         '{"mode": "hybrid"}'),
  ('context_builder/static@0.0.0',          'context_builder',  'static',      '0.0.0', null,         '{}');

-- Versions are immutable.
do $$
begin
  update rag.component_versions set params = '{"max": 1}' where id = 'chunker/structural@0.0.0';
  raise exception 'expected immutability error';
exception when raise_exception then
  if sqlerrm not like '%immutable%' then raise; end if;
end;
$$;

-- Source + canonical ----------------------------------------------------------
insert into rag.companies (cik, ticker, name) values ('0000000001', 'TST', 'Test Co');

insert into rag.filings (id, accession_no, cik, form, fiscal_year, period_of_report, filed_at,
                         primary_document, source_url, source_sha256, source_bytes, fetched_at)
values ('00000000-0000-0000-0000-000000000001', '0000000001-26-000001', '0000000001', '10-K', 2025,
        '2025-12-31', '2026-02-15', 'tst-10k.htm', 'https://www.sec.gov/Archives/test', 'x', 1, now());

-- text: [0,36) heading, [38,107) paragraph 1, [109,150) paragraph 2
insert into rag.canonical_documents (id, filing_id, parser_version_id, normalizer_version_id, tokenizer_version_id,
                                     text, text_sha256, token_count, items)
values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-000000000001',
        'parser/test-parser@0.0.0', 'normalizer/test-norm@0.0.0', 'tokenizer/test-tok@0.0.0',
        'Item 1A. Risk Factors — Supply chain' || E'\n\n' ||
        'Our suppliers are concentrated in Asia. Disruption could raise costs.' || E'\n\n' ||
        'Revenue grew 12% to $4.2 billion in 2025.',
        'x', 40, '{1A}');

do $$
declare
  v_len int;
begin
  select char_count into v_len from rag.canonical_documents where id = '00000000-0000-0000-0000-0000000000d1';
  if v_len <> 150 then raise exception 'unexpected canonical length %', v_len; end if;
end;
$$;

insert into rag.nodes (canonical_document_id, parent_id, ordinal, depth, node_type, item, heading, heading_path,
                       start_char, end_char, token_count, sentence_starts)
values ('00000000-0000-0000-0000-0000000000d1', null, 0, 0, 'document', null, null, '{}', 0, 150, 40, null);

insert into rag.nodes (canonical_document_id, parent_id, ordinal, depth, node_type, item, heading, heading_path,
                       start_char, end_char, token_count, sentence_starts)
select '00000000-0000-0000-0000-0000000000d1', id, 1, 1, 'item', '1A', 'Item 1A. Risk Factors — Supply chain',
       '{"Item 1A. Risk Factors — Supply chain"}', 0, 150, 40, null
from rag.nodes where ordinal = 0 and canonical_document_id = '00000000-0000-0000-0000-0000000000d1';

insert into rag.nodes (canonical_document_id, parent_id, ordinal, depth, node_type, item, heading_path,
                       start_char, end_char, token_count, sentence_starts)
select '00000000-0000-0000-0000-0000000000d1', p.id, v.ord, 2, 'paragraph', '1A',
       '{"Item 1A. Risk Factors — Supply chain"}', v.s, v.e, v.t, v.ss
from rag.nodes p,
     (values (2, 38, 107, 14, array[38, 78]), (3, 109, 150, 12, array[109])) as v(ord, s, e, t, ss)
where p.ordinal = 1 and p.canonical_document_id = '00000000-0000-0000-0000-0000000000d1';

-- Canonical text is immutable.
do $$
begin
  update rag.canonical_documents set text = 'changed' where id = '00000000-0000-0000-0000-0000000000d1';
  raise exception 'expected immutability error';
exception when raise_exception then
  if sqlerrm not like '%immutable%' then raise; end if;
end;
$$;

-- Boundaries ----------------------------------------------------------------
insert into rag.chunk_layouts (canonical_document_id, chunker_version_id, starts, ends, token_counts, node_ids, total_tokens)
select '00000000-0000-0000-0000-0000000000d1', 'chunker/structural@0.0.0',
       array[38, 109], array[107, 150], array[14, 12],
       array_agg(id order by ordinal), 26
from rag.nodes where canonical_document_id = '00000000-0000-0000-0000-0000000000d1' and ordinal in (2, 3);

-- Artifacts -----------------------------------------------------------------
insert into rag.embedding_sets (id, chunker_version_id, embedder_version_id, keyword_analyzer_version_id, status)
values ('00000000-0000-0000-0000-0000000000e1', 'chunker/structural@0.0.0', 'embedder/test-emb@0.0.0',
        'keyword_analyzer/english@0.0.0', 'ready');

insert into rag.units (embedding_set_id, canonical_document_id, ordinal, start_char, end_char, token_count,
                       node_id, item, embedding, tsv)
select '00000000-0000-0000-0000-0000000000e1', d.id, l.ord - 1, l.starts[l.ord], l.ends[l.ord],
       l.token_counts[l.ord], l.node_ids[l.ord], '1A',
       (select array_agg(case when i = l.ord then 1.0 else 0.01 end) from generate_series(1, 384) i)::extensions.halfvec(384),
       to_tsvector('english', substr(d.text, l.starts[l.ord] + 1, l.ends[l.ord] - l.starts[l.ord]))
from rag.canonical_documents d
join (select *, generate_subscripts(starts, 1) as ord from rag.chunk_layouts) l on l.canonical_document_id = d.id;

-- Integrity ------------------------------------------------------------------
do $$
declare
  v_problems int;
begin
  select count(*) into v_problems from rag.verify_corpus();
  if v_problems <> 0 then raise exception 'verify_corpus reported % problems', v_problems; end if;
end;
$$;

-- Retrieval: all modes and both vector paths --------------------------------
do $$
declare
  q2 extensions.halfvec(384) := (select array_agg(case when i = 2 then 1.0 else 0.01 end) from generate_series(1, 384) i)::extensions.halfvec(384);
  r record;
begin
  -- vector, exact: unit 2 (revenue paragraph) must rank first
  select * into r from rag.search_units(q2, null, '00000000-0000-0000-0000-0000000000e1', 'vector', 5, p_exact => true) limit 1;
  if r.start_char <> 109 then raise exception 'exact vector search ranked wrong unit first (%)', r.start_char; end if;

  -- vector, approximate (binary quantised + re-rank)
  select * into r from rag.search_units(q2, null, '00000000-0000-0000-0000-0000000000e1', 'vector', 5, p_exact => false) limit 1;
  if r.start_char <> 109 then raise exception 'approximate vector search ranked wrong unit first (%)', r.start_char; end if;

  -- keyword
  select * into r from rag.search_units(null, 'which suppliers could disrupt costs', '00000000-0000-0000-0000-0000000000e1', 'keyword', 5) limit 1;
  if r.start_char <> 38 then raise exception 'keyword search ranked wrong unit first (%)', r.start_char; end if;

  -- hybrid returns both, with ranks from both lists
  if (select count(*) from rag.search_units(q2, 'revenue suppliers', '00000000-0000-0000-0000-0000000000e1', 'hybrid', 5, p_exact => true)) <> 2 then
    raise exception 'hybrid search should return both units';
  end if;

  -- filters
  if exists (select 1 from rag.search_units(q2, null, '00000000-0000-0000-0000-0000000000e1', 'vector', 5, p_tickers => array['NOPE'], p_exact => true)) then
    raise exception 'ticker filter not applied';
  end if;
  if exists (select 1 from rag.search_units(q2, null, '00000000-0000-0000-0000-0000000000e1', 'vector', 5, p_items => array['7'], p_exact => true)) then
    raise exception 'item filter not applied';
  end if;
end;
$$;

-- Retrieval config + production pointer --------------------------------------
insert into rag.retrieval_configs (id, embedding_set_id, retriever_version_id, context_builder_version_id, budget_tokens)
values ('test-config', '00000000-0000-0000-0000-0000000000e1', 'retriever/hybrid@0.0.0', 'context_builder/static@0.0.0', 2000);
insert into rag.production_config (retrieval_config_id) values ('test-config');

-- Evaluation: gold span trigger ---------------------------------------------
insert into rag.questions (id, tier, split, qtype, question, answerable, origin, author)
values ('TEST-1', 'gold', 'dev', 'numeric', 'How much did revenue grow?', true, 'human', 'test');

insert into rag.gold_spans (question_id, canonical_document_id, start_char, end_char, quote)
values ('TEST-1', '00000000-0000-0000-0000-0000000000d1', 109, 150, 'Revenue grew 12% to $4.2 billion in 2025.');

do $$
begin
  insert into rag.gold_spans (question_id, canonical_document_id, start_char, end_char, quote)
  values ('TEST-1', '00000000-0000-0000-0000-0000000000d1', 109, 150, 'Revenue fell');
  raise exception 'expected quote mismatch';
exception when raise_exception then
  if sqlerrm not like '%does not match%' then raise; end if;
end;
$$;

-- Tuning experiments and Pareto frontier ---------------------------------------
insert into rag.component_versions (id, component, name, version, strategy, params) values
  ('chunker/structural.max256@0.0.0', 'chunker', 'structural.max256', '0.0.0', 'structural', '{"max": 256}'),
  ('chunker/structural.max1024@0.0.0', 'chunker', 'structural.max1024', '0.0.0', 'structural', '{"max": 1024}');

insert into rag.experiments (id, name, strategy, axes, stage, is_primary)
values ('exp-structural-max', 'structural max sweep', 'structural', '{"max": [128, 256, 384, 480]}', 'screening', true);

-- cost = chunks (lower better); quality = recall_at_5 (higher better)
-- A (256): recall .95, 91k chunks   B (480): recall .93, 48k   C (1024): recall .90, 27k
-- D (dominated by B): recall .91, 60k
insert into rag.sweep_points (experiment_id, chunker_version_id, params, stage, recall_at_5, chunks) values
  ('exp-structural-max', 'chunker/structural.max256@0.0.0',  '{"max": 256}',  'screening', 0.95, 91000),
  ('exp-structural-max', 'chunker/structural@0.0.0',         '{"max": 480}',  'screening', 0.93, 48000),
  ('exp-structural-max', 'chunker/structural.max1024@0.0.0', '{"max": 1024}', 'screening', 0.90, 27000),
  ('exp-structural-max', 'chunker/structural@0.0.0',         '{"max": 480, "variant": "d"}', 'screening', 0.91, 60000),
  ('exp-structural-max', 'chunker/structural@0.0.0',         '{"max": 480, "variant": "no-metric"}', 'screening', null, 10000);

do $$
declare
  v_params jsonb;
  v_n int;
begin
  select count(*) into v_n from rag.pareto_frontier('exp-structural-max', 'recall_at_5', 'chunks');
  if v_n <> 3 then raise exception 'pareto frontier should keep 3 points, got %', v_n; end if;
  if exists (
    select 1 from rag.pareto_frontier('exp-structural-max', 'recall_at_5', 'chunks') f
    join rag.sweep_points sp on sp.id = f.point_id
    where sp.params ->> 'variant' is not null
  ) then raise exception 'dominated or incomplete point leaked into the frontier'; end if;
  -- query-time params live on retrieval configs
  update rag.retrieval_configs set params = '{"k": 10, "neighbor_expansion": 1}' where id = 'test-config';
  select params into v_params from rag.retrieval_configs where id = 'test-config';
  if (v_params ->> 'k')::int <> 10 then raise exception 'retrieval config params not stored'; end if;
end;
$$;

-- Telemetry -----------------------------------------------------------------
insert into rag.ingest_runs (id, environment, versions, config)
values ('00000000-0000-0000-0000-0000000000a1', 'benchmark', '{}', '{}');
insert into rag.ingest_events (run_id, accession_no, stage, started_at, wall_ms, bytes_in, bytes_out, counts, status)
values ('00000000-0000-0000-0000-0000000000a1', '0000000001-26-000001', 'parse', now(), 12.5, 100, 50, '{"blocks": 2}', 'ok');

do $$
begin
  if rag.snapshot_storage('00000000-0000-0000-0000-0000000000a1', 'smoke', 1) < 20 then
    raise exception 'snapshot_storage captured too few relations';
  end if;
end;
$$;

-- Resource accounting: categories keep their own units ---------------------------
insert into rag.usage_ledger (category, subject, unit, quantity, ingest_run_id, accession_no) values
  ('bandwidth',         'sec:filing',                 'bytes',    1500000, '00000000-0000-0000-0000-0000000000a1', '0000000001-26-000001'),
  ('bandwidth',         'sec:filing',                 'requests', 1,       '00000000-0000-0000-0000-0000000000a1', '0000000001-26-000001'),
  ('embedding_compute', 'embedder/test-emb@0.0.0',    'tokens',   4000000, '00000000-0000-0000-0000-0000000000a1', null),
  ('embedding_compute', 'embedder/test-emb@0.0.0',    'seconds',  400,     '00000000-0000-0000-0000-0000000000a1', null);
insert into rag.usage_ledger (category, subject, unit, quantity, cost_usd) values
  ('llm', 'claude-opus-5-5:answer', 'usd', 0.026, 0.026);

do $$
declare
  v_bad int := 0;
begin
  -- embedding tokens cannot be filed under bandwidth, bytes cannot be LLM tokens, bandwidth has no dollar cost
  begin insert into rag.usage_ledger (category, subject, unit, quantity) values ('bandwidth', 'x', 'tokens', 1);
        v_bad := v_bad + 1; exception when check_violation then null; end;
  begin insert into rag.usage_ledger (category, subject, unit, quantity) values ('llm', 'x', 'bytes', 1);
        v_bad := v_bad + 1; exception when check_violation then null; end;
  begin insert into rag.usage_ledger (category, subject, unit, quantity, cost_usd) values ('embedding_compute', 'x', 'tokens', 1, 0.5);
        v_bad := v_bad + 1; exception when check_violation then null; end;
  begin insert into rag.usage_ledger (category, subject, unit, quantity) values ('storage', 'x', 'bytes', 1);
        v_bad := v_bad + 1; exception when check_violation then null; end;
  if v_bad <> 0 then raise exception 'usage_ledger accepted % invalid rows', v_bad; end if;

  if (select quantity from rag.resource_usage where category = 'bandwidth' and unit = 'bytes') <> 1500000 then
    raise exception 'resource_usage bandwidth wrong';
  end if;
  if (select quantity from rag.resource_usage where category = 'embedding_compute' and unit = 'tokens') <> 4000000 then
    raise exception 'resource_usage embedding tokens wrong';
  end if;
  if (select sum(cost_usd) from rag.resource_usage where category = 'llm') <> 0.026 then
    raise exception 'resource_usage llm cost wrong';
  end if;
  -- storage comes from the latest storage snapshot, not the ledger
  if not exists (select 1 from rag.resource_usage where category = 'storage' and subject = 'units' and unit = 'bytes') then
    raise exception 'resource_usage is missing storage rows';
  end if;
  -- the four categories never collapse into one total
  if (select count(distinct category) from rag.resource_usage) <> 4 then
    raise exception 'expected four distinct resource categories';
  end if;
end;
$$;

select rag.refresh_stats();

do $$
begin
  if (select tokens from rag.corpus_stats) <> 40 then raise exception 'corpus_stats wrong'; end if;
  if (select chunks from rag.layout_stats where chunker_version_id = 'chunker/structural@0.0.0') <> 2 then
    raise exception 'layout_stats wrong';
  end if;
end;
$$;

-- Rate limiter -----------------------------------------------------------------
do $$
begin
  if not rag.check_rate_limit('smoke', 2, 3600) then raise exception 'rate limit 1'; end if;
  if not rag.check_rate_limit('smoke', 2, 3600) then raise exception 'rate limit 2'; end if;
  if rag.check_rate_limit('smoke', 2, 3600) then raise exception 'rate limit should block third call'; end if;
end;
$$;

select 'schema smoke test passed' as result;

rollback;
