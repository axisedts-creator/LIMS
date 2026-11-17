```
Title: CR-C0-T0B-ASYNC-3-001: move worker payments config validation from module import to worker boot
From chunk: C0 (C0-0B)     To owner: C15
Type: bug
Blocking? yes — C0 06-IMPLEMENTATION-PLAN T0B-ASYNC-3 done_when (5) (LD-282): registry-sync must run with no LIMS_PAYMENTS_* variables set.
Problem (what you cannot do today, with the user story / acceptance criterion it serves):
  services/worker/src/jobs/payments/index.ts:15 runs `export const config = loadPaymentsConfig()` at import. syncAllManifests
  (services/worker/src/core/registry-sync.ts) imports every manifest to read task identifiers only, so the deploy-time
  registry sync fails with "payments config: LIMS_PAYMENTS_PUBLIC_BASE_URL is required" (founder run 2026-11-16 19:17, LD-282).
  C15 TRD §9.3 (02-TRD.md:527-529) requires failing BOOT of the API and worker, not failing at import; the registry sync is not boot.
Proposed change (exact):
  - jobs/payments/index.ts: no loadPaymentsConfig() call at import. Validate lazily (e.g. `export function config()` memoised)
    and call it from the worker boot path so startWorker still fails before taking jobs when §9.3 checks fail.
    The boot hook location (main.ts / startWorker) is owned by C0-0B; C15 states the call it needs, C0-0B wires it.
  - Task handlers read config through the lazy accessor (first run validates, same errors).
  - jobs/payments/__tests__/unit/manifest.test.ts:80-103 "boot fails per TRD §9.3 in the worker too": assert worker boot
    (or the accessor) throws with the same key names instead of "import throws"; add one case "import succeeds with no LIMS_PAYMENTS_*".
Backward compatible? yes — same validations, same error messages; only the moment changes from import to boot. API side unchanged.
Tenant/security impact: no RLS change, no PHI field, no new public surface. Worker still refuses to start on bad KEK/URLs (TRD §9.3).
IRD/regulatory impact (billing changes only): none.
Alternatives considered:
  A. sync-only flag honoured by payments/index.ts — new name not in spec; rejected.
  C. placeholder LIMS_PAYMENTS_* values in the CLI — the workaround LD-282 rejects.
Tests that will prove it:
  - services/worker/src/core/__tests__/registry-sync.all.test.ts passes with every LIMS_PAYMENTS_* unset.
  - updated manifest.test.ts boot cases pass; worker boot with a missing KEK file still throws naming LIMS_PAYMENTS_KEK_FILE.
```
