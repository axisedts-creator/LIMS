// identity.expire_support_sessions (02-TRD §10 crontab, platform; AC-E4.4/AC-E4.5): one call of app.identity_expire_support_sessions() (08 A15.3).
import { definerTask } from './shared.js';

export const EXPIRE_SUPPORT_SESSIONS = 'identity.expire_support_sessions';
export const expireSupportSessions = definerTask(EXPIRE_SUPPORT_SESSIONS, 'identity_expire_support_sessions');
