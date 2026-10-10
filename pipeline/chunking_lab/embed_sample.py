"""Measure local gte-small ONNX embedding throughput on real canonical SEC text.

This is a screening sample only. It records compute in the ingest run's telemetry
and usage ledger, but does not claim that all layouts have been embedded or indexed.
"""

from __future__ import annotations

import argparse
import json
import time
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import urlparse

import numpy as np
import onnxruntime as ort
import psycopg
from tokenizers import Tokenizer


def embed(session: ort.InferenceSession, batch: list[list[int]]) -> np.ndarray:
    width = max(len(ids) for ids in batch)
    input_ids = np.zeros((len(batch), width), dtype=np.int64)
    mask = np.zeros_like(input_ids)
    for row, ids in enumerate(batch):
        input_ids[row, :len(ids)] = ids
        mask[row, :len(ids)] = 1
    hidden = session.run(None, {"input_ids": input_ids, "attention_mask": mask,
                                "token_type_ids": np.zeros_like(input_ids)})[0]
    pooled = (hidden * mask[:, :, None]).sum(axis=1) / mask.sum(axis=1)[:, None]
    norm = np.linalg.norm(pooled, axis=1, keepdims=True)
    return pooled / np.maximum(norm, 1e-12)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dsn", required=True)
    ap.add_argument("--tokenizer", type=Path, required=True)
    ap.add_argument("--model", type=Path, required=True)
    ap.add_argument("--windows", type=int, default=128)
    ap.add_argument("--batch-size", type=int, default=8)
    args = ap.parse_args()
    if urlparse(args.dsn).hostname not in {"127.0.0.1", "localhost", "::1"}:
        raise SystemExit("embedding sample runs on local benchmark data only")
    tokenizer = Tokenizer.from_file(str(args.tokenizer))
    tokenizer.no_truncation()
    session = ort.InferenceSession(str(args.model), providers=["CPUExecutionProvider"])
    chunks: list[list[int]] = []
    with psycopg.connect(args.dsn) as conn, conn.cursor() as cur:
        cur.execute("select f.accession_no,d.text from rag.canonical_documents d "
                    "join rag.filings f on f.id=d.filing_id order by f.accession_no")
        for _, text in cur:
            ids = tokenizer.encode(text, add_special_tokens=True).ids
            # 256 tokens including the model's special tokens, comfortably inside its native window.
            for offset in range(0, len(ids) - 2, 254):
                chunks.append([ids[0], *ids[1 + offset:1 + offset + 254], ids[-1]])
                if len(chunks) >= args.windows:
                    break
            if len(chunks) >= args.windows:
                break
        if not chunks:
            raise SystemExit("no canonical documents to sample")
        tokens = sum(len(ids) for ids in chunks)
        started_at = datetime.now(UTC)
        cpu_start = time.process_time()
        wall_start = time.perf_counter()
        first = None
        for offset in range(0, len(chunks), args.batch_size):
            vectors = embed(session, chunks[offset:offset + args.batch_size])
            first = vectors[0] if first is None else first
        wall = time.perf_counter() - wall_start
        cpu = time.process_time() - cpu_start
        if first is None or first.shape != (384,) or not np.isfinite(first).all():
            raise RuntimeError("invalid embedding output")
        cur.execute("select id from rag.ingest_runs order by started_at desc limit 1")
        run_id = cur.fetchone()[0]
        cur.execute("insert into rag.ingest_events (run_id,accession_no,stage,started_at,wall_ms,cpu_ms,"
                    "counts,status) values (%s,%s,'embed',%s,%s,%s,%s,'ok')",
                    (run_id, 'sample:gte-small', started_at, wall * 1000, cpu * 1000,
                     json.dumps({"sample_only": True, "model": "gte-small-onnx-quantized",
                                 "windows": len(chunks), "tokens": tokens, "batch_size": args.batch_size})))
        cur.execute("insert into rag.usage_ledger (category,subject,unit,quantity,ingest_run_id,meta) values "
                    "('embedding_compute','gte-small-onnx-quantized','tokens',%s,%s,%s),"
                    "('embedding_compute','gte-small-onnx-quantized','seconds',%s,%s,%s)",
                    (tokens, run_id, json.dumps({"sample_only": True}), wall, run_id,
                     json.dumps({"sample_only": True})))
    print(json.dumps({"sample_windows": len(chunks), "tokens": tokens,
                      "wall_seconds": round(wall, 3), "cpu_seconds": round(cpu, 3),
                      "tokens_per_second": round(tokens / wall, 1), "dimensions": 384,
                      "sample_only": True}, indent=2))


if __name__ == "__main__":
    main()
