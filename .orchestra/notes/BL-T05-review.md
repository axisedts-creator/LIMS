APPROVE

# BL-T05 review (reviewer)
Range: 9863d01..HEAD (81c3e2f tests, a8d012e impl).

Checked:
- done_when: rates taken only from each line's `tax` and echoed on ComputedLine (snapshot; exempt -> no vatRateBp); `catalog.tax_config_missing` thrown when a taxable line lacks vatRateBp or otherTaxCode lacks otherTaxRateBp (US-BL-14.3, 08 R18); `baseFingerprint` = fingerprint of same lines with no discounts; B32 refuses `invoice_series_scope = branch` without `{branch}` in `TenantSettings.numbering.invoiceNoPattern` and scope switch after first invoice of the B.S. FY -> `400 common.validation_failed` path `/invoice_series_scope` (US-BL-01.5, 08 A13 D-23, TRD B32 row). Missing IdentityPort -> refused (fail closed).
- Names: B32/B34 operationIds, `billing.settings` columns, `billing.{cs,g_cs}_payment_methods`, `billing.{cs,g_cs}_reasons`, set names (TRD B34 row), `fiscal_year_bs` 'YYYY/YY' format all match spec/migration. No invented error codes (`common.version_conflict`, `common.precondition_required`, `common.validation_failed`, `catalog.tax_config_missing`).
- Tenant isolation: every statement binds `tenant_id = $1` (REQ-SEC-024) on top of existing RLS ENABLE+FORCE policies (no DDL in this task); global g_cs_* tables are RLS-exempt class G. tenant/actor from ctx only.
- Permissions/idempotency/rate tier: enforced by core pipeline from billing.yaml (`billing.settings.manage`, x-idempotency optional, tier general; B34 `billing.invoice.read`). If-Match -> 428/400; ETag returned.
- No logging, no PHI, no secrets. Error details are fixed text.
- Paths: all under services/api/src/modules/billing/** (C4-owned) + own notes.
- Ran: `vitest run src/modules/billing` -> 16 files passed / 413 tests (20 skipped, pre-existing).

Non-blocking notes (not defects for this task):
1. `tsc --noEmit -p services/api`: quote.service.ts imports contracts/ports/BillingCommandPort.ts, adding 2 TS2835 errors (extensionless imports in contracts/, not C4-owned). tsc was already red at base (common.ts/IdentityPort.ts, same cause), so gate status unchanged; writer's "tsc clean" claim is inaccurate. Fix belongs in contracts (CR) or a local type copy as instruments/drivers/types.ts does.
2. FY scope-switch check is read-then-update with no row lock (writer noted). At issue time D-23(3) still guards the pattern; consider `SELECT ... FOR UPDATE` on billing.settings in BL-T06/T04 issue path.
3. No live-DB test of the new repo SQL / RLS (writer and tester both noted).
