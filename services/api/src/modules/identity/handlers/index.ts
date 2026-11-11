// operationId -> handler map of module identity (02-CV §2.2). Keys = every operationId of contracts/openapi/identity.yaml; the
// core fails boot on a missing or extra key (AC-0D-1.2). Every stub throws common.internal (fail closed) until its task
// replaces it with handlers/<operationId>.ts. [CONV] same one-list stub pattern as modules/lab/handlers/index.ts.
import type { Handler } from '../../../core/module.js';
import { LimsError } from '../../../core/errors.js';
import { createRole } from './createRole.js';
import { deactivateRole } from './deactivateRole.js';
import { getRole } from './getRole.js';
import { listPermissions } from './listPermissions.js';
import { listRoles } from './listRoles.js';
import { updateRole } from './updateRole.js';
import { createBranch } from './createBranch.js';
import { createCentre } from './createCentre.js';
import { deactivateBranch } from './deactivateBranch.js';
import { deactivateCentre } from './deactivateCentre.js';
import { listBranches } from './listBranches.js';
import { listCentres } from './listCentres.js';
import { reactivateBranch } from './reactivateBranch.js';
import { reactivateCentre } from './reactivateCentre.js';
import { updateBranch } from './updateBranch.js';
import { updateCentre } from './updateCentre.js';
import { getBrandingAssetContent } from './getBrandingAssetContent.js';
import { getSettings } from './getSettings.js';
import { listFeatureFlags } from './listFeatureFlags.js';
import { listOwnIrdAnnexes } from './listOwnIrdAnnexes.js';
import { setTenantFeatureFlag } from './setTenantFeatureFlag.js';
import { updateSettings } from './updateSettings.js';
import { uploadBrandingAsset } from './uploadBrandingAsset.js';
import { activateSupportSession } from './activateSupportSession.js';
import { endSupportSession } from './endSupportSession.js';
import { listPlatformSupportSessions } from './listPlatformSupportSessions.js';
import { openSupportSession } from './openSupportSession.js';
import { createPlatformIrdAnnex } from './createPlatformIrdAnnex.js';
import { downloadIrdAnnexDocument } from './downloadIrdAnnexDocument.js';
import { listPlatformIrdAnnexes } from './listPlatformIrdAnnexes.js';
import { transitionIrdAnnex } from './transitionIrdAnnex.js';
import { updateIrdAnnex } from './updateIrdAnnex.js';
import { uploadIrdAnnexDocument } from './uploadIrdAnnexDocument.js';
import { listDeadLetters } from './listDeadLetters.js';
import { getDeadLetter } from './getDeadLetter.js';
import { replayDeadLetter } from './replayDeadLetter.js';
import { discardDeadLetter } from './discardDeadLetter.js';
import { createAuditExport } from './createAuditExport.js';
import { listAuditExports } from './listAuditExports.js';
import { getAuditExport } from './getAuditExport.js';
import { downloadAuditExport } from './downloadAuditExport.js';
import { listPlatformStaff } from './listPlatformStaff.js';
import { invitePlatformStaff } from './invitePlatformStaff.js';
import { updatePlatformStaff } from './updatePlatformStaff.js';
import { deactivatePlatformStaff } from './deactivatePlatformStaff.js';
import { resetPlatformStaffMfa } from './resetPlatformStaffMfa.js';
import { listPlatformSessions } from './listPlatformSessions.js';
import { revokePlatformSession } from './revokePlatformSession.js';
import { listPlatformAuthEvents } from './listPlatformAuthEvents.js';
import { loginStaff } from './loginStaff.js';
import { verifyMfaChallenge } from './verifyMfaChallenge.js';
import { startMfaEnrolment } from './startMfaEnrolment.js';
import { completeMfaEnrolment } from './completeMfaEnrolment.js';
import { resolveSession } from './resolveSession.js';
import { logoutSession } from './logoutSession.js';
import { requestPasswordRecovery } from './requestPasswordRecovery.js';
import { confirmEmailToken } from './confirmEmailToken.js';
import { setPasswordFromSetup } from './setPasswordFromSetup.js';

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

const implemented: Partial<Record<IdentityOperationId, Handler>> = {
  listPermissions, listRoles, createRole, getRole, updateRole, deactivateRole,   // T14
  listBranches, createBranch, updateBranch, deactivateBranch, reactivateBranch,                  // T15
  listCentres, createCentre, updateCentre, deactivateCentre, reactivateCentre,                    // T15
  getSettings, updateSettings, uploadBrandingAsset, getBrandingAssetContent, listFeatureFlags, setTenantFeatureFlag, listOwnIrdAnnexes,   // T16
  openSupportSession, activateSupportSession, endSupportSession, listPlatformSupportSessions,                       // T21
  listPlatformIrdAnnexes, createPlatformIrdAnnex, updateIrdAnnex, transitionIrdAnnex, uploadIrdAnnexDocument, downloadIrdAnnexDocument,   // T23
  listDeadLetters, getDeadLetter, replayDeadLetter, discardDeadLetter,                                          // T24
  createAuditExport, listAuditExports, getAuditExport, downloadAuditExport,                                    // T19
  listPlatformStaff, invitePlatformStaff, updatePlatformStaff, deactivatePlatformStaff, resetPlatformStaffMfa,  // T25
  listPlatformSessions, revokePlatformSession, listPlatformAuthEvents,                                          // T25
  loginStaff,                                                                                                   // T6
  verifyMfaChallenge, startMfaEnrolment, completeMfaEnrolment,                                                  // T7
  resolveSession, logoutSession,                                                                                // T8
  requestPasswordRecovery, confirmEmailToken, setPasswordFromSetup,                                             // T9
};

export const handlers: Readonly<Record<IdentityOperationId, Handler>> = Object.freeze(
  Object.fromEntries(OPERATION_IDS.map((op) => [op, implemented[op] ?? notImplemented(op)])) as Record<IdentityOperationId, Handler>,
);
