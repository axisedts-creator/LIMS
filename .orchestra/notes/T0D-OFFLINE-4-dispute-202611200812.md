# T0D-OFFLINE-4 dispute (writer)
Implementation is in the working tree; 57 of 58 offline4 tests pass. Two items block a green verify.cmd and are not fixable on the writer side.

1. TEST WRONG: offline4.flows.test.ts:123 `env.cash({ requiresStepUp: () => true })`. The fixture is `cash(permissions = P_ENTER, extra = {})`, so the options object lands in
   `permissions` and createCashFlows throws `TypeError: o.permissions.includes is not a function`. tsc confirms it: `TS2353 'requiresStepUp' does not exist in type 'readonly string[]'`.
   Fix (tester): `env.cash(P_ENTER, { requiresStepUp: () => true })`. Also offline4.flows.test.ts:149 fails tsc (TS2345: the callback types `code?: string`, but ConflictItem.code is
   `string | undefined` under exactOptionalPropertyTypes). Fix: type it `code?: string | undefined` or drop the annotation. The behaviour is implemented (cashflows.ts requiresStepUp, fails closed).
2. TESTS CONFLICT (lead): offline1.static "shell JavaScript grows by at most 25 KB gzipped" now measures 29.4 KB. At HEAD it was already 24.92 KB (0.08 KB headroom); the two modules
   offline4.static requires under core/offline (labflows.ts 3.8 KB, cashflows.ts 1.2 KB gzip of raw source with comments) cannot fit. The measure counts comments and the lab/cash code,
   which is loaded only through the dynamic import of controller.ts, not the shell bundle. Ask: raise the cap (32 KB suggested) or measure the minified bundle. Moving the logic outside
   core/offline behind a re-export only to pass the measure would hide the size, so I did not do it.
Unrelated, seen while running verify.cmd: verlevel1.settings "lab.config.manage alone does NOT make the policy editable" fails (no radio "level 2"); LabSettingsPage imports none of
the files this task changed. Not checked against HEAD (the sandbox refused the temporary checkout).
