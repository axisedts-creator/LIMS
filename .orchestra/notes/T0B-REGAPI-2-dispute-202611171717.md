# T0B-REGAPI-2 dispute (writer pass 4, after ruling 16:59)
TEST: billing/__tests__/preview/previewInvoiceNo.test.ts:108-115 "tenant isolation".
FAILS WITH: `new row violates row-level security policy for table "audit_log"` at line 110 (the fixture INSERT, before any product code runs).
CAUSE (fixture): `superTx(fn)` defaults `claimsTenant = TENANT_A` (frontdesk/__tests__/integration/helpers.ts:69); the INSERT writes a TENANT_B row into billing.fiscal_counters, so the audit trigger writes an audit_log row for tenant B under tenant A claims and RLS correctly refuses it. Product cannot change this (audit RLS is the tenant guard).
FIX: line 109-111 pass the tenant: `superTx(async (tx) => tx.query(...), TENANT_B)` (the same pattern accounts/helpers.ts:115 uses). Assertions unchanged.
Everything else is green: preview 8/9; frontdesk PG17 suite 1674/1676 with only boot.test 60 s timeouts under load; boot.test alone 30/30 (169 s).
