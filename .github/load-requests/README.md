Pushing a change to a `*.json` file in this folder on `main` starts the "Load real SEC filings" workflow
with those parameters (see `.github/workflows/load-data.yml`):

- `limit`: filings to embed in this run
- `max_new`: most new filings to fetch from the SEC (0 = embed only what is already loaded)
- `strategy`, `size`: chunking configuration
- `make_production`: make it the live search configuration
