// PG-T12 test harness: the staff intent operations P1-P5, P24, P24b (TRD §5.1) through the handlers, over the PG-T08 port harness (real adapters' signing, scripted
// gateway status, in-memory DB fake of helpers/merchantDb.ts). Synthetic data only.
//
// SEAM THE WRITER MUST FOLLOW (tester contract; the TRD fixes behaviour and DTO fields, not these wiring names; dispute via .orchestra/notes if wrong):
//   mappers/intent.mapper.ts   exports  toIntentSummary(row)  and  toIntentDetail(row, { transitions, gatewayCalls, callbacks, refunds })
//                              (pure: DB rows (node-pg shapes: bigint = decimal string, timestamptz = Date) -> TRD §5.1 DTOs, snake_case, Money = { amount_paisa, currency }, absent = omitted, never null)
//   handlers/intents.ts        exports  createIntentHandlers(deps: PaymentsDeps)  ->  { listPaymentIntents, getPaymentIntent, recheckPaymentIntent, resolvePaymentIntent,
//                              cancelPaymentIntent, listPaymentCodes, listPaymentCancelReasons }   (each a core Handler; deps = the PG-T08 PaymentsDeps)
//   Handler = (req: { params, query, headers, body }, ctx) => { status, headers?, body }.   `headers` is lower-case (If-Match = `"<n>"` as lab's ifMatch(): missing -> 428
//   common.precondition_required, malformed -> 400 common.validation_failed). Idempotency-Key is the core pipeline's job (x-idempotency), not the handler's.
//   Per request the handlers use ONLY: ctx.tenantId/actor, ctx.tx.query (dialect: helpers/merchantDb.ts), ctx.now(), ctx.audit.access(entry) (08 A13 P-3),
//   ctx.ports.IdentityPort.assertRole(ctx, { permission, centreId? }) (TRD §5.4: first WITHOUT centreId before any payments.* read; then WITH the row's centre_id after loading the row),
//   ctx.ports.BillingPort/FrontdeskPort (through the PG-T08 outcome service), ctx.log. A failing centre-scoped assertRole (auth.forbidden) is answered as 404 common.not_found (ST-18).
import { FIXED_NOW, TENANTS } from '../../../../../../../packages/fakes/src/base';
import { LimsError } from '../../../../core/errors.js';
import { BRANCH, MERCHANT_ID, makePortHarness, type PortHarness } from './portHarness';

export type Tenant = 'A' | 'B';
export type StaffOp = 'listPaymentIntents' | 'getPaymentIntent' | 'recheckPaymentIntent' | 'resolvePaymentIntent' | 'cancelPaymentIntent' | 'listPaymentCodes' | 'listPaymentCancelReasons';
export interface Res { status: number; headers?: Record<string, string>; body?: any }
export const CENTRE_1 = '01900000-0000-7000-8000-0000000ce001';   // = portHarness CENTRE
export const CENTRE_2 = '01900000-0000-7000-8000-0000000ce002';
export const hdr = (r: Res, name: string): string | undefined => Object.entries(r.headers ?? {}).find(([k]) => k.toLowerCase() === name)?.[1];

export type Persona = 'finance' | 'finance_aal1' | 'finance_centre1' | 'front_desk' | 'front_desk_centre1' | 'nobody';
const PERMS: Record<Persona, string[]> = {
  finance: ['payments.reconciliation.read', 'payments.intent.resolve'],
  finance_aal1: ['payments.reconciliation.read', 'payments.intent.resolve'],
  finance_centre1: ['payments.reconciliation.read', 'payments.intent.resolve'],
  front_desk: ['payments.intent.create'],                      // holds payments.intent.create, NOT payments.reconciliation.read (PRD AC-PG-13.3)
  front_desk_centre1: ['payments.intent.create'],
  nobody: [],
};
const PRIVILEGED = new Set(['payments.intent.resolve', 'payments.refund.request', 'payments.refund.approve', 'payments.merchant_config.manage']);

/** IdentityPort.assertRole double with the real error codes: auth.forbidden (no permission / other centre), auth.mfa_required (privileged permission at aal1). */
export function makeIdentity(persona: Persona, calls: { permission: string; centreId?: string; at: number }[], h: PortHarness) {
  return { async assertRole(_c: unknown, r: { permission: string; centreId?: string }): Promise<void> {
    calls.push({ permission: r.permission, ...(r.centreId ? { centreId: r.centreId } : {}), at: h.db.stmts.length });
    if (!PERMS[persona].includes(r.permission)) throw new LimsError('auth.forbidden');
    if (persona === 'finance_aal1' && PRIVILEGED.has(r.permission)) throw new LimsError('auth.mfa_required');
    if ((persona === 'finance_centre1' || persona === 'front_desk_centre1') && r.centreId !== undefined && r.centreId !== CENTRE_1) throw new LimsError('auth.forbidden');
  } };
}

export interface IntentSeed { id: string; tenant?: Tenant; orderId?: string; gateway?: 'esewa' | 'khalti'; status?: string; centre?: string; amountPaisa?: number; createdAt?: string;
  holdReason?: string; lastCheckedAt?: string; settled?: boolean; lastRaw?: string; version?: number }
let seq = 0;
export const uid = (n: number): string => `01900000-0000-7000-8000-0000000d${String(n).padStart(4, '0')}`;

export async function makeStaffHarness() {
  const h: PortHarness = await makePortHarness();
  await h.seed({ orders: [], returnUrlHosts: ['app.lims.test'] });
  let mod: any, mapper: any;
  try { mod = await import('../../handlers/intents.js'); } catch (e: any) { throw new Error(`PG-T12 not implemented: handlers/intents.ts (${e?.message ?? e})`); }
  if (typeof mod.createIntentHandlers !== 'function') throw new Error('PG-T12 not implemented: handlers/intents.ts must export createIntentHandlers(deps) (see helpers/staffHarness.ts header)');
  try { mapper = await import('../../mappers/intent.mapper.js'); } catch (e: any) { throw new Error(`PG-T12 not implemented: mappers/intent.mapper.ts (${e?.message ?? e})`); }
  const handlers: Record<StaffOp, (req: any, ctx: any) => Promise<Res>> = mod.createIntentHandlers(h.deps);
  const logs: unknown[] = [];
  const idCalls: { permission: string; centreId?: string; at: number }[] = [];

  /** a stored intent row (the arrange step bypasses CHECKs on purpose); also seeds the order so the scripted gateway can answer a status check */
  function add(o: IntentSeed): string {
    const tenant = TENANTS[o.tenant ?? 'A'], gateway = o.gateway ?? 'esewa', status = o.status ?? 'held_for_review', amount = o.amountPaisa ?? 225000;
    const orderId = o.orderId ?? uid(5000 + (++seq));
    const settledFamily = ['settled', 'refunded', 'partially_refunded'].includes(status);
    h.db.put('payments.intents', {
      id: o.id, tenant_id: tenant, order_id: orderId, branch_id: BRANCH, centre_id: o.centre ?? CENTRE_1, gateway, environment: h.config.gatewayEnv,
      merchant_account_id: MERCHANT_ID(o.tenant ?? 'A', gateway), status, amount_paisa: amount, idempotency_key: `seed-${o.id}`, request_fingerprint: 'b'.repeat(64),
      return_url: 'https://app.lims.test/pay/done?token=RETURN-URL-SENTINEL', cancel_url: 'https://app.lims.test/pay/cancel?token=CANCEL-URL-SENTINEL',
      callback_token_sha256: Buffer.alloc(32, (seq % 250) + 1), gateway_txn_ref: gateway === 'esewa' ? o.id : `SYN-PIDX-${seq}`,
      gateway_payment_url: gateway === 'khalti' ? 'https://pay.khalti.test/PAYMENT-URL-SENTINEL' : null, gateway_secondary_ref: 'SYN-TXN-REF-1',
      expires_at: new Date(Date.parse(FIXED_NOW) + 3600_000), initiated_at: new Date(o.createdAt ?? FIXED_NOW), created_at: new Date(o.createdAt ?? FIXED_NOW),
      last_checked_at: o.lastCheckedAt ? new Date(o.lastCheckedAt) : null, last_gateway_status_raw: o.lastRaw ?? null, check_count: o.lastCheckedAt ? 1 : 0,
      hold_reason: status === 'held_for_review' ? (o.holdReason ?? 'gateway_ambiguous') : null, failure_reason: ['failed', 'expired'].includes(status) ? 'expired_unpaid' : null,
      refunded_paisa: 0, created_actor_type: 'user', created_by: tenant, updated_by: tenant, version: o.version ?? 1,
      ...(settledFamily ? { settled_at: new Date(FIXED_NOW), ledger_entry_id: '01900000-0000-7000-8000-0000000c8000', verified_amount_paisa: amount,
        verification_method: gateway === 'esewa' ? 'esewa_status_check' : 'khalti_lookup' } : {}),
    });
    h.setOrder({ id: orderId, tenantId: tenant, dueAmountPaisa: amount, gatewayStatus: gateway === 'esewa' ? 'PENDING' : 'Pending' });
    return orderId;
  }
  /** what the gateway double answers to the next status check of this intent's order */
  const script = (orderId: string, status: string, amountPaisa?: number): void => {
    const cur = h.db.intents(TENANTS.A).concat(h.db.intents(TENANTS.B)).find((r) => r.order_id === orderId)!;
    h.setOrder({ id: orderId, tenantId: cur.tenant_id, dueAmountPaisa: Number(cur.amount_paisa), gatewayStatus: status, ...(amountPaisa !== undefined ? { gatewayAmountPaisa: amountPaisa } : {}) });
  };
  const row = (id: string, tenant: Tenant = 'A') => h.db.intents(TENANTS[tenant]).find((r) => r.id === id)!;
  const checks = () => h.gateway.calls.filter((c) => c.op === 'check');

  /** one HTTP request through a handler inside one DB transaction (rolled back, with the spies, when the handler throws — like the core pipeline). Throws are returned as { status, body: { code } } */
  async function call(op: StaffOp, o: { as?: Persona; tenant?: Tenant; params?: Record<string, string>; query?: Record<string, unknown>; body?: unknown; headers?: Record<string, string>;
    now?: string; actorType?: string } = {}): Promise<Res & { code?: string; err?: any }> {
    const tenantId = TENANTS[o.tenant ?? 'A'];
    const now = o.now ?? FIXED_NOW;
    let txRef: unknown;
    try {
      const res = await h.db.run(async (dctx: any) => {
        txRef = dctx.tx;
        const rec = (...a: unknown[]) => { logs.push(a); };
        const ctx: any = { operationId: op, clientIp: '203.0.113.9', requestId: dctx.requestId, tenantId, actor: { type: o.actorType ?? 'user', id: dctx.actor.id, membershipId: dctx.actor.membershipId },
          tx: dctx.tx, now: () => now, db: dctx.db, audit: dctx.audit, log: { info: rec, warn: rec, error: rec, debug: rec },
          ports: { ...h.ports, IdentityPort: makeIdentity(o.as ?? 'finance', idCalls, h) } };
        return handlers[op]({ params: o.params ?? {}, query: o.query ?? {}, headers: o.headers ?? {}, body: o.body }, ctx);
      }, { tenantId, now: () => new Date(now) });
      return res;
    } catch (e: any) {
      if (txRef !== undefined) h.rollback(txRef);
      if (e && typeof e.code === 'string') return { status: e.statusCode ?? 0, code: e.code, err: e, body: { code: e.code }, headers: e.retryAfterSeconds ? { 'retry-after': String(e.retryAfterSeconds) } : {} };
      throw e;
    }
  }
  /** global coded sets (05-SCHEMA §5 seed, the subset these tests use) */
  const SETS: Record<string, [string, string, boolean?][]> = {
    hold_reasons: [['amount_mismatch', 'Amount mismatch'], ['gateway_ambiguous', 'Gateway ambiguous'], ['exceeds_due', 'Exceeds due']],
    failure_reasons: [['gateway_cancelled', 'Gateway cancelled'], ['abandoned', 'Abandoned'], ['resolved_failed', 'Resolved as failed']],
    cancel_reasons: [['patient_changed_method', 'Patient changed method'], ['patient_left', 'Patient left'], ['wrong_amount', 'Wrong amount'], ['staff_error', 'Staff error'], ['other', 'Other', true]],
    resolution_reasons: [['gateway_confirmed_paid', 'Gateway confirmed paid'], ['gateway_confirmed_unpaid', 'Gateway confirmed unpaid'], ['provider_support_confirmed', 'Provider support confirmed'],
      ['duplicate_attempt', 'Duplicate attempt'], ['other', 'Other', true]],
    refund_reasons: [['test_cancelled', 'Test cancelled'], ['overpayment', 'Overpayment']],
  };
  function seedCodes(): void {
    let n = 0;
    for (const [set, codes] of Object.entries(SETS)) codes.forEach(([code, display, requiresText], i) => h.db.put('payments.g_cs_reasons', { id: uid(9000 + (++n)), set_name: set, code, display, requires_text: !!requiresText, sort_order: i + 1 }));
  }
  /** tenant override of a global code (05-SCHEMA cs_reasons: relabel / deactivate only) */
  const override = (tenant: Tenant, set: string, code: string, o: { display?: string; is_active?: boolean }): void => {
    h.db.put('payments.cs_reasons', { id: uid(9500 + (++seq)), tenant_id: TENANTS[tenant], set_name: set, code, display: o.display ?? code, is_active: o.is_active ?? true, created_by: TENANTS[tenant], updated_by: TENANTS[tenant] });
  };
  const access = (t: Tenant = 'A') => h.db.accessRows(TENANTS[t]);
  const readStmts = (from = 0) => h.db.stmts.slice(from).filter((s) => /payments\.(intents|intent_transitions|gateway_calls|callbacks|refunds)/i.test(s.text));
  return { h, call, add, script, row, checks, logs, idCalls, access, readStmts, mapper, handlers, seedCodes, override, SETS };
}
export type StaffHarness = Awaited<ReturnType<typeof makeStaffHarness>>;
