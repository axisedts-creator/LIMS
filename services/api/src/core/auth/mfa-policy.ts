// Operator switch for the second sign-in step of TENANT staff (founder decision 2026-11-26, recorded in .orchestra/cr/TENANT-MFA-OFF-1.md;
// it overrides REQ-SEC-062 / REQ-SEC-067 for this deployment). Default = enforced: only the exact value `off` turns it off.
//   LIMS_IDENTITY_TENANT_MFA=off
//     - a privileged permission no longer needs an aal2 session (IdentityPort.assertRole),
//     - a discount approver no longer needs aal2 (frontdesk),
//     - a role marked mfa_required no longer forces authenticator enrolment at sign-in or first password setup.
// Unchanged whatever the value: a user who HAS a verified authenticator is still asked for the code at sign-in, and platform staff
// (PlatformAuthz, platform login) always need the second step.
type Env = Readonly<Record<string, string | undefined>>;

export const tenantMfaOff = (env: Env = process.env): boolean => env['LIMS_IDENTITY_TENANT_MFA'] === 'off';
