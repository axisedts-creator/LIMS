// identity.purge_sessions (02-TRD §10 crontab, platform): one call of app.identity_purge_sessions() (05-SCHEMA §6, §9; 08 A15.3).
import { definerTask } from './shared.js';

export const PURGE_SESSIONS = 'identity.purge_sessions';
export const purgeSessions = definerTask(PURGE_SESSIONS, 'identity_purge_sessions');
