#!/usr/bin/env bash
# T0B-VERLEVEL-1 (LD-316): runs the verification level tests (and the whole lab __tests__ tree: probes, boot, contract) against a throwaway PG17 booted like tests/frontdesk/FD-T03.pg.sh
# (roles -> migrations incl. 20261117150000 -> graphile-worker -> seeds). Same pattern as tests/frontdesk/T0B-REGAPI-1.pg.sh; exports BOTH url pairs the lab tests read:
#   LIMS_TEST_DATABASE_URL / LIMS_TEST_ADMIN_DATABASE_URL (lab probe kit) and LIMS_TEST_APP_URL / LIMS_TEST_SUPER_URL; LIMS_T03_REQUIRE_DB=1 makes a missing database a FAILURE, never a skip.
# Run from the repo root. Exit code = vitest's. If the URLs are already exported no container is started. LAB_SUITE overrides the vitest path (default src/modules/lab/__tests__).
# Synthetic data only; random throwaway passwords.
set -euo pipefail
SUITE="${LAB_SUITE:-src/modules/lab/__tests__}"
# one file at a time: the probe files compare whole-tenant snapshots (crossTenant / crossCentre), so no other file may write tenant A or B meanwhile (the verlevel tests write both)
run_vitest() { export LIMS_T03_REQUIRE_DB=1; pnpm --dir services/api exec vitest run --no-file-parallelism $SUITE; }
if [ -n "${LIMS_TEST_DATABASE_URL:-}" ] && [ -n "${LIMS_TEST_ADMIN_DATABASE_URL:-}" ]; then
  export LIMS_TEST_APP_URL="$LIMS_TEST_DATABASE_URL" LIMS_TEST_SUPER_URL="$LIMS_TEST_ADMIN_DATABASE_URL"; run_vitest; exit $?
fi

IMAGE="${LIMS_PG_IMAGE:-supabase/postgres:17.6.1.136}"
export MSYS_NO_PATHCONV=1
HOSTPWD="$(pwd -W 2>/dev/null || pwd)"
NAME="lims_verlevel1_$$"; DB="postgres"
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT
PW() { head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 20; }
SUPER_PW="$(PW)"; MIG_PW="$(PW)"; API_PW="$(PW)"; WORKER_PW="$(PW)"; MON_PW="$(PW)"; REPL_PW="$(PW)"; SHIP_PW="$(PW)"

docker run -d --name "$NAME" -p 127.0.0.1::5432 -e POSTGRES_PASSWORD="$SUPER_PW" -v "$HOSTPWD":/repo:ro -w /repo "$IMAGE" >/dev/null
for _ in $(seq 1 60); do docker exec "$NAME" pg_isready -U supabase_admin -h localhost >/dev/null 2>&1 && break; sleep 2; done
docker exec "$NAME" pg_isready -U supabase_admin -h localhost >/dev/null
SU()  { docker exec -e PGPASSWORD="$SUPER_PW" "$NAME" psql -X -q -h localhost -U supabase_admin -d "$DB" -v ON_ERROR_STOP=1 "$@"; }
MIG() { docker exec -e PGPASSWORD="$MIG_PW"   "$NAME" psql -X -q -h localhost -U lims_migrator   -d "$DB" -v ON_ERROR_STOP=1 "$@"; }
SU -c "CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions"
SU -v lims_migrator_pw="$MIG_PW" -v lims_api_pw="$API_PW" -v lims_worker_pw="$WORKER_PW" -v lims_monitor_pw="$MON_PW" \
   -v lims_replicator_pw="$REPL_PW" -v lims_audit_ship_pw="$SHIP_PW" -v dbname="$DB" -f db/bootstrap/00_roles.sql
SU -v dbname="$DB" -f db/bootstrap/01_database.sql
STEP_C="20261105001200"   # same split as run-suites.sh (SP-2 / LD-31)
for f in $(ls db/migrations/*.sql | sort); do [[ "$(basename "$f")" < "$STEP_C" ]] && MIG --single-transaction -f "/repo/$f"; done
HOSTPORT="$(docker port "$NAME" 5432/tcp | head -n1 | sed 's/.*://')"
PGOPTIONS='-c role=lims_queue' PGPASSWORD="$MIG_PW" npx --no-install graphile-worker --schema-only -c "postgres://lims_migrator@127.0.0.1:$HOSTPORT/$DB"
for f in $(ls db/migrations/*.sql | sort); do [[ ! "$(basename "$f")" < "$STEP_C" ]] && MIG --single-transaction -f "/repo/$f"; done
for f in $(ls db/seeds/*.sql | sort); do MIG --single-transaction -f "/repo/$f"; done

export LIMS_TEST_DATABASE_URL="postgres://lims_api:$API_PW@127.0.0.1:$HOSTPORT/$DB"
export LIMS_TEST_ADMIN_DATABASE_URL="postgres://supabase_admin:$SUPER_PW@127.0.0.1:$HOSTPORT/$DB"
export LIMS_TEST_APP_URL="$LIMS_TEST_DATABASE_URL" LIMS_TEST_SUPER_URL="$LIMS_TEST_ADMIN_DATABASE_URL"
run_vitest
