CR_NEEDED — the disputed test (registry-sync.all.test.ts, sync with LIMS_PAYMENTS_* unset) is correct per done_when (5) and LD-282, but the brief's own scope (files list, done_when (1) "syncAllManifests unchanged", (6) "no change to other worker code") makes it unpassable; the fix is in C15-owned code.

Reasons:
- Verified: registry-sync.ts:37 syncAllManifests imports ../manifests.js, which loads services/worker/src/jobs/payments/index.ts; index.ts:15 runs `export const config = loadPaymentsConfig()` at import. No CLI-only change can affect an in-process call to syncAllManifests.
- Spec does NOT require import-time failure: spec/chunks/C15-payment-gateways/02-TRD.md:527-529 "§9.3 Boot checks (API and worker) — Fail boot if ..."; :69 "validated at boot". registry-sync is a deploy-time sync, not worker boot, so a sync that skips the check is spec-conformant.
- jobs/payments/__tests__/unit/manifest.test.ts:80-103 assert "import throws", which is stricter than TRD §9.3 (boot). It must become "worker start throws" if the check moves.
- Owner: worker `payments` → C15 (spec/program/01-CHUNK-MAP.md:73, :154). C0-0B may not edit it (CLAUDE.md, edit only owned paths).
- Option C (placeholders in CLI) is the workaround LD-282 rejects. Option A adds a sync-only flag the spec never names. Option B (move loadPaymentsConfig to worker start) matches TRD §9.3 text and needs no spec wording change.
- CR text: .orchestra/cr/T0B-ASYNC-3.md (to C15, proposes B). Until accepted: writer may land done_when (1)-(4) and the static test; (5) stays open, the .all test stays failing (do not stub or weaken it).
