#!/usr/bin/env bash
# Runs the SQL smoke tests in a fresh scratch database on a local Postgres + pgvector, then drops it.
#   supabase/tests/run_local.sh [host] [port] [user]
# Never touches existing databases. Needs the pgvector extension installed on the server.
set -euo pipefail
HOST="${1:-127.0.0.1}"; PORT="${2:-54329}"; USER_="${3:-postgres}"
DB="chunking_smoke_$$"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PSQL=(psql -h "$HOST" -p "$PORT" -U "$USER_" -v ON_ERROR_STOP=1 -q)
cleanup() { "${PSQL[@]}" -d postgres -c "drop database if exists \"$DB\"" >/dev/null 2>&1 || true; }
trap cleanup EXIT
"${PSQL[@]}" -d postgres -c "create database \"$DB\"" >/dev/null
"${PSQL[@]}" -d "$DB" -c "create schema if not exists extensions; create extension if not exists vector schema extensions" >/dev/null
"${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/tests/local_auth_stub.sql" >/dev/null 2>&1
for f in "$ROOT"/supabase/migrations/*.sql; do
  case "$f" in *_rag_schema.sql) continue;; esac   # superseded v1 schema
  "${PSQL[@]}" -d "$DB" -f "$f" >/dev/null 2>&1 || { echo "migration failed: $f"; "${PSQL[@]}" -d "$DB" -f "$f" 2>&1 | grep -i error | head -3; exit 1; }
done
for t in schema_smoke app_api_smoke; do
  out="$("${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/tests/$t.sql" 2>&1 | grep -E "ERROR|passed" || true)"
  echo "$t: ${out:-no result}"
  echo "$out" | grep -q passed || exit 1
done
