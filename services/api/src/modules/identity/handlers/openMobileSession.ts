// POST /v1/identity/mobile/sessions (T31; 02-TRD s4 item 10, s5.1; 05-SCHEMA s4.1; 07-SECURITY AU-T17, AU-T22; 08 R10). Public app
// route (no BFF), x-context identity_auth, rate tier login. Session kind staff_mobile: the membership must hold
// homecollection.sync.upload (403 auth.forbidden), no idle timeout (idle = absolute = LIMS_IDENTITY_MOBILE_ABSOLUTE_HOURS).
import type { Handler } from '../../../core/module.js';
import type { AuthDeps, MobileLoginInput } from '../service/auth.service.js';
import { createLoginHandler, parseBody, wiredAuthDeps } from './loginStaff.js';
import { bodyObject, invalid } from './verifyMfaChallenge.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** MobileSessionOpenRequest { email, password, app_instance_id (uuid), app_platform android|ios } (additionalProperties: false) */
function parseMobile(b: unknown): MobileLoginInput {
  const o = bodyObject(b, ['email', 'password', 'app_instance_id', 'app_platform']);
  const { email, password } = parseBody({ email: o['email'], password: o['password'] });
  const id = o['app_instance_id']; const platform = o['app_platform'];
  if (typeof id !== 'string' || !UUID_RE.test(id)) throw invalid();
  if (platform !== 'android' && platform !== 'ios') throw invalid();
  return { email, password, appInstanceId: id.toLowerCase(), appPlatform: platform };
}

export const createOpenMobileSession = (deps: AuthDeps): Handler =>
  createLoginHandler('openMobileSession', parseMobile, () => deps, (svc, c, i) => svc.openMobileSession(c, i));

export const openMobileSession: Handler = createLoginHandler('openMobileSession', parseMobile, wiredAuthDeps, (svc, c, i) => svc.openMobileSession(c, i));
