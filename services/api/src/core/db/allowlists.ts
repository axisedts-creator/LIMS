// Default operationId allowlists for the two privileged transaction APIs (02-TRD §6.3, §11).
// Overridable only by config at boot (LIMS_CORE_IDENTITY_AUTH_OPS / LIMS_CORE_WITH_TENANT_SCOPE_OPS); frozen, never widened at run time.

/** 08 A25 D-212: the only operations that may open ctx.db.identityAuthTx (module identity, x-context: identity_auth). */
export const IDENTITY_AUTH_OPS: readonly string[] = Object.freeze([
  'loginStaff', 'loginPartner', 'openMobileSession', 'refreshMobileSession', 'logoutMobileSession', 'confirmEmailToken',
  'requestPasswordRecovery', 'verifyMfaChallenge', 'startMfaEnrolment', 'completeMfaEnrolment', 'resolveSession', 'logoutSession',
  'setPasswordFromSetup', 'resolvePatientSession', 'logoutPatientSession',
]);

/** 08 R10 item 4 as extended by 08 A25 D-214: identity operations (platform context) that may call ctx.db.withTenantScope. */
export const WITH_TENANT_SCOPE_OPS: readonly string[] = Object.freeze([
  'provisionTenant', 'inviteTenantAdmin', 'activateTenant', 'suspendTenant', 'reactivateTenant', 'terminateTenant',
  'updateTenantSettingsAsPlatform', 'setFeatureFlagAsPlatform', 'openSupportSession', 'activateSupportSession', 'endSupportSession',
  'revokeSupportSession', 'getDeadLetter',
]);

/** 02-TRD §6.2 stage 9: operations tagged x-context: identity_auth skip the authz guard (D-212). */
export const authzGuardExempt = (operation: { readonly context?: unknown } | undefined): boolean =>
  operation?.context === 'identity_auth';

/**
 * Auth schemes whose resolver may run before any claims exist (ctx-less `db.preAuthTx`, the only SQL being a SELECT of a
 * SECURITY DEFINER function). Frozen; widening needs a reviewed change here, never configuration.
 * Today: patientPreAuth only (module engagement, C16 CR-C16-005); portalSession/deviceToken/... stay fail-closed until reviewed.
 */
export const PRE_AUTH_SCHEMES: readonly string[] = Object.freeze(['patientPreAuth']);
