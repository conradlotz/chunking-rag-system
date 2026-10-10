"""Resumable SEC 10-K canonical ingest for the local benchmark database.

Run with a real SEC_USER_AGENT, a local PostgreSQL DSN, and a gte-small tokenizer.json.
The raw cache is disposable; original documents are never inserted into Postgres.
"""

from __future__ import annotations

import argparse
import json
import time
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import urlparse

import psycopg

from chunking_lab.canonical import NORMALIZER, build_canonical
from chunking_lab.parse import PARSER, parse_filing
from chunking_lab.rawcache import FilingSource, RawCache
from chunking_lab.sec import SecClient
from chunking_lab.telemetry import Recorder, host_info
from chunking_lab.tokenize import HFTokenizer
from chunking_lab.versions import ComponentVersion


class OutOfScope(ValueError):
    """The filing is valid, but outside the selected fiscal-year range."""


def _register(cur: psycopg.Cursor, version: ComponentVersion) -> None:
    cur.execute(
        "insert into rag.component_versions (id,component,name,version,strategy,params,code_sha) "
        "values (%s,%s,%s,%s,%s,%s,%s) on conflict (id) do nothing",
        (version.id, version.component, version.name, version.version, version.strategy,
         json.dumps(version.params), version.code_sha),
    )


def _flush_events(cur: psycopg.Cursor, run_id, recorder: Recorder) -> None:
    for e in recorder.drain():
        cur.execute(
            "insert into rag.ingest_events "
            "(run_id,accession_no,stage,started_at,wall_ms,cpu_ms,bytes_in,bytes_out,counts,status,error) "
            "values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
            (run_id, e.accession_no, e.stage, e.started_at, e.wall_ms, e.cpu_ms,
             e.bytes_in, e.bytes_out, json.dumps(e.counts), e.status, e.error),
        )


def _load_nodes(cur: psycopg.Cursor, doc_id, nodes) -> None:
    for depth in sorted({node.depth for node in nodes}):
        batch = [dict(ordinal=n.ordinal, parent=n.parent, depth=n.depth, node_type=n.node_type,
                      item=n.item, heading=n.heading, heading_path=list(n.heading_path),
                      start_char=n.start, end_char=n.end, token_count=n.token_count,
                      sentence_starts=list(n.sentence_starts) if n.sentence_starts else None)
                 for n in nodes if n.depth == depth]
        cur.execute(
            "insert into rag.nodes (canonical_document_id,parent_id,ordinal,depth,node_type,item,heading,"
            "heading_path,start_char,end_char,token_count,sentence_starts) "
            "select %s,p.id,x.ordinal,x.depth,x.node_type,x.item,x.heading,x.heading_path,x.start_char,"
            "x.end_char,x.token_count,x.sentence_starts "
            "from jsonb_to_recordset(%s::jsonb) as x(ordinal int,parent int,depth smallint,node_type text,"
            "item text,heading text,heading_path text[],start_char int,end_char int,token_count int,"
            "sentence_starts int[]) "
            "left join rag.nodes p on p.canonical_document_id=%s and p.ordinal=x.parent",
            (doc_id, json.dumps(batch), doc_id),
        )


def _load_one(conn, run_id, company, ref, source, tokenizer, years: set[int]) -> tuple[int, int, int]:
    recorder = Recorder()
    with recorder.stage(ref.accession_no, "fetch") as event:
        fetched = source.fetch(ref)
        event.bytes_in = fetched.wire_bytes
        event.bytes_out = len(fetched.body)
        event.counts = {"cache_hit": fetched.from_cache, "source_bytes": len(fetched.body)}
    try:
        with recorder.stage(ref.accession_no, "parse") as event:
            parsed = parse_filing(fetched.body)
            event.bytes_in = len(fetched.body)
            event.counts = parsed.diagnostics
            fiscal_year = int(parsed.dei.get("fiscal_year_focus") or ref.fiscal_year)
            if fiscal_year not in years:
                raise OutOfScope(f"fiscal year {fiscal_year} outside {sorted(years)}")
            if not parsed.items:
                raise ValueError("no in-scope items found")
        with recorder.stage(ref.accession_no, "normalize") as event:
            doc, diagnostics = build_canonical(parsed, tokenizer)
            event.bytes_out = len(doc.text.encode("utf-8"))
            event.counts = diagnostics
            if not doc.text or doc.token_count <= 0:
                raise ValueError("empty canonical document")
        with conn.transaction(), conn.cursor() as cur:
            with recorder.stage(ref.accession_no, "load") as event:
                cur.execute(
                    "insert into rag.companies (cik,ticker,name,sic,sic_description) values (%s,%s,%s,%s,%s) "
                    "on conflict (cik) do update set ticker=excluded.ticker,name=excluded.name,"
                    "sic=excluded.sic,sic_description=excluded.sic_description",
                    (company.cik, company.ticker, company.name, company.sic, company.sic_description),
                )
                cur.execute(
                    "insert into rag.filings (accession_no,cik,form,fiscal_year,period_of_report,filed_at,"
                    "primary_document,source_url,source_sha256,source_bytes,fetched_at) "
                    "values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) returning id",
                    (ref.accession_no, ref.cik, ref.form, fiscal_year, ref.period_of_report, ref.filed_at,
                     ref.primary_document, ref.source_url, fetched.sha256, len(fetched.body), fetched.fetched_at),
                )
                filing_id = cur.fetchone()[0]
                cur.execute(
                    "insert into rag.canonical_documents (filing_id,parser_version_id,normalizer_version_id,"
                    "tokenizer_version_id,text,text_sha256,token_count,items) "
                    "values (%s,%s,%s,%s,%s,%s,%s,%s) returning id",
                    (filing_id, PARSER.id, NORMALIZER.id, tokenizer.version.id, doc.text, doc.sha256,
                     doc.token_count, list(doc.items)),
                )
                _load_nodes(cur, cur.fetchone()[0], doc.nodes)
                event.counts = {"nodes": len(doc.nodes), "tokens": doc.token_count}
            cur.execute("insert into rag.ingest_jobs (accession_no,cik,stage,attempts) values (%s,%s,'loaded',1) "
                        "on conflict (accession_no) do update set stage='loaded',last_error=null,"
                        "attempts=rag.ingest_jobs.attempts+1", (ref.accession_no, ref.cik))
            _flush_events(cur, run_id, recorder)
            cur.execute("insert into rag.usage_ledger (category,subject,unit,quantity,ingest_run_id,accession_no,meta) "
                        "values ('bandwidth','sec:filing','bytes',%s,%s,%s,%s)",
                        (fetched.wire_bytes, run_id, ref.accession_no,
                         json.dumps({"decompressed_bytes": len(fetched.body), "cache_hit": fetched.from_cache})))
        return len(fetched.body), len(doc.text.encode("utf-8")), doc.token_count
    except OutOfScope:
        # The source remains in the raw cache for reproducibility. It is excluded from this run's target.
        with conn.transaction(), conn.cursor() as cur:
            _flush_events(cur, run_id, recorder)
            cur.execute("insert into rag.ingest_jobs (accession_no,cik,stage,attempts,last_error) "
                        "values (%s,%s,'skipped',1,'out of target fiscal years') on conflict (accession_no) "
                        "do update set stage='skipped',last_error=excluded.last_error",
                        (ref.accession_no, ref.cik))
        raise
    except Exception:
        with conn.transaction(), conn.cursor() as cur:
            last_error = next((event.error for event in reversed(recorder.events) if event.error), "ingest failed")
            _flush_events(cur, run_id, recorder)
            cur.execute("insert into rag.ingest_jobs (accession_no,cik,stage,attempts,last_error) "
                        "values (%s,%s,'failed',1,%s) on conflict (accession_no) do update set "
                        "stage='failed',attempts=rag.ingest_jobs.attempts+1,last_error=excluded.last_error",
                        (ref.accession_no, ref.cik, last_error))
        raise


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dsn", required=True)
    parser.add_argument("--tokenizer", type=Path, required=True)
    parser.add_argument("--limit", type=int, default=100)
    parser.add_argument("--years", type=int, nargs="+", default=[2024, 2025])
    parser.add_argument("--mode", choices=("cache-first", "cache-only", "sec", "refresh"), default="cache-first")
    args = parser.parse_args()
    if urlparse(args.dsn).hostname not in {"127.0.0.1", "localhost", "::1"}:
        raise SystemExit("first ingest runs on a local benchmark database only")
    tokenizer = HFTokenizer(args.tokenizer)
    sec = SecClient()
    source = FilingSource(sec, RawCache(), args.mode)
    started = time.perf_counter()
    loaded = failed = skipped = source_bytes = canonical_bytes = tokens = 0
    with psycopg.connect(args.dsn, autocommit=True) as conn:
        with conn.cursor() as cur:
            for version in (PARSER, NORMALIZER, tokenizer.version):
                _register(cur, version)
            cur.execute("insert into rag.ingest_runs (environment,versions,config,host) "
                        "values ('benchmark',%s,%s,%s) returning id",
                        (json.dumps({"parser": PARSER.id, "normalizer": NORMALIZER.id,
                                     "tokenizer": tokenizer.version.id}),
                         json.dumps({"target": args.limit, "mode": args.mode, "years": args.years,
                                     "target_total": 1000}),
                         json.dumps(host_info())))
            run_id = cur.fetchone()[0]
        try:
            companies = sec.sp500_companies()
            for company in companies:
                if loaded >= args.limit:
                    break
                try:
                    company, refs = sec.ten_k_filings(company, latest=2)
                except Exception as exc:
                    print(f"discovery failed {company.ticker}: {exc}", flush=True)
                    continue
                for ref in refs:
                    if loaded >= args.limit:
                        break
                    with conn.cursor() as cur:
                        cur.execute("select 1 from rag.filings where accession_no=%s", (ref.accession_no,))
                        if cur.fetchone():
                            continue
                    try:
                        b, c, t = _load_one(conn, run_id, company, ref, source, tokenizer, set(args.years))
                        loaded += 1
                        source_bytes += b
                        canonical_bytes += c
                        tokens += t
                        print(f"{loaded}/{args.limit} {company.ticker} {ref.accession_no} "
                              f"raw={b} canonical={c} tokens={t}", flush=True)
                    except OutOfScope:
                        skipped += 1
                    except Exception as exc:
                        failed += 1
                        print(f"failed {company.ticker} {ref.accession_no}: {exc}", flush=True)
            with conn.cursor() as cur:
                cur.execute("select rag.refresh_stats()")
                cur.execute("select rag.snapshot_storage(%s,%s,%s)", (run_id, "first-ingest", loaded))
                cur.execute("select count(*) from rag.verify_corpus()")
                integrity_errors = cur.fetchone()[0]
                summary = {"loaded": loaded, "failed": failed, "skipped": skipped,
                           "source_bytes": source_bytes,
                           "canonical_bytes": canonical_bytes, "tokens": tokens,
                           "download_wire_bytes": sec.meter.total_wire(),
                           "cache_hits": source.stats.hits,
                           "wall_seconds": round(time.perf_counter() - started, 3),
                           "integrity_errors": integrity_errors}
                status = "complete" if loaded == args.limit and integrity_errors == 0 else "failed"
                cur.execute("update rag.ingest_runs set finished_at=%s,status=%s,summary=%s where id=%s",
                            (datetime.now(UTC), status, json.dumps(summary), run_id))
                print(json.dumps(summary, indent=2), flush=True)
        except BaseException:
            with conn.cursor() as cur:
                cur.execute("update rag.ingest_runs set finished_at=now(),status='aborted' where id=%s", (run_id,))
            raise


if __name__ == "__main__":
    main()
