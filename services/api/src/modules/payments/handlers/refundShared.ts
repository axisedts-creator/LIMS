// PG-T15 — what P11 / P7b / P11b share (TRD §5.1, §5.4, §6.6). Order in every handler: (1) staff actor + assertRole WITHOUT a centre, before any payments.* read; (2) shape validation;
// (3) load the refund (tenant-scoped, so another tenant's id is not_found); (4) assertRole WITH the row's centre — auth.forbidden there is answered as 404 (ST-18);
// (5) state rules and the work. No ctx.audit and no access-log row: refund transitions are recorded by the row-audit trigger only (08 A19 D-112, ST-24).
import { LimsError } from '../../../core/errors.js';
import { toRefundDto } from '../mappers/intent.mapper.js';
import { findRefund } from '../repository/refunds.repo.js';
import { invalid, notFound, uuid, type Ctx, type Row } from '../repository/shared.js';
import { OPEN_REFUND } from '../service/refund.completion.js';

type Port = { assertRole(c: unknown, r: { permission: string; centreId?: string }): Promise<unknown> };
export type RefundCtx = Omit<Ctx, 'ports' | 'actor'> & { actor: Ctx['actor'] & { membershipId?: string }; ports: Ctx['ports'] & { IdentityPort: Port } };
export interface Req { params?: unknown; query?: unknown; headers?: unknown; body?: unknown }

export const APPROVE = 'payments.refund.approve', RESOLVE = 'payments.intent.resolve';
const MAX_VERSION = 2147483647;

export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** a plain object with only these keys (so no status / amount / ledger id can ride along); undefined = no body = {} only when `optional` */
export function only(v: unknown, keys: readonly string[], optional = false): Record<string, unknown> {
  if (v === undefined && optional) return {};
  if (!isObj(v)) return invalid('body');
  for (const k of Object.keys(v)) if (!keys.includes(k)) invalid(k);
  return v;
}
export const text500 = (v: unknown, path: string): string | undefined => (v === undefined ? undefined : typeof v === 'string' && v.length <= 500 ? v : invalid(path));

/** staff only (08 R8: patient / portal / device actors never reach a refund), then the permission WITHOUT a centre */
export async function staff(ctx: RefundCtx, permission: string): Promise<void> {
  if (ctx.actor?.type !== 'user') throw new LimsError('auth.forbidden');
  await ctx.ports.IdentityPort.assertRole(ctx, { permission });
}
export const refundId = (req: Req): string => uuid(isObj(req.params) ? req.params['refund_id'] : undefined, 'refund_id');

/** [CONV] If-Match "<n>" exactly as P4: missing -> 428, malformed -> 400. */
export function ifMatch(headers: unknown): number {
  const h = isObj(headers) ? headers['if-match'] : undefined;
  if (h === undefined) throw new LimsError('common.precondition_required');
  const m = typeof h === 'string' ? /^"([1-9][0-9]{0,9})"$/.exec(h) : null;
  if (!m || Number(m[1]) > MAX_VERSION) return invalid('if-match');
  return Number(m[1]);
}

/** load + centre scope + "requested / held_for_review only" (else payments.refund_not_allowed) */
export async function loadOpen(ctx: RefundCtx, id: string, permission: string): Promise<Row> {
  const row = await findRefund(ctx, id) ?? notFound();
  try { await ctx.ports.IdentityPort.assertRole(ctx, { permission, centreId: row['centre_id'] }); } catch (e) {
    if (e instanceof LimsError && e.code === 'auth.forbidden') notFound();      // another centre's refund is "not found", never 403 (ST-18)
    throw e;
  }
  if (!(OPEN_REFUND as readonly string[]).includes(row['status'])) throw new LimsError('payments.refund_not_allowed');
  return row;
}

export const reply = (row: Row): { status: number; body: unknown } => ({ status: 200, body: toRefundDto(row) });
export const unavailable = (): LimsError => new LimsError('payments.gateway_not_available');
