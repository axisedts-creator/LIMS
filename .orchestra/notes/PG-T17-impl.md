# PG-T17 impl (writer)
Files: api `modules/payments/service/merchant.service.ts` (createMerchantService: P20–P23), worker `jobs/payments/tasks/rewrap_credentials.ts` (REWRAP_CREDENTIALS, createRewrapCredentials). No test files touched.
Tests: api merchant.service + contract + merchantDb 95/95 (after review fix: settings.change diff compares int8 threshold numerically); worker rewrap 9/9; tsc clean for both files.
[CONV] errors use LimsError + FieldError sub-code common.field_invalid (fixed messages, never echo values); uuidv7 via relative import (as catalog); settings.change detail = {fields: "a,b"} (core access() takes scalars only); entityId omitted for payment_settings.
[CONV] settings PUT is full replace (all 3 fields required); account PUT omitted optional fields/secret = unchanged. Concurrent first insert (23505 / ON CONFLICT no-op) -> 409/428, never 500.
[CONV] Khalti test with no secret stored -> 200 auth_failed (no key to present); redirects never followed; probe bounded by httpTimeoutInrequestMs; decrypt failure on test -> generic Error (500), not a 200 outcome.
Open: not wired — handlers/index.ts routes, worker manifest/cron.ts registration (belongs to wiring/cron tasks); LD-26 training-tenant sandbox-only rule not enforced (no tenant flag in spec/tests); rewrap skips unreadable rows silently (alerting is the cron task's).
