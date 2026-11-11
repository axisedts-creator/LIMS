// PG-T09 test harness: the public routes P30-P34 (TRD §5.2, §6.3, §6.3a, §7.5) over the PG-T08 port harness (real createPaymentProviderPort + in-memory DB fake).
// Intents are created through the REAL port (so tokens, hashes and open-slot rules are the production ones); the callback token is read from the eSewa launchUrl or the
// Khalti initiate input, exactly what a browser / the gateway would carry. Synthetic data only.
//
// SEAM THE WRITER MUST FOLLOW (tester contract; the TRD fixes behaviour, not these wiring names; dispute via .orchestra/notes if wrong):
//   service/callback.service.ts   exports  createCallbackService(deps: PaymentsDeps & { adapters.esewa.verifyCallbackSignature })  and
//                                          createCallbackResolver(deps: { systemActorId: string })  -> { resolve(token: string, tx): Promise<ResolverOk | undefined> }
//                                          (the manifest's authResolvers.paymentCallback; ResolverOk = { actor: { type:'system', id }, tenantId, extraClaims: { payment_intent_id } },
//                                           08 CR-REGISTER §4.11; `undefined` for EVERY invalid / unknown / expired / forged token, never a throw)
//   handlers/launchEsewaPayment.ts   exports createLaunchEsewaPayment(svc)    handlers/esewaSuccessCallback.ts exports createEsewaSuccessCallback(svc)
//   handlers/esewaFailureCallback.ts exports createEsewaFailureCallback(svc)   handlers/khaltiReturnCallback.ts exports createKhaltiReturnCallback(svc)
//   handlers/getPaymentResultPage.ts exports getPaymentResultPage: Handler     (static; needs no ctx.tx; no deps)
//   Handler = (req: { params: { callback_token }, query, headers, body }, ctx) => { status, headers, body? }  (core/module.ts HandlerResult; header names compared case-insensitively)
//   Per request the handlers/service use ONLY: ctx.tenantId/ctx.actor (the resolver's claims; ABSENT when the pipeline resolved nothing), ctx.tx.query (dialect: helpers/merchantDb.ts),
//   ctx.db.tx(fn) (the SAVEPOINT of 08 A19 P-44), ctx.rateLimit.consume('general', 'payments:cb:' + intentId) (TRD §6.3 step 2), ctx.now(), ctx.ports.BillingPort/FrontdeskPort,
//   ctx.log. The service finds the intent by sha256(path token) under the ctx tenant (RLS): a token of another tenant therefore finds nothing.
import { createHash } from 'node:crypto';
import { FIXED_NOW, TENANTS } from '../../../../../../../packages/fakes/src/base';
import { createEsewaAdapter, esewaSign } from '../../gateways/esewa.adapter.js';
import { PRODUCT_CODE, SECRET, makePortHarness, type PortHarness } from './portHarness';

export type Tenant = 'A' | 'B';
export type Op = 'launchEsewaPayment' | 'esewaSuccessCallback' | 'esewaFailureCallback' | 'khaltiReturnCallback' | 'getPaymentResultPage';
export interface Res { status: number; headers?: Record<string, string>; body?: unknown }

export const SYSTEM_ACTOR = '01900000-0000-7000-8000-0000000000a5';
export const ZERO_TENANT = '00000000-0000-0000-0000-000000000000';
export const RETURN = 'https://app.lims.test/pay/done';
export const CANCEL = 'https://app.lims.test/pay/cancel';
export const PORTAL_RETURN = 'https://portal.lims.test/r/payments/01900000-0000-7000-8000-0000000c9901/done';
export const RESULT_PAGE = 'https://api.lims.test/v1/payments/result';
export const sha256 = (t: string): Buffer => createHash('sha256').update(t).digest();
export const hdr = (r: Res, name: string): string | undefined => Object.entries(r.headers ?? {}).find(([k]) => k.toLowerCase() === name)?.[1];

export interface Made { intentId: string; orderId: string; token: string; tenant: Tenant; gateway: 'esewa' | 'khalti'; pidx?: string; action: any; dueAmountPaisa: number }

const LOAD = {
  launchEsewaPayment: async () => (await import('../../handlers/launchEsewaPayment.js') as any).createLaunchEsewaPayment,
  esewaSuccessCallback: async () => (await import('../../handlers/esewaSuccessCallback.js') as any).createEsewaSuccessCallback,
  esewaFailureCallback: async () => (await import('../../handlers/esewaFailureCallback.js') as any).createEsewaFailureCallback,
  khaltiReturnCallback: async () => (await import('../../handlers/khaltiReturnCallback.js') as any).createKhaltiReturnCallback,
} as const;

export async function makeCallbackHarness() {
  const h: PortHarness = await makePortHarness();
  await h.seed({ orders: [], returnUrlHosts: ['app.lims.test', 'portal.lims.test'] });

  let svcMod: any;
  try { svcMod = await import('../../service/callback.service.js'); } catch (e: any) { throw new Error(`PG-T09 not implemented: service/callback.service.ts (${e?.message ?? e})`); }
  if (typeof svcMod.createCallbackService !== 'function') throw new Error('PG-T09 not implemented: service/callback.service.ts must export createCallbackService(deps) (see helpers/callbackHarness.ts header)');
  if (typeof svcMod.createCallbackResolver !== 'function') throw new Error('PG-T09 not implemented: service/callback.service.ts must export createCallbackResolver({ systemActorId })');

  // the real PG-T06 adapter owns the callback-signature check; the PG-T08 harness only wired buildAction/check
  const realEsewa = createEsewaAdapter({ formUrl: h.deps.config.esewaFormUrl, statusUrl: h.deps.config.esewaStatusUrl, publicBase: h.deps.config.publicBaseUrl,
    timeouts: { initiateMs: 1200, inrequestMs: 2500, jobMs: 5000 }, allowFractionalRupees: h.deps.config.esewaAllowFractionalRupees });
  h.deps.adapters.esewa.verifyCallbackSignature = realEsewa.verifyCallbackSignature;

  const svc = svcMod.createCallbackService(h.deps);
  const resolver = svcMod.createCallbackResolver({ systemActorId: SYSTEM_ACTOR });
  const handlers: Partial<Record<Op, (req: any, ctx: any) => Promise<Res>>> = {};
  for (const op of Object.keys(LOAD) as (keyof typeof LOAD)[]) {
    let factory: any;
    try { factory = await LOAD[op](); } catch (e: any) { throw new Error(`PG-T09 not implemented: handlers/${op}.ts (${e?.message ?? e})`); }
    if (typeof factory !== 'function') throw new Error(`PG-T09 not implemented: handlers/${op}.ts must export its create<Op>(svc) factory (see helpers/callbackHarness.ts header)`);
    handlers[op] = factory(svc);
  }
  try { handlers.getPaymentResultPage = (await import('../../handlers/getPaymentResultPage.js') as any).getPaymentResultPage; } catch (e: any) { throw new Error(`PG-T09 not implemented: handlers/getPaymentResultPage.ts (${e?.message ?? e})`); }
  if (typeof handlers.getPaymentResultPage !== 'function') throw new Error('PG-T09 not implemented: handlers/getPaymentResultPage.ts must export getPaymentResultPage');

  const logs: unknown[] = [];
  const rl = { calls: [] as { tier: string; key: string }[], deny: false };
  const orders = new Map<string, any>();
  let n = 0;

  /** a fresh order + an intent created through the real port (system actor of the tenant) */
  async function make(o: { tenant?: Tenant; gateway?: 'esewa' | 'khalti'; due?: number; status?: string; gatewayAmountPaisa?: number; returnUrl?: string; cancelUrl?: string } = {}): Promise<Made> {
    const tenant = o.tenant ?? 'A', gateway = o.gateway ?? 'esewa', due = o.due ?? 225000;
    const orderId = `01900000-0000-7000-8000-0000000c16${String(++n).padStart(2, '0')}`;
    orders.set(orderId, { id: orderId, tenantId: TENANTS[tenant], dueAmountPaisa: due, gatewayStatus: o.status ?? (gateway === 'esewa' ? 'PENDING' : 'Pending'),
      ...(o.gatewayAmountPaisa !== undefined ? { gatewayAmountPaisa: o.gatewayAmountPaisa } : {}) });
    h.setOrder(orders.get(orderId));
    const r = await h.impl.createIntent(h.ctxFor(`${tenant}:system`), { orderId, gateway, idempotencyKey: `cb-${n}`, returnUrl: o.returnUrl ?? RETURN, cancelUrl: o.cancelUrl ?? CANCEL });
    const token = gateway === 'esewa' ? decodeURIComponent(new URL(r.action.launchUrl).pathname.split('/').filter(Boolean).at(-1)!) : (h.gateway.initiateInputs.at(-1) as any).callbackToken;
    const row = [...h.db.intents(TENANTS[tenant])].find((x) => x.id === r.intentId)!;
    return { intentId: r.intentId, orderId, token, tenant, gateway, action: r.action, dueAmountPaisa: due, ...(gateway === 'khalti' ? { pidx: row.gateway_txn_ref } : {}) };
  }
  /** what the gateway double answers to the next status check(s) of this intent */
  const script = (m: Made, s: { status: string; amountPaisa?: number }): void => {
    const cur = orders.get(m.orderId);
    orders.set(m.orderId, { ...cur, gatewayStatus: s.status, ...(s.amountPaisa !== undefined ? { gatewayAmountPaisa: s.amountPaisa } : { gatewayAmountPaisa: undefined }) });
    h.setOrder(orders.get(m.orderId));
  };

  /** one HTTP request through a handler, inside one DB transaction (rolled back, with the spies, if the handler throws — like the core pipeline) */
  async function call(op: Op, o: { token?: string; query?: Record<string, string>; tenant?: Tenant; anonymous?: boolean; now?: string; ports?: Record<string, unknown>; noTx?: boolean } = {}): Promise<Res> {
    const tenantId = o.anonymous ? ZERO_TENANT : TENANTS[o.tenant ?? 'A'];
    const now = o.now ?? FIXED_NOW;
    let txRef: unknown;
    try {
      return await h.db.run(async (dctx: any) => {
        txRef = dctx.tx;
        const rec = (...a: unknown[]) => { logs.push(a); };
        const ctx: any = { operationId: op, clientIp: '203.0.113.7', log: { info: rec, warn: rec, error: rec, debug: rec } };
        if (!o.noTx) {
          Object.assign(ctx, { requestId: dctx.requestId, tx: dctx.tx, now: () => now, db: dctx.db, audit: dctx.audit, ports: { ...h.ports, ...(o.ports ?? {}) },
            rateLimit: { async consume(tier: string, key: string) { rl.calls.push({ tier, key }); if (rl.deny) throw Object.assign(new Error('rate limited'), { code: 'common.rate_limited', retryAfterSeconds: 1 }); } } });
          if (!o.anonymous) Object.assign(ctx, { tenantId, actor: { type: 'system', id: SYSTEM_ACTOR } });
        }
        return handlers[op]!({ params: { callback_token: o.token }, query: o.query ?? {}, headers: {}, body: undefined }, ctx);
      }, { tenantId, now: () => new Date(now) });
    } catch (e) { if (txRef !== undefined) h.rollback(txRef); throw e; }
  }

  const row = (m: { intentId: string; tenant?: Tenant }) => h.db.intents(TENANTS[m.tenant ?? 'A']).find((r) => r.id === m.intentId)!;
  const callbacks = (t: Tenant = 'A') => h.db.callbacks(TENANTS[t]);
  const queryOf = (r: any): Record<string, unknown> | null => (r.query_redacted === null || r.query_redacted === undefined ? null : typeof r.query_redacted === 'string' ? JSON.parse(r.query_redacted) : r.query_redacted);
  const checks = () => h.gateway.calls.filter((c) => c.op === 'check');

  /** eSewa success `data` (Base64 JSON, TRD §7.2.2): correctly signed over `names` in order unless mutated afterwards */
  function esewaData(m: Pick<Made, 'intentId'>, o: { status?: string; total?: string; uuid?: string; productCode?: string; names?: string[]; signNames?: string[]; secret?: string;
    mutate?: (f: Record<string, string>) => void; dropKeys?: string[] } = {}): string {
    const names = o.names ?? ['transaction_code', 'status', 'total_amount', 'transaction_uuid', 'product_code', 'signed_field_names'];
    const f: Record<string, string> = { transaction_code: 'SYN0001', status: o.status ?? 'COMPLETE', total_amount: o.total ?? '2,250.0', transaction_uuid: o.uuid ?? m.intentId,
      product_code: o.productCode ?? PRODUCT_CODE, signed_field_names: names.join(',') };
    f['signature'] = esewaSign(o.secret ?? SECRET.esewa, f, o.signNames ?? names);
    o.mutate?.(f);
    for (const k of o.dropKeys ?? []) delete f[k];
    return Buffer.from(JSON.stringify(f)).toString('base64');
  }

  return { h, svc, resolver, call, make, script, row, callbacks, queryOf, checks, esewaData, logs, rl, handlers };
}
export type CallbackHarness = Awaited<ReturnType<typeof makeCallbackHarness>>;
