// Idempotency-Key hook (02-TRD §6.6, 03-APP-FLOW §3.1 K1–K5, 08 A25 D-202 / D-213). No Fastify types: the pipeline calls
// begin() at stage 6, finish() inside the request transaction at stage 10, release() after a rollback at stage 11.
// Tenant / actor always come from the verified claims, never from the request. Bodies and keys are never logged.
import { createHash } from 'node:crypto';
import type { DbClaims } from './auth/claims.js';
import type { Db, Tx } from './db/tx.js';
import { LimsError } from './errors.js';

export interface IdemOperation {
  readonly module: string; readonly operationId: string; readonly context?: string | undefined;
  readonly idempotency?: 'none' | 'optional' | 'required' | undefined;
}
export interface IdemRequest {
  readonly operation: IdemOperation; readonly method: string; readonly routeTemplate: string;
  readonly pathParams?: unknown; readonly query?: unknown; readonly body?: unknown;
  readonly idempotencyKey?: string | undefined; readonly claims: DbClaims;
  readonly requestId: string; readonly clientIp: string; readonly userAgent?: string | undefined;
}
export interface IdemHandle {
  readonly tenantId: string | null; readonly actorId: string; readonly key: string; readonly request: IdemRequest;
}
export type BeginResult =
  | { action: 'skip' }
  | { action: 'proceed'; handle: IdemHandle }
  | { action: 'replay'; status: number; body: unknown; headers: { 'Idempotent-Replayed': 'true' } };
export interface Outcome { readonly status: number; readonly body?: unknown; readonly commitOnError?: boolean }
type LogFn = (obj: object, msg?: string) => void;
export interface IdempotencyOptions { readonly db: Db; readonly now?: () => number; readonly log?: { info?: LogFn; warn?: LogFn; error?: LogFn } }

const KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;
// Row identity: IS NOT DISTINCT FROM, because `tenant_id = NULL` never matches a platform (NULL-tenant) key (D-213).
const WHERE = 'tenant_id IS NOT DISTINCT FROM $1::uuid AND actor_id = $2::uuid AND key = $3';
const CLAIM_SQL = `INSERT INTO core.idempotency_keys (tenant_id, actor_id, key, method, route, request_sha256, state, created_at, expires_at)
  VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, 'in_progress', now(), now() + interval '7 days')
  ON CONFLICT (tenant_id, actor_id, key) DO NOTHING RETURNING key`;
const SELECT_SQL = `SELECT request_sha256, state, response_status, response_body FROM core.idempotency_keys WHERE ${WHERE}`;
const TAKEOVER_SQL = `UPDATE core.idempotency_keys SET created_at = now()
  WHERE ${WHERE} AND state = 'in_progress' AND created_at <= now() - interval '60 seconds' RETURNING key`; // [CONV] 60 s
const COMPLETE_SQL = `UPDATE core.idempotency_keys SET state = 'completed', response_status = $4, response_body = $5::jsonb WHERE ${WHERE}`;
const RELEASE_SQL = `DELETE FROM core.idempotency_keys WHERE ${WHERE} AND state = 'in_progress'`;

/** Canonical JSON: keys sorted, no whitespace, undefined object members dropped (02-TRD §6.6 step 1). */
function canon(v: unknown): string {
  if (v === undefined) return 'null';
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canon(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}
export const requestSha256 = (r: Pick<IdemRequest, 'method' | 'routeTemplate' | 'pathParams' | 'query' | 'body'>): Buffer =>
  createHash('sha256').update(canon({ method: r.method, route_template: r.routeTemplate, path_params: r.pathParams ?? {}, query: r.query ?? {}, body: r.body })).digest();

const inProgress = (): LimsError => Object.assign(new LimsError('common.idempotency_in_progress'), { retryAfterSeconds: 1 });

export function createIdempotency(o: IdempotencyOptions) {
  const warn: LogFn = o.log?.warn ?? o.log?.error ?? (() => undefined);
  const txInput = (r: IdemRequest) => ({
    claims: r.claims, requestId: r.requestId, clientIp: r.clientIp, userAgent: r.userAgent,
    operation: { module: r.operation.module, operationId: r.operation.operationId, context: r.operation.context },
  });
  const ids = (h: IdemHandle) => [h.tenantId, h.actorId, h.key];

  return {
    async begin(req: IdemRequest): Promise<BeginResult> {
      const mode = req.operation.idempotency ?? 'none';
      if (mode === 'none') return { action: 'skip' };
      const key = req.idempotencyKey === '' ? undefined : req.idempotencyKey;
      if (key === undefined) {
        if (mode === 'required') throw new LimsError('common.idempotency_key_required');
        return { action: 'skip' };
      }
      if (typeof key !== 'string' || !KEY_RE.test(key)) {
        throw new LimsError('common.validation_failed', undefined,
          [{ path: 'header.Idempotency-Key', code: 'common.field_invalid', message: 'Idempotency-Key must match ^[A-Za-z0-9_-]{1,64}$' }]);
      }
      // §6.6 step 6: platform-context keys carry a NULL tenant (D-213); everything else needs an authenticated tenant actor.
      const c = req.claims as unknown as Record<string, unknown> | undefined;
      const platform = req.operation.context === 'platform';
      const actorId = c?.sub;
      const tenantId = platform ? null : c?.tenant_id;
      if (typeof actorId !== 'string' || (platform ? c?.scope !== 'platform' || c?.tenant_id != null : typeof tenantId !== 'string')) {
        throw new LimsError('common.internal'); // public / anonymous operations never use idempotency
      }
      const handle: IdemHandle = { tenantId: tenantId as string | null, actorId, key, request: req };
      const sha = requestSha256(req);
      const vals = ids(handle);

      const d = await o.db.requestTx(txInput(req), async (tx) => {
        const ins = await tx.query(CLAIM_SQL, [...vals, req.method, req.routeTemplate, sha]);
        if (ins.rows.length > 0) return { kind: 'proceed' } as const;
        const row = (await tx.query(SELECT_SQL, vals)).rows[0];
        if (!row) return { kind: 'busy' } as const; // released between INSERT and SELECT: the client retries
        if (!Buffer.from(row.request_sha256).equals(sha)) return { kind: 'reused' } as const;
        if (row.state === 'completed') return { kind: 'replay', status: Number(row.response_status), body: row.response_body ?? undefined } as const;
        const took = await tx.query(TAKEOVER_SQL, vals); // K4: abandoned claim (crashed process)
        return took.rows.length > 0 ? { kind: 'proceed' } as const : { kind: 'busy' } as const;
      });

      switch (d.kind) {
        case 'proceed': return { action: 'proceed', handle };
        case 'replay': return { action: 'replay', status: d.status, body: d.body, headers: { 'Idempotent-Replayed': 'true' } };
        case 'reused': throw new LimsError('common.idempotency_key_reused');
        default: throw inProgress();
      }
    },

    /** Stage 10, inside the request transaction (K2 / K3, D-202). */
    async finish(tx: Tx, handle: IdemHandle, out: Outcome): Promise<void> {
      if (out.status < 400) {
        await tx.query(COMPLETE_SQL, [...ids(handle), out.status, out.body === undefined ? null : JSON.stringify(out.body)]);
      } else if (out.commitOnError) {
        await tx.query(RELEASE_SQL, ids(handle));
      }
    },

    /** After a rollback, in its own transaction. Never rejects: a stuck key ages out via K4. */
    async release(handle: IdemHandle): Promise<void> {
      try {
        await o.db.requestTx(txInput(handle.request), async (tx) => { await tx.query(RELEASE_SQL, ids(handle)); });
      } catch (e) {
        warn({ event: 'idempotency_release_failed', request_id: handle.request.requestId, code: (e as { code?: unknown } | null)?.code }, 'idempotency_release_failed');
      }
    },
  };
}
export type Idempotency = ReturnType<typeof createIdempotency>;
