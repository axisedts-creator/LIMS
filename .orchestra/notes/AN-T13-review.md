CHANGES

1. services/api/src/modules/analytics/__tests__/boot.test.ts:43 — the analytics suite is red: the AN-T01 stub tests fail because the tester-owned `IMPLEMENTED` list does not include the two operations AN-T13 now implements. Fix (tester): after line 43 (`'getTatReport', // AN-T12`), add `'getPendingTestsSummary', 'listPendingTests', // AN-T13`. Then re-run `pnpm --dir services/api exec vitest run src/modules/analytics --no-file-parallelism`; it must be 0 failed.

Checked, no defect found:
- Names match TRD §5 #11/#12, §5.1 PendingSummary/PendingItemDto, and contracts/openapi/analytics.yaml (operationIds, enums, age buckets, `open_route_id` enum, `common.invalid_cursor`, `common.dependency_unavailable`).
- D-49: live reads run in ctx.tx, so C5 RLS applies. No implicit centre predicate; `centre_id = ANY` is sent only for an explicit centre_id/branch_id filter, already resolved against the caller's scope. D-13 hub case is covered by tests.
- Backlog uses the standard scope predicate (§6.7). Parameters are bound, nothing from input goes into the SQL text, and the cursor is validated (rejected with 400, input never echoed).
- authorise runs first. `open_route_id` is gated on getActor holding `lab.result.read`. Rate tier and idempotency come from the contract. No patient identifiers and no logs added. Only owned paths changed.
- freshness [CONV] is consistent with earlier DTOs (freshness service pending).
- Runs: AN-T13 files pass. Full analytics run serially: 1244 pass, 2 fail (boot.test only). The parallel run had 10 extra 5 s timeouts, all load-related; they pass serially.
- Not verifiable here: real-DB RLS on lab.v_pub_pending_items and a real 57014 timeout (needs a live DB).
