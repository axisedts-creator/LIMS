APPROVE

Scope: diff 2109ee577..HEAD touches services/api/src/modules/payments/handlers/intents.ts (csv helper only), one new test file, and .orchestra/notes. No migration, no contract edit, no new permission, no web change. All paths are owned.

Against done_when:
1. csv() accepts a comma string or an array of strings. Anything else (a number, null, nested array, object) answers invalid(). The same allowed lists, the 20 item limit after dedupe, and duplicate removal still apply. An empty array is now invalid. An empty string still fails the allowed check. Nothing else in the handler changed. The LD-455 comment is present.
2. Audit: payments.yaml has 4 parameters declared array + form + explode false (intents status/gateway, refunds status/gateway). listPaymentRefunds already accepts both forms, and the test proves it. Modules outside payments are listed in T0D-FIX-7-left.md and were not edited. inventory lots.schemas.ts:18 csvOf() is flagged as the same fault (see T0D-FIX-9).
3. Tests cover: one item and multi item arrays, a comma string, gateway, hold_reason, the bad value cases (400 common.validation_failed, no SQL built from them), an empty page (200 with empty data), forbidden (auth.forbidden, no reads), other tenant, and the exact reconciliation query (status=held_for_review&limit=50&sort=-created_at).

Checks run by reviewer:
- The verify command's 4 files (fix7, staff.http, staff.contract, refund.service): 322/322 pass.
- The full src/modules/payments suite: 201 failures, all in merchant.service, staticqr.service, reconciliation.service and unit/manifest. None of those test files call the listPaymentIntents handler or csv(), and the diff does not touch them. They are not caused by this task. I did not re-run them at the base commit. They look already broken; track them separately and do not block this task on them.
- Web tests were not run (no web change).

No PHI, no secrets, no invented names.
