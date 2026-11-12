#!/usr/bin/env bash
# HC-T03: boot the pinned PG17 image like tests/frontdesk/FD-T03.pg.sh (roles -> migrations -> graphile-worker schema -> seeds), make sure the `homecollection`
# tables exist, then run the HC-T03 vitest suite with LIMS_TEST_APP_URL (lims_api) + LIMS_TEST_SUPER_URL. Run from the repo root. Exit code = vitest's.
# P-1 (C0's homecollection DDL migration) has not landed yet: if homecollection.visits is missing after the migrations, the DDL + RLS policies are applied
# from the normative blocks of spec/chunks/C17-home-collection/05-SCHEMA.md §4 and §4.1 (extracted verbatim; no hand copy). Once P-1 lands this step is a no-op.
# If both URLs are already exported, no container is started (point them at any migrated + seeded PG17 that has the homecollection tables).
set -euo pipefail
SUITE="${HC_SUITE:-src/modules/homecollection/repository/__tests__}"   # HC_SUITE: later tasks (HC-T04) reuse this bootstrap for their own folder
run_vitest() { pnpm --dir services/api exec vitest run "$SUITE"; }
if [ -n "${LIMS_TEST_APP_URL:-}" ] && [ -n "${LIMS_TEST_SUPER_URL:-}" ]; then run_vitest; exit $?; fi

IMAGE="${LIMS_PG_IMAGE:-supabase/postgres:17.6.1.136}"
export MSYS_NO_PATHCONV=1
HOSTPWD="$(pwd -W 2>/dev/null || pwd)"
NAME="lims_hct03_$$"; DB="postgres"
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT
PW() { head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 20; }
SUPER_PW="$(PW)"; MIG_PW="$(PW)"; API_PW="$(PW)"; WORKER_PW="$(PW)"; MON_PW="$(PW)"; REPL_PW="$(PW)"; SHIP_PW="$(PW)"

docker run -d --name "$NAME" -p 127.0.0.1::5432 -e POSTGRES_PASSWORD="$SUPER_PW" -v "$HOSTPWD":/repo:ro -w /repo "$IMAGE" >/dev/null
for _ in $(seq 1 60); do docker exec "$NAME" pg_isready -U supabase_admin -h localhost >/dev/null 2>&1 && break; sleep 2; done
docker exec "$NAME" pg_isready -U supabase_admin -h localhost >/dev/null
SU()  { docker exec -e PGPASSWORD="$SUPER_PW" "$NAME" psql -X -q -h localhost -U supabase_admin -d "$DB" -v ON_ERROR_STOP=1 "$@"; }
SUI() { docker exec -i -e PGPASSWORD="$SUPER_PW" "$NAME" psql -X -q -h localhost -U supabase_admin -d "$DB" -v ON_ERROR_STOP=1 "$@"; }
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

# P-1 stand-in: only when C0's homecollection migration is absent
if [ "$(SU -tA -c "SELECT to_regclass('homecollection.visits') IS NOT NULL")" != "t" ]; then
  echo "HC-T03: homecollection.* missing after migrations (P-1 not landed): applying 05-SCHEMA §4/§4.1 DDL + policies"
  awk '/^## 4\. DDL/{on=1} /^### 4\.2/{on=0} on && /^```sql/{f=1; next} on && /^```/{f=0} on && f' spec/chunks/C17-home-collection/05-SCHEMA.md \
    | SUI --single-transaction -f -
fi

for f in $(ls db/seeds/*.sql | sort); do MIG --single-transaction -f "/repo/$f"; done

export LIMS_TEST_APP_URL="postgres://lims_api:$API_PW@127.0.0.1:$HOSTPORT/$DB"
export LIMS_TEST_SUPER_URL="postgres://supabase_admin:$SUPER_PW@127.0.0.1:$HOSTPORT/$DB"
run_vitest
