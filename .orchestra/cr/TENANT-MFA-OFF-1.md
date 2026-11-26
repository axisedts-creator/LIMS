Title: CR-TENANT-MFA-OFF-1: operator switch to turn off the second sign-in step for tenant staff
From chunk: founder decision (2026-11-26, direct session)            To owner: C2 (identity), C5 (frontdesk discount approval), security owner
Type: api (behaviour behind a setting)
Blocking? no. Built at the founder's instruction after an informed choice ("All lab admin screens": no authenticator on any lab staff screen, every lab).

Problem: REQ-SEC-062 / REQ-SEC-067 make every privileged permission need an aal2 session. A lab admin signed in with a password only could not open Lab settings (403 auth.mfa_required, shown as "Could not load lab settings"). The founder asked for the rule to be removed for lab staff.

Proposed change (exact): new setting `LIMS_IDENTITY_TENANT_MFA` read by `services/api/src/core/auth/mfa-policy.ts`. Default (unset or any value but `off`) = today's behaviour. `off`:
- `IdentityPort.assertRole`: a privileged permission no longer needs aal2 (tenant user, partner, support actors alike on this path).
- frontdesk `discount.service`: the approver no longer needs aal2.
- `auth.service` (tenant sign-in) and `setPasswordFromSetup`: a role with `mfa_required` no longer forces authenticator enrolment.
Unchanged: a user who has a verified authenticator is still asked for the code at sign-in; platform staff always need the second step (PlatformAuthz, platform login); `mfa_pending` sessions stay blocked until the code is entered.

Backward compatible? yes: off by default, no contract or schema change.

Tenant/security impact: with `off`, a password alone gives a lab admin full control of that lab (settings, users, roles, audit, exports, patient data). The staff web is on the public internet and the password minimum is 6 characters (decision of 2026-11-24), so the remaining protections are the login rate limits and fail2ban. Applies to every tenant of the deployment. Deviates from REQ-SEC-062, REQ-SEC-067, 04 A4. The founder was told this before choosing.

Alternatives considered (offered, not chosen): keep the rule and enrol the authenticator for the account; lift it for Lab settings only; keep it and fix the misleading error text.

To turn it back on: remove the setting (or any value but `off`) on the api containers and roll them. No rebuild.

Open point: the staff web shows `auth.mfa_required` on a page load as "Could not load ..." instead of asking for the code. Not changed here.

Tests that prove it: `IdentityPort.c2.test.ts` (describe LIMS_IDENTITY_TENANT_MFA: off passes at aal1; eight other values still refuse; no grant, platform.* and a pending code entry are unaffected).
