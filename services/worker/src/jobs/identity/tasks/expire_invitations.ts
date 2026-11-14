// identity.expire_invitations (02-TRD §10 crontab, platform): one call of app.identity_expire_invitations() (08 A15.3).
import { definerTask } from './shared.js';

export const EXPIRE_INVITATIONS = 'identity.expire_invitations';
export const expireInvitations = definerTask(EXPIRE_INVITATIONS, 'identity_expire_invitations');
