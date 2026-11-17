#!/usr/bin/env bash
# T0B-11 / AC-0B-6.4 (04 D16, B17): runtime proof that `billing` is isolatable per tenant.
#   seed billing rows for tenants A and B (incl. the FK chain invoices/invoice_lines/credit_notes/credit_note_lines/ledger_entries + one self-referencing reversal)
#   -> `node db/tools/export-tenant-billing.ts --tenant A` -> restore the output into an EMPTY, really-migrated `billing` schema (second database, same migrations except storage (LD-52))
#   -> per tenant table: row count and md5 checksum of A's rows match the source; zero rows of any other tenant; B's id/values absent from the output;
#   source billing data unchanged by the export (read-only); a role under FORCE RLS gets an error, never a silently short export.
# Run from the repo root:  bash db/tests/billing_isolatable/T0B-11_billing_isolatable.sh     Exit 0 = pass, 1 = assertion failed, 2 = environment.
# Needs docker (pinned supabase/postgres image, same bootstrap as db/tests/run-suites.sh), node, and `psql` on the HOST PATH (the tool shells out to
# psql like db/tools/policy-dump.ts). Synthetic data only; throwaway container and random passwords.
set -euo pipefail
IMAGE="${LIMS_PG_IMAGE:-supabase/postgres:17.6.1.136}"
export MSYS_NO_PATHCONV=1
command -v psql >/dev/null || { echo "T0B-11: psql is not on PATH (the export tool needs it)"; exit 2; }
command -v docker >/dev/null || { echo "T0B-11: docker is required"; exit 2; }
HOSTPWD="$(pwd -W 2>/dev/null || pwd)"
NAME="lims_t0b11_$$"; DB="postgres"; RDB="lims_restore"
WORK="$(cd "$(mktemp -d)" && (pwd -W 2>/dev/null || pwd))"
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT
PW() { head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 20; }
SUPER_PW="$(PW)"; MIG_PW="$(PW)"; API_PW="$(PW)"; WORKER_PW="$(PW)"; MON_PW="$(PW)"; REPL_PW="$(PW)"; SHIP_PW="$(PW)"
TA='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; TB='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'; ACTOR='cccccccc-cccc-4ccc-8ccc-cccccccccccc'

docker run -d --name "$NAME" -p 127.0.0.1::5432 -e POSTGRES_PASSWORD="$SUPER_PW" -v "$HOSTPWD":/repo:ro -w /repo "$IMAGE" >/dev/null
for _ in $(seq 1 60); do docker exec "$NAME" pg_isready -U supabase_admin -h localhost >/dev/null 2>&1 && break; sleep 2; done
docker exec "$NAME" pg_isready -U supabase_admin -h localhost >/dev/null || { echo "T0B-11: postgres did not start"; exit 2; }
SUD()  { local d="$1"; shift; docker exec -i -e PGPASSWORD="$SUPER_PW" "$NAME" psql -X -q -t -A -h localhost -U supabase_admin -d "$d" -v ON_ERROR_STOP=1 "$@"; }
SU()   { SUD "$DB" "$@"; }
MIGD() { local d="$1"; shift; docker exec -e PGPASSWORD="$MIG_PW" "$NAME" psql -X -q -h localhost -U lims_migrator -d "$d" -v ON_ERROR_STOP=1 "$@"; }
PORT="$(docker port "$NAME" 5432/tcp | head -n1 | sed 's/.*://')"
URL="postgres://supabase_admin:$SUPER_PW@127.0.0.1:$PORT/$DB"
RURL="postgres://supabase_admin:$SUPER_PW@127.0.0.1:$PORT/$RDB"

# --- schema: roles once, then TWO identically migrated databases: $DB (source, seeded) and $RDB (restore target, stays empty) ---
SU -v lims_migrator_pw="$MIG_PW" -v lims_api_pw="$API_PW" -v lims_worker_pw="$WORKER_PW" -v lims_monitor_pw="$MON_PW" \
   -v lims_replicator_pw="$REPL_PW" -v lims_audit_ship_pw="$SHIP_PW" -v dbname="$DB" -f db/bootstrap/00_roles.sql
build_db() { # $1 database: bootstrap + all migrations (same D-201 window as run-suites.sh)
  # LD-52: skip every <timestamp>_storage__*.sql on BOTH databases (storage grant defect belongs to CR-C0-T0B-12 / T0B-12, out of scope for AC-0B-6.4; billing needs no storage).
  local d="$1" f STEP_C="20261105001200"
  [ "$d" = "$DB" ] || { SU -c "CREATE DATABASE $d"; SUD "$d" -c "CREATE SCHEMA IF NOT EXISTS extensions"; }  # fresh DB lacks the image's init-DB `extensions` schema (review round 4)
  SUD "$d" -c "CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions"
  SUD "$d" -v dbname="$d" -f db/bootstrap/01_database.sql
  for f in $(ls db/migrations/*.sql | sort); do case "$(basename "$f")" in *_storage__*) continue;; esac; if [[ "$(basename "$f")" < "$STEP_C" ]]; then MIGD "$d" --single-transaction -f "/repo/$f"; fi; done
  if ! PGOPTIONS='-c role=lims_queue' PGPASSWORD="$MIG_PW" npx --no-install graphile-worker --schema-only -c "postgres://lims_migrator@127.0.0.1:$PORT/$d"; then
    echo "T0B-11: graphile-worker --schema-only failed"; exit 2; fi
  for f in $(ls db/migrations/*.sql | sort); do case "$(basename "$f")" in *_storage__*) continue;; esac; if [[ ! "$(basename "$f")" < "$STEP_C" ]]; then MIGD "$d" --single-transaction -f "/repo/$f"; fi; done
}
build_db "$DB"; build_db "$RDB"

# --- seed A/B in the source (superuser + replica role: FKs into core.* and triggers are out of scope for SEEDING; CHECKs still apply). The seed
#     covers the FK-linked chain so the restore must cope with intra-schema FKs: invoice_lines/credit_notes/ledger_entries -> invoices,
#     credit_note_lines -> credit_notes + invoice_lines, ledger_entries.reverses_entry_id -> ledger_entries (the reversal id sorts BEFORE its payment). ---
BR='99999999-9999-4999-8999-999999999999'; CEN='99999999-9999-4999-8999-999999999998'
FPR='0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
inv() { # tenant id seq order buyer
  echo "('$2','$1','$BR','$CEN','INV','2082/83',$3,'INV-2082/83-00000$3','tax_invoice','registration','$4','dddddddd-dddd-4ddd-8ddd-0000000000f$3','$5','Synthetic Lab Seller','2082-04-01T10:00:00+05:45','2082-04-01',10000,0,0,10000,1300,0,11300,false,'$FPR','not_required','$ACTOR','$ACTOR')"; }
line() { # tenant id invoice_id
  echo "('$2','$1','$3','$CEN',1,'orderable','T1','Synthetic Test',10000,10000,0,0,10000,'taxable',1300,1300,0,11300,'$ACTOR')"; }
cnote() { # tenant id invoice_id seq
  echo "('$2','$1','$BR','2082/83',$4,'CN-2082/83-00000$4','partial','$3','INV-2082/83-000001','2082/83','Synthetic Buyer','2082-04-02T10:00:00+05:45','2082-04-02','synthetic',5000,0,0,5000,650,0,5650,'not_required','$ACTOR','$ACTOR')"; }
led() { # tenant id kind amount reverses(sql literal) order invoice
  local reason="NULL"; [ "$3" = reversal ] && reason="'synthetic'"
  echo "('$2','$1','$BR','$6','$7','$3','manual','cash',$4,$5,$reason,'2082/83','2082-04-01','$ACTOR','$ACTOR')"; }
A_INV1='a1a1a1a1-0000-4000-8000-000000000001'; A_INV2='a1a1a1a1-0000-4000-8000-000000000002'; B_INV1='b1b1b1b1-0000-4000-8000-000000000001'
A_ORD1='a0a0a0a0-0000-4000-8000-000000000001'; A_ORD2='a0a0a0a0-0000-4000-8000-000000000002'; B_ORD1='b0b0b0b0-0000-4000-8000-000000000001'
A_LN1='a2a2a2a2-0000-4000-8000-000000000001';  A_LN2='a2a2a2a2-0000-4000-8000-000000000002';  B_LN1='b2b2b2b2-0000-4000-8000-000000000001'
A_CN1='a3a3a3a3-0000-4000-8000-000000000001';  B_CN1='b3b3b3b3-0000-4000-8000-000000000001'
A_PAY1='a5a5a5a5-0000-4000-8000-000000000001'
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
INSERT INTO billing.invoices (id,tenant_id,branch_id,centre_id,series,fiscal_year_bs,invoice_seq,invoice_no,invoice_kind,purpose,order_id,patient_id,buyer_name,seller_name,issued_at,invoice_date_bs,gross_paisa,discount_paisa,exempt_paisa,taxable_paisa,vat_paisa,other_tax_paisa,net_paisa,prices_include_tax,quote_fingerprint,cbms_state,created_by,updated_by) VALUES
  $(inv "$TA" "$A_INV1" 1 "$A_ORD1" 'Synthetic Buyer A1'),
  $(inv "$TA" "$A_INV2" 2 "$A_ORD2" 'Synthetic Buyer A2'),
  $(inv "$TB" "$B_INV1" 1 "$B_ORD1" 'B-SECRET-BUYER');
INSERT INTO billing.invoice_lines (id,tenant_id,invoice_id,centre_id,line_no,line_kind,code,name,unit_price_paisa,gross_paisa,discount_paisa,exempt_paisa,taxable_paisa,vat_treatment,vat_rate_bp,vat_paisa,other_tax_paisa,net_paisa,created_by) VALUES
  $(line "$TA" "$A_LN1" "$A_INV1"),
  $(line "$TA" "$A_LN2" "$A_INV2"),
  $(line "$TB" "$B_LN1" "$B_INV1");
INSERT INTO billing.credit_notes (id,tenant_id,branch_id,fiscal_year_bs,credit_note_seq,credit_note_no,kind,invoice_id,invoice_no,invoice_fiscal_year_bs,buyer_name,issued_at,credit_note_date_bs,reason_code,gross_paisa,discount_paisa,exempt_paisa,taxable_paisa,vat_paisa,other_tax_paisa,net_paisa,cbms_state,created_by,updated_by) VALUES
  $(cnote "$TA" "$A_CN1" "$A_INV1" 1),
  $(cnote "$TB" "$B_CN1" "$B_INV1" 1);
INSERT INTO billing.credit_note_lines (id,tenant_id,credit_note_id,invoice_line_id,gross_paisa,discount_paisa,exempt_paisa,taxable_paisa,vat_paisa,other_tax_paisa,net_paisa,created_by) VALUES
  ('a4a4a4a4-0000-4000-8000-000000000001','$TA','$A_CN1','$A_LN1',5000,0,0,5000,650,0,5650,'$ACTOR'),
  ('b4b4b4b4-0000-4000-8000-000000000001','$TB','$B_CN1','$B_LN1',5000,0,0,5000,650,0,5650,'$ACTOR');
INSERT INTO billing.ledger_entries (id,tenant_id,branch_id,order_id,invoice_id,entry_kind,capture_kind,method_code,amount_paisa,reverses_entry_id,reason_code,fiscal_year_bs,business_date,collected_by_membership_id,created_by) VALUES
  $(led "$TA" '00000000-a5a5-4000-8000-000000000002' reversal -11300 "'$A_PAY1'" "$A_ORD1" "$A_INV1"),
  $(led "$TA" "$A_PAY1" payment 11300 NULL "$A_ORD1" "$A_INV1"),
  $(led "$TA" 'a5a5a5a5-0000-4000-8000-000000000003' payment 2000 NULL "$A_ORD2" "$A_INV2"),
  $(led "$TB" 'b5b5b5b5-0000-4000-8000-000000000001' payment 11300 NULL "$B_ORD1" "$B_INV1");
SQL

# per-table fingerprint of a schema: "<table>|<tenant>|<count>|<md5>" for every billing table with a tenant_id column
FP() { # $1 schema  $2 database
SUD "$2" <<SQL
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
FP billing "$DB" > "$WORK/src_all.txt"
for t in settings fiscal_counters credit_accounts payment_intent_refs invoices invoice_lines credit_notes credit_note_lines ledger_entries; do
  grep -q "^$t|$TA|" "$WORK/src_all.txt" || { echo "FAIL: seed has no tenant-A rows in billing.$t"; exit 1; }
  grep -q "^$t|$TB|" "$WORK/src_all.txt" || { echo "FAIL: seed has no tenant-B rows in billing.$t (vacuous test)"; exit 1; }
done

# --- export A with the tool (host psql, DATABASE_URL, --out) ---
DATABASE_URL="$URL" node db/tools/export-tenant-billing.ts --tenant "$TA" --out "$WORK/export_a.sql" || { echo "FAIL: tool exited $?"; exit 1; }
[ -s "$WORK/export_a.sql" ] || { echo "FAIL: empty export"; exit 1; }
if grep -qiE "$TB|B-SECRET" "$WORK/export_a.sql"; then echo "FAIL: tenant B data present in tenant A export"; exit 1; fi
grep -qi "$TA" "$WORK/export_a.sql" || { echo "FAIL: export does not mention tenant A"; exit 1; }

# source untouched by the export (read-only)
FP billing "$DB" > "$WORK/src_after.txt"
cmp -s "$WORK/src_all.txt" "$WORK/src_after.txt" || { echo "FAIL: export changed the source billing data"; exit 1; }

# no silent data loss: billing tables are FORCE RLS; a role without BYPASSRLS must get an ERROR (row_security=off), never a quietly short export with exit 0.
RPW="$(PW)"
SU -c "CREATE ROLE t0b11_reader LOGIN PASSWORD '$RPW'; GRANT CONNECT ON DATABASE $DB TO t0b11_reader; GRANT USAGE ON SCHEMA billing TO t0b11_reader; GRANT SELECT ON ALL TABLES IN SCHEMA billing TO t0b11_reader"
if DATABASE_URL="postgres://t0b11_reader:$RPW@127.0.0.1:$PORT/$DB" node db/tools/export-tenant-billing.ts --tenant "$TA" --out "$WORK/export_reader.sql" 2>"$WORK/reader.err"; then
  cmp -s "$WORK/export_a.sql" "$WORK/export_reader.sql" || { echo "FAIL: exit 0 but the export is short for a role under RLS (silent data loss)"; exit 1; }
else
  grep -qiE "row-level security|row_security" "$WORK/reader.err" || { echo "FAIL: non-zero exit for an RLS-restricted role, but not for the RLS reason:"; cat "$WORK/reader.err"; exit 1; }
fi

# --- restore into the EMPTY, really-migrated billing schema ($RDB: constraints, FKs, triggers present) ---
for t in invoices invoice_lines credit_notes credit_note_lines ledger_entries settings; do
  [ "$(SUD "$RDB" -c "SELECT count(*) FROM billing.$t")" = "0" ] || { echo "FAIL: restore target billing.$t not empty"; exit 1; }
done
[ "$(SUD "$RDB" -c "SELECT count(*) FROM pg_constraint c JOIN pg_class r ON r.oid = c.conrelid JOIN pg_namespace n ON n.oid = r.relnamespace WHERE n.nspname = 'billing' AND c.contype = 'f' AND c.confrelid = r.oid")" -ge 1 ] \
  || { echo "FAIL: restore target lacks the real billing FKs (not the migrated DDL)"; exit 1; }
# applied exactly as documented: one transaction, stop on error; NO harness-side session_replication_role or trigger tweaks (the script must cope itself)
psql "$RURL" -X -q -1 -v ON_ERROR_STOP=1 -f "$WORK/export_a.sql" || { echo "FAIL: restore of the export into the migrated empty billing schema failed"; exit 1; }

# --- assertions ---
FP billing "$RDB" > "$WORK/restored.txt"
grep -v "|$TA|" "$WORK/restored.txt" > "$WORK/restored_foreign.txt" || true
[ ! -s "$WORK/restored_foreign.txt" ] || { echo "FAIL: restored schema holds non-A rows:"; cat "$WORK/restored_foreign.txt"; exit 1; }
grep "|$TA|" "$WORK/src_all.txt" > "$WORK/src_a.txt"
if ! diff -u "$WORK/src_a.txt" "$WORK/restored.txt"; then echo "FAIL: row counts / checksums of tenant A differ between source and restore"; exit 1; fi
echo "ok - AC-0B-6.4: $(wc -l < "$WORK/restored.txt") tenant-A table fingerprints match after restore into a migrated empty billing schema, no other tenant's row restored, source unchanged"
