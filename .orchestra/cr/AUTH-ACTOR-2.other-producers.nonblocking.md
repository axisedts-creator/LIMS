Title: CR-C1-AUTH-ACTOR-2: other SessionState producers omit actor.permissions (report only)
From chunk: C1            To owner: C0-0C (contracts/openapi/identity.yaml SessionState)
Type: api
Blocking? no (LD-222 RULES: report-only; no code change in this task)
Problem: LD-222 adds the OPTIONAL SessionState.actor.permissions for staff_web sessions (loginStaff, resolveSession, verifyMfaChallenge, completeMfaEnrolment, setPasswordFromSetup, confirmEmailToken). The other SessionState producers loginPartner, resolvePatientSession, openMobileSession and refreshMobileSession do NOT send it, by design: auth.service.ts:283 passes permissions only for mode 'staff'; session.service.ts:204 only for an active tenant_staff/platform session.
Proposed change (exact): none now. If partner/patient/mobile clients later need the list, a follow-up task applies the same loader (service/session-actor.ts) to those producers.
Backward compatible? yes (property optional; omitted = today's shape).
Tenant/security impact: none new; omitting the list exposes less. Permissions still only for state 'active' (LD-222 SECURITY RULE).
Alternatives considered: fill permissions for all producers now (outside LD-222 scope, not required by the partner portal / mobile / patient clients today).
Tests that will prove it: none in this task; a follow-up would add producer tests plus the real-validator contract test for those operations.
