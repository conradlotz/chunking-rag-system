"""End-to-end load of real SEC filings into a target database (benchmark or hosted).

discover -> fetch -> parse -> canonicalise -> load (via ``ingest``) -> chunk one configuration ->
embed with gte-small (ONNX) -> load units, embedding set and retrieval config.

Runs wherever SEC and Hugging Face are reachable (a GitHub Actions runner, a laptop). Needs
``SEC_USER_AGENT``. The model files are downloaded once into ``data/models/gte-small`` (git-ignored).
Only real filings are loaded; the dev fixture is refused.
"""

from __future__ import annotations

import argparse
import json
import time
from datetime import UTC, datetime
from pathlib import Path

import httpx
import numpy as np
import psycopg

from chunking_lab.canonical import NORMALIZER
from chunking_lab.chunkers import build_chunker
from chunking_lab.ingest import OutOfScope, _load_one, _register
from chunking_lab.parse import PARSER
from chunking_lab.rawcache import FilingSource, RawCache
from chunking_lab.sec import SecClient
from chunking_lab.telemetry import host_info
from chunking_lab.tokenize import HFTokenizer
from chunking_lab.versions import ComponentVersion

MODEL_REPO = "https://huggingface.co/Supabase/gte-small/resolve/main"
MODEL_FILES = {"tokenizer.json": "tokenizer.json", "model_quantized.onnx": "onnx/model_quantized.onnx"}
EMBEDDER = ComponentVersion("embedder", "gte-small-onnx-q", "1.0.0",
                            params={"dims": 384, "model": "Supabase/gte-small", "file": "model_quantized.onnx"})
ANALYZER = ComponentVersion("keyword_analyzer", "english", "1.0.0")
RETRIEVER = ComponentVersion("retriever", "hybrid-rrf", "1.0.0", params={"rrf_k": 60})
CONTEXT = ComponentVersion("context_builder", "expand", "1.0.0")


def fetch_model(directory: Path) -> tuple[Path, Path, int]:
    """Download tokenizer + model once. Returns (tokenizer, model, wire bytes downloaded)."""
    directory.mkdir(parents=True, exist_ok=True)
    wire = 0
    for local, remote in MODEL_FILES.items():
        target = directory / local
        if target.exists() and target.stat().st_size > 0:
            continue
        with httpx.stream("GET", f"{MODEL_REPO}/{remote}", follow_redirects=True, timeout=300) as r:
            r.raise_for_status()
            with target.open("wb") as fh:
                for part in r.iter_bytes(1 << 20):
                    fh.write(part)
                    wire += len(part)
    return directory / "tokenizer.json", directory / "model_quantized.onnx", wire


class Embedder:
    """gte-small: mean-pooled, L2-normalised, 384 dimensions, inputs inside the 512-token window."""

    def __init__(self, tokenizer_path: Path, model_path: Path) -> None:
        import onnxruntime as ort
        from tokenizers import Tokenizer

        self.tok = Tokenizer.from_file(str(tokenizer_path))
        self.tok.no_padding()
        self.tok.enable_truncation(max_length=512)
        self.session = ort.InferenceSession(str(model_path), providers=["CPUExecutionProvider"])
        self.tokens = 0

    def embed(self, texts: list[str], batch_size: int = 16) -> np.ndarray:
        encoded = [e.ids for e in self.tok.encode_batch(texts, add_special_tokens=True)]
        order = sorted(range(len(texts)), key=lambda i: len(encoded[i]))
        out = np.zeros((len(texts), 384), dtype=np.float32)
        for lo in range(0, len(order), batch_size):
            idx = order[lo:lo + batch_size]
            width = max(len(encoded[i]) for i in idx)
            ids = np.zeros((len(idx), width), dtype=np.int64)
            mask = np.zeros_like(ids)
            for row, i in enumerate(idx):
                ids[row, :len(encoded[i])] = encoded[i]
                mask[row, :len(encoded[i])] = 1
            hidden = self.session.run(None, {"input_ids": ids, "attention_mask": mask,
                                             "token_type_ids": np.zeros_like(ids)})[0]
            pooled = (hidden * mask[:, :, None]).sum(axis=1) / mask.sum(axis=1)[:, None]
            pooled /= np.maximum(np.linalg.norm(pooled, axis=1, keepdims=True), 1e-12)
            out[idx] = pooled
            self.tokens += int(mask.sum())
        return out


def _vec(v: np.ndarray) -> str:
    return "[" + ",".join(f"{x:.6f}" for x in v) + "]"


def _embed_filing(cur, embedder: Embedder, chunker, tokenizer, set_id, accession_no: str) -> tuple[int, int, float]:
    """Chunk one loaded filing, embed every chunk, store layout and units. Returns (units, tokens, seconds)."""
    cur.execute("select d.id, d.text from rag.canonical_documents d join rag.filings f on f.id=d.filing_id "
                "where f.accession_no=%s", (accession_no,))
    doc_id, text = cur.fetchone()
    cur.execute("select ordinal, id, start_char, end_char, item from rag.nodes "
                "where canonical_document_id=%s", (doc_id,))
    rows = cur.fetchall()
    ids = {r[0]: r[1] for r in rows}
    items = {r[0]: r[4] for r in rows}

    # Rebuild the in-memory document from the database so chunking sees exactly what was stored.
    from chunking_lab.model import CanonicalDocument, Node

    cur.execute("select ordinal,parent_id,depth,node_type,start_char,end_char,token_count,item,heading,heading_path,"
                "sentence_starts from rag.nodes where canonical_document_id=%s order by ordinal", (doc_id,))
    by_id = {r[1]: r[0] for r in rows}
    nodes = tuple(Node(ordinal=o, parent=by_id.get(p), depth=d, node_type=t, start=s, end=e, token_count=tc, item=it,
                       heading=h, heading_path=tuple(hp or ()), sentence_starts=tuple(ss) if ss else None)
                  for o, p, d, t, s, e, tc, it, h, hp, ss in cur.fetchall())
    doc = CanonicalDocument(text=text, nodes=nodes, items=tuple(sorted({n.item for n in nodes if n.item})),
                            token_count=sum(n.token_count for n in nodes if n.is_leaf),
                            parser_version=PARSER.id, normalizer_version=NORMALIZER.id,
                            tokenizer_version=tokenizer.version.id)
    layout = chunker.layout(doc, tokenizer)
    cur.execute("insert into rag.chunk_layouts (canonical_document_id,chunker_version_id,starts,ends,token_counts,"
                "node_ids,total_tokens) values (%s,%s,%s,%s,%s,%s,%s) on conflict do nothing",
                (doc_id, chunker.version.id, list(layout.starts), list(layout.ends), list(layout.token_counts),
                 [ids[o] for o in layout.node_ordinals], layout.total_tokens))
    texts = [text[s:e] for s, e in layout.spans()]
    t0 = time.perf_counter()
    vectors = embedder.embed(texts)
    seconds = time.perf_counter() - t0
    cur.executemany(
        "insert into rag.units (embedding_set_id,canonical_document_id,ordinal,start_char,end_char,token_count,"
        "node_id,item,embedding) values (%s,%s,%s,%s,%s,%s,%s,%s,%s::extensions.halfvec(384))",
        [(set_id, doc_id, i, s_, e_, layout.token_counts[i], ids[layout.node_ordinals[i]],
          items[layout.node_ordinals[i]], _vec(vectors[i])) for i, (s_, e_) in enumerate(layout.spans())])
    cur.execute("update rag.units u set tsv=to_tsvector('english', "
                "substr(d.text, u.start_char+1, u.end_char-u.start_char)) "
                "from rag.canonical_documents d where d.id=u.canonical_document_id and u.canonical_document_id=%s "
                "and u.embedding_set_id=%s", (doc_id, set_id))
    return len(texts), layout.total_tokens, seconds


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dsn", required=True, help="target Postgres DSN (use the Supabase session pooler)")
    ap.add_argument("--limit", type=int, default=20, help="filings to add to the target")
    ap.add_argument("--years", type=int, nargs="+", default=[2024, 2025])
    ap.add_argument("--strategy", default="structural", choices=("fixed", "recursive", "sentence", "structural",
                                                                 "hierarchical"))
    ap.add_argument("--size", type=int, default=256, help="chunk size in tokens (max 480)")
    ap.add_argument("--models", type=Path, default=Path("data/models/gte-small"))
    ap.add_argument("--mode", choices=("cache-first", "sec", "refresh", "cache-only"), default="cache-first")
    ap.add_argument("--tickers", nargs="*", help="restrict to these tickers (default: S&P 500 order)")
    ap.add_argument("--environment", choices=("benchmark", "hosted"), default="hosted")
    ap.add_argument("--make-production", action="store_true", help="set as the live retrieval configuration")
    args = ap.parse_args()

    tok_path, model_path, model_bytes = fetch_model(args.models)
    tokenizer = HFTokenizer(tok_path)
    embedder = Embedder(tok_path, model_path)
    params = {"size": args.size} if args.strategy in ("fixed", "recursive") else (
        {"atomic": args.size} if args.strategy == "hierarchical" else {"max_tokens": args.size})
    if args.strategy == "fixed":
        params = {"size": args.size, "overlap_pct": 0}
    chunker = build_chunker(args.strategy, **params)

    sec = SecClient()
    source = FilingSource(sec, RawCache(), args.mode)
    started = time.perf_counter()
    loaded = failed = units = embedded_tokens = streak = 0
    embed_seconds = 0.0

    with psycopg.connect(args.dsn, autocommit=True) as conn:
        with conn.cursor() as cur:
            cur.execute("select 1 from rag.companies where name ilike '%(FIXTURE)%' or cik like '9999%' limit 1")
            if cur.fetchone():
                raise SystemExit("target contains fixture data; refusing to mix it with real filings")
            for v in (PARSER, NORMALIZER, tokenizer.version, EMBEDDER, ANALYZER, RETRIEVER, CONTEXT, chunker.version):
                _register(cur, v)
            cur.execute("insert into rag.ingest_runs (environment,versions,config,host) values "
                        "(%s,%s,%s,%s) returning id",
                        (args.environment, json.dumps({"parser": PARSER.id, "chunker": chunker.version.id,
                                                      "embedder": EMBEDDER.id}),
                         json.dumps({"limit": args.limit, "years": args.years, "mode": args.mode}),
                         json.dumps(host_info())))
            run_id = cur.fetchone()[0]
            cur.execute("insert into rag.usage_ledger (category,subject,unit,quantity,ingest_run_id) values "
                        "('bandwidth','huggingface:gte-small','bytes',%s,%s)", (model_bytes, run_id))
            cur.execute("insert into rag.embedding_sets (chunker_version_id,embedder_version_id,"
                        "keyword_analyzer_version_id,status,retention) values (%s,%s,%s,'building',%s) "
                        "on conflict (chunker_version_id,embedder_version_id,keyword_analyzer_version_id) "
                        "do update set status='building' returning id",
                        (chunker.version.id, EMBEDDER.id, ANALYZER.id,
                         "production" if args.make_production else "retained"))
            set_id = cur.fetchone()[0]

        companies = sec.sp500_companies()
        if args.tickers:
            wanted = {t.upper() for t in args.tickers}
            companies = [c for c in companies if c.ticker.upper() in wanted]
        try:
            for company in companies:
                if loaded >= args.limit:
                    break
                try:
                    company, refs = sec.ten_k_filings(company, latest=2)
                except Exception as exc:  # discovery failures are reported, never silent
                    print(f"discovery failed {company.ticker}: {exc}", flush=True)
                    continue
                for ref in refs:
                    if loaded >= args.limit:
                        break
                    with conn.cursor() as cur:
                        cur.execute("select 1 from rag.filings where accession_no=%s", (ref.accession_no,))
                        have = cur.fetchone() is not None
                    try:
                        if not have:
                            _load_one(conn, run_id, company, ref, source, tokenizer, set(args.years))
                        with conn.transaction(), conn.cursor() as cur:
                            cur.execute("select 1 from rag.units u join rag.canonical_documents d on d.id="
                                        "u.canonical_document_id join rag.filings f on f.id=d.filing_id "
                                        "where f.accession_no=%s and u.embedding_set_id=%s limit 1",
                                        (ref.accession_no, set_id))
                            if cur.fetchone():
                                loaded += 1
                                continue
                            n, tk, secs = _embed_filing(cur, embedder, chunker, tokenizer, set_id, ref.accession_no)
                        units += n
                        embedded_tokens += tk
                        embed_seconds += secs
                        loaded += 1
                        streak = 0
                        print(f"{loaded}/{args.limit} {company.ticker} {ref.accession_no} units={n} "
                              f"tokens={tk} embed={secs:.1f}s", flush=True)
                    except OutOfScope:
                        pass
                    except Exception as exc:
                        failed += 1
                        streak += 1
                        print(f"failed {company.ticker} {ref.accession_no}: {exc}", flush=True)
                        if streak >= 5:
                            raise SystemExit(f"stopping after {streak} failures in a row; fix the cause and re-run")
            with conn.cursor() as cur:
                cur.execute("update rag.embedding_sets set status='ready', unit_count=(select count(*) from rag.units "
                            "where embedding_set_id=%s), tokens_embedded=%s, build_seconds=%s where id=%s",
                            (set_id, embedded_tokens, embed_seconds, set_id))
                cfg_id = f"{chunker.version.name}.hybrid.k10.b4000"
                cur.execute("insert into rag.retrieval_configs (id,embedding_set_id,retriever_version_id,"
                            "context_builder_version_id,budget_tokens,params) values (%s,%s,%s,%s,4000,%s) "
                            "on conflict (id) do nothing",
                            (cfg_id, set_id, RETRIEVER.id, CONTEXT.id, json.dumps({"mode": "hybrid", "k": 10})))
                if args.make_production:
                    cur.execute("insert into rag.production_config (singleton,retrieval_config_id,notes) values "
                                "(true,%s,'first real load') on conflict (singleton) do update set "
                                "retrieval_config_id=excluded.retrieval_config_id, activated_at=now()", (cfg_id,))
                cur.execute("insert into rag.usage_ledger (category,subject,unit,quantity,ingest_run_id) values "
                            "('embedding_compute',%s,'tokens',%s,%s),('embedding_compute',%s,'seconds',%s,%s)",
                            (EMBEDDER.id, embedded_tokens, run_id, EMBEDDER.id, embed_seconds, run_id))
                cur.execute("insert into rag.usage_ledger (category,subject,unit,quantity,ingest_run_id) values "
                            "('bandwidth','sec:total','bytes',%s,%s)", (sec.meter.total_wire(), run_id))
                cur.execute("select rag.refresh_stats()")
                cur.execute("select rag.snapshot_storage(%s,%s,%s)", (run_id, "publish", loaded))
                cur.execute("select count(*) from rag.verify_corpus()")
                integrity_errors = cur.fetchone()[0]
                summary = {"filings": loaded, "failed": failed, "units": units, "embedded_tokens": embedded_tokens,
                           "embed_seconds": round(embed_seconds, 2),
                           "embed_tokens_per_second": (round(embedded_tokens / embed_seconds, 1)
                                                       if embed_seconds else None),
                           "sec_wire_bytes": sec.meter.total_wire(), "model_download_bytes": model_bytes,
                           "wall_seconds": round(time.perf_counter() - started, 1),
                           "chunker": chunker.version.id, "integrity_errors": integrity_errors,
                           "finished": datetime.now(UTC).isoformat()}
                cur.execute("update rag.ingest_runs set finished_at=now(), status=%s, summary=%s where id=%s",
                            ("complete" if integrity_errors == 0 and loaded else "failed", json.dumps(summary), run_id))
            print(json.dumps(summary, indent=2), flush=True)
        except BaseException:
            with conn.cursor() as cur:
                cur.execute("update rag.ingest_runs set finished_at=now(), status='aborted' where id=%s", (run_id,))
            raise


if __name__ == "__main__":
    main()
