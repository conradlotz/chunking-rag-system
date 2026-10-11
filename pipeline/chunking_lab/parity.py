"""Embedding parity check: are queries embedded the same way as the corpus?

The corpus is embedded offline with gte-small ONNX (publish.Embedder); live questions are embedded by
Supabase's built-in gte-small (Edge Function). If the two disagree, vector search compares vectors from
two different spaces. This fetches the fixed probe sentences embedded by the Edge Function
(supabase/functions/embed-parity), embeds the same sentences offline, prints their cosine similarity,
and runs a vector search with each embedding so the results can be compared side by side.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import httpx
import numpy as np
import psycopg

from chunking_lab.publish import Embedder, fetch_model


def _vec(v) -> str:
    return "[" + ",".join(f"{x:.6f}" for x in v) + "]"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dsn", required=True)
    ap.add_argument("--url", required=True, help="Supabase project URL")
    ap.add_argument("--key", required=True, help="anon (public) key")
    ap.add_argument("--models", type=Path, default=Path("data/models/gte-small"))
    args = ap.parse_args()

    res = httpx.post(f"{args.url}/functions/v1/embed-parity",
                     headers={"Authorization": f"Bearer {args.key}", "apikey": args.key}, timeout=120)
    res.raise_for_status()
    probes = res.json()["probes"]
    tok, model, _ = fetch_model(args.models)
    embedder = Embedder(tok, model)
    offline = embedder.embed([p["text"] for p in probes])

    print("## Edge Function vs offline ONNX, same text (1.000 = identical)")
    report = {"cosine": {}, "search": {}}
    for p, off in zip(probes, offline, strict=True):
        live = np.asarray(p["embedding"], dtype=np.float32)
        cos = float(np.dot(live, off) / (np.linalg.norm(live) * np.linalg.norm(off)))
        report["cosine"][p["text"]] = round(cos, 4)
        print(f"  {cos:7.4f}  norm(live)={np.linalg.norm(live):.3f}  {p['text']}")

    with psycopg.connect(args.dsn) as conn, conn.cursor() as cur:
        cur.execute("select e.id from rag.embedding_sets e join rag.retrieval_configs r on r.embedding_set_id = e.id "
                    "join rag.production_config p on p.retrieval_config_id = r.id")
        set_id = cur.fetchone()[0]
        for idx in (0, 1, 2):
            for label, emb in (("edge", probes[idx]["embedding"]), ("offline", offline[idx])):
                cur.execute(
                    "select s.vector_similarity, c.ticker, u.item, "
                    "left(regexp_replace(substr(d.text, s.start_char + 1, s.end_char - s.start_char), "
                    "'\\s+', ' ', 'g'), 110) "
                    "from rag.search_units(%s::extensions.halfvec(384), null, %s, 'vector', 5, "
                    "p_exact => true) s "
                    "join rag.units u on u.id = s.unit_id join rag.canonical_documents d on d.id = s.canonical_document_id "
                    "join rag.filings f on f.id = d.filing_id join rag.companies c on c.cik = f.cik "
                    "order by s.vector_similarity desc", (_vec(emb), set_id))
                rows = cur.fetchall()
                key = f"{label}: {probes[idx]['text']}"
                report["search"][key] = [[round(r[0], 3), r[1], r[2], r[3]] for r in rows]
                print(f"\n## Vector search, {key}")
                for sim, ticker, item, txt in rows:
                    print(f"  {sim:.3f}  {ticker:6} Item {item or '-':3} {txt}")
    print("\n" + json.dumps(report["cosine"], indent=2))


if __name__ == "__main__":
    main()
