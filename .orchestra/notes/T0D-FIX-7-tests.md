# T0D-FIX-7 tests (tester)
- New: `services/api/src/modules/payments/__tests__/contract/fix7.list-array-query.test.ts` (37 tests, staff + refund harnesses, no new helper).
- Run: `pnpm --dir services/api exec vitest run src/modules/payments/__tests__/contract/fix7.list-array-query.test.ts`; one-liner in `T0D-FIX-7-verify.cmd` (also runs the existing staff.http, staff.contract, refund.service tests).
- Now: 13 fail, 24 pass. Failing = every array filter answers 400 (csv() in handlers/intents.ts:106 takes strings only), the exact reconciliation query, dedupe, empty page, tenant B. Passing guards = comma strings, bad/empty/non-string input, forbidden, refunds list.
- Audit (payments.yaml): array+form+explode:false only on listPaymentIntents status/gateway and listPaymentRefunds status/gateway. Refunds already accept both (guard test added). hold_reason and kind are declared comma strings; csv() should take an array for hold_reason too (tested).
- Web: read.server.ts and the reconciliation page send `status=held_for_review` (comma wire form = contract). Web query is right, no web test added.
- Limit semantics kept: 20 items counted after dedupe; empty string or empty array = 400.
- Writer: fix csv() only. Other modules with the same string-only pattern go to `.orchestra/notes/T0D-FIX-7-left.md`, not edited (known candidate to check: payments reconciliation.service.ts:190 `kind` is a string by contract, so fine).
