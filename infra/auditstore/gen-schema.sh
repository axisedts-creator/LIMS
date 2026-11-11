#!/usr/bin/env bash
# infra/auditstore/gen-schema.sh (02-TRD s10.3, 05-SCHEMA s3.1/s3.5, 08 A29.2). Audit-store subscriber DDL from the
# primary's catalog. Connections are libpq conninfo strings WITHOUT passwords (PGPASSFILE / ~/.pgpass / service file).
#
#   gen-schema.sh SOURCE_CONNINFO
#       Prints the subscriber DDL of the three published tables from a freshly migrated staging DB
#       (pg_dump --schema-only), stripped of FKs, CHECK constraints, RLS, policies, triggers, owners and grants
#       (PK, NOT NULL, defaults and indexes kept). Used to refresh schema.sql; the generated output wins (05-SCHEMA s3.1).
#
#   gen-schema.sh --apply SOURCE_CONNINFO STORE_CONNINFO
#       deploy.yml, BEFORE app migrations: compares information_schema.columns of source and store with drift.py
#       (the same logic as CI job auditstore-drift) and applies only what drift.py --apply-sql prints - ADD COLUMN
#       (never NOT NULL) and DROP NOT NULL - in one transaction as auditstore_owner (STORE_CONNINFO = instance
#       superuser, break-glass per 05-SCHEMA s3.2), logged in auditstore_meta.schema_sync_log (release = $LIMS_RELEASE).
#       Exit 0 = store matches the source afterwards; 1 = drift drift.py may not fix (type change, extra column,
#       source NOT NULL the store lacks) - fix by hand, nothing was applied; 2 = invalid input.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
drift="$here/drift.py"
tables=(audit.audit_log audit.access_log billing.activity_log)
cols_q="SELECT coalesce(json_agg(c), '[]'::json) FROM (
  SELECT table_schema, table_name, column_name, data_type, udt_name, is_nullable
    FROM information_schema.columns
   WHERE (table_schema, table_name) IN (('audit','audit_log'), ('audit','access_log'), ('billing','activity_log'))) c"

usage() { echo "usage: $0 SOURCE_CONNINFO | --apply SOURCE_CONNINFO STORE_CONNINFO" >&2; exit 2; }

generate() {
  local args=()
  for t in "${tables[@]}"; do args+=("--table=$t"); done
  pg_dump --schema-only --no-owner --no-privileges --no-comments --no-security-labels --no-publications \
    --no-subscriptions --no-tablespaces -d "$1" "${args[@]}" |
  awk '
    # one statement at a time (pg_dump ends each with ";" at end of line); comment and blank lines dropped
    /^--/ || /^[[:space:]]*$/ { next }
    { buf = buf $0 "\n" }
    /;[[:space:]]*$/ { emit(buf); buf = "" }
    function emit(s,   n, lines, i, out, keep, k) {
      if (s ~ /^(SET |SELECT pg_catalog\.)/) return
      if (s !~ /^CREATE TABLE/) {
        if (s ~ /FOREIGN KEY|ROW LEVEL SECURITY|CREATE POLICY|CREATE TRIGGER|CHECK \(/) return
        printf "%s\n", s; return
      }
      n = split(s, lines, "\n"); k = 0
      for (i = 1; i <= n; i++) if (lines[i] !~ /^[[:space:]]+CONSTRAINT [^ ]+ CHECK /) keep[++k] = lines[i]
      out = ""
      for (i = 1; i <= k; i++) {
        if (keep[i] ~ /^\);/ && out ~ /,\n$/) sub(/,\n$/, "\n", out)
        out = out keep[i] (i < k ? "\n" : "")
      }
      printf "%s\n", out
    }'
}

columns() { psql -X -w -q -At -v ON_ERROR_STOP=1 -d "$1" -c "$cols_q"; }

apply() {
  local src=$1 store=$2 tmp rc
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  columns "$src" >"$tmp/src.json"
  columns "$store" >"$tmp/sub.json"
  rc=0
  python3 -I "$drift" "$tmp/src.json" "$tmp/sub.json" --apply-sql >"$tmp/fix.sql" || rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "gen-schema: drift.py exit $rc; nothing applied" >&2
    exit "$rc"
  fi
  if [ -s "$tmp/fix.sql" ]; then
    {
      echo "SET ROLE auditstore_owner;"
      cat "$tmp/fix.sql"
      echo "RESET ROLE;"
      echo "INSERT INTO auditstore_meta.schema_sync_log (release, ddl_sha256, statements)"
      echo "  VALUES (:'release', sha256(convert_to(:'stmts', 'UTF8')), :'stmts');"
    } | psql -X -w -q -v ON_ERROR_STOP=1 -1 -d "$store" -v release="${LIMS_RELEASE:-unknown}" -v stmts="$(cat "$tmp/fix.sql")" -f -
  fi
  columns "$store" >"$tmp/sub.json"
  python3 -I "$drift" "$tmp/src.json" "$tmp/sub.json"
}

case "${1:-}" in
  --apply) [ $# -eq 3 ] || usage; apply "$2" "$3" ;;
  ""|-*) usage ;;
  *) [ $# -eq 1 ] || usage; generate "$1" ;;
esac
