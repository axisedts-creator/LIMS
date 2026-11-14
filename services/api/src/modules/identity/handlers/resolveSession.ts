// POST /v1/identity/auth/session/resolve (T8; 02-TRD s5.1; 03-APP-FLOW s3.5). BFF-only (bffSession), x-context identity_auth.
// Body ResolveSessionRequest { touch: boolean } (additionalProperties: false). The X-Lims-Background header is the BFF's business:
// the API reads only body.touch. Client IP = ctx.clientIp (P-61). Logic: service/session.service.ts.
import { LimsError } from '../../../core/errors.js';
import type { Handler, HandlerContext, HandlerRequest } from '../../../core/module.js';
import type { TxFn, TxInput } from '../../../core/db/tx.js';
import { createAuthEventsRepo } from '../repository/auth-events.repo.js';
import { createMfaRepo, type MfaRepo } from '../repository/mfa.repo.js';
import { createSessionService, type SessionCall, type SessionDeps } from '../service/session.service.js';
import { bodyObject, gw, invalid, sessionToken } from './verifyMfaChallenge.js';

interface SessionHctx extends HandlerContext {
  requestId: string; bffKey?: string; actor?: { type: string; id: string }; commitOnError?: () => void;
  db: { identityAuthTx<T>(input: TxInput, fn: TxFn<T>): Promise<T> };
}
export const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** request -> SessionCall; E-9: missing / malformed cookie looks like any other dead session */
export function sessionCall(operationId: SessionCall['operationId'], req: HandlerRequest, hctx: HandlerContext,
  token: string | undefined = sessionToken(req)): SessionCall {
  const ctx = hctx as SessionHctx;
  const actorId = ctx.actor?.id;
  if (typeof actorId !== 'string' || !actorId) throw new LimsError('common.internal');   // system actor = created_by of every write
  if (!token || !TOKEN_RE.test(token)) throw new LimsError('auth.session_expired');
  const ua = (req.headers as Record<string, unknown> | undefined)?.['user-agent'];
  return { operationId, token, bffKey: ctx.bffKey, actorId, requestId: ctx.requestId, clientIp: ctx.clientIp, userAgent: typeof ua === 'string' ? ua : undefined,
    commitOnError: ctx.commitOnError, db: ctx.db };
}

export const createResolveSession = (deps: SessionDeps) => {
  const svc = createSessionService(deps);
  return async (req: HandlerRequest, hctx: HandlerContext) => {
    const { touch } = bodyObject(req.body, ['touch']);
    if (typeof touch !== 'boolean') throw invalid();
    return svc.resolve(sessionCall('resolveSession', req, hctx), touch);
  };
};

// ---------- wiring (shared with logoutSession) ----------
const wiredGotrue: SessionDeps['gotrue'] = { refresh: (rt) => gw().refresh(rt) };   // the one lazily built HTTP gateway of T7
let wiredRepo: MfaRepo | undefined;
const wiredEvents = createAuthEventsRepo();
export function wireSession(factory: (deps: SessionDeps) => (req: HandlerRequest, hctx: HandlerContext) => Promise<unknown>,
  extra: Partial<SessionDeps> = {}): Handler {
  return (async (req: HandlerRequest, hctx: HandlerContext) =>
    factory({ gotrue: wiredGotrue, repo: (wiredRepo ??= createMfaRepo()), events: wiredEvents, ...extra })(req, hctx)) as Handler;
}

export const resolveSession: Handler = wireSession(createResolveSession);
