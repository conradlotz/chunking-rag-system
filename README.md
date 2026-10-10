# Chunking Lab

An experimental platform for measuring how **document structure, chunking
strategy, hybrid retrieval and dynamic context construction** affect RAG
retrieval quality, run over **1,000+ SEC 10-K filings**.

- Source filings stay at the SEC. The platform owns a canonical, hierarchical
  representation of each filing with stable character offsets.
- Six chunking strategy families, swept over 42 parameter configurations inside the embedder's native window (size,
  overlap, boundary rule, semantic breakpoint, atomic unit size), are stored as span
  layouts over that representation, so every configuration exists for every filing
  without copying text.
- Three separate benchmarks: **chunking** (the chunks themselves), **retrieval**
  (what reaches the model's context at a fixed token budget) and **answers**
  (correctness, grounding, abstention).
- Tuning, not a winner: parameter curves and quality-versus-cost Pareto frontiers show
  how recall, answer-span containment, answer accuracy, context tokens, index size and
  latency trade off as each parameter moves.
- Primary hypothesis: retrieving small structure-aligned units and expanding them
  through the document tree at query time beats any static chunking layout at
  equal token budget.
- A UI that shows the engineering: corpus size, chunk and token counts, chunk
  boundaries, retrieval traces, source passages and benchmark results.

> Status: v2 schema applied and smoke-tested on hosted Supabase; Vercel production configuration repaired and deployed. Local SEC ingest has reached 100 FY2024–FY2025 filings, with telemetry recorded. Owner login/allow-list setup and the full embedding benchmark remain pending. See [execution status](docs/EXECUTION_STATUS.md).

## Documents

| Document | Contents |
|----------|----------|
| [docs/PLAN.md](docs/PLAN.md) | Goal, scope, milestones, decisions, risks |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Canonical representation, layouts, retrieval and context construction, storage, UI, ADRs |
| [docs/TEST_STRATEGY.md](docs/TEST_STRATEGY.md) | Software tests, corpus checks, the three benchmarks, hypotheses, system checks, statistics, CI gates |

## Stack

Python (pipeline, benchmarks) · Next.js on Vercel · Supabase Postgres +
pgvector · `gte-small` embeddings (Supabase built-in) · Claude (answers, judging)

Data: [SEC EDGAR](https://www.sec.gov/edgar). Filings are referenced by
accession number and linked to their originals on sec.gov.
