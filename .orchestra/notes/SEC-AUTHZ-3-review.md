APPROVE

# SEC-AUTHZ-3 review (reviewer), diff 5b675284e..aed43d0af

- Scope: authz-central.ts, the new authz-central.platform.test.ts, 2 revised cases in authz-central.test.ts, and notes. 3 code files, within the 6-file cap. platform/authz.ts is only read. No change to contracts, permissions, role packs, SQL, policies, migrations or authz-exceptions.json (still []).
- Logic: skipReason no longer skips platform.*. A platform.* permission is decided only by PlatformAuthz.assertPlatform(ctx, x-permission), before the handler. ctx.platformRole and aal come only from a verified platform session (pipeline/index.ts:132), so tenant, patient, partner, portal, system, device and unknown actors get auth.forbidden, and a privileged code at aal1 gets auth.mfa_required. No new error code. The deny log and metric keep the SEC-AUTHZ-2 keys and the operation_id label only, so no PHI, token, email or person id. Shadow and enforce behave as in SEC-AUTHZ-2. The stage 9 mark is set before the check; in enforce a deny throws before the handler.
- Tenant operations: the support-session rule stays in assertRole step 4, and the test pins identity.support_session_required before the handler. bffSession and identity session operations stay skipped.
- The revised SEC-AUTHZ-2 tests are a justified reversal, not a weakening: the old ones pinned "platform.* skipped". The stage 9 skipped-operation sample now uses an operation with no x-permission.
- Snapshot: I re-ran classify-authz.mjs and its output is byte-identical to tests/security/authz-classification.json. Class platform = 34, so no regeneration is needed.
- Checks run: the verify.cmd vitest set passed 8 files, 754/754. node --test authz-classification passed 19/19. vitest src/modules/identity: 5917 pass, 10 fail. All 10 failures are in ci-scripts.test.ts (service-key grep) and apply-role-pack.script.test.ts (ADMINPACK runbook and package.json). They check repo files and docs that this diff does not touch, so they are not caused by it, but I did not run them at the base commit to confirm they fail there too. Platform sign-in and MFA tests are green.
- Non-blocking: if an exception-listed operation ever maps to platform.*, mark() is skipped but assertPlatform still marks through markAsserted. That is harmless today because the list is empty.
- Not verified: real DB/RLS (unchanged by this diff); the full api suite.
