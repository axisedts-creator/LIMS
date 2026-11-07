Files: services/api/src/modules/billing/{index,permissions,config}.ts, handlers/index.ts (stubs -> common.service_unavailable, like FD-T01), services/worker/src/jobs/billing/index.ts, apps/web/src/features/billing/nav.manifest.ts.
[CONV] exports `manifest` (api, worker) / `navManifest` (web) per 02-CONV §2.2/2.3; config reads only LIMS_BILLING_* keys.
Run (vitest, revised tests): 15/16 pass. FAIL: boot test — core ajv strict mode rejects `x-coded-set` in billing.yaml body schemas
  ("strict mode: unknown keyword: \"x-coded-set\"", POST /v1/billing/invoices/:invoice_id/cancel).
Cause is in C0-0D-owned services/api/src/core/openapi.ts, not billing or the test. BLOCKED: CR filed at .orchestra/cr/BL-T01.md.
Open: re-run boot test after CR lands; no billing code change expected.
