// POST /v1/identity/auth/partner/login (T31; 02-TRD s5.1; 03-APP-FLOW s3.5a; 07-SECURITY AU-T14; 08 R10). Partner BFF only
// (x-edge-exposure internal), x-context identity_auth, rate tier login. Session kind partner; only an actor_type 'partner'
// membership of app.identity_login_context is accepted. Envelope (one identityAuthTx, P-42, P-61): loginStaff.ts.
import type { Handler } from '../../../core/module.js';
import type { AuthDeps } from '../service/auth.service.js';
import { createLoginHandler, parseBody, wiredAuthDeps } from './loginStaff.js';

export const createLoginPartner = (deps: AuthDeps): Handler =>
  createLoginHandler('loginPartner', parseBody, () => deps, (svc, c, i) => svc.loginPartner(c, i));

export const loginPartner: Handler = createLoginHandler('loginPartner', parseBody, wiredAuthDeps, (svc, c, i) => svc.loginPartner(c, i));
