APPROVE

Scope: git diff 8cd8d2f42..HEAD (tester revision 6d74ab9ce per arbiter ruling 16f244d77 + impl note), read against the whole SEC-AUTHZ-4 diff b01ed3abb..HEAD.

Checked:
- Ruling applied as written: oracle totals derived from CONTRACT.size (no 1018/993/25 literals); anchor asserts inviteUser, approveSupportSession, denySupportSession, revokeSupportSession are `guarded-exact` with permission === contract x-permission. Lines 194/202 (CR 1018 baseline) unchanged.
- All 53 `guarded('<perm>')` / applyRolePack permissions in services/api/src/modules/identity/handlers/*.ts match the operation's x-permission in contracts/openapi/identity.yaml (scripted compare: 53 checked, 0 mismatch). inviteUser = identity.user.manage; approve/deny/revokeSupportSession = identity.settings.manage.
- Snapshot tests/security/authz-classification.json, identity operations: guarded-exact 61, identity-session-flow 6, public 9, platform 34, stub 3, unguarded 0.
- Untouched: loginStaff, verifyMfaChallenge, start/completeMfaEnrolment, resolveSession, logoutSession and every x-public operation; no change to contracts/, permissions.yaml, role packs, SQL, policies, migrations. authz-exceptions.json stays []. Files are all identity module, tests/security, .orchestra/notes.
- Guard runs before the wrapped handler (no read/write), fails closed (common.internal) without IdentityPort, passes assertRole's own error through; no new error code; no log lines added.
- Ran: verify.cmd vitest 6 files 779/779 pass; node --test authz-identity + authz-classification 27/27 pass.

Non-blocking notes (no change required):
- The patient/partner/portal matrix uses a mock assertRole (actor.type !== 'user'), so it proves the guard consults the port, not the real port's actor rule.
- As the impl note says, /me operations now deny sessions in mfa_pending (IdentityPort.impl.ts:233). The web /admin/me page sits behind the staff route guard, so no regression was found.
