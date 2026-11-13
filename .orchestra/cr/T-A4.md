Title: CR-C16-T-A4: (a) LimsAppLockGate lock-out message slot; (b) patient transport exposes Retry-After on 429
From chunk: C16            To owner: C0-0D (packages/ui-flutter) for (a); C16 T-A1 / lims_api_client owner (CR-C16-016/017) for (b)
Type: ui-kit (a); shared-lib (b)
Blocking? no for T-A4 delivery. (a) workaround in place; (b) a real 429 shows a fallback line until fixed.
Problem:
 (a) 04-UI-UX.md:74 A4 uses `LimsAppLockGate` and, after 3 failed device prompts, "Locked. Open the app again later." with no button. The kit gate (packages/ui-flutter/lib/src/cr16_widgets.dart LimsAppLockGate) always shows its unlock button and has no message slot. Today apps/patient_app/lib/app/app_lock_gate.dart takes the kit gate offstage and shows kit `LimsEmptyState(icon: Icons.lock, title: ...)` over it (US-EN-02.1/02.2).
 (b) 04-UI-UX.md:63 A2/A3 copy "Too many codes requested. Try again in {minutes} minutes." needs the 429 Retry-After value. `PatientTransport` returns only decoded JSON and throws `LimsException(code)`; no header reaches T-A4, so `RateLimitedException(retryAfter)` is never built from real traffic and the app shows the fallback "Too many codes requested. Try again later." (not in the spec).
Proposed change (exact):
 (a) `LimsAppLockGate({..., String? lockedOutMessage})`: when non-null and `isLocked`, render the lock icon + `lockedOutMessage` and no button, and do not call `onUnlockRequested`.
 (b) The inner transport (lims_api_client) throws, for HTTP 429 with code `common.rate_limited`, a `LimsException` subtype or a `LimsException` with `Duration? retryAfter` parsed from `Retry-After` (seconds). T-A4 then maps it to `RateLimitedException(retryAfter)` in TransportPatientAuthApi.
Backward compatible? yes — both additive optional fields.
Tenant/security impact: none (no PHI, no new surface; REQ-SEC-110 unchanged).
IRD/regulatory impact: n/a
Alternatives considered: local look-alike lock screen (rejected by review: 02-CV:1168, 04-UI-UX:326); parsing Retry-After in T-A4 (no access to headers).
Tests that will prove it: kit widget test for `lockedOutMessage`; a4_app_lock_test unchanged; a transport test that a 429 with `Retry-After: 600` yields retryAfter 600 s and A2 shows "Try again in 10 minutes.".
