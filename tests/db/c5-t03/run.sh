#!/usr/bin/env bash
# C5 T-03 harness: throwaway container of the PINNED image -> bootstrap roles/database -> migrations (as lims_migrator, SP-2 three-step window) -> seeds
# -> vitest for the repository integration tests with LIMS_TEST_DATABASE_URL (role lims_api, RLS enforced) and LIMS_TEST_ADMIN_DATABASE_URL (superuser, RLS bypassed:
# proves the repositories' EXPLICIT tenant filter). Mirrors db/tests/run-suites.sh (read-only, not edited). Run from the repo root:  bash tests/db/c5-t03/run.sh
# LIMS_PG_IMAGE overrides the pinned image for a local smoke run only. Needs docker, node, pnpm (dependencies installed). Exit code = vitest's.
set -euo pipefail
IMAGE="${LIMS_PG_IMAGE:-supabase/postgres:17.6.1.136}"
export MSYS_NO_PATHCONV=1
HOSTPWD="$(pwd -W 2>/dev/null || pwd)"
NAME="lims_c5t03_$$"
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
for f in $(ls db/seeds/*.sql 2>/dev/null | sort); do MIG --single-transaction -f "/repo/$f"; done

export LIMS_TEST_DATABASE_URL="postgres://lims_api:$API_PW@127.0.0.1:$HOSTPORT/$DB"
export LIMS_TEST_ADMIN_DATABASE_URL="postgres://supabase_admin:$SUPER_PW@127.0.0.1:$HOSTPORT/$DB"
export LIMS_T03_REQUIRE_DB=1     # the tests FAIL (not skip) when the database is missing
if [ -n "${LIMS_T03_CMD:-}" ]; then   # debug hook: run another command against the migrated DB (e.g. a fixtures-only smoke check)
  SUPER_PW="$SUPER_PW" NAME="$NAME" DB="$DB" bash -c "$LIMS_T03_CMD"
else
  pnpm --filter @lims/api exec vitest run src/modules/lab/repository/__tests__
fi
