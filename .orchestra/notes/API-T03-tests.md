# API-T03 tests
- File (vitest): `services/api/src/modules/instruments/__tests__/unit/device-credentials.test.ts` — formats, resolver, kind gate (AC-01.6/AB4), 401 uniformity (AC-01.5), two agents (AC-01.7), touch throttle, failures metric, probes. Run: `.orchestra\notes\API-T03-verify.cmd`.
- Header comment fixes the expected API of `auth/deviceTokenResolver.ts` (classifyCredential, createDeviceTokenResolver({metrics}), manifest.authResolvers.deviceToken) and `service/credentials.service.ts` (generateDeviceToken/EnrolmentCode, hashCredential, requireCredentialKind, touchCredential).
- Failures must reach the core registry as `AuthError auth.device_token_invalid` (401): the resolver returns `{ error: 'auth.device_token_invalid' }`; bare `undefined` would give `auth.unauthenticated`.
- `lims_instruments_device_auth_failures_total` is missing from core `metrics.ts` DEFS (createMetrics would throw): tests inject a sink; writer needs a CR for the core metric table.
- Touch runs on the request tx via `touchCredential` (SQL-throttled UPDATE); resolver itself only does one SELECT (no tenant yet, no write).
- No real-DB integration (no Postgres in this lane); DEFINER function is faked by sha256 lookup. S-07 timing and GUC clearing belong to db/tests (05-SCHEMA §8). Not run: no `node_modules` here; tests fail now (modules missing).
