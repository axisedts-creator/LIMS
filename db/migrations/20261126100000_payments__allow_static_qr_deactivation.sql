-- CR-C0-T0B-GREEN-1-002 option (b) (.orchestra/cr/T0B-GREEN-1.payments-static-qr-generated-column.nonblocking.md).
-- payments.static_qr_reconciliations has a STORED generated column (difference_paisa). In a BEFORE UPDATE row trigger NEW does not carry
-- the generated value yet, so app.enforce_mutable_columns saw it as changed and refused every UPDATE with immutable_row: is_active could
-- never change (C15 05-SCHEMA: "the only non-audit column"). difference_paisa joins the trigger's argument list. Nothing becomes writable:
-- Postgres refuses any direct write to a generated column, and its two inputs (statement_total_paisa, system_total_paisa) stay immutable.
-- Idempotent: CREATE OR REPLACE TRIGGER.
-- DOWN (manual): re-run the 20261115150000 static_qr__mutable_columns trigger text.
SET LOCAL ROLE lims_owner;

CREATE OR REPLACE TRIGGER static_qr__mutable_columns BEFORE UPDATE ON payments.static_qr_reconciliations FOR EACH ROW
  EXECUTE FUNCTION app.enforce_mutable_columns('is_active','updated_at','updated_by','version','difference_paisa');
