# Execution status

## Hosted app and database

- Vercel project `web` has `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` in Production and Preview. Production was redeployed at <https://web-ashen-three-fts4191pu8.vercel.app/>; the former missing-configuration error is gone.
- Before migration, the hosted `rag` v1 schema had no real filings or benchmark data: eleven of twelve tables were empty and `strategies` held five seed rows. The v2 canonical hierarchy and app API migrations were applied atomically after a table-count guard. Hosted schema and API smoke tests passed and their test data was rolled back.
- The hosted schema has 28 `rag` tables and 15 public `lab_*` functions. Anonymous overview access was rejected with HTTP 401. A login must exist in Supabase Auth and be listed in `rag.app_users` before the owner can use the app. No test login was created during this run.

## First local SEC ingest

The disposable `data/raw/` cache is git-ignored. Raw SEC documents remain outside Postgres; Postgres holds source URLs, fingerprints, canonical text, structure, offsets, and telemetry. The local benchmark database is separate from the hosted app database. The corpus target remains at least 1,000 real S&P 500 FY2024–FY2025 10-K filings.

| Measure | Observed |
| --- | ---: |
| Successfully canonicalised filings | 103 |
| FY2024–FY2025 filings | 99 |
| FY2026 filings found in initial ingest | 4 |
| Companies represented | 53 |
| Canonical tokens | 4,857,270 |
| Source bytes represented | 485,092,449 |
| Canonical text bytes | 24,971,735 |
| Hierarchy nodes | 65,091 |
| Local database size | 51 MB |
| Corpus integrity errors | 0 |

The first 100 filings loaded in two completed runs. The second run reported 13 parser failures (`no in-scope items found`), so failures need review before scaling. A later run added three FY2024–FY2025 filings but was interrupted; it is marked `aborted` in telemetry. The ingest now filters to fiscal years 2024 and 2025 by default. One more qualifying filing is required to reach the 100-filing in-scope milestone. These figures are local observations, not hosted Supabase storage projections.

A sample-only local `gte-small` quantized ONNX run processed 128 windows / 32,768 tokens in 7.691 seconds wall time (about 4,260 tokens per second) and produced 384-dimensional vectors. This is a throughput probe, not the 42-configuration embedding sweep or retrieval benchmark.

## Verification and remaining work

Hosted schema and app API smoke tests, 51 Python tests, 10 web unit tests, 5 live deployment auth-flow tests, web typecheck, production build, and Ruff on the new ingest and embedding modules passed. Full-repository Ruff still reports 76 pre-existing fixture issues. Local fixture browser tests did not complete because the local Next.js dev server exited under memory pressure; the live deployment auth-flow tests passed.

Next: create and allow-list the single owner test account; confirm live sign-in. Review the 13 parser failures, finish the first 100 in-scope filings and segmentation audit, measure storage per filing and full-corpus capacity, then lay out and evaluate the 42 chunker configurations. The 1,000-filing target must not be reduced based on the first ingest.
