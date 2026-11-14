// PG-T14 test harness: refund operations P6-P10 + port refund() (TRD §5.1, §6.6) over the PG-T08 port harness (in-memory DB fake of helpers/merchantDb.ts,
// BillingPort fake double with getOrderBalance, job spy). Synthetic data only.
//
// SEAM THE WRITER MUST FOLLOW (tester contract; the TRD fixes behaviour, DTO fields and port signature, not these wiring names; dispute via .orchestra/notes if wrong):
//   service/refund.service.ts   exports  createRefundService(deps: PaymentsDeps)  ->  {
//       listPaymentRefunds(ctx, query),                          // P6  query = { status?: string[], gateway?: string[], intent_id?, sort? }  -> { data: Row[], page: { limit, next_cursor? } }
//       getPaymentRefund(ctx, { refundId }),                      // P7  -> refund
//       createPaymentRefundRequest(ctx, { intentId, body }),      // P8  body = { refund_amount_paisa, reason_code, reason_text? }  -> the new refund (status pending_approval)
//       approvePaymentRefund(ctx, { refundId, body }),            // P9  body = { note? }                -> the refund after approve + port refund (status requested)
//       rejectPaymentRefund(ctx, { refundId, body }),             // P10 body = { reason_code, note? }   -> the refund (status rejected)
//       refund(ctx, input),                                       // the port refund(): { intentId, amount: {amountPaisa, currency}, reasonCode, idempotencyKey, approvalId } -> { refundId, status, replayed }
//     }
//   Every method returns the stored refund (node-pg row: bigint = decimal string, timestamptz = Date) or something with the same `id` / `status` fields (a RefundDto): the tests read
//   only `id` and `status` from a return value and read everything else from the database. Mapping to the RefundDto stays with mappers/intent.mapper.ts#toRefundDto.
//   ports/PaymentProviderPort.impl.ts  createPaymentProviderPort(deps).refund  = the same port refund() (it replaces the PG-T01 stub).
//   Per call the service uses ONLY: ctx.tx.query (dialect: helpers/merchantDb.ts), ctx.now() (ISO string), ctx.tenantId, ctx.actor ({ type, id, membershipId }),
//   ctx.ports.IdentityPort.assertRole(ctx, { permission, centreId? }), ctx.ports.BillingPort.getOrderBalance, deps.jobs.enqueue, deps.newId, deps.config. No wall clock, no ctx.audit.
//   (08 A19 D-112: refund operations are recorded by the row-audit trigger only, never by ctx.audit.access.)
import { FIXED_NOW, TENANTS } from '../../../../../../../packages/fakes/src/base';
import { LimsError } from '../../../../core/errors.js';
import { BRANCH, CENTRE, MERCHANT_ID, makePortHarness, type PortHarness } from './portHarness';

export const CENTRE_1 = CENTRE;                                   // '...0000000ce001'
export const CENTRE_2 = '01900000-0000-7000-8000-0000000ce002';
export const uid = (n: number): string => `01900000-0000-7000-8000-0000000f${String(n).padStart(4, '0')}`;
/** membership ids of the finance users (ctx.actor.membershipId); the two-person rule compares these */
export const M = { A: uid(9001), B: uid(9002) } as const;

export type Persona = 'A' | 'B' | 'A_aal1' | 'B_aal1' | 'requester_only' | 'approver_only' | 'front_desk' | 'reader' | 'finance_centre1';
const ALL = ['payments.reconciliation.read', 'payments.intent.resolve', 'payments.refund.request', 'payments.refund.approve'];
const PERMS: Record<Persona, string[]> = {
  A: ALL, B: ALL, A_aal1: ALL, B_aal1: ALL, finance_centre1: ALL,
  requester_only: ['payments.reconciliation.read', 'payments.refund.request'],
  approver_only: ['payments.reconciliation.read', 'payments.refund.approve'],
  front_desk: ['payments.intent.create'],
  reader: ['payments.reconciliation.read'],
};
const PRIVILEGED = new Set(['payments.intent.resolve', 'payments.refund.request', 'payments.refund.approve', 'payments.merchant_config.manage']);
export const membershipOf = (p: Persona): string => (p === 'B' || p === 'B_aal1' || p === 'approver_only' ? M.B : M.A);
export const actorIdOf = (p: Persona): string => uid(9100 + ['A', 'B', 'A_aal1', 'B_aal1', 'requester_only', 'approver_only', 'front_desk', 'reader', 'finance_centre1'].indexOf(p));

/** IdentityPort.assertRole double with the real error codes: auth.forbidden (no permission / other centre), auth.mfa_required (privileged permission at aal1). */
export function makeIdentity(persona: Persona, calls: { permission: string; centreId?: string; at: number }[], h: PortHarness) {
  return { async assertRole(_c: unknown, r: { permission: string; centreId?: string }): Promise<void> {
    calls.push({ permission: r.permission, ...(r.centreId ? { centreId: r.centreId } : {}), at: h.db.stmts.length });
    if (!PERMS[persona].includes(r.permission)) throw new LimsError('auth.forbidden');
    if ((persona === 'A_aal1' || persona === 'B_aal1') && PRIVILEGED.has(r.permission)) throw new LimsError('auth.mfa_required');
    if (persona === 'finance_centre1' && r.centreId !== undefined && r.centreId !== CENTRE_1) throw new LimsError('auth.forbidden');
  } };
}

export interface IntentSeed { id?: string; tenant?: 'A' | 'B'; gateway?: 'esewa' | 'khalti'; status?: string; amountPaisa?: number; refundedPaisa?: number;
  /** BillingPort.getOrderBalance().balanceDue in paisa; negative = overpaid (C4 cancelled the invoice) */
  balanceDue?: number; centre?: string }
export interface RefundSeed { id: string; intent: string; tenant?: 'A' | 'B'; status?: string; amountPaisa?: number; reason?: string; requestedBy?: string; approvedBy?: string; centre?: string;
  mode?: 'manual' | 'api'; gateway?: 'esewa' | 'khalti'; key?: string }
export interface Out { value?: any; code?: string; status?: number; err?: any }

/** global coded sets (05-SCHEMA §5 seed, the codes these tests use) */
const SETS: Record<string, [string, string, boolean?][]> = {
  refund_reasons: [['test_cancelled', 'Test cancelled'], ['overpayment', 'Overpayment'], ['service_not_provided', 'Service not provided'], ['duplicate_payment', 'Duplicate payment'], ['other', 'Other', true]],
  refund_reject_reasons: [['not_eligible', 'Not eligible'], ['wrong_amount', 'Wrong amount'], ['duplicate_request', 'Duplicate request'], ['other', 'Other', true]],
  refund_fail_reasons: [['gateway_confirmed_not_refunded', 'Gateway confirmed not refunded'], ['other', 'Other', true]],
};

export async function makeRefundHarness(o: { intents?: IntentSeed[]; thresholdPaisa?: number; apiRefunds?: boolean } = {}) {
  const h: PortHarness = await makePortHarness();
  let svcCache: Record<string, (ctx: any, input?: any) => Promise<any>> | undefined;
  /** loaded on the first call so the arrange helpers (and the helper self-test) work before PG-T14 exists */
  const service = async () => {
    if (svcCache) return svcCache;
    let mod: any;
    try { mod = await import('../../service/refund.service.js'); } catch (e: any) { throw new Error(`PG-T14 not implemented: service/refund.service.ts (${e?.message ?? e})`); }
    if (typeof mod.createRefundService !== 'function') throw new Error('PG-T14 not implemented: service/refund.service.ts must export createRefundService(deps) (see helpers/refundHarness.ts header)');
    return (svcCache = mod.createRefundService(h.deps));
  };

  const seeds = (o.intents ?? [{}]).map((s, i) => ({ id: s.id ?? uid(1 + i), tenant: s.tenant ?? 'A', gateway: s.gateway ?? 'khalti', status: s.status ?? 'settled', amountPaisa: s.amountPaisa ?? 225000,
    refundedPaisa: s.refundedPaisa ?? 0, balanceDue: s.balanceDue ?? -(s.amountPaisa ?? 225000), centre: s.centre ?? CENTRE_1, orderId: uid(101 + i) }));
  await h.seed({
    returnUrlHosts: ['app.lims.test'],
    orders: seeds.map((s) => ({ id: s.orderId, tenantId: TENANTS[s.tenant], dueAmountPaisa: s.balanceDue })),
    intents: seeds.map((s) => ({ id: s.id, tenantId: TENANTS[s.tenant], orderId: s.orderId, gateway: s.gateway, status: s.status, amountPaisa: s.amountPaisa, refundedPaisa: s.refundedPaisa,
      idempotencyKey: `seed-${s.id}` })),
  });
  for (const s of seeds) h.db.intents(TENANTS[s.tenant]).find((r) => r.id === s.id)!.centre_id = s.centre;
  let n = 0;
  for (const [set, codes] of Object.entries(SETS)) codes.forEach(([code, display, requiresText], i) => h.db.put('payments.g_cs_reasons', { id: uid(8000 + (++n)), set_name: set, code, display, requires_text: !!requiresText, sort_order: i + 1 }));
  if (o.thresholdPaisa !== undefined) for (const t of Object.values(TENANTS)) h.db.put('payments.settings', { tenant_id: t, refund_two_person_threshold_paisa: o.thresholdPaisa, created_by: t, updated_by: t });
  if (o.apiRefunds) h.db.accounts(TENANTS.A).find((a) => a.gateway === 'khalti')!.api_refunds_enabled = true;

  const idCalls: { permission: string; centreId?: string; at: number }[] = [];
  const intent = (id = seeds[0]!.id, tenant: 'A' | 'B' = 'A') => h.db.intents(TENANTS[tenant]).find((r) => r.id === id)!;
  const refunds = (tenant: 'A' | 'B' = 'A') => h.db.refunds(TENANTS[tenant]);
  const refundRow = (id: string, tenant: 'A' | 'B' = 'A') => refunds(tenant).find((r) => r.id === id)!;
  const access = (tenant: 'A' | 'B' = 'A') => h.db.accessRows(TENANTS[tenant]);
  /** a stored refund (arrange step: bypasses CHECKs on purpose) */
  const addRefund = (r: RefundSeed): string => {
    const tenant = TENANTS[r.tenant ?? 'A'], status = r.status ?? 'pending_approval', it = h.db.intents(tenant).find((x) => x.id === r.intent)!;
    h.db.put('payments.refunds', { id: r.id, tenant_id: tenant, intent_id: r.intent, order_id: it.order_id, centre_id: r.centre ?? it.centre_id, gateway: r.gateway ?? it.gateway, mode: r.mode ?? 'manual',
      status, amount_paisa: r.amountPaisa ?? 225000, reason_code: r.reason ?? 'test_cancelled', requested_by_membership_id: r.requestedBy ?? M.A, requested_at: new Date(FIXED_NOW),
      ...(r.key ? { idempotency_key: r.key } : {}),
      ...(['pending_approval', 'rejected'].includes(status) ? {} : { approved_by_membership_id: r.approvedBy ?? M.B, approved_at: new Date(FIXED_NOW) }),
      ...(status === 'held_for_review' ? { held_reason: 'refund_not_visible' } : {}), created_by: actorIdOf('A'), updated_by: actorIdOf('A') });
    return r.id;
  };
  /** re-point what BillingPort.getOrderBalance answers for an intent's order */
  const setBalance = (balanceDue: number, id = seeds[0]!.id, tenant: 'A' | 'B' = 'A'): void => h.setOrder({ id: intent(id, tenant).order_id, tenantId: TENANTS[tenant], dueAmountPaisa: balanceDue });

  const asOut = (e: any): Out => {
    if (e && typeof e.code === 'string') return { status: e.statusCode ?? 0, code: e.code, err: e };
    throw e;
  };
  /** one service call inside one DB transaction (rolled back, with the spies, when it throws - like the core pipeline) */
  async function call(op: string, input: unknown, c: { as?: Persona; tenant?: 'A' | 'B'; now?: string; actorType?: string } = {}): Promise<Out> {
    const tenantId = TENANTS[c.tenant ?? 'A'], now = c.now ?? FIXED_NOW, persona = c.as ?? 'A';
    let txRef: unknown;
    const svc = await service();
    try {
      const value = await h.db.run(async (dctx: any) => {
        txRef = dctx.tx;
        const ctx: any = { operationId: op, requestId: dctx.requestId, tenantId, actor: { type: c.actorType ?? 'user', id: actorIdOf(persona), membershipId: membershipOf(persona) },
          tx: dctx.tx, now: () => now, db: dctx.db, audit: dctx.audit, log: dctx.log, ports: { ...h.ports, IdentityPort: makeIdentity(persona, idCalls, h) } };
        return svc[op]!(ctx, input);
      }, { tenantId, now: () => new Date(now) });
      return { value };
    } catch (e: any) { if (txRef !== undefined) h.rollback(txRef); return asOut(e); }
  }
  /** the real port refund() through the wrapped port (PaymentProviderPort.impl.ts), as another module (system actor) would call it */
  async function port(input: unknown, c: { tenant?: 'A' | 'B'; actorType?: string } = {}): Promise<Out> {
    try { return { value: await h.impl.refund(h.ctxFor(`${c.tenant ?? 'A'}:${c.actorType ?? 'user'}:finance`), input as never) }; } catch (e: any) { return asOut(e); }
  }
  return { h, call, port, intent, refunds, refundRow, access, addRefund, setBalance, idCalls, seeds, M, MERCHANT_ID, BRANCH,
    intentId: seeds[0]!.id, orderId: seeds[0]!.orderId, nothingElseTouched: () => ({ gatewayCalls: h.gateway.calls.length, ledger: h.ledger.refunds.length + h.ledger.calls.length, jobs: h.jobs.length }) };
}
export type RefundHarness = Awaited<ReturnType<typeof makeRefundHarness>>;
