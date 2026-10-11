# Deploying the web app

The app is Next.js (in `apps/web`), the data lives in Supabase, and only one person can sign in. Four things have to
be in place. Authorized CLI or dashboard access can perform deployment and migration setup.
The deployed status and remaining owner-specific steps are recorded in [EXECUTION_STATUS.md](EXECUTION_STATUS.md).

## 1. Vercel project settings

The repository root contains a Python pipeline as well as the app, so Vercel must be told where the app is.
In the Vercel project: **Settings → General**

| Setting | Value |
|---------|-------|
| Root Directory | `apps/web` |
| Framework Preset | Next.js |
| Node.js Version | 22.x |

(Without a Root Directory, Vercel detects the Python pipeline and fails with "No python entrypoint found".)

**Settings → Environment Variables** (Production, Preview, Development). Both values are public by design:

| Name | Value |
|------|-------|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://drwaolxtxmyxwppjxmpi.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | the project's publishable key (`sb_publishable_…`) from Supabase → Project Settings → API Keys |

Do **not** set `LAB_FIXTURE` on Vercel. The app refuses to start in fixture mode there.

## 2. Apply the database migrations

For an initial setup only, run these two files **in order** in Supabase → SQL Editor.
**The first migration is a destructive replacement, not a safe repeatable upgrade.**
Count every existing `rag` table and inspect dependencies before running it; stop if any real data exists.
Apply both files in a single transaction with an empty-table guard so failures roll back together.

1. `supabase/migrations/20261010120000_canonical_hierarchy.sql`
   Creates the `rag` schema. It begins with `drop schema if exists rag cascade`, which removes the earlier, empty
   `rag` tables and dependent objects. Verify cross-schema dependencies before applying it.
2. `supabase/migrations/20261010140000_app_api.sql`
   Creates the allow-list, the context builder and the read-only `public.lab_*` functions.

(`20261010000000_rag_schema.sql` is the superseded first draft; do not run it.)

## 3. Create the single user and allow-list them

This project's Supabase Auth is shared with another app, so being signed in is **not** enough: every data function
checks an allow-list.

1. Supabase → Authentication → Users → **Add user** → enter your email and a strong password (tick "Auto confirm").
2. Run, with your email:

```sql
insert into rag.app_users (user_id, email)
select id, email from auth.users where email = 'YOUR-EMAIL@example.com';
```

Anyone else who signs in sees "This account isn't authorised" and nothing else.

## 4. The query-embedding Edge Function

`supabase/functions/embed-query` is already deployed to the project (it needs the migrations above for its allow-list
check). To redeploy: `supabase functions deploy embed-query` or the dashboard.

## Local development

```bash
supabase/tests/run_local.sh                       # SQL tests in a scratch database (needs local Postgres + pgvector)
cd pipeline && uv run python -m tests.fixtures.load_dev_fixture \
    --dsn postgresql://postgres@127.0.0.1:54329/bench --reset   # development fixture, local databases only
cd apps/web && npm install && npm run test:unit
LAB_FIXTURE=1 LAB_FIXTURE_DATABASE_URL=postgresql://postgres@127.0.0.1:54329/bench npx next dev
npx playwright test                               # browser tests (fixture and signed-out)
```

## Loading real filings (GitHub Actions)

The pipeline needs `sec.gov` and `huggingface.co`, which GitHub runners can reach. In the repository go to
Settings, Secrets and variables, Actions, and add two secrets:

| Secret | Value |
|--------|-------|
| `SEC_USER_AGENT` | Your name and contact email (required by the SEC) |
| `SUPABASE_DB_URL` | Supabase, Project Settings, Database, Connection string, **Session pooler** (runners are IPv4 only) |

Then Actions, "Load real SEC filings", Run workflow. Start with 20 filings. It downloads the `gte-small`
model, loads the filings, chunks them, embeds each chunk and writes one configuration to Supabase; the run
summary shows throughput and counts. Re-running adds more filings and skips ones already loaded.
Fixture data is refused.

## Written answers (Ask)

The Search page can have Claude write a short, cited answer from exactly the passages the search
retrieved. It needs one server-side environment variable in Vercel (Settings, Environment Variables,
Production and Preview), then a redeploy:

| Variable | Value |
|----------|-------|
| `ANTHROPIC_API_KEY` | An Anthropic API key (console.anthropic.com). Server-only; never prefix it with `NEXT_PUBLIC_`. |
| `ANTHROPIC_MODEL` | Optional. Default `claude-opus-5-5` ($4 / $20 per million input / output tokens). `claude-sonnet-5-5` is half that, `claude-haiku-5-5` about a fortieth. |
| `ANSWER_EFFORT` | Optional. Default `low`; `medium` or `high` think longer and cost more. |

Without the key, search still works and the answer panel says written answers are off. Each answer
shows its model, tokens and cost.
