// WorkerManifest of module identity (02-TRD §3 tree, §10). C2 consumes no events. Handlers build no GoTrue/DB client at import time.
import type { WorkerManifest } from '../../core/manifest.js';
import { BUILD_AUDIT_EXPORT, buildAuditExport } from './tasks/build_audit_export.js';
import { GOTRUE_SIGNOUT, gotrueSignout } from './tasks/gotrue_signout.js';
import { REMOVE_MFA_FACTORS, removeMfaFactors } from './tasks/remove_mfa_factors.js';
import { SEND_INVITATION, sendInvitation } from './tasks/send_invitation.js';
import { SEND_RECOVERY, sendRecovery } from './tasks/send_recovery.js';

export const manifest: WorkerManifest = {
  module: 'identity',
  tasks: {
    [GOTRUE_SIGNOUT]: gotrueSignout, [SEND_INVITATION]: sendInvitation, [SEND_RECOVERY]: sendRecovery,
    [REMOVE_MFA_FACTORS]: removeMfaFactors, [BUILD_AUDIT_EXPORT]: buildAuditExport,
  },
  subscriptions: {},
  maxAttempts: { [GOTRUE_SIGNOUT]: 10, [SEND_INVITATION]: 8, [SEND_RECOVERY]: 8, [REMOVE_MFA_FACTORS]: 10, [BUILD_AUDIT_EXPORT]: 5 },
};
