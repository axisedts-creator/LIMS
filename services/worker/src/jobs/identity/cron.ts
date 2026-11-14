// identity crontab (02-TRD §10; REQ-ARCH-042; 08 A13 P-6 / A23.1). TRD times are Asia/Kathmandu (UTC+05:45, no DST); schedules here are UTC:
// :07 NPT = :22 UTC, :17 = :32, :27 = :42, 00:10 NPT = 18:25 UTC (previous day), 06:40 = 00:55, 03:40 = 21:55.
// maxAttempts: not in the TRD -> core default.
import type { CronEntry } from '../../core/manifest.js';
import { ACCESS_REVIEW_DUE } from './tasks/access_review_due.js';
import { APPLY_PENDING_NUMBERING } from './tasks/apply_pending_numbering.js';
import { EXPIRE_AUDIT_EXPORTS } from './tasks/expire_audit_exports.js';
import { EXPIRE_INVITATIONS } from './tasks/expire_invitations.js';
import { EXPIRE_SUPPORT_SESSIONS } from './tasks/expire_support_sessions.js';
import { PURGE_AUTH_EVENTS } from './tasks/purge_auth_events.js';
import { PURGE_SESSIONS } from './tasks/purge_sessions.js';

export const crontab: readonly CronEntry[] = Object.freeze([
  Object.freeze({ identifier: PURGE_SESSIONS, schedule: '22 * * * *', tenantScope: 'platform' as const }),
  Object.freeze({ identifier: EXPIRE_SUPPORT_SESSIONS, schedule: '*/5 * * * *', tenantScope: 'platform' as const }),
  Object.freeze({ identifier: EXPIRE_INVITATIONS, schedule: '32 * * * *', tenantScope: 'platform' as const }),
  Object.freeze({ identifier: EXPIRE_AUDIT_EXPORTS, schedule: '42 * * * *', tenantScope: 'platform' as const }),
  Object.freeze({ identifier: APPLY_PENDING_NUMBERING, schedule: '25 18 * * *', tenantScope: 'per_tenant' as const }),
  Object.freeze({ identifier: ACCESS_REVIEW_DUE, schedule: '55 0 * * *', tenantScope: 'per_tenant' as const }),
  Object.freeze({ identifier: PURGE_AUTH_EVENTS, schedule: '55 21 * * *', tenantScope: 'platform' as const }),
]);
