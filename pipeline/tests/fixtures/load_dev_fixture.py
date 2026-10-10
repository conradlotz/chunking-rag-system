"""Load the sample filings into a LOCAL Postgres through the real pipeline code (parser, canonical tree,
chunkers, retrieval, metrics), for developing and testing the web app.

FIXTURE DATA ONLY. The company is invented, the tokenizer is a regex stand-in (gte-small files are not available
offline), and the embedder is a deterministic hashed bag of words. The loader refuses any database that is not on
localhost, so fixture rows can never reach the hosted project.

    uv run python -m tests.fixtures.load_dev_fixture --dsn postgresql://postgres@127.0.0.1:54329/bench
"""

from __future__ import annotations

import argparse
import hashlib
import json
import time
from datetime import UTC, date, datetime
from urllib.parse import urlparse

import numpy as np
import psycopg

from chunking_lab.canonical import NORMALIZER, build_canonical
from chunking_lab.chunkers import (
    FixedChunker,
    HierarchicalUnitChunker,
    RecursiveChunker,
    SemanticChunker,
    SentenceChunker,
    StructuralChunker,
)
from chunking_lab.metrics import SpanIndex, layout_metrics, span_containment
from chunking_lab.parse import PARSER, parse_filing
from chunking_lab.tokenize import RegexTokenizer
from chunking_lab.versions import ComponentVersion
from tests.fixtures.dev_embedder import DIMS, EMBEDDER_ID, embed_many, embed_text
from tests.fixtures.sample_filing import sample_filing_html

FIXTURE_USER = "11111111-1111-1111-1111-111111111111"
ANALYZER = ComponentVersion("keyword_analyzer", "english", "fixture")
RETRIEVER = ComponentVersion("retriever", "hybrid-rrf", "fixture", params={"rrf_k": 60})
CONTEXT = ComponentVersion("context_builder", "expand", "fixture")
DEV_EMBEDDER = ComponentVersion("embedder", "dev-hash-bow", "fixture", params={"dims": DIMS, "fixture": True})

# (question id, type, text, quote, filing fiscal year)
QUESTIONS = [
    ("FX-01", "numeric", "What share of products is made by independent factories in Vietnam, Indonesia and China?",
     "independent factories in Vietnam, Indonesia and China produced approximately 86% of our products", 2025),
    ("FX-02", "numeric", "By how much did freight costs reduce gross margin?",
     "Higher freight rates reduced our gross margin by approximately 40 basis points in fiscal 2025.", 2025),
    ("FX-03", "factual", "How do tariffs threaten gross margin and what can offset them?",
     "our gross margin would decline unless we could offset the increase through price changes, supplier concessions or a shift in sourcing", 2025),
    ("FX-04", "numeric", "What was operating margin as a percent of net sales?",
     "Operating income was $412 million, or 10.7% of net sales", 2025),
    ("FX-05", "factual", "Why did wholesale sales fall?",
     "Wholesale net sales decreased 1.7% to $1.38 billion as several department store partners reduced inventory", 2025),
    ("FX-06", "numeric", "How much would a 10% stronger dollar reduce net sales?",
     "would have reduced fiscal 2025 net sales by approximately $62 million", 2025),
]

CHUNKERS = [
    ("fixed", dict(size=128, overlap_pct=0)),
    ("fixed", dict(size=128, overlap_pct=20)),
    ("fixed", dict(size=256, overlap_pct=0)),
    ("fixed", dict(size=256, overlap_pct=20)),
    ("fixed", dict(size=480, overlap_pct=0)),
    ("recursive", dict(target=256, overlap_pct=10)),
    ("sentence", dict(max_tokens=256)),
    ("structural", dict(max_tokens=256)),
    ("structural", dict(max_tokens=480)),
    ("semantic", dict(percentile=90)),
    ("hierarchical", dict(atomic=128)),
    ("hierarchical", dict(atomic=256)),
]


def build_chunker(strategy, params):
    if strategy == "fixed":
        return FixedChunker(**params)
    if strategy == "recursive":
        return RecursiveChunker(**params)
    if strategy == "sentence":
        return SentenceChunker(**params)
    if strategy == "structural":
        return StructuralChunker(**params)
    if strategy == "hierarchical":
        return HierarchicalUnitChunker(min_tokens=16, **params)
    return SemanticChunker(embed_many, embedder_id=EMBEDDER_ID, min_tokens=32, **params)


def register(cur, v: ComponentVersion):
    cur.execute(
        "insert into rag.component_versions (id, component, name, version, strategy, params, code_sha) "
        "values (%s,%s,%s,%s,%s,%s,%s) on conflict (id) do nothing",
        (v.id, v.component, v.name, v.version, v.strategy, json.dumps(v.params), v.code_sha),
    )


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dsn", required=True)
    ap.add_argument("--reset", action="store_true", help="delete existing fixture rows first")
    args = ap.parse_args()

    host = urlparse(args.dsn).hostname
    if host not in ("127.0.0.1", "localhost", "::1"):
        raise SystemExit(f"refusing to load fixture data into non-local database host {host!r}")

    tokenizer = RegexTokenizer()
    t_run = time.perf_counter()
    with psycopg.connect(args.dsn, autocommit=False) as conn, conn.cursor() as cur:
        if args.reset:
            cur.execute("truncate rag.filings, rag.companies, rag.embedding_sets, rag.retrieval_configs, "
                        "rag.questions, rag.benchmark_runs, rag.experiments, rag.ingest_runs, rag.usage_ledger, "
                        "rag.storage_snapshots, rag.production_config restart identity cascade")
        cur.execute("insert into rag.app_users (user_id, email) values (%s, 'fixture@local.invalid') "
                    "on conflict do nothing", (FIXTURE_USER,))
        for v in (PARSER, NORMALIZER, tokenizer.version, DEV_EMBEDDER, ANALYZER, RETRIEVER, CONTEXT):
            register(cur, v)

        cur.execute("insert into rag.ingest_runs (environment, versions, config, host, git_sha) values "
                    "('benchmark', %s, %s, %s, 'fixture') returning id",
                    (json.dumps({"parser": PARSER.id, "normalizer": NORMALIZER.id, "tokenizer": tokenizer.version.id}),
                     json.dumps({"fixture": True}), json.dumps({"note": "development fixture"})))
        run_id = cur.fetchone()[0]

        cur.execute("insert into rag.companies (cik, ticker, name, sic, sic_description) values "
                    "('0009999001','HPO','Harbor & Pine Outfitters, Inc. (FIXTURE)','5651','Retail-Family Clothing Stores') "
                    "on conflict do nothing")

        docs: dict[int, dict] = {}
        for fy in (2024, 2025):
            body = sample_filing_html(fy)
            t0 = time.perf_counter()
            parsed = parse_filing(body)
            t_parse = (time.perf_counter() - t0) * 1000
            t0 = time.perf_counter()
            doc, diag = build_canonical(parsed, tokenizer)
            t_canon = (time.perf_counter() - t0) * 1000
            acc = f"0009999001-{26 - (2025 - fy):02d}-00000{fy - 2023}"
            cur.execute(
                "insert into rag.filings (accession_no, cik, form, fiscal_year, period_of_report, filed_at, primary_document,"
                " source_url, source_sha256, source_bytes, fetched_at) values (%s,'0009999001','10-K',%s,%s,%s,%s,%s,%s,%s,%s)"
                " returning id",
                (acc, fy, date(fy + 1, 1, 31), date(fy + 1, 3, 15), f"hpo-{fy}.htm",
                 f"https://www.sec.gov/Archives/edgar/data/9999001/{acc.replace('-', '')}/hpo-{fy}.htm",
                 hashlib.sha256(body).hexdigest(), len(body), datetime.now(UTC)))
            filing_id = cur.fetchone()[0]
            cur.execute(
                "insert into rag.canonical_documents (filing_id, parser_version_id, normalizer_version_id, tokenizer_version_id,"
                " text, text_sha256, token_count, items) values (%s,%s,%s,%s,%s,%s,%s,%s) returning id",
                (filing_id, PARSER.id, NORMALIZER.id, tokenizer.version.id, doc.text, doc.sha256, doc.token_count,
                 list(doc.items)))
            doc_id = cur.fetchone()[0]
            ids: dict[int, int] = {}
            for n in doc.nodes:
                cur.execute(
                    "insert into rag.nodes (canonical_document_id, parent_id, ordinal, depth, node_type, item, heading,"
                    " heading_path, start_char, end_char, token_count, sentence_starts) values"
                    " (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) returning id",
                    (doc_id, ids.get(n.parent) if n.parent is not None else None, n.ordinal, n.depth, n.node_type, n.item,
                     n.heading, list(n.heading_path), n.start, n.end, n.token_count,
                     list(n.sentence_starts) if n.sentence_starts else None))
                ids[n.ordinal] = cur.fetchone()[0]
            docs[fy] = dict(doc=doc, doc_id=doc_id, ids=ids)
            for stage, wall, bytes_in, bytes_out in (("parse", t_parse, len(body), len(doc.text)),
                                                     ("normalize", t_canon, len(doc.text), len(doc.text))):
                cur.execute("insert into rag.ingest_events (run_id, accession_no, stage, started_at, wall_ms, bytes_in,"
                            " bytes_out, counts, status) values (%s,%s,%s,now(),%s,%s,%s,%s,'ok')",
                            (run_id, acc, stage, wall, bytes_in, bytes_out, json.dumps(diag)))

        # gold questions + spans (anchored to the FY2025 canonical text)
        d25 = docs[2025]
        cur.execute("delete from rag.questions where id like 'FX-%'")
        gold_spans: list[tuple[int, int]] = []
        for qid, qtype, text, quote, _fy in QUESTIONS:
            start = d25["doc"].text.index(quote)
            cur.execute("insert into rag.questions (id, tier, split, qtype, question, answerable, origin, author)"
                        " values (%s,'gold','dev',%s,%s,true,'human','fixture')", (qid, qtype, text))
            cur.execute("insert into rag.gold_spans (question_id, canonical_document_id, start_char, end_char, quote)"
                        " values (%s,%s,%s,%s,%s)", (qid, d25["doc_id"], start, start + len(quote), quote))
            gold_spans.append((start, start + len(quote)))

        cur.execute("insert into rag.experiments (id, name, strategy, hypothesis, axes, stage, is_primary, status) values "
                    "('fixture-sweep','Fixture sweep (development data)',null,"
                    "'Exercises the sweep views with real metrics on the invented sample filings.',%s,'screening',true,'complete')"
                    " on conflict (id) do nothing", (json.dumps({"fixture": True}),))
        cur.execute("insert into rag.benchmark_runs (kind, environment, git_sha, corpus, versions, config, status, summary)"
                    " values ('retrieval','benchmark','fixture',%s,%s,%s,'complete',%s) returning id",
                    (json.dumps({"filings": 2, "fixture": True}), json.dumps({}), json.dumps({"fixture": True}),
                     json.dumps({"note": "development fixture"})))
        bench_run = cur.fetchone()[0]

        for strategy, params in CHUNKERS:
            chunker = build_chunker(strategy, params)
            register(cur, chunker.version)
            total_tokens = 0
            for fy, d in docs.items():
                t0 = time.perf_counter()
                layout = chunker.layout(d["doc"], tokenizer)
                wall = (time.perf_counter() - t0) * 1000
                total_tokens += layout.total_tokens
                cur.execute(
                    "insert into rag.chunk_layouts (canonical_document_id, chunker_version_id, starts, ends, token_counts,"
                    " node_ids, total_tokens) values (%s,%s,%s,%s,%s,%s,%s)",
                    (d["doc_id"], chunker.version.id, list(layout.starts), list(layout.ends), list(layout.token_counts),
                     [d["ids"][o] for o in layout.node_ordinals], layout.total_tokens))
                d.setdefault("layouts", {})[chunker.version.id] = layout
                cur.execute("insert into rag.ingest_events (run_id, accession_no, stage, started_at, wall_ms, counts, status)"
                            " values (%s,%s,'chunk',now(),%s,%s,'ok')",
                            (run_id, f"fixture-{fy}", wall, json.dumps({"config": chunker.version.id, "chunks": len(layout)})))

            # embed units (dev embedder) and build the keyword index
            t0 = time.perf_counter()
            cur.execute("insert into rag.embedding_sets (chunker_version_id, embedder_version_id, keyword_analyzer_version_id,"
                        " status, retention) values (%s,%s,%s,'building','retained') returning id",
                        (chunker.version.id, DEV_EMBEDDER.id, ANALYZER.id))
            set_id = cur.fetchone()[0]
            n_units = embedded_tokens = 0
            for fy, d in docs.items():
                layout = d["layouts"][chunker.version.id]
                texts = [d["doc"].text[s:e] for s, e in layout.spans()]
                vecs = embed_many(texts)
                for i, (s, e) in enumerate(layout.spans()):
                    node = d["doc"].nodes[layout.node_ordinals[i]]
                    cur.execute(
                        "insert into rag.units (embedding_set_id, canonical_document_id, ordinal, start_char, end_char,"
                        " token_count, node_id, item, embedding, tsv) values (%s,%s,%s,%s,%s,%s,%s,%s,%s::extensions.halfvec(384),"
                        " to_tsvector('english', %s))",
                        (set_id, d["doc_id"], i, s, e, layout.token_counts[i], d["ids"][node.ordinal], node.item,
                         "[" + ",".join(f"{x:.6f}" for x in vecs[i]) + "]", texts[i]))
                n_units += len(texts)
                embedded_tokens += layout.total_tokens
            embed_secs = time.perf_counter() - t0
            cur.execute("update rag.embedding_sets set status='ready', unit_count=%s, tokens_embedded=%s, build_seconds=%s"
                        " where id=%s", (n_units, embedded_tokens, embed_secs, set_id))
            cur.execute("insert into rag.usage_ledger (category, subject, unit, quantity, ingest_run_id) values"
                        " ('embedding_compute', %s, 'tokens', %s, %s), ('embedding_compute', %s, 'seconds', %s, %s)",
                        (DEV_EMBEDDER.id, embedded_tokens, run_id, DEV_EMBEDDER.id, embed_secs, run_id))
            cur.execute("insert into rag.retrieval_configs (id, embedding_set_id, retriever_version_id,"
                        " context_builder_version_id, budget_tokens, params) values (%s,%s,%s,%s,2000,%s)",
                        (f"{chunker.version.name}.hybrid.k10.b2000", set_id, RETRIEVER.id, CONTEXT.id,
                         json.dumps({"mode": "hybrid", "k": 10})))

            # measure: real retrieval on the fixture questions + intrinsic metrics
            hits_at5, rr, full = [], [], []
            lat = []
            d25_layout = d25["layouts"][chunker.version.id]
            for qid, _t, text, quote, _fy in QUESTIONS:
                g0 = d25["doc"].text.index(quote)
                g1 = g0 + len(quote)
                t0 = time.perf_counter()
                cur.execute("select unit_id, start_char, end_char, canonical_document_id from rag.search_units("
                            "%s::extensions.halfvec(384), %s, %s, 'hybrid', 10, p_exact => true)",
                            ("[" + ",".join(f"{x:.6f}" for x in embed_text(text)) + "]", text, set_id))
                rows = cur.fetchall()
                lat.append((time.perf_counter() - t0) * 1000)
                found_rank = None
                for r in range(1, len(rows) + 1):
                    cover = sum(max(0, min(e, g1) - max(s, g0)) for _u, s, e, did in rows[:r] if did == d25["doc_id"])
                    if cover >= 0.8 * (g1 - g0):
                        found_rank = r
                        break
                hits_at5.append(found_rank is not None and found_rank <= 5)
                rr.append(1 / found_rank if found_rank else 0.0)
                full.append(found_rank is not None and found_rank <= 5)
            idx = SpanIndex(d25_layout)
            asc = span_containment(idx, gold_spans).summary()
            cur.execute(
                "insert into rag.sweep_points (experiment_id, run_id, chunker_version_id, params, stage, recall_at_5, mrr,"
                " answer_span_containment, full_evidence_rate, chunks, tokens_embedded, retrieval_p95_ms, extra) values"
                " ('fixture-sweep',%s,%s,%s,'screening',%s,%s,%s,%s,%s,%s,%s,%s)",
                (bench_run, chunker.version.id, json.dumps({"strategy": strategy, **params}),
                 float(np.mean(hits_at5)), float(np.mean(rr)), asc["contained_rate"], float(np.mean(full)),
                 n_units, embedded_tokens, float(np.percentile(lat, 95)), json.dumps({"fixture": True})))
            cur.execute("insert into rag.sweep_points (experiment_id, run_id, chunker_version_id, params, stage,"
                        " answer_span_containment, chunks, tokens_embedded) values ('fixture-sweep',%s,%s,%s,'intrinsic',"
                        "%s,%s,%s)", (bench_run, chunker.version.id, json.dumps({"strategy": strategy, **params}),
                                      asc["contained_rate"], n_units, embedded_tokens))
            print(f"  {chunker.version.id:42s} chunks={n_units:3d} recall@5={np.mean(hits_at5):.2f} "
                  f"containment={asc['contained_rate']:.2f}")

        # production pointer: the structural.max256 configuration
        cur.execute("insert into rag.production_config (retrieval_config_id, notes) values "
                    "('structural.max256.hybrid.k10.b2000', 'fixture: chosen for development only') "
                    "on conflict (singleton) do update set retrieval_config_id = excluded.retrieval_config_id")
        cur.execute("update rag.ingest_runs set finished_at=now(), status='complete' where id=%s", (run_id,))
        cur.execute("select rag.snapshot_storage(%s, 'fixture-load', 2)", (run_id,))
        cur.execute("select rag.refresh_stats()")
        cur.execute("select count(*) from rag.verify_corpus()")
        problems = cur.fetchone()[0]
        if problems:
            raise SystemExit(f"verify_corpus found {problems} problems")
        conn.commit()
    print(f"loaded fixture in {time.perf_counter() - t_run:.1f}s")


if __name__ == "__main__":
    main()
