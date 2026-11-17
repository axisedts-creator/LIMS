// identity.purge_auth_events (02-TRD §10 crontab, platform): one call of app.identity_purge_auth_events() (02-CV §5.11; 08 A15.3).
import { definerTask } from './shared.js';

export const PURGE_AUTH_EVENTS = 'identity.purge_auth_events';
export const purgeAuthEvents = definerTask(PURGE_AUTH_EVENTS, 'identity_purge_auth_events');
