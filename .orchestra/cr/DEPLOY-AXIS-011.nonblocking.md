Title: CR-C1-DEPLOY-011: the first tenant administrator's session hits nine production defects (sign-out, number pipeline, frozen context, server pages, session bursts, worker ports, password reset then MFA, WAL archiving, test fakes)
From chunk: C1 (deploy attempt, prod-lean, 2026-11-21; found while a real tenant administrator and a client used the app in a browser; fixed in the deploy copy by the unattended runs night17, night18 and night19)    To owner: per item (listed below)
Type: bug
Blocking? yes for production go-live (items 2, 3, 7 stop a new tenant from registering patients or signing in after a password reset); no for any current orchestra task, so this file is named `.nonblocking`.
Relation to earlier CRs: 007 item 2 (tenantless sign-out jobs) and 008 (GoTrue session ended by a password change) are two of the roots; 010 covers the invite path of the same journey. This CR covers what happened after the first sign-in. Patches on the deploy host: `DEPLOY-AXIS-NIGHT17.patch`, `DEPLOY-AXIS-NIGHT18.patch`, `DEPLOY-AXIS-NIGHT19.patch` (each a diff against the copy before that run, so take them in order).

## Evidence from the host
UTC timeline, 2026-11-21, tenant `demo_lab2` (the first administrator signed in at 09:35, authenticator enrolled 09:36):
- 09:34:51 api `logoutSession` 500 `common.internal`, db_error P0001 (`app.enqueue_job` raise);
- 09:36:22 api `previewRegistrationNumbers` 500 `RangeError`; at the same minute web-a `TypeError: h.VIEWS.includes is not a function`;
- 09:36:18, 09:40:37, 09:40:53 bursts of 40, 31 and 29 `resolveSession` calls in one second, 84 `common.rate_limited` (429) in 40 minutes;
- worker task `quality.sync_qc_observations` failed `common.internal` on all 5 attempts (jobs 3410, 3418);
- 15:28 to 15:33 and again 15:44: the administrator forgot the password, used the recovery link (`confirmEmailToken` 200, `setPasswordFromSetup` 200), then `verifyMfaChallenge` 401 `auth.mfa_invalid` four times; GoTrue logged `POST /factors/<id>/challenge` "Session not found" for each;
- 15:27 to 16:40 after night17's roll: every front desk read returned 500 (`getCodedSet`, `listOrders`, `listFavouriteTests`, `searchPatients` and others; `TypeError`). A client demo failed in this window.
Nothing here contains personal data or secrets.

## Items

### 1. Platform-console sign-out returns 500 and leaves the session active  (To: C2 identity, platform owner; policy decision) (verified, rolled-back probe)
Problem: `logoutSession` enqueues `identity.gotrue_signout`, whose registry scope is `per_tenant`. A platform-console session has no tenant, so its payload has no `tenant_id` and `app.enqueue_job` raises `job_tenant_mismatch` (SQLSTATE P0001). A tenant session's payload is already correct (a probe as `lims_app` inside BEGIN ... ROLLBACK accepted it). Same family as CR-007 item 2.
Proposed change (owner decision): give the platform sign-out its own platform-scope task identifier, or call GoTrue directly for platform sessions, or register `identity.gotrue_signout` with a scope that accepts both. No change was made in the deploy copy.
Backward compatible? yes.

### 2. Registration, patient and booking numbers cannot be rendered for a new tenant  (To: C3 frontdesk, C2 identity for the settings) (verified, fixed in night17 and night19)
Problem: (a) the pipeline's `ctx.now()` is an ISO string, but frontdesk treated it as a `Date` (`RangeError`); (b) the `{prefix}` token of the default numbering patterns was never supplied at any caller: preview, `patient.service.ts` (~line 301), `registration.service.ts` (~line 557), `booking.service.ts` (~lines 112 and 246). A tenant on the default patterns could not preview, and would fail validation on saving a patient, registration or booking.
Where the prefix comes from: identity settings carry `numbering.prefix` at runtime only (`contracts/ports/IdentityPort.ts` has no field for it). A new tenant gets `numbering_prefix` `''` from the column default because provisioning does not set it. An absent key also gives `''`. With the default patterns the numbers come out as `00000001` (patient) and `KTM000001` (registration).
Deploy-copy fix: `patientCtx` converts string clocks to `Date`; every site passes `prefix`; identity settings expose `numbering.prefix`.
Proposed change: take the fix; add `prefix` to `IdentityPort` (contracts are owner-edited); decide whether provisioning must set a real prefix per tenant instead of `''`.
Backward compatible? yes.

### 3. The pipeline context is frozen and night17's override threw on it  (To: C3 frontdesk, C0 core) (verified, fixed in night19)
Problem: the first fix for item 2 used `Object.assign(Object.create(ctx), { now })`, which throws on the frozen pipeline context. It broke every front desk read that used it (see timeline, 15:27 to 16:40). The unit tests used an unfrozen context, so they passed.
Deploy-copy fix: `services/api/src/core/ctxOverride.ts` exports `withCtx`, used at every such site (including `labCtx` and billing `previewInvoiceNo`); 17 new tests in `night19.prefix-frozen.test.ts`.
Proposed change: take `withCtx` and ban the `Object.create(ctx)` pattern with a lint rule; make the shared test context factory freeze its object so this class of bug fails in unit tests.
Backward compatible? yes.

### 4. Server pages import runtime values from `'use client'` files  (To: C9 web) (verified for two files, reported for the rest)
Problem: a server page that imports an array or object from a `'use client'` module receives a client reference, not the value: `catalog/tests/page.tsx` read `VIEWS` (web error `h.VIEWS.includes is not a function`), and the catalog test detail page read `TAB_IDS`. Fixed by moving the constants into plain modules (`tabs.server-safe.test.ts`, 3 tests). Remaining server-page imports from `'use client'` files are listed in the night19 report (billing columns, partners `WAITING`).
Proposed change: take both moves; move the remaining constants; add a lint or test that fails when a server file imports a non-component value from a `'use client'` file.
Backward compatible? yes.

### 5. One page load calls `resolveSession` 30 to 40 times  (To: C9 web, C2 identity for the limiter) (verified)
Problem: every sidebar link (`Rail.tsx`) was prefetched, and each prefetch passes the middleware, which calls `resolveSession` at the api. React `cache()` cannot help because these are separate requests. Since night14 the api sees the real client address, so a whole page shares one per-address limit and bursts end in 429.
Deploy-copy fix: `prefetch={false}` on the three `Rail.tsx` links (not proven without a real page load; the existing Rail tests could not run in the test image).
Proposed change: take the change; also let the middleware skip the session lookup for prefetch requests (header `next-router-prefetch`), and re-check the limiter tier numbers for `resolveSession` against realistic page loads. Note: behind an SSH tunnel every user shares one client address, so a demo through a tunnel hits the per-address limit sooner than a public edge would.
Backward compatible? yes.

### 6. Worker jobs have no `ports` in their context  (To: C7 worker, C2 identity) (verified live)
Problem: `quality.sync_qc_observations` calls `tenantZone`, which needs `ctx.ports`; the worker job context has none, so the task failed `common.internal` on every attempt.
Deploy-copy fix: a minimal tenant-bound `IdentityPort` view in `services/worker/src/jobs/quality/ports.ts`, used by the sync and reprocess jobs. After the roll the job completes (seven completions in an hour, one on attempt 5 of 5).
Proposed change: give the worker job context the same ports object as the api pipeline instead of one view per job; other worker jobs may have the same gap.
Backward compatible? yes.

### 7. A password reset ends the GoTrue session that the authenticator step needs  (To: C2 identity) (verified in logs, fixed in night18, not proven live)
Problem: `setPasswordFromSetup` changes the password through the GoTrue admin API, which ends the user's sessions. The handler kept the now-dead token pair, so `verifyMfaChallenge` got "Session not found" from GoTrue and the app reported `auth.mfa_invalid` (wrong code) even though the code was right. Same root as CR-008, now on the recovery path of an already enrolled user. Each retry from the reset screen repeated it.
Deploy-copy fix: after the password update the handler signs in with the new password the same way `loginStaff` does and stores the fresh session (the new password is verified for real; MFA is still required; the password is never logged or stored); if that sign-in is refused it returns `common.dependency_unavailable` and the transaction rolls back. `verifyMfaChallenge` maps "session gone" to the existing `auth.session_expired` and does not count a failed attempt. 7 new tests in `night18.session-ended.test.ts` use a GoTrue fake that ends sessions on a password update. The first-admin enrolment path (CR-008) uses the same handler and is covered by the same change.
Proposed change: take the change; add `auth.session_expired` to `x-error-codes` of `verifyMfaChallenge` and `completeMfaEnrolment` in `contracts/openapi/identity.yaml` (not edited on the host); keep the GoTrue fake that ends sessions as the shared fake.
Backward compatible? yes.

### 8. WAL archiving of the database looks broken  (To: C0/C1 deploy, database owner) (reported from the log only, not diagnosed)
Problem: the `supabase-db` log repeats `archive-push command requires option: repo1-cipher-pass` every few seconds. If archiving is not working, point-in-time recovery has no WAL. Night19 was not asked to diagnose it.
Proposed change: find which secret id or environment name should supply `repo1-cipher-pass` for the pgBackRest (or equivalent) archive command, whether it is rendered into the runtime secrets, and since when the log shows it; fix the render or the command, then prove a WAL segment reaches the repository.
Backward compatible? yes.

### 9. Other findings  (To: C7 worker, C0 core) (reported)
- Two worker jobs log "unknown gauge" metrics errors (names in the night17 report).
- Test failures that already fail on the base copy, unrelated to the changes: 2 identity tests, 1 frontdesk static test, 4 in lab `critical.service`; the wider web test folders cannot load in the test image.
- `core.rate_limit_counters` cannot be cleared by the database administrator role used on the host (permission denied); an operator locked out by the limiter can only wait for the hourly window. A supported "clear limiter for this address" action would help operations.

Tenant/security impact: items 1, 5 and 7 touch sign-in and session handling; item 7 keeps MFA required after a reset and never logs the password; no PHI fields; no secret value appears in this CR.
IRD/regulatory impact: none.
Alternatives considered: leaving all fixes only in the deploy copy (done for the test; not repeatable for a rebuild or DR); for item 5, a larger limiter tier (rejected: 30 to 40 calls per page is a web bug, a higher limit hides it); for item 7, sending the user to the normal sign-in page after a reset (simpler, kept as a fallback if the owners dislike a sign-in inside the handler).
Tests that will prove it:
- unit: `night19.prefix-frozen.test.ts` (frozen context, default patterns), `night18.session-ended.test.ts` (session ended by password update), `tabs.server-safe.test.ts`; plus the existing suites listed in the night17 to 19 reports;
- DB (devstack): `app.enqueue_job` with a platform session payload for the chosen design of item 1; numbering preview for a tenant created by provisioning with no settings;
- flow test: provision tenant, accept invitation, set password, enrol MFA, activate, sign out, reset the password, sign in with the existing authenticator code, save a patient, a registration and a booking;
- host smoke in a browser: logout as tenant administrator and as platform administrator, front desk pages, one page load counted in the api log (calls to `resolveSession` per page), the QC job completes, a WAL segment appears in the archive repository (item 8).
