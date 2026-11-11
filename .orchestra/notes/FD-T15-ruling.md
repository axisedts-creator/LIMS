TESTS_WRONG — boot.test.ts:148-171 assert a non-empty stub inventory; the spec only requires stubs "until their task merges", so an empty inventory after FD-T15 is the required end state.
Reasons:
- spec/chunks/C4-frontdesk-billing/06-IMPLEMENTATION-PLAN.md:11 — stubs throw `common.service_unavailable` only "until their task merges"; no row requires a stub to exist.
- 06-IMPLEMENTATION-PLAN.md:25 — FD-T15 implements the last handler ops (F7, F24, F25, F26); rows :26-28 (FD-T16..T18) add probes/help/perf, not handlers. So `probes/pending.json` = `[]` is correct (LD-70, writer-owned; verified `[]` in HEAD).
- Same reasoning as prior ruling FD-T04-ruling.md (TESTS_WRONG) cited in boot.test.ts:134.
What the TESTER changes (boot.test.ts only):
1. :148-159 — drop the `toBeGreaterThan(0)` assertion at :152; keep the loop (it is vacuous when `stubOps()` is `[]`). Keep the fallback when pending.json is absent.
2. :161-171 — if `stubOps()` is empty, return early (no stub to echo-test); otherwise unchanged.
3. :173-178 — not in dispute and unchanged: every real handler must still reject `params: {}`/`body: undefined`; it stays a binding check on the implementation.
Out of scope: the 60s timeouts in :93-120 are not a stub issue; this ruling makes no finding on them.
