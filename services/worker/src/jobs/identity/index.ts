// WorkerManifest of module identity (02-TRD §3 tree, §10). C2 consumes no events. Handlers build no GoTrue/DB client at import time.
import type { WorkerManifest } from '../../core/manifest.js';
import { crontab } from './cron.js';
import { ACCESS_REVIEW_DUE, accessReviewDue } from './tasks/access_review_due.js';
import { APPLY_PENDING_NUMBERING, applyPendingNumbering } from './tasks/apply_pending_numbering.js';
import { BUILD_AUDIT_EXPORT, buildAuditExport } from './tasks/build_audit_export.js';
import { EXPIRE_AUDIT_EXPORTS, expireAuditExports } from './tasks/expire_audit_exports.js';
import { EXPIRE_INVITATIONS, expireInvitations } from './tasks/expire_invitations.js';
import { EXPIRE_SUPPORT_SESSIONS, expireSupportSessions } from './tasks/expire_support_sessions.js';
import { GOTRUE_SIGNOUT, gotrueSignout } from './tasks/gotrue_signout.js';
import { IMPORT_BREACHED_PASSWORDS, importBreachedPasswords } from './tasks/import_breached_passwords.js';
import { PURGE_AUTH_EVENTS, purgeAuthEvents } from './tasks/purge_auth_events.js';
import { PURGE_SESSIONS, purgeSessions } from './tasks/purge_sessions.js';
import { REMOVE_MFA_FACTORS, removeMfaFactors } from './tasks/remove_mfa_factors.js';
import { SEND_INVITATION, sendInvitation } from './tasks/send_invitation.js';
import { SEND_RECOVERY, sendRecovery } from './tasks/send_recovery.js';

export const manifest: WorkerManifest = {
  module: 'identity',
  tasks: {
    [GOTRUE_SIGNOUT]: gotrueSignout, [SEND_INVITATION]: sendInvitation, [SEND_RECOVERY]: sendRecovery,
    [REMOVE_MFA_FACTORS]: removeMfaFactors, [BUILD_AUDIT_EXPORT]: buildAuditExport,
    [PURGE_SESSIONS]: purgeSessions, [EXPIRE_SUPPORT_SESSIONS]: expireSupportSessions, [EXPIRE_INVITATIONS]: expireInvitations,
    [EXPIRE_AUDIT_EXPORTS]: expireAuditExports, [APPLY_PENDING_NUMBERING]: applyPendingNumbering, [ACCESS_REVIEW_DUE]: accessReviewDue,
    [PURGE_AUTH_EVENTS]: purgeAuthEvents, [IMPORT_BREACHED_PASSWORDS]: importBreachedPasswords,
  },
  subscriptions: {},
  crontab,
  maxAttempts: { [GOTRUE_SIGNOUT]: 10, [SEND_INVITATION]: 8, [SEND_RECOVERY]: 8, [REMOVE_MFA_FACTORS]: 10, [BUILD_AUDIT_EXPORT]: 5, [IMPORT_BREACHED_PASSWORDS]: 3 },
};
