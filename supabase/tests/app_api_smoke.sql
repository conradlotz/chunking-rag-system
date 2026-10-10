-- App API smoke test: access control, context construction and the lab_* functions.
-- Runs as the real roles and rolls back, so it leaves no data behind:
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/app_api_smoke.sql
-- (Needs supabase/tests/local_auth_stub.sql on a plain Postgres; hosted Supabase has auth.uid().)

begin;

-- Fixture: one tiny filing with a section of four paragraphs, one unit per paragraph --------------
insert into rag.component_versions (id, component, name, version, strategy, params) values
  ('parser/t@0',     'parser',           't',    '0', null,         '{}'),
  ('normalizer/t@0', 'normalizer',       't',    '0', null,         '{}'),
  ('tokenizer/t@0',  'tokenizer',        't',    '0', null,         '{}'),
  ('chunker/structural.max480@0', 'chunker', 'structural.max480', '0', 'structural', '{"max": 480}'),
  ('embedder/t@0',   'embedder',         't',    '0', null,         '{}'),
  ('keyword_analyzer/english@0', 'keyword_analyzer', 'english', '0', null, '{}'),
  ('retriever/hybrid@0', 'retriever',    'hybrid', '0', null,       '{}'),
  ('context_builder/expand@0', 'context_builder', 'expand', '0',  null, '{}');

insert into rag.companies (cik, ticker, name) values ('0000000001', 'TST', 'Test Co');
insert into rag.filings (id, accession_no, cik, form, fiscal_year, period_of_report, filed_at, primary_document,
                         source_url, source_sha256, source_bytes, fetched_at)
values ('00000000-0000-0000-0000-00000000f001', '0000000001-26-000001', '0000000001', '10-K', 2025, '2025-12-31',
        '2026-02-15', 't.htm', 'https://www.sec.gov/Archives/test', 'x', 1, now());

do $$
declare
  doc   constant uuid := '00000000-0000-0000-0000-00000000d001';
  heads text := 'Item 1A. Risk Factors';
  paras text[] := array[
    'Suppliers are concentrated in Asia and any disruption raises our costs.',
    'Our logistics partners handle most shipments, so freight rates matter.',
    'Currency movements affect reported revenue and operating margin.',
    'Cybersecurity incidents could interrupt operations and damage trust.'];
  doc_text text;
  pos   int;
  i     int;
  s     int;
  e     int;
  nid   bigint;
  sec   bigint;
  docn  bigint;
  setid constant uuid := '00000000-0000-0000-0000-00000000e001';
  starts int[] := '{}'; ends int[] := '{}'; toks int[] := '{}'; nodes bigint[] := '{}';
begin
  doc_text := heads || E'\n\n' || array_to_string(paras, E'\n\n');
  insert into rag.canonical_documents (id, filing_id, parser_version_id, normalizer_version_id, tokenizer_version_id,
                                       text, text_sha256, token_count, items)
  values (doc, '00000000-0000-0000-0000-00000000f001', 'parser/t@0', 'normalizer/t@0', 'tokenizer/t@0', doc_text, 'x',
          (select sum(cardinality(regexp_split_to_array(p, '\s+'))) from unnest(paras || heads) p)::int, '{1A}');
  insert into rag.nodes (canonical_document_id, parent_id, ordinal, depth, node_type, item, heading, heading_path,
                         start_char, end_char, token_count)
  values (doc, null, 0, 0, 'document', null, null, '{}', 0, char_length(doc_text), 80) returning id into docn;
  insert into rag.nodes (canonical_document_id, parent_id, ordinal, depth, node_type, item, heading, heading_path,
                         start_char, end_char, token_count)
  values (doc, docn, 1, 1, 'item', '1A', heads, array[heads], 0, char_length(doc_text), 80) returning id into sec;
  pos := char_length(heads) + 2;
  for i in 1..4 loop
    s := pos; e := pos + char_length(paras[i]);
    insert into rag.nodes (canonical_document_id, parent_id, ordinal, depth, node_type, item, heading_path,
                           start_char, end_char, token_count, sentence_starts)
    values (doc, sec, 1 + i, 2, 'paragraph', '1A', array[heads], s, e,
            cardinality(regexp_split_to_array(paras[i], '\s+')), array[s]) returning id into nid;
    starts := starts || s; ends := ends || e; toks := toks || cardinality(regexp_split_to_array(paras[i], '\s+'));
    nodes := nodes || nid;
    pos := e + 2;
  end loop;
  insert into rag.chunk_layouts (canonical_document_id, chunker_version_id, starts, ends, token_counts, node_ids, total_tokens)
  values (doc, 'chunker/structural.max480@0', starts, ends, toks, nodes, (select sum(t) from unnest(toks) t));
  insert into rag.embedding_sets (id, chunker_version_id, embedder_version_id, keyword_analyzer_version_id, status, retention, unit_count)
  values (setid, 'chunker/structural.max480@0', 'embedder/t@0', 'keyword_analyzer/english@0', 'ready', 'retained', 4);
  for i in 1..4 loop
    insert into rag.units (embedding_set_id, canonical_document_id, ordinal, start_char, end_char, token_count, node_id, item,
                           embedding, tsv)
    values (setid, doc, i - 1, starts[i], ends[i], toks[i], nodes[i], '1A',
            (select array_agg(case when k = i then 1.0 else 0.01 end) from generate_series(1, 384) k)::extensions.halfvec(384),
            to_tsvector('english', substr(doc_text, starts[i] + 1, ends[i] - starts[i])));
  end loop;
end;
$$;

select rag.refresh_stats();

insert into rag.app_users (user_id, email) values ('33333333-3333-3333-3333-333333333333', 'allowed-test@example.com');

-- 1. anon cannot even call the functions ----------------------------------------------------------------
set local role anon;
do $$
begin
  perform public.lab_overview();
  raise exception 'anon was able to call lab_overview';
exception when insufficient_privilege then null;
end;
$$;
reset role;

-- 2. a logged-in user who is not on the allow-list is refused (lab_is_allowed says so without raising) --------------------------------------------
set local role authenticated;
select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
do $$
declare
  v_failed int := 0;
begin
  if public.lab_is_allowed() then raise exception 'lab_is_allowed true for a non-allow-listed user'; end if;
  begin perform public.lab_overview();     exception when insufficient_privilege then v_failed := v_failed + 1; end;
  begin perform public.lab_filings();      exception when insufficient_privilege then v_failed := v_failed + 1; end;
  begin perform public.lab_search(null, 'suppliers', '00000000-0000-0000-0000-00000000e001', 'keyword', 3);
                                           exception when insufficient_privilege then v_failed := v_failed + 1; end;
  begin perform public.lab_context('{1}', 100); exception when insufficient_privilege then v_failed := v_failed + 1; end;
  begin perform public.lab_document_text('00000000-0000-0000-0000-00000000d001');
                                           exception when insufficient_privilege then v_failed := v_failed + 1; end;
  if v_failed <> 5 then raise exception 'non-allow-listed user got through % of 5 calls', 5 - v_failed; end if;
  -- and cannot read the tables directly either
  begin
    perform 1 from rag.filings;
    raise exception 'authenticated could read rag.filings directly';
  exception when insufficient_privilege then null;
  end;
end;
$$;

-- 3. the allow-listed user can use every function --------------------------------------------------------
select set_config('request.jwt.claim.sub', '33333333-3333-3333-3333-333333333333', true);
do $$
declare
  setid constant uuid := '00000000-0000-0000-0000-00000000e001';
  doc   constant uuid := '00000000-0000-0000-0000-00000000d001';
  j     jsonb;
  ids   bigint[];
  n     int;
begin
  if not public.lab_is_allowed() then raise exception 'lab_is_allowed false for the allow-listed user'; end if;
  j := public.lab_overview();
  if (j -> 'corpus' ->> 'filings')::int <> 1 then raise exception 'overview filings wrong: %', j; end if;
  if jsonb_array_length(j -> 'layouts') < 1 then raise exception 'overview layouts missing'; end if;

  j := public.lab_filings('TS');
  if (j ->> 'total')::int <> 1 or j -> 'rows' -> 0 ->> 'ticker' <> 'TST' then raise exception 'lab_filings wrong: %', j; end if;
  if (public.lab_filings('zzz') ->> 'total')::int <> 0 then raise exception 'lab_filings filter wrong'; end if;

  j := public.lab_document(doc);
  if jsonb_array_length(j -> 'nodes') <> 6 or jsonb_array_length(j -> 'layouts') <> 1 then
    raise exception 'lab_document wrong: nodes %, layouts %', jsonb_array_length(j -> 'nodes'), jsonb_array_length(j -> 'layouts');
  end if;
  if char_length(public.lab_document_text(doc)) <> (j ->> 'char_count')::int then raise exception 'lab_document_text length'; end if;
  if substr(public.lab_document_text(doc, 0, 4), 1, 4) <> 'Item' then raise exception 'lab_document_text slice'; end if;

  j := public.lab_layout(doc, 'chunker/structural.max480@0');
  if jsonb_array_length(j -> 'starts') <> 4 then raise exception 'lab_layout wrong'; end if;

  j := public.lab_configs();
  if jsonb_array_length(j -> 'embedding_sets') <> 1 or jsonb_array_length(j -> 'chunkers') <> 1 then
    raise exception 'lab_configs wrong: %', j;
  end if;

  -- search: keyword, vector (exact + approximate), hybrid; filters
  j := public.lab_search(null, 'currency revenue margin', setid, 'keyword', 3);
  if j -> 0 ->> 'text' not like 'Currency%' then raise exception 'keyword search wrong: %', j -> 0; end if;
  j := public.lab_search((select '[' || string_agg(case when k = 4 then '1.0' else '0.01' end, ',') || ']'
                            from generate_series(1, 384) k), null, setid, 'vector', 3, p_exact => true);
  if j -> 0 ->> 'text' not like 'Cybersecurity%' then raise exception 'vector search wrong: %', j -> 0; end if;
  j := public.lab_search((select '[' || string_agg(case when k = 4 then '1.0' else '0.01' end, ',') || ']'
                            from generate_series(1, 384) k), 'cybersecurity', setid, 'hybrid', 3);
  if (j -> 0 ->> 'vector_rank') is null or (j -> 0 ->> 'keyword_rank') is null then raise exception 'hybrid ranks missing'; end if;
  if jsonb_array_length(public.lab_search(null, 'suppliers', setid, 'keyword', 3, p_tickers => array['NOPE'])) <> 0 then
    raise exception 'ticker filter ignored';
  end if;

  -- context: static ----------------------------------------------------------------------------------
  -- unit ids come from the API (this role cannot read rag.units directly)
  select array_agg((x ->> 'unit_id')::bigint order by (x ->> 'start')::int) into ids
    from jsonb_array_elements(public.lab_search(null, 'suppliers logistics currency cybersecurity', setid, 'keyword', 10)) x;
  if cardinality(ids) <> 4 then raise exception 'expected 4 units, got %', cardinality(ids); end if;
  j := public.lab_context(array[ids[2]], 1000, 'static');
  if jsonb_array_length(j) <> 1 or j -> 0 ->> 'role' <> 'hit' then raise exception 'static context wrong: %', j; end if;

  -- context: neighbours (hit + previous + next paragraph)
  j := public.lab_context(array[ids[2]], 1000, 'expand', 1, 0);
  if jsonb_array_length(j) <> 3 then raise exception 'neighbour expansion should give 3 spans, got %', (select jsonb_agg(jsonb_build_object('role', x ->> 'role', 'start', x -> 'start', 'end', x -> 'end', 'tok', x -> 'tokens')) from jsonb_array_elements(j) x); end if;
  if (select string_agg(x ->> 'role', ',' order by (x ->> 'start')::int) from jsonb_array_elements(j) x) <> 'neighbor,hit,neighbor' then
    raise exception 'neighbour roles wrong: %', j;
  end if;

  -- context: parent replaces what it contains
  j := public.lab_context(array[ids[2]], 1000, 'expand', 1, 1);
  if jsonb_array_length(j) <> 1 or j -> 0 ->> 'role' <> 'parent' then raise exception 'parent expansion wrong: %', j; end if;

  -- context: budget is respected (hit 12 tokens, neighbours about 11 each)
  select sum((x ->> 'tokens')::int) into n
    from jsonb_array_elements(public.lab_context(array[ids[2]], 25, 'expand', 1, 1)) x;
  if n > 25 then raise exception 'budget exceeded: % tokens', n; end if;
  if jsonb_array_length(public.lab_context(array[ids[2]], 1, 'static')) <> 0 then raise exception 'oversized hit should be skipped'; end if;

  -- context: no overlapping spans when hits are adjacent
  if exists (
    select 1 from jsonb_array_elements(public.lab_context(array[ids[2], ids[3]], 1000, 'expand', 1, 0)) a
    join jsonb_array_elements(public.lab_context(array[ids[2], ids[3]], 1000, 'expand', 1, 0)) b
      on (a ->> 'ord') <> (b ->> 'ord')
     and (a ->> 'start')::int < (b ->> 'end')::int and (b ->> 'start')::int < (a ->> 'end')::int) then
    raise exception 'context spans overlap';
  end if;

  -- context is deterministic
  if public.lab_context(array[ids[3], ids[1]], 60, 'expand', 1, 0) is distinct from
     public.lab_context(array[ids[3], ids[1]], 60, 'expand', 1, 0) then
    raise exception 'context not deterministic';
  end if;

  if jsonb_array_length(public.lab_gold_spans(doc)) <> 0 then raise exception 'lab_gold_spans should be empty for the fixture'; end if;
  perform public.lab_resource_usage();
  perform public.lab_ingest_stats();
  perform public.lab_storage();
  perform public.lab_benchmarks();
  perform public.lab_pareto('none', 'recall_at_5', 'chunks');
end;
$$;

reset role;
select 'app api smoke test passed' as result;

rollback;
