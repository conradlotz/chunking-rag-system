# Plan

## 1. Goal

Build a working, publicly hosted research assistant over a **real library of
published research reports**, and use it to answer one question with evidence:

> Which chunking strategy returns the right passages most often, and does that
> translate into more accurate, verifiable answers?

The system is judged on retrieval quality and validated answers, not on
chunking speed.

## 2. Use case

An analyst at a research firm has years of published reports. They need to:

- find the passage that answers a question, with the exact source;
- check a statement in a draft against what the research actually says;
- pull every relevant figure on a topic across reports;
- trust that the numbers shown are really in the sources.

The corpus is real published research pulled from online repositories (see
ARCHITECTURE.md section 3.0). There is no demo or synthetic content in the
product; test fixtures exist only inside automated tests.

## 3. Deliverables

| # | Deliverable |
|---|-------------|
| D1 | Live web app on Vercel (Supabase backend) |
| D2 | Public GitHub repo with README, architecture and test strategy |
| D3 | Evaluation results: dashboard page and a one-page `docs/RESULTS.md` |
| D4 | 3-minute walkthrough video |

## 4. Features

### Core (committed)

| Feature | What it does |
|---------|--------------|
| **Ask** | Question in, validated answer out, with citation chips that open the source passage highlighted in its document |
| **Compare** | The same question through two chunking strategies side by side, with ranks and shared passages |
| **Chunk X-ray** | One document, each strategy's chunk boundaries drawn as coloured bands, answer passages overlaid |
| **Results** | Evaluation dashboard: metrics by strategy and question type, confidence intervals, per-question drill-down |

### Proposed additions (to choose from)

| Feature | What it does | Why it impresses | Effort |
|---------|--------------|------------------|--------|
| **Claim Checker** | Paste a sentence from a draft deck or report. Verdict: supported / contradicted / not in the corpus, with the evidence quoted | The "validate output" idea as a product feature; a real QA task for researchers | M |
| **Stat Finder** | Ask for figures on a topic; get a table of every number found across reports (value, population, year, source), charted over time; every number passes the numeric grounding check | Very visual; turns documents into data; shows the validators earning their keep | M |
| **Retrieval trace** | A "glass box" panel on every answer: vector rank, keyword rank, fusion score, gate decision, each validator's verdict, tokens, latency, cost | Shows engineering depth in one glance; cheap because the data already exists | S |
| **Theme Map** | All passages clustered into themes on an interactive 2-D map, themes labelled by Claude; click a theme to read its passages | Thematic analysis is core qualitative research work | M–L |
| **Research Brief** | Enter a topic; get a structured, cited brief (key findings, figures, caveats, gaps) exportable to PDF | Closest to a decision-support product | M |
| **Live ingestion** | Add a URL or upload a PDF; watch it parsed, chunked five ways, embedded and searchable within a minute | Proves it's a real system rather than a fixed dataset | M–L |

Recommendation: **Retrieval trace + Claim Checker + Stat Finder** on top of the
core, with Theme Map as the stretch goal. All three reuse the same search and
validators, so they add surface without adding risk to the evaluation.

### Design direction

Editorial "research desk" look: serif display type with a clean sans for UI,
warm paper-white light theme and ink dark theme, generous whitespace, citation
chips, smooth passage-highlight transitions, a ⌘K command palette, and
charts that follow one consistent palette. Before building the UI, a clickable
design mock-up is reviewed and approved.

## 5. Milestones

| # | Milestone | Output | Status |
|---|-----------|--------|--------|
| M0 | Design docs | PLAN, ARCHITECTURE, TEST_STRATEGY | Done |
| M0.5 | Database schema | `rag` schema applied to Supabase, smoke-tested, test rows removed | Done |
| M1 | Corpus | Connectors, snapshots in Storage, manifest, canonical text | |
| M2 | Golden set | 40 questions with gold spans, reviewed, dataset checks green | |
| M3 | Chunkers + loader | 5 strategies, invariant and property tests, loaded and verified | |
| M4 | Retrieval eval | Dev-set results, CI regression gate, τ tuned | |
| M5 | Answer path | `/api/answer`, validators, mutation tests, rate limits | |
| M6 | Generation eval | Test-set run, judge calibration, baselines, statistics | |
| M7 | UI | Core pages, then chosen additions, Playwright suite | |
| M8 | Publish | RESULTS.md, README, video | |

## 6. Decisions

| Decision | Choice | Status |
|----------|--------|--------|
| Answer model | Claude (`claude-opus-5-5`) | Decided |
| Hosting | Vercel (web) + Supabase (database, storage) | Decided |
| Database | Existing Supabase project, isolated `rag` schema | Decided, applied |
| Vector search | pgvector, exact search; hybrid with Postgres full-text + RRF | Decided |
| Corpus | Real published research from online repositories | Decided |
| Embeddings | Voyage AI (`voyage-3.5`, 1024-d) recommended | **Open** |
| Corpus sources and topic | Which repositories and which subject area | **Open** |
| Additional features | Which of the proposed additions | **Open** |

## 7. Risks

| Risk | Mitigation |
|------|------------|
| Public research may already be known to the model, inflating accuracy | Closed-book baseline; emphasise faithfulness and citation accuracy |
| Small question set gives noisy comparisons | Paired design, bootstrap intervals, no winner claimed on overlapping intervals |
| Labels unintentionally favour one strategy | Minimal sentence-level spans; questions in the researcher's own words |
| Public URL runs up API costs | Per-IP and global rate limits, cached sample answers, spend cap |
| Feature creep delays the evaluation | Evaluation milestones (M2–M6) come before additional features |
| Shared Supabase project | Separate schema, no changes to existing tables, no Data API exposure |
