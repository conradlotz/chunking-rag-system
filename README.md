# Chunking Lab

A research assistant over a library of real published research reports, built
to measure how **chunking strategy** affects whether the right passages come
back, and whether the answers built on them are accurate and verifiable.

- Five chunking strategies (fixed, fixed with overlap, sentence, section-aware, semantic)
- Keyword, vector and hybrid retrieval in Postgres (pgvector + full-text, rank fusion)
- Answers from Claude with citations, checked by deterministic validators before display
- An evaluation harness with a golden question set, retrieval and answer metrics,
  baselines and confidence intervals

> Status: design and database schema complete; implementation in progress.

## Documents

| Document | Contents |
|----------|----------|
| [docs/PLAN.md](docs/PLAN.md) | Goal, use case, features, milestones, decisions |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System design, diagrams, data model, answer validation, ADRs |
| [docs/TEST_STRATEGY.md](docs/TEST_STRATEGY.md) | Software tests, golden dataset, evaluation metrics, judge calibration, statistics, CI gates |

## Stack

Python (pipeline, evaluation) · Next.js on Vercel (app) · Supabase Postgres +
pgvector (storage, search) · Claude (answers, judging) · Voyage AI (embeddings)
