// POST forgot password (03-APP-FLOW §3.7; 01-PRD AC-A7.1; 07-SECURITY AU-T5; 02-TRD §10 identity.send_recovery; 08 A25 D-212/D-219/P-61).
// Constant 202 {} for any e-mail: the handler does NO GoTrue call and NO existence-dependent read; it always writes the tenant-less
// password_reset_requested event + enqueues the platform task (job_key dedupes to <= 1 mail / 10 min / account) and the job decides.
// One ctx.db.identityAuthTx without a tenant. The link TTL is GoTrue's (D-219).
import { createHash } from 'node:crypto';
import { LimsError } from '../../../core/errors.js';
import type { Handler, HandlerContext, HandlerRequest } from '../../../core/module.js';
import type { Tx, TxFn, TxInput } from '../../../core/db/tx.js';
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { createAuthEventsRepo, createAuthRepo, type AuthEvent } from '../repository/auth-events.repo.js';
import type { AuthLimits } from '../service/auth.service.js';
import { createAuthLimits } from './loginStaff.js';
import { bodyObject, envHmac, invalid } from './verifyMfaChallenge.js';

export interface RecoveryRequestDeps {
  repo: { enqueue(tx: Tx, taskIdentifier: string, payload: Record<string, unknown>, jobKey: string): Promise<void> };
  events: { recordTenantless(tx: Tx, e: AuthEvent): Promise<void> };
  limits: Pick<AuthLimits, 'consumeAttempt'>;
  hmac?: (normalisedEmail: string) => string; newId?: () => string; now?: () => Date;
}
interface Hctx extends HandlerContext {
  requestId: string; actor?: { type: string; id: string };
  db: { identityAuthTx<T>(input: TxInput, fn: TxFn<T>): Promise<T> };
}

const OPERATION = Object.freeze({ module: 'identity', operationId: 'requestPasswordRecovery', context: 'identity_auth' });
const TASK = 'identity.send_recovery';
const BUCKET_MS = 10 * 60_000;   // 02-TRD §10: job_key recovery:<sha256(email_norm)>:<10-min bucket>
const EMAIL_MAX = 254;

export function createRequestPasswordRecovery(deps: RecoveryRequestDeps) {
  const hmac = deps.hmac ?? envHmac;
  const newId = deps.newId ?? uuidv7;
  const now = deps.now ?? (() => new Date());
  return async (req: HandlerRequest, hctx: HandlerContext) => {
    const ctx = hctx as Hctx;
    const { email } = bodyObject(req.body, ['email']);
    if (typeof email !== 'string') throw invalid();
    const norm = email.trim().normalize('NFC').toLowerCase();
    if (norm.length < 3 || norm.length > EMAIL_MAX || !norm.includes('@')) throw invalid();
    const actorId = ctx.actor?.id;
    if (typeof actorId !== 'string' || !actorId) throw new LimsError('common.internal');
    const ua = (req.headers as Record<string, unknown> | undefined)?.['user-agent'];
    const userAgent = typeof ua === 'string' ? ua : undefined;

    const k = hmac(norm);
    await deps.limits.consumeAttempt(k);   // login tier a:<hmac>: same key shape for known and unknown e-mails
    const bucket = Math.floor(now().getTime() / BUCKET_MS);
    const jobKey = `recovery:${createHash('sha256').update(norm).digest('hex')}:${bucket}`;

    await ctx.db.identityAuthTx({ operation: OPERATION, requestId: ctx.requestId, clientIp: ctx.clientIp, userAgent }, async (tx) => {
      await deps.events.recordTenantless(tx, { id: newId(), eventType: 'password_reset_requested', emailHmacHex: k, clientIp: ctx.clientIp,
        userAgent, requestId: ctx.requestId, actorId });
      await deps.repo.enqueue(tx, TASK, { email_norm: norm }, jobKey);
    });
    return { status: 202 as const, body: {} };
  };
}

const repo = createAuthRepo();
const events = createAuthEventsRepo();
export const requestPasswordRecovery: Handler = (async (req: HandlerRequest, hctx: HandlerContext) =>
  createRequestPasswordRecovery({ repo, events, limits: createAuthLimits((hctx as { rateLimit?: Parameters<typeof createAuthLimits>[0] }).rateLimit) })(req, hctx)) as Handler;
