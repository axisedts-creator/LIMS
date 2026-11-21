Title: CR-C1-AUTH-BFF-1: HandlerContext gains optional bffKey
From chunk: C1            To owner: C0 (T0D-18)
Type: port
Blocking? no (LD-206 authorised the core edit; this records it)
Problem: identity needs ctx.bffKey === 'staff_web' for login, set-password, MFA verify, email confirm, session resolve; pipeline never passed it.
Proposed change (exact): 02-TRD s6.3 HandlerContext, after clientIp: `readonly bffKey?: 'staff_web' | 'partner' | 'portal'` (lead already made the one-line spec edit; lane does not edit spec).
Backward compatible? yes (optional member).
Tenant/security impact: none new; value only from createBffKeyVerifier result for X-Lims-Bff-Key, undefined otherwise.
Alternatives considered: ctx wrapper in tests only (does not work on the real server).
Tests that will prove it: pipeline/__tests__/bff-key.test.ts, stage08-handler-context.test.ts MEMBERS.
