"""Does changing the chunk size help? A retrieval benchmark over real 10-K filings.

The same filings are cut several ways (fixed-size token windows vs. structure-aware chunks, at several sizes),
every chunk is embedded with gte-small, and hand-written questions with known answer sentences are run against
each version. A question is *found* when the top results cover at least 80% of its answer sentence.

Retrieval mirrors production: exact cosine similarity on the vectors, a BM25 keyword score, and reciprocal-rank
fusion with the keyword rank weighted 1.5x. The search pool is the filings holding an answer plus distractor
filings, so every question competes against tens of thousands of chunks from other companies.

Nothing is stored per chunk in the hosted database. Only the questions, their answer spans, one row per
configuration in ``rag.sweep_points`` and the run summary are written, which is what the Benchmarks page reads.

    uv run python -m chunking_lab.benchmark --dsn "$DB" --questions ../bench/questions.json
"""

from __future__ import annotations

import argparse
import json
import math
import re
import time
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

import numpy as np
import psycopg

from chunking_lab.chunkers import build_chunker
from chunking_lab.ingest import _register
from chunking_lab.metrics import SpanIndex, layout_metrics, span_containment
from chunking_lab.publish import EMBEDDER, RETRIEVER, Embedder, fetch_model, load_document
from chunking_lab.telemetry import host_info
from chunking_lab.tokenize import HFTokenizer

EXPERIMENT = "chunk-size-10k"
SIZES = (128, 256, 384, 480)
CONFIGS = [("fixed", {"size": s, "overlap_pct": 0}) for s in SIZES] + [
    ("structural", {"max_tokens": s}) for s in SIZES]
K = 10
FOUND = 0.8          # share of the answer sentence the results must cover
CANDIDATES = 100     # per retriever, before fusion (as in production)
RRF_K = 60
KEYWORD_WEIGHT = 1.5
BUDGETS = (1000, 2000)  # equal-context comparison: results taken until this many tokens

_WORD = re.compile(r"[a-z0-9]+(?:\.[0-9]+)?")
_STOP = frozenset({
    "a", "an", "and", "are", "as", "at", "be", "by", "did", "do", "does", "for", "from", "had", "has", "have",
    "how", "in", "is", "it", "its", "of", "on", "or", "our", "than", "that", "the", "their", "they", "this", "to",
    "was", "we", "were", "what", "when", "which", "who", "why", "with",
})


# ---------------------------------------------------------------------------------------------------------------
# pure pieces (unit-tested)

def locate(text: str, quote: str) -> list[tuple[int, int]]:
    """Every occurrence of ``quote`` in ``text``; whitespace runs may differ."""
    spans = []
    start = text.find(quote)
    while start >= 0:
        spans.append((start, start + len(quote)))
        start = text.find(quote, start + 1)
    if spans:
        return spans
    pattern = r"\s+".join(re.escape(w) for w in quote.split())
    return [m.span() for m in re.finditer(pattern, text)]


def coverage(chunks: list[tuple[int, int]], span: tuple[int, int]) -> float:
    """Share of ``span`` covered by the union of ``chunks`` (same document)."""
    s, e = span
    parts = sorted((max(cs, s), min(ce, e)) for cs, ce in chunks if ce > s and cs < e)
    covered, pos = 0, s
    for a, b in parts:
        a = max(a, pos)
        if b > a:
            covered += b - a
            pos = b
    return covered / (e - s)


def terms(text: str) -> list[str]:
    """Keyword terms: lower-cased words and numbers, stop words dropped, plural -s removed.

    A light stand-in for Postgres' English stemmer, good enough to rank exact figures and names."""
    out = []
    for w in _WORD.findall(text.lower()):
        if w in _STOP:
            continue
        if len(w) > 3 and w.endswith("s") and not w.endswith("ss"):
            w = w[:-1]
        out.append(w)
    return out


class BM25:
    def __init__(self, docs: list[list[str]], k1: float = 1.2, b: float = 0.75) -> None:
        self.k1, self.b = k1, b
        self.lengths = np.array([len(d) for d in docs], dtype=np.float32)
        self.avg = float(self.lengths.mean()) if len(docs) else 0.0
        self.postings: dict[str, list[tuple[int, int]]] = defaultdict(list)
        for i, d in enumerate(docs):
            for t, n in Counter(d).items():
                self.postings[t].append((i, n))
        self.n = len(docs)

    def scores(self, query: list[str]) -> dict[int, float]:
        out: dict[int, float] = defaultdict(float)
        for t in set(query):
            plist = self.postings.get(t)
            if not plist:
                continue
            idf = math.log(1 + (self.n - len(plist) + 0.5) / (len(plist) + 0.5))
            for i, tf in plist:
                norm = tf + self.k1 * (1 - self.b + self.b * self.lengths[i] / self.avg)
                out[i] += idf * tf * (self.k1 + 1) / norm
        return out


def fuse(vector: list[int], keyword: list[int], rrf_k: int = RRF_K,
         keyword_weight: float = KEYWORD_WEIGHT) -> list[int]:
    """Reciprocal-rank fusion of two ranked id lists (best first)."""
    score: dict[int, float] = defaultdict(float)
    for r, i in enumerate(vector, 1):
        score[i] += 1 / (rrf_k + r)
    for r, i in enumerate(keyword, 1):
        score[i] += keyword_weight / (rrf_k + r)
    return sorted(score, key=lambda i: (-score[i], i))


@dataclass
class Outcome:
    rank: int | None          # first rank at which the answer is found (None: not in the top K)
    full_at_5: bool           # the top 5 hold the whole answer sentence
    doc_at_5: bool            # the right filing appears in the top 5
    context_tokens_5: int     # tokens a model would read from the top 5
    found_at_budget: dict[int, bool]


def judge(ranked: list[int], chunk_doc: np.ndarray, chunk_span: np.ndarray, chunk_tokens: np.ndarray,
          gold_doc: int, gold: list[tuple[int, int]]) -> Outcome:
    """Score one ranked result list against the answer spans (any occurrence counts)."""
    def cov(n: int) -> float:
        mine = [tuple(chunk_span[i]) for i in ranked[:n] if chunk_doc[i] == gold_doc]
        return max(coverage(mine, g) for g in gold) if mine else 0.0

    rank = next((r for r in range(1, min(K, len(ranked)) + 1) if cov(r) >= FOUND), None)
    by_budget = {}
    for budget in BUDGETS:
        used = n = 0
        while n < len(ranked) and used + chunk_tokens[ranked[n]] <= budget:
            used += int(chunk_tokens[ranked[n]])
            n += 1
        by_budget[budget] = cov(n) >= FOUND
    return Outcome(rank=rank, full_at_5=cov(5) >= 0.999, doc_at_5=any(chunk_doc[i] == gold_doc for i in ranked[:5]),
                   context_tokens_5=int(sum(chunk_tokens[i] for i in ranked[:5])), found_at_budget=by_budget)


def summarise(outcomes: list[Outcome]) -> dict:
    n = len(outcomes)

    def rate(xs) -> float:
        return sum(xs) / n if n else 0.0

    return {
        "recall_at_1": rate(o.rank == 1 for o in outcomes),
        "recall_at_5": rate(o.rank is not None and o.rank <= 5 for o in outcomes),
        "recall_at_10": rate(o.rank is not None for o in outcomes),
        "mrr": sum(1 / o.rank for o in outcomes if o.rank) / n if n else 0.0,
        "full_evidence_rate": rate(o.full_at_5 for o in outcomes),
        "doc_at_5": rate(o.doc_at_5 for o in outcomes),
        "context_tokens_mean": float(np.mean([o.context_tokens_5 for o in outcomes])) if n else 0.0,
        **{f"recall_at_budget_{b}": rate(o.found_at_budget[b] for o in outcomes) for b in BUDGETS},
    }


# ---------------------------------------------------------------------------------------------------------------
# the run

def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dsn", required=True)
    ap.add_argument("--questions", type=Path, required=True)
    ap.add_argument("--pool", type=int, default=100, help="filings searched: those holding answers plus distractors")
    ap.add_argument("--models", type=Path, default=Path("../data/models/gte-small"))
    ap.add_argument("--configs", nargs="*", help="limit to these chunker names, e.g. fixed.s256.o0")
    args = ap.parse_args()

    spec = json.loads(args.questions.read_text())["questions"]
    tok_path, model_path, _ = fetch_model(args.models)
    tokenizer = HFTokenizer(tok_path)
    embedder = Embedder(tok_path, model_path)
    started = time.perf_counter()

    with psycopg.connect(args.dsn, autocommit=True) as conn, conn.cursor() as cur:
        cur.execute("select 1 from rag.companies where name ilike '%(FIXTURE)%' or cik like '9999%' limit 1")
        if cur.fetchone():
            raise SystemExit("target contains fixture data; refusing to benchmark against it")
        selected = "join rag.corpus_selection s on s.filing_id = f.id" if _has_selection(cur) else ""
        cur.execute(f"select d.id, d.text, c.ticker, f.accession_no from rag.canonical_documents d "
                    f"join rag.filings f on f.id = d.filing_id join rag.companies c on c.cik = f.cik {selected} "
                    f"order by c.ticker = any(%s) desc, md5(f.accession_no) limit %s",
                    ([q["ticker"] for q in spec], args.pool))
        rows = cur.fetchall()
        by_ticker = {r[2]: i for i, r in enumerate(rows)}
        missing = sorted({q["ticker"] for q in spec} - set(by_ticker))
        if missing:
            raise SystemExit(f"no filing in the corpus for {missing}")

        docs, accessions = [], []
        for doc_id, text, _ticker, acc in rows:
            doc, _ids, _items = load_document(cur, doc_id, text, tokenizer)
            docs.append((doc_id, doc))
            accessions.append(acc)
        print(f"pool: {len(docs)} filings, {sum(d.token_count for _, d in docs):,} tokens", flush=True)

        # Questions and where their answers are.
        questions = []
        for q in spec:
            i = by_ticker[q["ticker"]]
            gold = locate(docs[i][1].text, q["quote"])
            if not gold:
                raise SystemExit(f"{q['id']}: answer quote not found in {q['ticker']} {accessions[i]}")
            questions.append((q, i, gold))
        _store_questions(cur, questions, docs, accessions)

        q_vecs = embedder.embed([q["question"] for q, _, _ in questions])
        q_terms = [terms(q["question"]) for q, _, _ in questions]

        cur.execute("insert into rag.benchmark_runs (kind, environment, corpus, versions, config, status, notes) "
                    "values ('retrieval', 'hosted', %s, %s, %s, 'running', %s) returning id",
                    (json.dumps({"filings": len(docs), "answer_filings": len({i for _, i, _ in questions}),
                                 "tokens": sum(d.token_count for _, d in docs)}),
                     json.dumps({"embedder": EMBEDDER.id, "retriever": RETRIEVER.id,
                                 "tokenizer": tokenizer.version.id}),
                     json.dumps({"k": K, "found_threshold": FOUND, "candidates": CANDIDATES, "rrf_k": RRF_K,
                                 "keyword_weight": KEYWORD_WEIGHT, "budgets": list(BUDGETS),
                                 "questions": len(questions), "host": host_info()}),
                     "Chunk size benchmark: fixed vs structure-aware chunks, gold questions, exact vector search"))
        run_id = cur.fetchone()[0]
        cur.execute("insert into rag.experiments (id, name, strategy, hypothesis, axes, stage, is_primary, status) "
                    "values (%s, %s, null, %s, %s, 'screening', true, 'running') on conflict (id) do update set "
                    "name = excluded.name, hypothesis = excluded.hypothesis, axes = excluded.axes, status = 'running'",
                    (EXPERIMENT, "Chunk size: fixed vs structure-aware",
                     "There is no universal best size. Small chunks pinpoint facts but split answers; large chunks "
                     "keep answers whole but cost more context and dilute the match. Structure-aware chunks should do "
                     "better than blind token windows at every size.",
                     json.dumps({"strategy": ["fixed", "structural"], "size": list(SIZES), "overlap_pct": [0]})))
        cur.execute("delete from rag.sweep_points where experiment_id = %s", (EXPERIMENT,))

        results = {}
        try:
            for strategy, params in CONFIGS:
                chunker = build_chunker(strategy, **params)
                if args.configs and chunker.version.name not in args.configs:
                    continue
                _register(cur, chunker.version)
                results[chunker.version.name] = _measure(cur, run_id, chunker, strategy, params, docs, questions,
                                                         embedder, tokenizer, q_vecs, q_terms)
        except BaseException:
            cur.execute("update rag.benchmark_runs set status = 'failed' where id = %s", (run_id,))
            raise

        question_set = [{"id": q["id"], "ticker": q["ticker"], "question": q["question"], "answer": q.get("answer"),
                         "quote": q["quote"]} for q, _, _ in questions]
        summary = {"experiment": EXPERIMENT, "configs": results, "questions": len(questions), "filings": len(docs),
                   "question_set": question_set,
                   "wall_seconds": round(time.perf_counter() - started, 1), "finished": datetime.now(UTC).isoformat()}
        cur.execute("update rag.benchmark_runs set status = 'complete', summary = %s where id = %s",
                    (json.dumps(summary), run_id))
        cur.execute("update rag.experiments set status = 'complete' where id = %s", (EXPERIMENT,))
    print(json.dumps({k: {m: round(v, 3) for m, v in r.items() if isinstance(v, float)} for k, r in results.items()},
                     indent=1), flush=True)


def _has_selection(cur) -> bool:
    cur.execute("select to_regclass('rag.corpus_selection') is not null")
    return cur.fetchone()[0]


def _store_questions(cur, questions, docs, accessions) -> None:
    ids = [q["id"] for q, _, _ in questions]
    cur.execute("delete from rag.questions where id like 'G-%%' and not (id = any(%s))", (ids,))
    for q, i, gold in questions:
        cur.execute("insert into rag.questions (id, tier, split, qtype, question, reference_answer, answerable, origin,"
                    " author, metadata) values (%s, 'gold', 'dev', %s, %s, %s, true, 'llm_assisted', 'claude', %s) "
                    "on conflict (id) do update set qtype = excluded.qtype, question = excluded.question, "
                    "reference_answer = excluded.reference_answer, metadata = excluded.metadata",
                    (q["id"], q["qtype"], q["question"], q.get("answer"),
                     json.dumps({"ticker": q["ticker"], "accession_no": accessions[i],
                                 "note": "answer sentence copied verbatim from the filing"})))
        cur.execute("delete from rag.gold_spans where question_id = %s", (q["id"],))
        for s, e in gold:
            cur.execute("insert into rag.gold_spans (question_id, canonical_document_id, start_char, end_char, quote) "
                        "values (%s, %s, %s, %s, %s)", (q["id"], docs[i][0], s, e, docs[i][1].text[s:e]))


def _measure(cur, run_id, chunker, strategy, params, docs, questions, embedder, tokenizer, q_vecs, q_terms) -> dict:
    name = chunker.version.name
    t0 = time.perf_counter()
    chunk_doc, chunk_span, chunk_tokens, texts = [], [], [], []
    containment, mid_sentence = [], []
    for i, (_doc_id, doc) in enumerate(docs):
        layout = chunker.layout(doc, tokenizer)
        chunk_doc += [i] * len(layout)
        chunk_span += layout.spans()
        chunk_tokens += list(layout.token_counts)
        texts += [doc.text[s:e] for s, e in layout.spans()]
        gold_here = [g for _q, gi, gold in questions if gi == i for g in gold]
        if gold_here:
            containment.append(span_containment(SpanIndex(layout), gold_here))
        lm = layout_metrics(doc, layout).summary()
        mid_sentence.append((lm["boundaries"]["mid_sentence_rate"], lm["boundaries"]["cuts"]))
    chunk_seconds = time.perf_counter() - t0
    chunk_doc, chunk_span, chunk_tokens = np.array(chunk_doc), np.array(chunk_span), np.array(chunk_tokens)
    print(f"{name}: {len(texts):,} chunks, {int(chunk_tokens.sum()):,} tokens; embedding", flush=True)

    t0 = time.perf_counter()
    vecs = embedder.embed(texts)
    embed_seconds = time.perf_counter() - t0
    bm25 = BM25([terms(t) for t in texts])

    outcomes = {"hybrid": [], "vector": [], "keyword": []}
    per_question, latency = {}, []
    for qi, (q, gi, gold) in enumerate(questions):
        t = time.perf_counter()
        sims = vecs @ q_vecs[qi]
        top = np.argpartition(-sims, min(CANDIDATES, len(sims) - 1))[:CANDIDATES]
        vector = [int(i) for i in top[np.lexsort((top, -sims[top]))]]
        kw = bm25.scores(q_terms[qi])
        keyword = sorted(kw, key=lambda i: (-kw[i], i))[:CANDIDATES]
        hybrid = fuse(vector, keyword)
        latency.append((time.perf_counter() - t) * 1000)
        for mode, ranked in (("hybrid", hybrid), ("vector", vector), ("keyword", keyword)):
            outcomes[mode].append(judge(ranked, chunk_doc, chunk_span, chunk_tokens, gi, gold))
        per_question[q["id"]] = outcomes["hybrid"][-1].rank

    hybrid = summarise(outcomes["hybrid"])
    total = sum(c.n for c in containment) or 1
    contained = sum(c.contained for c in containment) / total
    cuts = sum(n for _, n in mid_sentence) or 1
    mid = sum(r * n for r, n in mid_sentence) / cuts
    extra = {
        "questions": len(questions), "filings": len(docs),
        "recall_at_1": hybrid["recall_at_1"], "recall_at_10": hybrid["recall_at_10"], "doc_at_5": hybrid["doc_at_5"],
        **{k: v for k, v in hybrid.items() if k.startswith("recall_at_budget")},
        "vector_recall_at_5": summarise(outcomes["vector"])["recall_at_5"],
        "keyword_recall_at_5": summarise(outcomes["keyword"])["recall_at_5"],
        "vector_mrr": summarise(outcomes["vector"])["mrr"],
        "keyword_mrr": summarise(outcomes["keyword"])["mrr"],
        "mid_sentence_cut_rate": mid,
        "mean_chunk_tokens": float(chunk_tokens.mean()),
        "chunk_seconds": round(chunk_seconds, 1), "embed_seconds": round(embed_seconds, 1),
        "per_question_rank": per_question,
    }
    point = (EXPERIMENT, run_id, chunker.version.id, json.dumps({"strategy": strategy, **params}))
    cur.execute("insert into rag.sweep_points (experiment_id, run_id, chunker_version_id, params, stage, recall_at_5, "
                "mrr, answer_span_containment, full_evidence_rate, chunks, tokens_embedded, index_bytes, "
                "context_tokens_mean, retrieval_p95_ms, extra) values (%s,%s,%s,%s,'screening',%s,%s,%s,%s,%s,%s,%s,"
                "%s,%s,%s)",
                (*point, hybrid["recall_at_5"], hybrid["mrr"], contained, hybrid["full_evidence_rate"], len(texts),
                 int(chunk_tokens.sum()), len(texts) * 384 * 2, hybrid["context_tokens_mean"],
                 float(np.percentile(latency, 95)), json.dumps(extra)))
    cur.execute("insert into rag.sweep_points (experiment_id, run_id, chunker_version_id, params, stage, "
                "answer_span_containment, chunks, tokens_embedded, extra) values (%s,%s,%s,%s,'intrinsic',%s,%s,%s,%s)",
                (*point, contained, len(texts), int(chunk_tokens.sum()),
                 json.dumps({"mid_sentence_cut_rate": mid, "mean_chunk_tokens": float(chunk_tokens.mean())})))
    print(f"{name}: recall@5={hybrid['recall_at_5']:.2f} mrr={hybrid['mrr']:.2f} contained={contained:.2f} "
          f"context={hybrid['context_tokens_mean']:.0f} embed={embed_seconds:.0f}s", flush=True)
    return {**hybrid, "answer_span_containment": contained, "chunks": len(texts),
            "tokens_embedded": int(chunk_tokens.sum()), "vector_recall_at_5": extra["vector_recall_at_5"],
            "keyword_recall_at_5": extra["keyword_recall_at_5"], "mid_sentence_cut_rate": mid,
            "strategy": strategy, "size": next(iter(params.values()))}


if __name__ == "__main__":
    main()
