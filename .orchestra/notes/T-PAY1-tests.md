# T-PAY1 tests (tester)
- API E41/E42: `services/api/src/modules/engagement/service/__tests__/payment.handlers.test.ts` (29 tests; 26 fail now: handlers are the T-01 placeholder `common.service_unavailable`, 3 contract tests pass).
- Worker: `services/worker/src/jobs/engagement/__tests__/payment.tasks.test.ts` (create_payment_intent, refresh_payment_request, expire_payment_requests cron, e2e with the C15 `PaymentProviderPort` fake; fails: stubs "not implemented", no cron row).
- App A15: `apps/patient_app/test/features/payments/{a15_pay_due,a15_result,payments_source_rules}_test.dart` + `test/support/payments_fakes.dart` (IMPL CONTRACT in its header: `PatientPaymentsApi`, `patientPaymentsApiProvider`, `paymentUrlOpenerProvider`, `PayDueScreen`, `PaymentResultScreen`). Not run: Flutter suite fails to compile until lib/features/payments exists.
- Extended `__tests__/link.world.ts` with a `payment_requests` table (CHECKs, one open request per order, PAT_ACC / PAT_ACC_PID).
- Run: `.orchestra\notes\T-PAY1-verify.cmd`
- ASSUMPTIONS (spec silent, flag if wrong): "last checked" for E42's refresh enqueue = `payment_requests.updated_at` (>= 3 s; table has no other column); portal origin = env `LIMS_ORIGIN_PORTAL` (as the C6 task); stored `action_json` is `{kind, url}` (eSewa: url = launchUrl); non-`payments.*` createIntent/getIntent errors reject for retry; getIntent `common.not_found` -> expired; "Try again" returns to the choice view.
- NOT covered: real Postgres RLS, core Idempotency-Key replay, 426 guard, exact +30 min boundary, payment_completed notification (T-N1).
