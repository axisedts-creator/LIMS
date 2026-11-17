# T0B-ACTIVATE-2 tests (LD-302, CR-C0-ACTIVATE-1c)
Files (all under services/api/src/modules/identity/): repository/__tests__/mfa.repo.accept-invitation.test.ts, handlers/__tests__/activate.chain.test.ts, domain/__tests__/invitation.state.test.ts.
Run: `.orchestra\notes\T0B-ACTIVATE-2-verify.cmd` (pnpm --dir services/api exec vitest run on those 3 files).
Fail now (6, right reason): state edge pending->accepted is false; INVITE_ACCEPT_SQL lists only 'sent' (3 repo tests); chain tests (no worker step) end with membership invited / tenant_not_ready.
Pass now (60): revoked, failed, expired, accepted, superseded and expired-pending stay refused; wrong token_hash and unknown setup session refused; scoping, params, malformed call unchanged.
Chain test now uses the REAL repo acceptInvitation over a fake tx that executes the statement's status predicate (no stubbed accept logic).
invitation.state.test.ts: added allowed edge ['pending','accepted'] per the ruling (all other edges unchanged; checkStateTable still asserts every other pair false).
Not covered here: locked or multiple memberships and token verification itself (existing confirmEmailToken tests, AU-T6/T21, unchanged); real-DB SQL not run (fake tx only).
