CHANGES
1. services/api/src/modules/lab/events/__tests__/publish.test.ts:421-434 is red on this branch: `npx vitest run src/modules/lab/events` gives 1 failed, "expected types toHaveLength(7)". lab/index.ts:16 now produces 8 events (adds lab.result.signed_off.v1). Ruling item 4 (T0B-VERLEVEL-1-ruling.md) was never applied. Fix (tester path): change the title "(7)" to "(8)", add a `resultSignedOff(ctx, <valid payload with result_id, result_version_no, order_id, test_id, department_id, seq, action, signoff_count, signoff_required, is_final, signer_user_id, signer_is_pathologist, signed_at>, { resultRowVersion: 1 })` call next to the other 7 publisher calls, and use `toHaveLength(8)`. Keep the `toEqual([...manifest.produces].sort())` line as it is. The impl note (T0B-VERLEVEL-1-impl.md:25) says "0 failed" for the whole lab suite. That is wrong: its runs covered lab/__tests__ only, and events/__tests__ is part of the lab module suite that done_when (12) requires to be green.
2. Contract gap. service/result.service.ts:288 (planVerifySignoff) runs criticalGate when a verify is the final sign-off (policy with require_pathologist false). That makes verifyResult (lab.yaml:2836-2854) and bulkVerifyResults (lab.yaml:2972-2995) able to return `lab.critical_ack_required`, but neither lists it in x-error-codes (approveResult does, at lab.yaml:3290). Keeping the gate is correct: done_when (7) says the critical gate is unchanged, and AC-13.5 applies at approval. Fix: write `.orchestra/cr/T0B-VERLEVEL-1.md` (template in spec/program/04-CHANGE-REQUESTS.md) asking C0-0C to add `lab.critical_ack_required` to the x-error-codes of verifyResult and bulkVerifyResults. Do not remove the gate in code.

Checked, no defect found:
- Names match lab.yaml (operations, error codes, ResultDto signoff_count / signoff_required / next_step enum, ResultSignoff fields).
- Every SQL statement in signoff.store and worklist.store filters tenant_id = $1, and `ANY($2::uuid[])` has the cast.
- RLS, grants and append-only rules come from the T0C migration; the probes (kit.ts:360, tables.live, crossTenant.live, registry.static) cover both new tables.
- Permissions go through the existing x-permission gate; getResultSignoffs re-checks the centre and returns 404.
- The If-Match / 428 / 409 flow matches the contract; level validation is 1-3; the target must exist in the tenant.
- No PHI in the event payload or the refusal audit detail; no secrets.
- Seed 005 codes are verbatim from C5 05-SCHEMA §2:53-56.
- The amend guard refuses the module-only codes; amend resets the counter and keeps the old chain.
- tsc not re-run by the reviewer.
- 22 handler/critical.service unit failures exist but are not from this diff: they come from the T-32 P-10 gate in handlers/index.ts, and the ruling routes them to the debugger.
- boot.test fails outside the pg.sh environment only for the missing LIMS_ENGAGEMENT_OTP_HMAC_KEY_FILE (environmental).
