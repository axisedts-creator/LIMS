# T0B-ASYNC-3 dispute (writer)

Conflict: done_when (5) cannot pass inside the brief's limits (1) and (6), and the payments chunk's own tests rule out the obvious fix.

- The edited `registry-sync.all.test.ts` calls `syncAllManifests` in-process with every LIMS_PAYMENTS_* unset. `syncAllManifests` must stay unchanged (done_when 1). It imports `../manifests.js`. That file imports `jobs/payments/index.ts`, and that module runs `export const config = loadPaymentsConfig()` at import.
  Result (run 2026-11-16): 5/9 fail with `payments config: LIMS_PAYMENTS_PUBLIC_BASE_URL is required`.
- Only the CLI block may change, so the CLI block cannot fix an in-process call to `syncAllManifests`.
- Making payments config lazy would mean editing `jobs/payments/index.ts`, which is outside the file list and breaks (6) "no change to other worker code". It also breaks `jobs/payments/__tests__/unit/manifest.test.ts` "boot fails per TRD §9.3 in the worker too", which needs the import to throw. The async-manifests runbook test also says the worker refuses to start without those variables.
- Other import-time checks: a grep finds only payments (`instruments/configs.ts` reads its key lazily, at task run).

Lead needs to choose one:
 A. Let `syncAllManifests` (or `manifests.ts`) skip the import-time check at sync time, for example with a sync-only flag that payments/index.ts honours. This needs payments-chunk ownership and a TRD §9.3 wording change, because the worker still fails boot but sync does not.
 B. Move payments `loadPaymentsConfig` from import to worker start (`main.ts`/`startWorker`). This needs a payments-owner change and updates to manifest.test.ts and the boot tests.
 C. Keep the `.all` test's payments stub (revert that test edit). The CLI-only part of (5) stays failing unless the CLI sets inert placeholders, and that is the same workaround LD-282 rejects.
The writer recommends B: the boot check stays at worker start, and the registry sync, which reads only identifiers, never triggers it.
Nothing is implemented yet (parts 1–4 are blocked on this choice, because (5) shapes the CLI block).
