#!/usr/bin/env bash
# Runs every pgTAP suite under db/tests/** on a throwaway container of the PINNED image supabase/postgres:17.6.1.136 (SP-3; review C0 m#33):
# bootstrap roles/database -> migrations (as lims_migrator) -> seeds -> generated isolation probes -> all *.test.sql, incl. db/tests/definers (the
# DEFINER owner-policy suite of 05-SCHEMA §10 schema tests 13-17 and 22-33). Exit code != 0 on any failure or when the run exceeds 10 minutes
# (02-TRD §9: isolation suite <= 10 min in CI). Run from the repo root:  bash db/tests/run-suites.sh [suite.test.sql ...]
# Needs docker; uses pg_prove inside the container when present, else psql and a "not ok" scan of the TAP stream. Synthetic data only; no secrets kept.
set -euo pipefail
IMAGE="${LIMS_PG_IMAGE:-supabase/postgres:17.6.1.136}"   # override only for a local smoke run; CI uses the pin
export MSYS_NO_PATHCONV=1                                 # Git Bash on Windows: keep /repo as written
HOSTPWD="$(pwd -W 2>/dev/null || pwd)"
NAME="lims_t0b08_$$"
DB="postgres"                               # SP-3: the LIMS database is the image's init database (extensions/auth/storage live there)
START=$SECONDS
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

PW() { head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 20; }
SUPER_PW="$(PW)"; MIG_PW="$(PW)"; API_PW="$(PW)"; WORKER_PW="$(PW)"; MON_PW="$(PW)"; REPL_PW="$(PW)"; SHIP_PW="$(PW)"

[ -n "${LIMS_SKIP_GEN:-}" ] || node db/tools/gen-isolation-probes.ts   # writes db/tests/isolation/_registry.sql + one probe file per tenant table

docker run -d --name "$NAME" -p 127.0.0.1::5432 -e POSTGRES_PASSWORD="$SUPER_PW" -v "$HOSTPWD":/repo:ro -w /repo "$IMAGE" >/dev/null
for _ in $(seq 1 60); do docker exec "$NAME" pg_isready -U supabase_admin -h localhost >/dev/null 2>&1 && break; sleep 2; done
docker exec "$NAME" pg_isready -U supabase_admin -h localhost >/dev/null

SU()  { docker exec -e PGPASSWORD="$SUPER_PW" "$NAME" psql -X -q -h localhost -U supabase_admin -d "$DB" -v ON_ERROR_STOP=1 "$@"; }
MIG() { docker exec -e PGPASSWORD="$MIG_PW"   "$NAME" psql -X -q -h localhost -U lims_migrator   -d "$DB" -v ON_ERROR_STOP=1 "$@"; }

SU -c "CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions"
SU -v lims_migrator_pw="$MIG_PW" -v lims_api_pw="$API_PW" -v lims_worker_pw="$WORKER_PW" -v lims_monitor_pw="$MON_PW" \
   -v lims_replicator_pw="$REPL_PW" -v lims_audit_ship_pw="$SHIP_PW" -v dbname="$DB" -f db/bootstrap/00_roles.sql
SU -v dbname="$DB" -f db/bootstrap/01_database.sql
# SP-2 / LD-31: D-201 window is split. (a) migrations < 20261105001200 (..001100 commits GRANT CREATE to lims_queue); (b) graphile-worker 0.18.0
# --schema-only as lims_migrator with session role lims_queue on a direct connection; (c) ..001200 onward (wrapper + REVOKE CREATE).
# If (b) fails, re-run (c)'s REVOKEs so no CREATE stays standing, then exit 1.
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
# --no-seeds / LIMS_SKIP_SEEDS=1: local runs only (seed 010 blocked by T0B-09 RLS INSERT policies)
if [ "${1:-}" = "--no-seeds" ]; then LIMS_SKIP_SEEDS=1; shift; fi
if [ -z "${LIMS_SKIP_SEEDS:-}" ]; then for f in $(ls db/seeds/*.sql 2>/dev/null | sort); do MIG --single-transaction -f "/repo/$f"; done; fi

if [ "$#" -gt 0 ]; then SUITES=("$@"); else mapfile -t SUITES < <(find db/tests -name '*.test.sql' | sort); fi
FAIL=0
for s in "${SUITES[@]}"; do
  echo "# --- $s"
  OUT="$(docker exec -e PGPASSWORD="$SUPER_PW" "$NAME" sh -c "cd /repo && psql -X -q -t -A -h localhost -U supabase_admin -d $DB -v ON_ERROR_STOP=1 -f $s" 2>&1)" || { echo "$OUT"; echo "psql failed: $s"; FAIL=1; continue; }
  echo "$OUT" | grep -E '^(not ok|# Failed|ok .*# SKIP)' || true
  if echo "$OUT" | grep -q '^not ok'; then FAIL=1; fi
done

ELAPSED=$((SECONDS - START))
echo "# elapsed ${ELAPSED}s"
if [ "$ELAPSED" -gt 600 ]; then echo "suites exceeded the 10 minute CI budget"; FAIL=1; fi
exit "$FAIL"
# pg_prove variant used in CI images that ship it: pg_prove -d "$DB" -U supabase_admin "${SUITES[@]}"
