APPROVE

Reviewed `git diff 8cc7b160..HEAD` (openapi.ts +8, bff-session.test.ts new, lane notes).

- Scope (LD-212): only `services/api/src/core/openapi.ts` securityHandlers() + one test file under core/pipeline/__tests__/; no fixture, no identity/contract/spec/migration/web/package edits. bearerJwt block unchanged.
- Handler: always registered; passes only if `requestAuth.get(req)?.bffKind` (verifier result from onRequest, LD-206), `routeOptions.url` starts `/v1/identity/auth/`, and Cookie has `__Host-lims_sid` (anchored on `^|;\s*`, value 1..4096 non-`;`/space chars, lookahead blocks oversize). Else `AuthError('auth.unauthenticated')`. No DB call, no logging of key/cookie, no claims, no kind check. Names verbatim (bffSession, X-Lims-Bff-Key, __Host-lims_sid, auth.unauthenticated).
- Tests cover LD (a)-(i) x six REAL identity.yaml operations through mountSpec + installRouteHooks + app.inject, plus prefix traps, 4096/4097 boundaries, cookie-as-value trap, no-DB-call on 401, kind not checked, no leak of key/cookie in 401 body/headers.
- Tenant isolation / RLS / idempotency / rate tier: not touched by this change (security stage only).
- Writer note has the REPORT ONLY items (deviceToken, portalSession, patientPreAuth, paymentCallbackToken, queueDisplayToken without handler; createAuthResolverRegistry not called by production code).

Checks run by reviewer:
- `vitest run src/core/pipeline/__tests__/bff-session.test.ts`: 158/158 pass.
- `vitest run src/core/pipeline src/core/auth`: 20 files, 787 pass, 24 skipped, 0 fail.
- `tsc --noEmit`: no errors in core/openapi.ts or bff-session.test.ts.
Not re-run by reviewer: full identity module suite (writer reports 1 known pre-existing failure, role-packs/route-guard.test.ts).
Not covered (per LD-212): live GoTrue TOTP enrolment, session tables under real RLS, live resolveSession.
