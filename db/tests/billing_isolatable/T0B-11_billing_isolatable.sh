#!/usr/bin/env bash
# T0B-11 / AC-0B-6.4 (04 D16, B17): runtime proof that `billing` is isolatable per tenant.
#   seed billing rows for tenants A and B -> `node db/tools/export-tenant-billing.ts --tenant A` -> restore the output into an EMPTY billing schema
#   -> per tenant table: row count and md5 checksum of A's rows match the source; zero rows of any other tenant; B's id/values absent from the output;
#   source billing data unchanged by the export (read-only).
# Run from the repo root:  bash db/tests/billing_isolatable/T0B-11_billing_isolatable.sh     Exit 0 = pass, 1 = assertion failed, 2 = environment.
# Needs docker (pinned supabase/postgres image, same bootstrap as db/tests/run-suites.sh), node, and `psql` on the HOST PATH (the tool shells out to
# psql like db/tools/policy-dump.ts). Synthetic data only; throwaway container and random passwords.
set -euo pipefail
IMAGE="${LIMS_PG_IMAGE:-supabase/postgres:17.6.1.136}"
export MSYS_NO_PATHCONV=1
command -v psql >/dev/null || { echo "T0B-11: psql is not on PATH (the export tool needs it)"; exit 2; }
command -v docker >/dev/null || { echo "T0B-11: docker is required"; exit 2; }
HOSTPWD="$(pwd -W 2>/dev/null || pwd)"
NAME="lims_t0b11_$$"; DB="postgres"
WORK="$(mktemp -d)"
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT
PW() { head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 20; }
SUPER_PW="$(PW)"; MIG_PW="$(PW)"; API_PW="$(PW)"; WORKER_PW="$(PW)"; MON_PW="$(PW)"; REPL_PW="$(PW)"; SHIP_PW="$(PW)"
TA='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; TB='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'; ACTOR='cccccccc-cccc-4ccc-8ccc-cccccccccccc'

docker run -d --name "$NAME" -p 127.0.0.1::5432 -e POSTGRES_PASSWORD="$SUPER_PW" -v "$HOSTPWD":/repo:ro -w /repo "$IMAGE" >/dev/null
for _ in $(seq 1 60); do docker exec "$NAME" pg_isready -U supabase_admin -h localhost >/dev/null 2>&1 && break; sleep 2; done
docker exec "$NAME" pg_isready -U supabase_admin -h localhost >/dev/null || { echo "T0B-11: postgres did not start"; exit 2; }
SU()  { docker exec -i -e PGPASSWORD="$SUPER_PW" "$NAME" psql -X -q -t -A -h localhost -U supabase_admin -d "$DB" -v ON_ERROR_STOP=1 "$@"; }
MIG() { docker exec -e PGPASSWORD="$MIG_PW" "$NAME" psql -X -q -h localhost -U lims_migrator -d "$DB" -v ON_ERROR_STOP=1 "$@"; }
PORT="$(docker port "$NAME" 5432/tcp | head -n1 | sed 's/.*://')"
URL="postgres://supabase_admin:$SUPER_PW@127.0.0.1:$PORT/$DB"
HP() { psql "$URL" -X -q -t -A -v ON_ERROR_STOP=1 "$@"; }          # host psql (restore target / what the tool uses)

# --- schema: bootstrap + all migrations (same D-201 window as run-suites.sh) ---
SU -c "CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions"
SU -v lims_migrator_pw="$MIG_PW" -v lims_api_pw="$API_PW" -v lims_worker_pw="$WORKER_PW" -v lims_monitor_pw="$MON_PW" \
   -v lims_replicator_pw="$REPL_PW" -v lims_audit_ship_pw="$SHIP_PW" -v dbname="$DB" -f db/bootstrap/00_roles.sql
SU -v dbname="$DB" -f db/bootstrap/01_database.sql
STEP_C="20261105001200"
for f in $(ls db/migrations/*.sql | sort); do [[ "$(basename "$f")" < "$STEP_C" ]] && MIG --single-transaction -f "/repo/$f"; done
if ! PGOPTIONS='-c role=lims_queue' PGPASSWORD="$MIG_PW" npx --no-install graphile-worker --schema-only -c "postgres://lims_migrator@127.0.0.1:$PORT/$DB"; then
  echo "T0B-11: graphile-worker --schema-only failed"; exit 2; fi
for f in $(ls db/migrations/*.sql | sort); do [[ ! "$(basename "$f")" < "$STEP_C" ]] && MIG --single-transaction -f "/repo/$f"; done

# --- seed A/B (superuser, replica role: FKs into core.* and triggers are out of scope here; CHECKs still apply) ---
SU <<SQL
SET session_replication_role = replica;
INSERT INTO billing.settings (tenant_id, created_by, updated_by) VALUES ('$TA','$ACTOR','$ACTOR'), ('$TB','$ACTOR','$ACTOR');
INSERT INTO billing.fiscal_counters (tenant_id, series, fiscal_year_bs, last_no, created_by, updated_by) VALUES
  ('$TA','INV','2082/83',5,'$ACTOR','$ACTOR'), ('$TA','CN','2082/83',2,'$ACTOR','$ACTOR'), ('$TA','INV','2083/84',0,'$ACTOR','$ACTOR'),
  ('$TB','INV','2082/83',9,'$ACTOR','$ACTOR'), ('$TB','RC','2082/83',3,'$ACTOR','$ACTOR');
INSERT INTO billing.credit_accounts (tenant_id, credit_party_id, party_code, party_display_name, created_by, updated_by) VALUES
  ('$TA','dddddddd-dddd-4ddd-8ddd-000000000001','A-CREDIT-1','Synthetic Party A1','$ACTOR','$ACTOR'),
  ('$TA','dddddddd-dddd-4ddd-8ddd-000000000002','A-CREDIT-2','Synthetic Party A2','$ACTOR','$ACTOR'),
  ('$TA','dddddddd-dddd-4ddd-8ddd-000000000003','A-CREDIT-3','Synthetic Party A3','$ACTOR','$ACTOR'),
  ('$TB','eeeeeeee-eeee-4eee-8eee-000000000001','B-SECRET-CREDIT','Synthetic Party B1','$ACTOR','$ACTOR'),
  ('$TB','eeeeeeee-eeee-4eee-8eee-000000000002','B-SECRET-CREDIT-2','Synthetic Party B2','$ACTOR','$ACTOR');
INSERT INTO billing.payment_intent_refs (tenant_id, intent_id, order_id, gateway, amount_paisa, created_by, id) VALUES
  ('$TA','ffffffff-ffff-4fff-8fff-000000000001','ffffffff-ffff-4fff-8fff-0000000000a1','esewa',10000,'$ACTOR','ffffffff-ffff-4fff-8fff-0000000000b1'),
  ('$TA','ffffffff-ffff-4fff-8fff-000000000002','ffffffff-ffff-4fff-8fff-0000000000a2','khalti',25050,'$ACTOR','ffffffff-ffff-4fff-8fff-0000000000b2'),
  ('$TB','ffffffff-ffff-4fff-8fff-000000000003','ffffffff-ffff-4fff-8fff-0000000000a3','fonepay',777,'$ACTOR','ffffffff-ffff-4fff-8fff-0000000000b3');
SQL

# per-table fingerprint of a schema: "<table>|<tenant>|<count>|<md5>" for every billing table with a tenant_id column
FP() { # $1 schema
SU <<SQL
DO \$\$ DECLARE t record; r record; BEGIN
  CREATE TEMP TABLE IF NOT EXISTS fp(tbl text, tenant uuid, n bigint, sum text); TRUNCATE fp;
  FOR t IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = '$1' AND c.relkind = 'r' AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
  LOOP
    FOR r IN EXECUTE format('SELECT tenant_id AS tid, count(*) AS n, md5(string_agg(x::text, ''|'' ORDER BY x::text)) AS s FROM %I.%I x GROUP BY tenant_id', '$1', t.relname)
    LOOP INSERT INTO fp VALUES (t.relname, r.tid, r.n, r.s); END LOOP;
  END LOOP;
END \$\$;
SELECT tbl||'|'||tenant||'|'||n||'|'||sum FROM fp ORDER BY 1;
SQL
}
FP billing > "$WORK/src_all.txt"
grep -c "|$TA|" "$WORK/src_all.txt" > "$WORK/src_a_tables.txt"
[ "$(cat "$WORK/src_a_tables.txt")" -ge 4 ] || { echo "FAIL: seed did not reach >= 4 tenant-A tables"; exit 1; }
grep -q "|$TB|" "$WORK/src_all.txt" || { echo "FAIL: seed has no tenant-B rows (vacuous test)"; exit 1; }

# --- export A with the tool (host psql, DATABASE_URL, --out) ---
DATABASE_URL="$URL" node db/tools/export-tenant-billing.ts --tenant "$TA" --out "$WORK/export_a.sql" || { echo "FAIL: tool exited $?"; exit 1; }
[ -s "$WORK/export_a.sql" ] || { echo "FAIL: empty export"; exit 1; }
if grep -qiE "$TB|B-SECRET-CREDIT" "$WORK/export_a.sql"; then echo "FAIL: tenant B data present in tenant A export"; exit 1; fi
grep -qi "$TA" "$WORK/export_a.sql" || { echo "FAIL: export does not mention tenant A"; exit 1; }

# source untouched by the export (read-only)
FP billing > "$WORK/src_after.txt"
cmp -s "$WORK/src_all.txt" "$WORK/src_after.txt" || { echo "FAIL: export changed the source billing data"; exit 1; }

# --- empty billing schema: park the source as billing_src, recreate billing with the same (empty) tables, restore ---
SU <<SQL
ALTER SCHEMA billing RENAME TO billing_src;
CREATE SCHEMA billing;
DO \$\$ DECLARE t record; BEGIN
  FOR t IN SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'billing_src' AND c.relkind = 'r' LOOP
    EXECUTE format('CREATE TABLE billing.%I (LIKE billing_src.%I INCLUDING DEFAULTS INCLUDING GENERATED)', t.relname, t.relname);
  END LOOP;
END \$\$;
SQL
[ "$(SU -c "SELECT count(*) FROM billing.settings")" = "0" ] || { echo "FAIL: restore target not empty"; exit 1; }
HP -1 -f "$WORK/export_a.sql" || { echo "FAIL: restore of the export failed"; exit 1; }

# --- assertions ---
FP billing > "$WORK/restored.txt"
grep -v "|$TA|" "$WORK/restored.txt" > "$WORK/restored_foreign.txt" || true
[ ! -s "$WORK/restored_foreign.txt" ] || { echo "FAIL: restored schema holds non-A rows:"; cat "$WORK/restored_foreign.txt"; exit 1; }
FP billing_src | grep "|$TA|" > "$WORK/src_a.txt"
if ! diff -u "$WORK/src_a.txt" "$WORK/restored.txt"; then echo "FAIL: row counts / checksums of tenant A differ between source and restore"; exit 1; fi
echo "ok - AC-0B-6.4: $(wc -l < "$WORK/restored.txt") tenant-A table fingerprints match, no other tenant's row restored, source unchanged"
