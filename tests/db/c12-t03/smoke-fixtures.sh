#!/usr/bin/env bash
# Debug hook for run.sh:  bash tests/db/c12-t03/run.sh smoke
# Applies fixtures.sql to the migrated database and prints row counts (proves the fixture is valid against the real DDL). Uses SUPER_PW / NAME / DB exported by run.sh.
set -euo pipefail
PSQL() { docker exec -i -e PGPASSWORD="$SUPER_PW" "$NAME" psql -X -h localhost -U supabase_admin -d "$DB" -v ON_ERROR_STOP=1 "$@"; }
PSQL -q -f - < tests/db/c12-t03/fixtures.sql
PSQL -c "SELECT (SELECT count(*) FROM inventory.items) items, (SELECT count(*) FROM inventory.stores) stores, (SELECT count(*) FROM inventory.stock_balances) balances,
  (SELECT count(*) FROM inventory.stock_movements) movements, (SELECT count(*) FROM inventory.purchase_order_lines) po_lines, (SELECT count(*) FROM inventory.goods_receipt_lines) grn_lines,
  (SELECT count(*) FROM inventory.transfer_lines) tr_lines, (SELECT count(*) FROM inventory.consumption_rules) rules, (SELECT count(*) FROM inventory.alerts) alerts,
  (SELECT count(*) FROM inventory.instrument_qc_daily) qc"
