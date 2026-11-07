// operationId -> handler map of module identity (02-CV §2.2). Keys = every operationId of contracts/openapi/identity.yaml; the
// core fails boot on a missing or extra key (AC-0D-1.2). Every stub throws common.internal (fail closed) until its task
// replaces it with handlers/<operationId>.ts. [CONV] same one-list stub pattern as modules/lab/handlers/index.ts.
import type { Handler } from '../../../core/module.js';
import { LimsError } from '../../../core/errors.js';

const OPERATION_IDS = [
  // auth (identity_auth)
  'loginStaff', 'verifyMfaChallenge', 'startMfaEnrolment', 'completeMfaEnrolment', 'resolveSession', 'logoutSession',
  'requestPasswordRecovery', 'confirmEmailToken', 'setPasswordFromSetup', 'loginPartner', 'resolvePatientSession',
  'logoutPatientSession', 'openMobileSession', 'refreshMobileSession', 'logoutMobileSession',
  // self service
  'getMe', 'changeOwnPassword', 'listOwnSessions', 'revokeOwnSession', 'listOwnMfaFactors', 'removeOwnMfaFactor',
  // tenant admin
  'listUsers', 'inviteUser', 'searchUsers', 'getUser', 'updateUser', 'setUserRoles', 'setUserCentreScope', 'lockUser',
  'unlockUser', 'deactivateUser', 'reactivateUser', 'resendInvitation', 'resetUserMfa', 'revokeUserSessions',
  'uploadUserSignature', 'listPermissions', 'listRoles', 'createRole', 'getRole', 'updateRole', 'deactivateRole',
  'listBranches', 'createBranch', 'updateBranch', 'deactivateBranch', 'reactivateBranch', 'listCentres', 'createCentre',
  'updateCentre', 'deactivateCentre', 'reactivateCentre', 'getSettings', 'updateSettings', 'uploadBrandingAsset',
  'getBrandingAssetContent', 'listFeatureFlags', 'setTenantFeatureFlag', 'listOwnIrdAnnexes', 'listSessions', 'revokeSession',
  'listTenantSupportSessions', 'approveSupportSession', 'denySupportSession', 'revokeSupportSession', 'listAuditEntries',
  'getAuditEntry', 'listAccessLogEntries', 'listAuthEvents', 'createAuditExport', 'listAuditExports', 'getAuditExport',
  'downloadAuditExport', 'listAdminNotices', 'dismissAdminNotice', 'listAccessReviews', 'recordAccessReview',
  // platform
  'listTenants', 'provisionTenant', 'getTenant', 'updateTenant', 'activateTenant', 'suspendTenant', 'reactivateTenant',
  'terminateTenant', 'getTenantSettingsAsPlatform', 'updateTenantSettingsAsPlatform', 'setFeatureFlagAsPlatform',
  'inviteTenantAdmin', 'listPlatformIrdAnnexes', 'createPlatformIrdAnnex', 'updateIrdAnnex', 'transitionIrdAnnex',
  'uploadIrdAnnexDocument', 'downloadIrdAnnexDocument', 'openSupportSession', 'listPlatformSupportSessions',
  'activateSupportSession', 'endSupportSession', 'listDeadLetters', 'getDeadLetter', 'replayDeadLetter', 'discardDeadLetter',
  'listPlatformStaff', 'invitePlatformStaff', 'updatePlatformStaff', 'deactivatePlatformStaff', 'resetPlatformStaffMfa',
  'listPlatformSessions', 'revokePlatformSession', 'listPlatformAuthEvents',
] as const;

export type IdentityOperationId = (typeof OPERATION_IDS)[number];

const notImplemented = (operationId: string): Handler => async () => {
  throw new LimsError('common.internal', `identity ${operationId} not implemented`);
};

export const handlers: Readonly<Record<IdentityOperationId, Handler>> = Object.freeze(
  Object.fromEntries(OPERATION_IDS.map((op) => [op, notImplemented(op)])) as Record<IdentityOperationId, Handler>,
);
