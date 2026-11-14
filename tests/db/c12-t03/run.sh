#!/usr/bin/env bash
# C12 T-03 harness (clone of tests/db/c14-t02/run.sh): throwaway container of the PINNED image -> bootstrap roles/database -> migrations (as lims_migrator, SP-2 three-step window)
# -> seeds -> inventory DDL -> vitest for the inventory repository tests with LIMS_TEST_DATABASE_URL (role lims_api, RLS on) and LIMS_TEST_ADMIN_DATABASE_URL
# (superuser, RLS bypassed: proves the repositories' EXPLICIT tenant filter). Run from the repo root:  bash tests/db/c12-t03/run.sh
# The inventory DDL is applied from db/migrations/*_inventory__*.sql when C0 has delivered it; until then it is extracted verbatim from spec/chunks/C12-inventory/05-SCHEMA.md §8 (read-only),
# followed by the RLS template (§4.1, §4.3) and grants (§4.4) of the same document, because the §8 block only references them.
# LIMS_PG_IMAGE overrides the pinned image for a local smoke run only. Needs docker, node, pnpm (dependencies installed). Exit code = vitest's.
set -euo pipefail
IMAGE="${LIMS_PG_IMAGE:-supabase/postgres:17.6.1.136}"
export MSYS_NO_PATHCONV=1
HOSTPWD="$(pwd -W 2>/dev/null || pwd)"
NAME="lims_c12t03_$$"
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

# inventory tables: C0's migration when it exists, else the spec's DDL block (05-SCHEMA §8) verbatim + RLS template + grants (§4).
if ls db/migrations/*_inventory__*.sql >/dev/null 2>&1; then
  echo "inventory DDL: delivered by db/migrations (C0)"
elif docker exec "$NAME" psql -X -q -t -A -h localhost -U supabase_admin -d "$DB" -c "SELECT to_regclass('inventory.items')" | grep -q items; then
  echo "inventory DDL: already present"
else
  echo "inventory DDL: extracted from spec 05-SCHEMA §8 (+ §4 RLS/grants)"
  { echo "SET LOCAL ROLE lims_owner;"   # every C0 migration switches to the schema owner role first
    awk '/^## 8\. DDL/{s=1;next} s&&/^```sql/{b=1;next} b&&/^```/{exit} b{print}' spec/chunks/C12-inventory/05-SCHEMA.md
    cat <<'SQL'
DO $rls$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['cs_reasons','cs_tax_codes','settings','number_counters','items','item_packs','item_barcodes','stores','store_item_settings','suppliers',
    'supplier_items','lots','stock_balances','stock_movements','purchase_orders','purchase_order_lines','goods_receipts','goods_receipt_lines','transfers','transfer_lines',
    'stock_documents','stock_document_lines','stock_counts','stock_count_lines','opened_containers','instrument_bindings','consumption_rules','consumption_facts',
    'consumption_daily','test_counts_daily','instrument_qc_daily','alerts'] LOOP
    EXECUTE format('ALTER TABLE inventory.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE inventory.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON inventory.%I FOR SELECT TO lims_app USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))', t || '__select__tenant', t);
    EXECUTE format('CREATE POLICY %I ON inventory.%I FOR INSERT TO lims_app WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))', t || '__insert__tenant', t);
    IF t NOT IN ('stock_movements','stock_documents','stock_document_lines') THEN   -- A tables: no UPDATE grant, no policy (§4.2)
      EXECUTE format('CREATE POLICY %I ON inventory.%I FOR UPDATE TO lims_app USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system())) WITH CHECK (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.is_staff_or_system()))', t || '__update__tenant', t);
    END IF;
  END LOOP;
END $rls$;
CREATE POLICY alerts__delete__tenant ON inventory.alerts FOR DELETE TO lims_app
  USING (tenant_id = (SELECT app.current_tenant_id()) AND (SELECT app.current_actor_type()) = 'system' AND expires_at < now());
GRANT SELECT, INSERT, UPDATE ON inventory.cs_reasons, inventory.cs_tax_codes, inventory.settings, inventory.number_counters,
  inventory.items, inventory.item_packs, inventory.item_barcodes, inventory.stores, inventory.store_item_settings,
  inventory.suppliers, inventory.supplier_items, inventory.lots, inventory.stock_balances,
  inventory.purchase_orders, inventory.goods_receipts, inventory.transfers, inventory.stock_counts, inventory.stock_count_lines,
  inventory.opened_containers, inventory.instrument_bindings, inventory.consumption_rules, inventory.consumption_facts,
  inventory.consumption_daily, inventory.test_counts_daily, inventory.instrument_qc_daily, inventory.alerts,
  inventory.purchase_order_lines, inventory.goods_receipt_lines, inventory.transfer_lines TO lims_app;
GRANT DELETE ON inventory.alerts TO lims_app;
GRANT SELECT, INSERT ON inventory.stock_movements, inventory.stock_documents, inventory.stock_document_lines TO lims_app;
GRANT SELECT ON inventory.g_cs_uom, inventory.g_cs_reasons, inventory.g_cs_tax_codes TO lims_app;
SQL
  } | MIGI --single-transaction -f -
fi

for f in $(ls db/seeds/*.sql 2>/dev/null | sort); do MIG --single-transaction -f "/repo/$f"; done

export LIMS_TEST_DATABASE_URL="postgres://lims_api:$API_PW@127.0.0.1:$HOSTPORT/$DB"
export LIMS_TEST_ADMIN_DATABASE_URL="postgres://supabase_admin:$SUPER_PW@127.0.0.1:$HOSTPORT/$DB"
export LIMS_C12T03_REQUIRE_DB=1     # the tests FAIL (not skip) when the database is missing
[ "${1:-}" = "smoke" ] && LIMS_C12T03_CMD="bash tests/db/c12-t03/smoke-fixtures.sh"   # `run.sh smoke`: only apply fixtures.sql and count rows (needs no repository code)
if [ -n "${LIMS_C12T03_CMD:-}" ]; then   # debug hook: run another command against the migrated DB
  SUPER_PW="$SUPER_PW" NAME="$NAME" DB="$DB" bash -c "$LIMS_C12T03_CMD"
else
  pnpm --dir services/api exec vitest run src/modules/inventory/repository/__tests__
fi
