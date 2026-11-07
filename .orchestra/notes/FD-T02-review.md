APPROVE
Re-review after fixes (852c6a3, e24398b). Both earlier items are resolved:
1. discountApproval.state.ts:37 now returns `common.immutable_record` for "not pending/expired" (02-TRD.md:211, F18/F19).
2. discountApproval.state.test.ts:60-65 now asserts `toEqual({ ok: false, code: 'common.immutable_record' })` for the already-%s and expired-by-clock cases.
The rest is unchanged from the first review: transition tables match 03-APP-FLOW §1.1/§1.3/§1.4, including the forbidden examples. Only owned paths changed. No PHI or secrets. RLS, idempotency and rate tier do not apply (pure domain).
vitest src/modules/frontdesk/domain/__tests__: 6 files, 232 tests pass.
