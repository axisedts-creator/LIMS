#!/usr/bin/env bash
# Milestone T13: boot the pinned PG17 container, migrate, seed, apply T13 test fixture,
# then run the live HTTP E2E suite (Fastify API on 127.0.0.1:8088 + Flutter Patient App over real HTTP).
set -euo pipefail

SUITE="src/modules/engagement/__tests__/mhn-live-http.e2e.test.ts"
run_vitest() { pnpm --dir services/api exec vitest run "$SUITE"; }
if [ -n "${LIMS_TEST_APP_URL:-}" ] && [ -n "${LIMS_TEST_SUPER_URL:-}" ]; then run_vitest; exit $?; fi

IMAGE="${LIMS_PG_IMAGE:-public.ecr.aws/supabase/postgres:17.6.1.155}"
export MSYS_NO_PATHCONV=1
HOSTPWD="$(pwd -W 2>/dev/null || pwd)"
NAME="lims_mhnt13_$$"; DB="postgres"
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT
PW() { head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 20; }
SUPER_PW="$(PW)"; MIG_PW="$(PW)"; API_PW="$(PW)"; WORKER_PW="$(PW)"; MON_PW="$(PW)"; REPL_PW="$(PW)"; SHIP_PW="$(PW)"

echo "Starting isolated test PostgreSQL container..."
docker run -d --name "$NAME" -p 127.0.0.1::5432 -e POSTGRES_PASSWORD="$SUPER_PW" -v "$HOSTPWD":/repo:ro -w /repo "$IMAGE" >/dev/null
for _ in $(seq 1 60); do docker exec "$NAME" pg_isready -U supabase_admin -h localhost >/dev/null 2>&1 && break; sleep 2; done
docker exec "$NAME" pg_isready -U supabase_admin -h localhost >/dev/null

SU()  { docker exec -e PGPASSWORD="$SUPER_PW" "$NAME" psql -X -q -h localhost -U supabase_admin -d "$DB" -v ON_ERROR_STOP=1 "$@"; }
MIG() { docker exec -e PGPASSWORD="$MIG_PW"   "$NAME" psql -X -q -h localhost -U lims_migrator   -d "$DB" -v ON_ERROR_STOP=1 "$@"; }

echo "Applying bootstrap and roles..."
SU -c "CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions"
SU -v lims_migrator_pw="$MIG_PW" -v lims_api_pw="$API_PW" -v lims_worker_pw="$WORKER_PW" -v lims_monitor_pw="$MON_PW" \
   -v lims_replicator_pw="$REPL_PW" -v lims_audit_ship_pw="$SHIP_PW" -v dbname="$DB" -f db/bootstrap/00_roles.sql
SU -v dbname="$DB" -f db/bootstrap/01_database.sql

echo "Applying migrations part 1..."
STEP_C="20261105001200"
for f in $(ls db/migrations/*.sql | sort); do [[ "$(basename "$f")" < "$STEP_C" ]] && MIG --single-transaction -f "/repo/$f"; done

HOSTPORT="$(docker port "$NAME" 5432/tcp | head -n1 | sed 's/.*://')"
echo "Applying graphile-worker schema on port $HOSTPORT..."
PGOPTIONS='-c role=lims_queue' PGPASSWORD="$MIG_PW" npx --no-install graphile-worker --schema-only -c "postgres://lims_migrator@127.0.0.1:$HOSTPORT/$DB"

echo "Applying migrations part 2..."
for f in $(ls db/migrations/*.sql | sort); do [[ ! "$(basename "$f")" < "$STEP_C" ]] && MIG --single-transaction -f "/repo/$f"; done

echo "Applying seeds..."
for f in $(ls db/seeds/*.sql | sort); do MIG --single-transaction -f "/repo/$f"; done

echo "Registering engagement async tasks..."
SU -c "INSERT INTO core.g_task_registry (identifier, module, kind, scope, max_attempts, is_active)
VALUES
  ('core.event_fanout', 'core', 'core', 'per_tenant', 25, true),
  ('engagement.send_login_otp', 'engagement', 'task', 'per_tenant', 3, true),
  ('engagement.create_self_patient', 'engagement', 'task', 'per_tenant', 10, true),
  ('engagement.backfill_link', 'engagement', 'task', 'per_tenant', 10, true),
  ('engagement.fetch_smart_summary', 'engagement', 'task', 'per_tenant', 5, true),
  ('engagement.send_booking_message', 'engagement', 'task', 'per_tenant', 8, true),
  ('engagement.send_reminder', 'engagement', 'task', 'per_tenant', 8, true),
  ('engagement.sync_bookable_items', 'engagement', 'task', 'per_tenant', 5, true),
  ('engagement.sync_booking_centres', 'engagement', 'task', 'per_tenant', 5, true),
  ('engagement.create_payment_intent', 'engagement', 'task', 'per_tenant', 5, true)
ON CONFLICT (identifier) DO NOTHING;"

echo "Applying T13 synthetic fixture..."
MIG --single-transaction -f "/repo/tests/e2e/mhn-t13.fixture.sql"

export LIMS_TEST_APP_URL="postgres://lims_api:$API_PW@127.0.0.1:$HOSTPORT/$DB"
export LIMS_TEST_SUPER_URL="postgres://supabase_admin:$SUPER_PW@127.0.0.1:$HOSTPORT/$DB"

echo "Running live HTTP E2E suite against Fastify and PG17..."
run_vitest
