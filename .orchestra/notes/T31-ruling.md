TESTS_WRONG — the two cases assert lifetimes against the test's private virtual clock but give the handler no way to read it.
Cases: session-kinds.login.test.ts:111 (12 h) and :121 (8 h via LIMS_IDENTITY_MOBILE_ABSOLUTE_HOURS).
1. The spec requires only the lifetime: staff_mobile absolute = LIMS_IDENTITY_MOBILE_ABSOLUTE_HOURS (default 12), idle_timeout_minutes = that × 60
   (spec/chunks/C2-identity-admin/02-TRD.md:579; 05-SCHEMA.md:93). It says nothing about which clock a test injects; the expected values 12 h / 8 h / 480 are correct and stay.
2. Harness defect: loginRunner (kinds.helpers.ts:50) keeps only `tx` from w.makeCtx() and drops ctx.now (auth.helpers.ts:157); hctx (kinds.helpers.ts:45-47) has no `now`;
   mobileWorld deps (session-kinds.login.test.ts:18) = T6 deps with no clock (kinds.helpers.ts:6 lists none). So the handler can only read wall time, and no conforming implementation can pass.
TESTER, change only the test side:
 - session-kinds.login.test.ts:18 mobileWorld: add `now: () => new Date(w.clock.ms)` to `deps` (same as AppDeps.now at kinds.helpers.ts:144).
 - kinds.helpers.ts:6 header: add `now?` to the listed AuthDeps seams (the writer's AuthDeps.now, default new Date()).
Do not change any expected value. Writer: keep AuthDeps.now; then rerun the suite and show 101/101.
