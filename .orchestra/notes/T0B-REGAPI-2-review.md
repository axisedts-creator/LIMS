APPROVE
Scope: `git diff 30ae663ff..HEAD` = one test-fixture line (billing/__tests__/preview/previewInvoiceNo.test.ts:111) plus notes/CR renames.
- Fix matches arbiter ruling 5f6be6a7a exactly: fixture insert of the TENANT_B counter now runs with TENANT_B claims (`superTx(..., TENANT_B)`; superTx re-exported from frontdesk/__tests__/integration/helpers.ts:69, second arg = claimsTenant). Assertions 112-115 unchanged; nothing loosened, skipped or deleted.
- Audit RLS (FORCE, INSERT policy tenant_id = app.current_tenant_id()) left intact; tenant isolation intent of LD-323 (e) kept.
- No product code, migration, contract, permission, route, error code or spec change in range; no PHI, no secrets; only owned paths (billing tests, .orchestra notes).
- Reviewer ran `bash tests/billing/T0B-REGAPI-2.pg.sh` (throwaway PG17): 1 file, 9/9 passed.
- Not a code defect, noted for the lead: debugger rounds 1-2 report the whole frontdesk verify failing only on unit/boot.test.ts 60 s timeout under host load (65 workers); boot.test.ts alone 30/30. done_when (12) three green runs in a row still needs an idle-host rerun or a lead decision on a verify-side worker cap.
