// PG-T15 test harness: the refund completion handlers P11 confirmManualPaymentRefund, P7b recheckPaymentRefund, P11b failManualPaymentRefund (TRD §5.1, §6.6 steps 5-9)
// over the PG-T14 refund harness (helpers/refundHarness.ts: DB fake with the full refunds model, BillingPort double incl. recordGatewayRefund, scripted gateway checks). Synthetic data only.
//
// SEAM THE WRITER MUST FOLLOW (tester contract; the TRD fixes behaviour and DTO fields, not these wiring names; dispute via .orchestra/notes if wrong):
//   handlers/confirmManualPaymentRefund.ts   exports createConfirmManualPaymentRefund(deps: PaymentsDeps): Handler   (P11; this file is not in the plan row's list but P11 needs a home)
//   handlers/recheckPaymentRefund.ts         exports createRecheckPaymentRefund(deps): Handler                       (P7b)
//   handlers/failManualPaymentRefund.ts      exports createFailManualPaymentRefund(deps): Handler                    (P11b)
//   Handler = (req: { params: { refund_id }, query, headers, body }, ctx) => { status, headers?, body: RefundDto }  (lower-case headers; If-Match = `"<n>"` as P4: missing -> 428
//   common.precondition_required, malformed -> 400 common.validation_failed, stale -> 409 common.version_conflict). Idempotency-Key is the core pipeline's job.
//   Per request the handlers use ONLY: ctx.tenantId/actor (membershipId), ctx.tx.query (dialect: helpers/merchantDb.ts), ctx.now(), ctx.ports.IdentityPort.assertRole (first WITHOUT a centre,
//   then WITH the row's centre; a centre failure is a 404), ctx.ports.BillingPort.recordGatewayRefund, deps.adapters.<gateway>.check (the same scripted adapters the PG-T08 services use),
//   deps.config.verifyMinIntervalSeconds, deps.newId. No ctx.audit (08 A19 D-112: refund transitions are recorded by the row-audit trigger only).
//   The completion step (TRD §6.6 step 6) is ONE shared function used by P11, P7b and the check_refund task; the tests below pin its effects identically for all three.
import { TENANTS } from '../../../../../../../packages/fakes/src/base';
import { FIXED_NOW } from '../../../../../../../packages/fakes/src/base';
import { makeIdentity, makeRefundHarness, type Persona, type RefundHarness } from './refundHarness';

export type Op = 'confirmManualPaymentRefund' | 'recheckPaymentRefund' | 'failManualPaymentRefund';
export interface Res { status: number; headers?: Record<string, string>; body?: any; code?: string; err?: any }
export const hdr = (r: Res, name: string): string | undefined => Object.entries(r.headers ?? {}).find(([k]) => k.toLowerCase() === name)?.[1];
export const at = (seconds: number): string => new Date(Date.parse(FIXED_NOW) + seconds * 1000).toISOString();

const FILES: Record<Op, [string, string]> = {
  confirmManualPaymentRefund: ['../../handlers/confirmManualPaymentRefund.js', 'createConfirmManualPaymentRefund'],
  recheckPaymentRefund: ['../../handlers/recheckPaymentRefund.js', 'createRecheckPaymentRefund'],
  failManualPaymentRefund: ['../../handlers/failManualPaymentRefund.js', 'createFailManualPaymentRefund'],
};
/** the raw status the scripted gateway answers (portHarness `scripted`): khalti 'Refunded' / 'Partially Refunded' / 'Completed'; esewa 'FULL_REFUND' / 'PARTIAL_REFUND' / 'COMPLETE'; 'code:0' = transient */
export const GW = { khalti: { full: 'Refunded', partial: 'Partially Refunded', none: 'Completed' }, esewa: { full: 'FULL_REFUND', partial: 'PARTIAL_REFUND', none: 'COMPLETE' } } as const;

export async function makeActionHarness(o: Parameters<typeof makeRefundHarness>[0] = {}) {
  const t: RefundHarness = await makeRefundHarness(o);
  const handlers = new Map<Op, (req: any, ctx: any) => Promise<Res>>();
  async function handler(op: Op): Promise<(req: any, ctx: any) => Promise<Res>> {
    if (handlers.has(op)) return handlers.get(op)!;
    const [file, name] = FILES[op];
    let mod: any;
    try {
      mod = await (op === 'confirmManualPaymentRefund' ? import('../../handlers/confirmManualPaymentRefund.js') : op === 'recheckPaymentRefund' ? import('../../handlers/recheckPaymentRefund.js')
        : import('../../handlers/failManualPaymentRefund.js'));
    } catch (e: any) { throw new Error(`PG-T15 not implemented: ${file.replace('../../', '')} (${e?.message ?? e})`); }
    if (typeof mod[name] !== 'function') throw new Error(`PG-T15 not implemented: ${file.replace('../../', '')} must export ${name}(deps) (see helpers/refundActionHarness.ts header)`);
    handlers.set(op, mod[name](t.h.deps));
    return handlers.get(op)!;
  }
  const logs: unknown[] = [];

  /** one HTTP request through a handler inside one DB transaction (rolled back, with the spies, when the handler throws, like the core pipeline); throws come back as { status, code, err } */
  async function act(op: Op, c: { refundId: string; as?: Persona; tenant?: 'A' | 'B'; body?: unknown; headers?: Record<string, string>; now?: string; actorType?: string }): Promise<Res> {
    const tenantId = TENANTS[c.tenant ?? 'A'], now = c.now ?? FIXED_NOW, persona = c.as ?? 'A';
    const h = await handler(op);
    let txRef: unknown;
    try {
      return await t.h.db.run(async (dctx: any) => {
        txRef = dctx.tx;
        const rec = (...a: unknown[]) => { logs.push(a); };
        const ctx: any = { operationId: op, clientIp: '203.0.113.9', requestId: dctx.requestId, tenantId,
          actor: { type: c.actorType ?? 'user', id: dctx.actor.id, membershipId: persona === 'B' || persona === 'B_aal1' || persona === 'approver_only' ? t.M.B : t.M.A },
          tx: dctx.tx, now: () => now, db: dctx.db, audit: dctx.audit, log: { info: rec, warn: rec, error: rec, debug: rec },
          ports: { ...t.h.ports, IdentityPort: makeIdentity(persona, t.idCalls, t.h) } };
        return h({ params: { refund_id: c.refundId }, query: {}, headers: c.headers ?? {}, body: c.body }, ctx);
      }, { tenantId, now: () => new Date(now) });
    } catch (e: any) {
      if (txRef !== undefined) t.h.rollback(txRef);
      if (e && typeof e.code === 'string') return { status: e.statusCode ?? 0, code: e.code, err: e, body: { code: e.code }, headers: e.retryAfterSeconds ? { 'retry-after': String(e.retryAfterSeconds) } : {} };
      throw e;
    }
  }

  /** what the gateway double answers to the next status check of this intent's order (the order map also feeds BillingPort.getOrderBalance, so due is kept negative = overpaid) */
  const script = (raw: string, intentId = t.intentId, tenant: 'A' | 'B' = 'A'): void => {
    const it = t.intent(intentId, tenant);
    t.h.setOrder({ id: it.order_id, tenantId: TENANTS[tenant], dueAmountPaisa: -Number(it.amount_paisa), gatewayStatus: raw });
  };
  const checks = () => t.h.gateway.calls.filter((x) => x.op === 'check');
  const ifMatch = (id: string, tenant: 'A' | 'B' = 'A') => ({ 'if-match': `"${t.refundRow(id, tenant).version}"` });
  /** statements that read or write payments.refunds / intents (to prove "no read before the permission check") */
  const refundStmts = (from = 0) => t.h.db.stmts.slice(from).filter((s) => /payments\.(refunds|intents)/i.test(s.text));
  const writes = (from = 0) => t.h.db.stmts.slice(from).filter((s) => /^\s*(update|insert|delete)\b/i.test(s.text));
  /** deep snapshots of a refund + its intent, to prove "nothing written" */
  const snap = (id: string, tenant: 'A' | 'B' = 'A') => structuredClone({ refund: t.refundRow(id, tenant), intent: t.intent(t.refundRow(id, tenant).intent_id, tenant) });
  return { ...t, t, act, script, checks, ifMatch, refundStmts, writes, snap, logs };
}
export type ActionHarness = Awaited<ReturnType<typeof makeActionHarness>>;
