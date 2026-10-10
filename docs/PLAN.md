# Plan

## 1. Goal

An experimental platform for measuring how document structure, chunking
strategy, hybrid retrieval and **dynamic context construction** affect RAG
retrieval quality and answer accuracy, run over at least **1,000 real SEC 10-K
filings**, with a UI that exposes the engineering: corpus scale, chunk and token
counts, chunk boundaries, retrieval traces, source passages and benchmark results.

Primary research question:

> At an equal token budget, does retrieving small structure-aligned units and
> expanding them through the document tree at query time deliver more of the
> needed evidence than any static chunking layout?

## 2. Scope

| In scope | Out of scope (for now) |
|----------|------------------------|
| 10-K filings, S&P 500, FY2024–FY2025 (≥ 1,000 filings) | 10-Q, 8-K, other forms (the pipeline supports adding them) |
| Items 1, 1A, 7, 7A | Financial statements and exhibits (figures come from XBRL) |
| Six chunking strategy families swept over 42 parameter configurations inside gte-small's native window (sizes 128 / 256 / 384 / 480) (size, overlap, boundary, semantic breakpoint, atomic size); query-time sweeps of mode, `k`, budget and expansion | Fine-tuned embedding models |
| Chunking, retrieval and answer benchmarks | Re-hosting SEC source documents |
| Live serving on Vercel + Supabase free plan | Multi-tenant uploads |

## 3. Deliverables

| # | Deliverable |
|---|-------------|
| D1 | Live web app: Corpus, Explorer, Retrieval Lab, Benchmarks, Ask, Method |
| D2 | Public repo: pipeline, SQL, app, tests, CI |
| D3 | Benchmark results committed and shown in the app; one-page `docs/RESULTS.md` |
| D4 | 3–5 minute walkthrough video |

## 4. Milestones

| # | Milestone | Exit criterion | Status |
|---|-----------|----------------|--------|
| M0 | Design | PLAN, ARCHITECTURE, TEST_STRATEGY reviewed | Done |
| M1 | Schema v2 | Canonical hierarchical schema applied and smoke-tested, no data left behind | Migration written; awaiting approval to apply |
| M2 | SEC connector + canonicaliser | 100 filings canonicalised; determinism and segmentation audits pass; measured storage per filing | |
| M3 | Configurations + chunking benchmark | All 42 primary index-time configurations laid out over the first 100 filings; invariant tests green; first intrinsic benchmark including answer-span containment | |
| M4 | Scale to ≥ 1,000 | Full corpus ingested; failures explained; storage confirmed against the plan | |
| M5 | Embeddings + indexes | Benchmark DB fully embedded; hosted serving index; embedding parity passes | |
| M6 | Questions | Gold 50 reviewed; silver ≥ 300 generated and audited | |
| M7 | Search + context construction | `search_chunks`, `build_context` with tests; serving parity and ANN recall measured | |
| M8 | Tuning sweeps + retrieval benchmark | Intrinsic sweep on all filings; screening of shortlisted configurations; full-corpus runs on the Pareto set; parameter curves and frontiers; production configuration chosen on dev; one test run; H1 decided | |
| M9 | Answer path + answer benchmark | Validators with mutation tests; judge calibrated; baselines | |
| M10 | UI | Mock-up approved, then Corpus → Explorer → Retrieval Lab → Benchmarks → Ask | |
| M11 | Publish | RESULTS.md, README, video | |

Benchmarks (M3, M8, M9) are not blocked by the UI (M10); the UI reads whatever
results exist.

## 5. Decisions

| Decision | Choice | Status |
|----------|--------|--------|
| Corpus | SEC EDGAR 10-K, S&P 500, FY2024–25, ≥ 1,000 filings; sources stay at SEC | Decided |
| Representation | Canonical document tree with frozen character offsets | Decided |
| Strategies | Six families (`fixed`, `recursive`, `sentence`, `structural`, `semantic`, `hierarchical`); each parameter combination is a separately versioned configuration stored as a span layout | Decided |
| Tuning | Index-time parameters swept in stages (intrinsic, screening, full); query-time parameters swept freely; results as parameter curves and Pareto frontiers, not a single winner | Decided |
| Hosted Supabase | Holds the winning production configuration only; the benchmark is never sized to the free plan | Decided |
| Chunk sizes | Primary sweep stays inside gte-small's native window (128 / 256 / 384 / 480; 480 stands in for "512"); chunks above it and multi-window aggregation are a separate secondary experiment | Decided |
| Raw SEC cache | Disposable local cache under git-ignored `data/raw/` for parser development; fingerprinted; never committed or deployed; ingestion can use cache or SEC | Decided |
| Cost accounting | Bandwidth, local embedding compute, storage and paid generation are tracked and shown separately, never summed | Decided |
| Embeddings | `gte-small` (Supabase built-in), 384-d, `halfvec`; same model offline | Decided |
| Answer model / judge | `claude-opus-5-5` | Decided |
| Hosting | Vercel + existing Supabase project (free plan), isolated `rag` schema | Decided |
| Benchmarks | Separate benchmark Postgres with the same migrations; exact search | Decided |
| Primary hypothesis | Dynamic context construction (TEST_STRATEGY H1) | Decided |
| Hosted capacity | Re-measure after 100 filings; overflow → second free project or Pro, never a smaller corpus | Decided |
| Showcase features beyond the core pages | Claim Checker, Stat Finder (XBRL-backed) | Open, after M10 |

## 6. Risks

| Risk | Mitigation |
|------|------------|
| 10-K HTML is inconsistent; item segmentation fails on some filings | Parser validation gates, audit sample, failures logged and counted, never silently dropped |
| Hosted storage tighter than estimated | Measure at 100 filings; capacity plan in ARCHITECTURE section 10 |
| Embedding the sweep grid (about 2.0B tokens for 42 configurations) is slow on CPU | Stage the grid; measure throughput on the first filings before scheduling anything; GPU batch run; cache by text hash |
| Model memorised public filings | Closed-book baseline; faithfulness and citation metrics |
| Gold set too small for fine-grained claims | Silver XBRL set for numeric lookups; primary hypothesis tested only where the gold set has power |
| Labels unintentionally favour a layout | Minimal sentence-level spans, analyst wording, strategy-blind labelling |
| Shared Supabase project | Separate schema, no Data API exposure, no changes to other app's tables |
