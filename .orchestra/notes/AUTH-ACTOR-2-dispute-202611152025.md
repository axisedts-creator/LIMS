# AUTH-ACTOR-2 dispute (writer): 10 older tests assert the pre-LD-222 actor shape
Binding LD-222 adds `actor.permissions` to every ACTIVE tenant/platform session, so exact `toEqual` on the actor in these older (T-level) tests now fails. Nothing else in them fails; the new AUTH-ACTOR-2 tests pass (84 api + 27 web).
- `identity/handlers/__tests__/session-actor.test.ts` (6): loginStaff tenant actor, loginStaff only-3-fields, resolveSession tenant_staff / platform / only-3-fields (active sessions now carry `permissions`).
- `identity/handlers/__tests__/mfa.complete.test.ts` (5): verifyMfaChallenge + completeMfaEnrolment tenant/platform actor (always active => permissions).
Tester: update those expectations to `{ ...ACTOR, permissions: [...] }` (or allow the key); the "only display_name/roles/tenant_code leave" tests should add `permissions` to the allowed set. Partner resolve is unchanged (no permissions).
Not related: `role-packs/route-guard.test.ts` AppShell regex (pre-existing failure).
