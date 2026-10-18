#!/usr/bin/env bash
# Spins up a throwaway Postgres, applies the migrations and runs the SQL tests.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
pgbin="$(ls -d /usr/lib/postgresql/*/bin | sort -V | tail -1)"
tmp="$(mktemp -d)"
trap '"$pgbin/pg_ctl" -D "$tmp/data" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$tmp"' EXIT
"$pgbin/initdb" -D "$tmp/data" -U postgres >/dev/null
"$pgbin/pg_ctl" -D "$tmp/data" -o "-k $tmp -p 54329 -c listen_addresses=''" -l "$tmp/log" start >/dev/null
psql() { command psql -h "$tmp" -p 54329 -U postgres -d postgres -v ON_ERROR_STOP=1 -q "$@"; }
psql -f "$here/stub_supabase.sql"
for f in "$here"/../migrations/*.sql; do psql -f "$f"; done
psql -f "$here/credits_test.sql"
