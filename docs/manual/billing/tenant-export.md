# Billing per-tenant export and restore (runbook)

Task `billing.export_tenant` (TRD §13; manual, not on the crontab, maxAttempts 1). Platform operators run it only from C2's audited support session, under the claims of the one tenant being exported.

## Export
1. Set `LIMS_BILLING_EXPORT_KEY` (base64 of 32 random bytes) in the worker environment. Keep the key apart from the archive.
2. Enqueue `billing.export_tenant` with payload `{"tenant_id": "<uuid>"}` under that tenant's claims. A payload tenant that differs from the claims tenant is ignored (nothing read, nothing stored).
3. The task reads every `billing` table with a `tenant_id` column in FK order (parents first), rows ordered by primary key, and stores ONE object in bucket `billing-exports` at `<tenant_id>/tenant-export/<timestamp>-<rand>.lbx`.
4. Archive = AES-256-GCM encrypted JSON. The **manifest** lists, per table: `table`, `row_count`, `sha256` (SHA-256 of the table's rows, one JSON row per line, primary-key order). Opening the archive (`openArchive(bytes, key)`) fails on a wrong key, any modified byte, or a manifest that does not match the rows.

## Restore
1. Create an empty database with the same DDL (all migrations applied; billing tables empty for this tenant).
2. Decrypt with `openArchive`, then load each table of the manifest in manifest order as a superuser (or role allowed `SET session_replication_role = replica`): generated columns are left to the target; `INSERT INTO billing.<t> (<cols>) SELECT <cols> FROM jsonb_populate_record(NULL::billing.<t>, <row>)`.
3. Verify: per-table row count and checksum equal the manifest; no row of another tenant exists in the target.
4. Run `billing.integrity_check` for the tenant: it must report zero violations.
5. Continuation is gapless: `billing.fiscal_counters.last_no` is restored with the invoices, so the next invoice number is `last_no + 1` in the same series and fiscal year.

The SQL-script alternative `db/tools/export-tenant-billing.ts` produces an unencrypted data-only script; use it only inside a trusted operator session.
