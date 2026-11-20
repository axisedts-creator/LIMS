Title: CR-C1-PLATFORM-WIRE-1-SPEC: stage 9 counts PlatformAuthz.assertPlatform as the assertion for platform.* operations (LD-271 option A)
From chunk: C1            To owner: C0-0D (spec text; lead folds into the stage 8a/9 amendments with SEC-AUTHZ-9)
Type: port
Blocking? no (code landed under LD-271 addendum, FOUNDER 'ok' 2026-11-16 12:57 NPT)
Problem: spec/chunks/C0-foundation-contracts/02-TRD.md:468 (stage 9) and AC-0D-2.4 name only IdentityPort.assertRole as the assertion. Platform services call PlatformAuthz.assertPlatform (02-TRD.md:1112, CR-C0-004), so every platform 2xx answered 500 common.internal outside production.
Proposed change (exact): add to 02-TRD stage 9 and to AC-0D-2.4 the sentence: "PlatformAuthz.assertPlatform counts as the stage 9 assertion for platform.* operations: it marks the request as asserted only after its permission and aal checks have passed, and marks nothing when it throws."
Backward compatible? yes. IdentityPort.assertRole, the guard rules and the exemption list (x-context identity_auth only) are unchanged.
Tenant/security impact: no RLS, grant, policy or contract change; no new authority. Only a platform-session handler context is bound to the mark; a platform handler that never calls assertPlatform is still caught by stage 9.
Alternatives considered: B (assertRole delegates platform.* to PlatformAuthz; contradicts 02-TRD.md:1112), C (exemption for platform operations; rejected earlier). See LD-271.
Tests that will prove it: services/api/src/modules/identity/__tests__/platform-wire.operations.test.ts "end to end status" (8 cases, now 200); core/ports/__tests__/authz-guard.test.ts unchanged and green.
