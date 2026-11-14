# RS-C2 dispute (debugger, 2026-11-14)
Test: apps/web/src/features/admin/__tests__/rs-c2.static.test.ts:121 "data, action, validation-table and nav files are untouched" fails; baseline rs-c2.baseline.json holds an old sha256 for features/admin/auth/actions.ts.
Cause is not the restyle: commit 62f59645 [writer] T0D-DEP-02 impl (LD-174, merged from main via 1cdbced0) replaced the inline LIMS_WEB_BFF_KEY_FILE read with readBffKey() from @/core/session/bff-key. Zero RS-C2 edits to that file. Reverting it would break T0D-DEP-02.
Spec: LD-140 "no change to API calls, fields, validation, permissions or routes" is kept (same BFF key, same header); the test's "byte-identical" rule is stricter than the spec and predates LD-174.
Needed (tester): re-record the baseline once (RS_C2_RECORD=1) or drop auth/actions.ts from DATA_FILES. I may not edit tests or the baseline.
Also: rs-c2.screens.test.tsx again hit "Failed to start forks worker ... Timeout waiting for worker to respond" (host, not code); LD-177 gives no further reset.
