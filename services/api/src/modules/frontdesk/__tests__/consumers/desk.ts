// FD-T12 review follow-up harness: the three desk operations F12 confirmPreRegisteredOrder, F22 listOrderFlags, F23 resolveOrderFlag (02-TRD §5.1; plan row FD-T12 "Consumers + flags + confirm F12, F22, F23").
// Same convention as ../registration/helpers.ts and ../orders/helpers.ts: the handler is driven with a request-shaped object + a HandlerContext over a REAL PG17 tx (lims_api, RLS on); ports are the REAL fakes.
// Idempotency-Key replay is the C0 core hook (not the handler): the header is sent, the replay itself is covered by core tests; this harness asserts the contract declares it (flags.static.test.ts).
// If-Match = the row `version` as `"<n>"` (02-CV §4.2, as FD-T09): absent -> common.precondition_required, stale -> common.version_conflict. Synthetic data only.
import { access } from '../../../../core/audit/access.js';
import { handlers } from '../../handlers/index.js';
import { rows } from '../integration/helpers.js';
import { CENTRE, NOW, SYS_ACTOR, TENANT_A, TENANT_B, appTx, makeIdentity, ownerRows, rejection, req, seed, uid } from '../patients/helpers.js';
import { ctxFor, rworld, type RWorld } from '../registration/helpers.js';
import { ensureTaskRegistry, seedLimits } from '../registration/helpers.js';

export { rows, rworld, seed, uid, rejection, ownerRows };
export const EDIT = 'frontdesk.order.edit';
export const READ = 'frontdesk.order.read';
export const CREATE = 'frontdesk.registration.create';
export const INVOICE = 'billing.invoice.issue';
const H = handlers as unknown as Record<string, (r: any, ctx: any) => Promise<{ status: number; body?: any }>>;

export interface DeskOpts { grants?: readonly string[]; tenant?: string; centreIds?: readonly string[]; ifMatch?: string | null; key?: string; failEvent?: string; w?: RWorld }
export interface DeskReply { status: number; body: any; wrote: boolean; probe: { logs: string[]; accessCalls: any[]; ctx: any }; w: RWorld }

/** F12: one confirm = one request tx. On throw the tx rolls back and the in-memory spies drop what it published (as the real outbox would). */
export async function confirm(orderId: string, body: unknown, o: DeskOpts = {}): Promise<DeskReply> {
  await seedLimits();
  await ensureTaskRegistry();
  const tenant = o.tenant ?? TENANT_A;
  const w = o.w ?? rworld();
  const probe: DeskReply['probe'] = { logs: [], accessCalls: [], ctx: undefined };
  const out = await appTx(tenant, async (tx: any) => {
    const ctx = ctxFor(tx, tenant, w, { grants: o.grants ?? [CREATE, INVOICE], centreIds: o.centreIds, failEvent: o.failEvent } as any,
      { logs: probe.logs, accessCalls: probe.accessCalls, identity: undefined, requestId: uid(), ctx: undefined });
    ctx.operationId = 'confirmPreRegisteredOrder';
    probe.ctx = ctx;
    const headers: Record<string, string> = { 'idempotency-key': o.key ?? uid() };
    const v = o.ifMatch === undefined ? `"${Number((await ownerRows('frontdesk.orders', 'id = $1', [orderId]))[0]?.version ?? 1)}"` : o.ifMatch;
    if (v !== null) headers['if-match'] = v;
    try {
      const reply = await H['confirmPreRegisteredOrder']!(req({ params: { order_id: orderId }, body, headers }), ctx);
      const x = await tx.query('SELECT txid_current_if_assigned() AS x');
      return { ...reply, wrote: x.rows[0].x !== null };
    } catch (e) { w.spy.rollback(tx); w.notif.__rollback(tx); throw e; }
  });
  return { ...(out as any), probe, w };
}
export const confirmFails = (orderId: string, body: unknown, o: DeskOpts = {}) => rejection(confirm(orderId, body, o));

type FlagOp = 'listOrderFlags' | 'resolveOrderFlag';
/** F22 / F23 over a request tx (RLS on). F23 sends Idempotency-Key + If-Match (default: the flag's current version). */
export async function flagCall(op: FlagOp, r: { query?: object; flagId?: string; body?: unknown }, o: DeskOpts = {}): Promise<DeskReply> {
  const tenant = o.tenant ?? TENANT_A;
  const side = tenant === TENANT_B ? 'b' : 'a';
  const identity: any = makeIdentity(o.grants ?? [op === 'listOrderFlags' ? READ : EDIT], { centreIds: o.centreIds ?? [CENTRE[side]] });
  const probe: DeskReply['probe'] = { logs: [], accessCalls: [], ctx: undefined };
  const headers: Record<string, string> = {};
  if (op === 'resolveOrderFlag') {
    headers['idempotency-key'] = o.key ?? uid();
    const v = o.ifMatch === undefined ? `"${Number((await ownerRows('frontdesk.order_flags', 'id = $1', [r.flagId]))[0]?.version ?? 1)}"` : o.ifMatch;
    if (v !== null) headers['if-match'] = v;
  }
  const out = await appTx(tenant, async (tx: any) => {
    tx.startedAt = NOW;
    const log = (lvl: string) => (obj: object, msg?: string) => { probe.logs.push(`${lvl} ${JSON.stringify(obj)} ${msg ?? ''}`); };
    const ctx: any = { operationId: op, clientIp: '203.0.113.9', log: { info: log('info'), warn: log('warn'), error: log('error') }, tenantId: tenant, tx, requestId: uid(), now: () => NOW,
      centreId: CENTRE[side], actor: { type: 'system', id: SYS_ACTOR, membershipId: uid() }, ports: { IdentityPort: identity } };
    ctx.audit = { access: async (e: any) => { probe.accessCalls.push(e); await access(ctx, e); } };
    probe.ctx = ctx;
    const reply = await H[op]!(req({ query: r.query ?? {}, params: r.flagId ? { flag_id: r.flagId } : {}, body: r.body, headers }), ctx);
    const x = await tx.query('SELECT txid_current_if_assigned() AS x');
    return { ...reply, wrote: x.rows[0].x !== null };
  });
  return { ...(out as any), probe };
}
export const listFlags = (query: object = {}, o: DeskOpts = {}) => flagCall('listOrderFlags', { query }, o);
export const resolveFlag = (flagId: string, body: unknown, o: DeskOpts = {}) => flagCall('resolveOrderFlag', { flagId, body }, o);
export const listFlagsFail = (query: object, o: DeskOpts = {}) => rejection(listFlags(query, o));
export const resolveFlagFails = (flagId: string, body: unknown, o: DeskOpts = {}) => rejection(resolveFlag(flagId, body, o));
export const flagRow = async (id: string) => (await ownerRows('frontdesk.order_flags', 'id = $1', [id]))[0];
