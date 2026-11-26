// POST /v1/identity/mobile/sessions (T31; 02-TRD s4 item 10, s5.1; 05-SCHEMA s4.1; 07-SECURITY AU-T17, AU-T22; 08 R10). Public app
// route (no BFF), x-context identity_auth, rate tier login. Session kind staff_mobile: the membership must hold
// homecollection.sync.upload (403 auth.forbidden), no idle timeout (idle = absolute = LIMS_IDENTITY_MOBILE_ABSOLUTE_HOURS).
import type { Handler } from '../../../core/module.js';
import type { AuthDeps, MobileLoginInput } from '../service/auth.service.js';
import { createLoginHandler, parseBody, wiredAuthDeps } from './loginStaff.js';
import { bodyObject, invalid } from './verifyMfaChallenge.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PHONE_RE = /^\+[1-9][0-9]{7,14}$/;

/** MobileSessionOpenRequest { email | phone_e164 (exactly one), password, app_instance_id (uuid), app_platform android|ios } (additionalProperties: false).
 *  PHLEBO-UI-FULL-1: with phone_e164 the service resolves the account's email itself; an unknown phone fails like a wrong password. */
function parseMobile(b: unknown): MobileLoginInput {
  const o = bodyObject(b, ['email', 'phone_e164', 'password', 'app_instance_id', 'app_platform']);
  const phone = o['phone_e164'];
  if ((phone === undefined) === (o['email'] === undefined)) throw invalid();
  if (phone !== undefined && (typeof phone !== 'string' || !PHONE_RE.test(phone))) throw invalid();
  // parseBody keeps its email/password rules; for a phone login the phone stands in until the service resolves it.
  const { email, password } = parseBody({ email: phone ?? o['email'], password: o['password'] });
  const id = o['app_instance_id']; const platform = o['app_platform'];
  if (typeof id !== 'string' || !UUID_RE.test(id)) throw invalid();
  if (platform !== 'android' && platform !== 'ios') throw invalid();
  return { email, password, appInstanceId: id.toLowerCase(), appPlatform: platform, ...(typeof phone === 'string' ? { phoneE164: phone } : {}) };
}

export const createOpenMobileSession = (deps: AuthDeps): Handler =>
  createLoginHandler('openMobileSession', parseMobile, () => deps, (svc, c, i) => svc.openMobileSession(c, i));

export const openMobileSession: Handler = createLoginHandler('openMobileSession', parseMobile, wiredAuthDeps, (svc, c, i) => svc.openMobileSession(c, i));
