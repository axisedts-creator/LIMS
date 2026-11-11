#!/usr/bin/env bash
# C14 T02 harness (clone of tests/db/c5-t03/run.sh): throwaway container of the PINNED image -> bootstrap roles/database -> migrations (as lims_migrator, SP-2 three-step window)
# -> seeds -> smartreport DDL -> vitest for the smartreport repository tests with LIMS_TEST_DATABASE_URL (role lims_api, RLS on) and LIMS_TEST_ADMIN_DATABASE_URL
# (superuser, RLS bypassed: proves the repositories' EXPLICIT tenant filter). Run from the repo root:  bash tests/db/c14-t02/run.sh
# The smartreport DDL is applied from db/migrations/*smartreport* when C0 has delivered it; until then it is extracted verbatim from spec/chunks/C14-smart-report/05-SCHEMA.md §9 (read-only).
# LIMS_PG_IMAGE overrides the pinned image for a local smoke run only. Needs docker, node, pnpm (dependencies installed). Exit code = vitest's.
set -euo pipefail
IMAGE="${LIMS_PG_IMAGE:-supabase/postgres:17.6.1.136}"
export MSYS_NO_PATHCONV=1
HOSTPWD="$(pwd -W 2>/dev/null || pwd)"
NAME="lims_c14t02_$$"
DB="postgres"
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

PW() { head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 20; }
SUPER_PW="$(PW)"; MIG_PW="$(PW)"; API_PW="$(PW)"; WORKER_PW="$(PW)"; MON_PW="$(PW)"; REPL_PW="$(PW)"; SHIP_PW="$(PW)"

docker run -d --name "$NAME" -p 127.0.0.1::5432 -e POSTGRES_PASSWORD="$SUPER_PW" -v "$HOSTPWD":/repo:ro -w /repo "$IMAGE" >/dev/null
for _ in $(seq 1 60); do docker exec "$NAME" pg_isready -U supabase_admin -h localhost >/dev/null 2>&1 && break; sleep 2; done
docker exec "$NAME" pg_isready -U supabase_admin -h localhost >/dev/null

SU()  { docker exec -e PGPASSWORD="$SUPER_PW" "$NAME" psql -X -q -h localhost -U supabase_admin -d "$DB" -v ON_ERROR_STOP=1 "$@"; }
MIG() { docker exec -e PGPASSWORD="$MIG_PW"   "$NAME" psql -X -q -h localhost -U lims_migrator   -d "$DB" -v ON_ERROR_STOP=1 "$@"; }
MIGI() { docker exec -i -e PGPASSWORD="$MIG_PW" "$NAME" psql -X -q -h localhost -U lims_migrator -d "$DB" -v ON_ERROR_STOP=1 "$@"; }

SU -c "CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions"
SU -v lims_migrator_pw="$MIG_PW" -v lims_api_pw="$API_PW" -v lims_worker_pw="$WORKER_PW" -v lims_monitor_pw="$MON_PW" \
   -v lims_replicator_pw="$REPL_PW" -v lims_audit_ship_pw="$SHIP_PW" -v dbname="$DB" -f db/bootstrap/00_roles.sql
SU -v dbname="$DB" -f db/bootstrap/01_database.sql
STEP_C="20261105001200"
for f in $(ls db/migrations/*.sql | sort); do
  [[ "$(basename "$f")" < "$STEP_C" ]] && MIG --single-transaction -f "/repo/$f"
done
HOSTPORT="$(docker port "$NAME" 5432/tcp | head -n1 | sed 's/.*://')"
if ! PGOPTIONS='-c role=lims_queue' PGPASSWORD="$MIG_PW" npx --no-install graphile-worker --schema-only -c "postgres://lims_migrator@127.0.0.1:$HOSTPORT/$DB"; then
  SU -c "REVOKE CREATE ON SCHEMA app FROM lims_queue; REVOKE CREATE ON DATABASE $DB FROM lims_queue"
  echo "graphile-worker --schema-only failed (SP-2 step b); CREATE revoked"; exit 1
fi
for f in $(ls db/migrations/*.sql | sort); do
  [[ ! "$(basename "$f")" < "$STEP_C" ]] && MIG --single-transaction -f "/repo/$f"
done

# smartreport tables: C0's migration when it exists, else the spec's DDL block (05-SCHEMA §9) verbatim.
if ls db/migrations/*smartreport__create_tables*.sql >/dev/null 2>&1 || ls db/migrations/*__smartreport_*.sql >/dev/null 2>&1; then
  echo "smartreport DDL: delivered by db/migrations (C0)"
elif docker exec "$NAME" psql -X -q -t -A -h localhost -U supabase_admin -d "$DB" -c "SELECT to_regclass('smartreport.summaries')" | grep -q summaries; then
  echo "smartreport DDL: already present"
else
  echo "smartreport DDL: extracted from spec 05-SCHEMA §9"
  { echo "SET LOCAL ROLE lims_owner;"   # every C0 migration switches to the schema owner role first
    awk '/^## 9\. DDL/{s=1;next} s&&/^```sql/{b=1;next} b&&/^```/{exit} b{print}' spec/chunks/C14-smart-report/05-SCHEMA.md; } | MIGI --single-transaction -f -
fi

for f in $(ls db/seeds/*.sql 2>/dev/null | sort); do MIG --single-transaction -f "/repo/$f"; done

export LIMS_TEST_DATABASE_URL="postgres://lims_api:$API_PW@127.0.0.1:$HOSTPORT/$DB"
export LIMS_TEST_ADMIN_DATABASE_URL="postgres://supabase_admin:$SUPER_PW@127.0.0.1:$HOSTPORT/$DB"
export LIMS_C14T02_REQUIRE_DB=1     # the tests FAIL (not skip) when the database is missing
[ "${1:-}" = "smoke" ] && LIMS_C14T02_CMD="bash tests/db/c14-t02/smoke-fixtures.sh"   # `run.sh smoke`: only apply fixtures.sql and count rows
if [ -n "${LIMS_C14T02_CMD:-}" ]; then   # debug hook: run another command against the migrated DB
  SUPER_PW="$SUPER_PW" NAME="$NAME" DB="$DB" bash -c "$LIMS_C14T02_CMD"
else
  pnpm --dir services/api exec vitest run src/modules/smartreport/repository/__tests__
fi
