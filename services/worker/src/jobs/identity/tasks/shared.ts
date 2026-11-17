// Shared bits of the identity worker tasks (T11): payload checks, GoTrue error classes, the lazy GoTrue gateway, tx query.
import { LimsError as ApiLimsError } from '../../../../../api/src/core/errors.js';
import { LimsError, type ErrorCode } from '../../../../../../packages/shared-ts/src/errors/index.js';
import { GoTrueError, type GoTrueGateway } from '../../../../../api/src/modules/identity/gotrue/gateway.js';
import { gotrueGatewayFromEnv } from '../../../../../api/src/modules/identity/gotrue/gateway.http.js';
import type { JobContext, TaskHandler } from '../../../core/manifest.js';

/** [CONV] the GoTrue gateway throws the api LimsError, core/deadletter only knows the contracts one (else 'common.internal'):
 *  re-throw with the same code (detail dropped, it never reaches the dead letter). Everything else passes through untouched. */
export const coreErrors = (h: TaskHandler): TaskHandler => async (p, ctx) => {
  try { await h(p, ctx); } catch (e) { throw e instanceof ApiLimsError ? new LimsError(e.code as ErrorCode) : e; }
};

export type Row = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);

/** A payload no enqueuer sends = a bug: reject (retries -> dead letter), never ack silently. The detail carries no payload data. */
export const malformed = (task: string): never => { throw new LimsError('common.validation_failed' as ErrorCode, `${task}: malformed payload`); };

/** Payload must be an object whose keys are exactly one of `shapes`. */
export function shapeOf(payload: unknown, shapes: Record<string, readonly string[]>): [string, Row] | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const keys = Object.keys(payload).sort().join(',');
  const hit = Object.entries(shapes).find(([, ks]) => [...ks].sort().join(',') === keys);
  return hit ? [hit[0], payload as Row] : undefined;
}

/** Payload tenant_id must be the job's tenant (both absent = platform task). */
export const sameTenant = (p: Row, ctx: Pick<JobContext, 'tenantId'>) =>
  'tenant_id' in p ? isUuid(p['tenant_id']) && p['tenant_id'] === ctx.tenantId : ctx.tenantId === undefined;

/** GoTrue says the thing is already gone. */
export const gone = (e: unknown, codes: readonly string[]) => e instanceof GoTrueError && codes.includes(e.errorCode);
/** GoTrue 4xx other than 401/403 (bad/rotated service key: operator must see a dead letter) and 429: retrying cannot help. */
export const permanent = (e: unknown): e is GoTrueError =>
  e instanceof GoTrueError && e.status >= 400 && e.status < 500 && ![401, 403, 429].includes(e.status);

let gateway: GoTrueGateway | undefined;
/** Lazy: nothing is built at import time. */
export const gotrue = () => (gateway ??= gotrueGatewayFromEnv());

export const q = async (tx: unknown, sql: string, v: unknown[]) => (await (tx as { query(t: string, v: unknown[]): Promise<{ rows: Row[] }> }).query(sql, v)).rows;
/** T27 platform task guard: payload {} and no job tenant. */
export const platformOnly = (task: string, payload: unknown, ctx: Pick<JobContext, 'tenantId'>) => {
  if (!shapeOf(payload, { none: [] }) || ctx.tenantId !== undefined) malformed(task);
};
/** T27 per_tenant guard: payload exactly {tenant_id} = the job tenant. Returns the tenant. */
export const tenantOnly = (task: string, payload: unknown, ctx: Pick<JobContext, 'tenantId'>): string => {
  const s = shapeOf(payload, { t: ['tenant_id'] });
  if (!s || !sameTenant(s[1], ctx) || ctx.tenantId === undefined) malformed(task);
  return ctx.tenantId!;
};
/** T27 maintenance cron task: exactly one call of its inventoried DEFINER (the DEFINER sets/resets app.maintenance itself, A15.3 / D-T19). */
export const definerTask = (task: string, fn: string): TaskHandler => async (payload, ctx) => {
  platformOnly(task, payload, ctx);
  const rows = await q(ctx.tx, `SELECT app.${fn}() AS n`, []);
  ctx.log?.info?.({ event: task, affected: rows[0]?.['n'] ?? rows[0]?.[fn] ?? null });
};

/** [CONV] platform rows (tenant_id NULL) are not reachable by the worker role and no DEFINER exists for them yet: fail closed (dead letter, visible). */
export const platformUnwired = (what: string): never => { throw new LimsError('common.internal' as ErrorCode,`identity worker: platform ${what} not wired`); };
