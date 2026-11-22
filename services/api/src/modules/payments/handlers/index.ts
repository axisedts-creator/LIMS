// Payments handler map: one entry per operationId in contracts/openapi/payments.yaml (core checkHandlers, 02-TRD §6.3).
// T0D-FIX-5 (LD-447, LD-449; CR DEPLOY-AXIS-012 item 1): the operations that already have a real implementation and tests are wired here; the
// rest keep the common.service_unavailable (503) placeholder, never a 2xx (REQ-SEC-099), and are listed in .orchestra/notes/T0D-FIX-5-left.md.
// Not wired (founder exclusions of LD-310: money movement, provider calls, credentials; and the runtime has no jobs / events / gateway adapters
// for payments yet): intent recheck / resolve / cancel, refund create / approve / reject / recheck / confirm / fail, startReconciliationRun,
// putMerchantAccount, testMerchantAccount, launchEsewaPayment and the three provider callbacks.
// Every wired service asks IdentityPort for the contract x-permission FIRST and scopes every statement by tenant_id = $1 (SEC-AUTHZ-6).
import { LimsError } from '../../../core/errors.js';
import type { Handler } from '../../../core/module.js';
import { loadPaymentsConfig } from '../config.js';
import { toRefundDto } from '../mappers/intent.mapper.js';
import { invalid, type PaymentsDeps } from '../repository/shared.js';
import { loadKek } from '../service/credentials.js';
import { createMerchantService } from '../service/merchant.service.js';
import { createReconciliationService } from '../service/reconciliation.service.js';
import { createRefundService } from '../service/refund.service.js';
import { createStaticQrService } from '../service/staticqr.service.js';
import { getPaymentResultPage } from './getPaymentResultPage.js';
import { createIntentHandlers } from './intents.js';

/** Boot check (TRD §9.3): validated at import, so a bad LIMS_PAYMENTS_* set stops the process. The ONE config every handler reads (LD-449 d). */
export const config = loadPaymentsConfig();

const notYet: Handler = async () => { throw new LimsError('common.service_unavailable'); };
const offline = async (): Promise<never> => { throw new LimsError('payments.gateway_not_available'); };
const offlineSync = (): never => { throw new LimsError('payments.gateway_not_available'); };
const noRuntime = async (): Promise<never> => { throw new LimsError('common.service_unavailable'); };

// Only read / review paths are wired, so the adapters, jobs and events are never reached; if one ever is, it fails closed (no outside call).
const deps: PaymentsDeps = {
  config,
  kek: loadKek(config.kekFile),
  adapters: { esewa: { buildAction: offline, check: offline }, khalti: { initiate: offline, buildAction: offlineSync, check: offline } },
  events: { publish: noRuntime },
  jobs: { enqueue: noRuntime },
};

type R = { params?: unknown; query?: unknown; headers?: unknown; body?: unknown };
const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : {});
const ok = (body: unknown, status = 200) => ({ status, body });
/** If-Match "<n>" (02-CV §4.2): absent -> undefined (the service decides 428 or a first save), malformed -> 400. */
const ifMatch = (headers: unknown): number | undefined => {
  const h = obj(headers)['if-match'];
  if (h === undefined) return undefined;
  const m = typeof h === 'string' ? /^"([1-9][0-9]{0,9})"$/.exec(h) : null;
  return m && Number(m[1]) <= 2147483647 ? Number(m[1]) : invalid('if-match');
};
const as = (f: (req: R, ctx: any) => Promise<{ status: number; body: unknown }>): Handler => (req, ctx) => f(req as R, ctx);

const intents = createIntentHandlers(deps);
const refunds = createRefundService(deps);
const recon = createReconciliationService(deps);
const staticQr = createStaticQrService();
const merchant = createMerchantService({ config, kek: deps.kek });

const wired: Record<string, Handler> = {
  listPaymentIntents: intents.listPaymentIntents,
  getPaymentIntent: intents.getPaymentIntent,
  listPaymentCodes: intents.listPaymentCodes,
  listPaymentCancelReasons: intents.listPaymentCancelReasons,
  listPaymentRefunds: as(async (req, ctx) => {
    const r = await refunds.listPaymentRefunds(ctx, req.query);
    return ok({ data: r.data.map(toRefundDto), page: r.page });
  }),
  getPaymentRefund: as(async (req, ctx) => ok(toRefundDto(await refunds.getPaymentRefund(ctx, { refundId: obj(req.params)['refund_id'] })))),
  listReconciliationRuns: as(async (req, ctx) => ok(await recon.listReconciliationRuns(ctx, req.query))),
  getReconciliationRun: as(async (req, ctx) => ok(await recon.getReconciliationRun(ctx, { runId: obj(req.params)['run_id'] }))),
  listReconciliationFindings: as(async (req, ctx) => ok(await recon.listReconciliationFindings(ctx, req.query))),
  resolveReconciliationFinding: as(async (req, ctx) => {
    const expectedVersion = ifMatch(req.headers);
    return ok(await recon.resolveReconciliationFinding(ctx, { findingId: obj(req.params)['finding_id'], ...(expectedVersion !== undefined ? { expectedVersion } : {}), body: req.body }));
  }),
  listStaticQrReconciliations: as(async (req, ctx) => ok(await staticQr.listStaticQrReconciliations(ctx, req.query))),
  previewStaticQrReconciliation: as(async (req, ctx) => ok(await staticQr.previewStaticQrReconciliation(ctx, req.query ?? {}))),
  createStaticQrReconciliation: as(async (req, ctx) => ok(await staticQr.createStaticQrReconciliation(ctx, req.body), 201)),
  listMerchantAccounts: as(async (_req, ctx) => ok(await merchant.listMerchantAccounts(ctx))),
  getPaymentSettings: as(async (_req, ctx) => ok(await merchant.getPaymentSettings(ctx))),
  updatePaymentSettings: as(async (req, ctx) => {
    const expectedVersion = ifMatch(req.headers);
    return ok(await merchant.updatePaymentSettings(ctx, { ...(expectedVersion !== undefined ? { expectedVersion } : {}), body: req.body }));
  }),
  getPaymentResultPage,
};

const OPERATION_IDS = [
  'listPaymentIntents', 'getPaymentIntent', 'recheckPaymentIntent', 'resolvePaymentIntent', 'cancelPaymentIntent',
  'listPaymentRefunds', 'getPaymentRefund', 'recheckPaymentRefund', 'createPaymentRefundRequest', 'approvePaymentRefund',
  'rejectPaymentRefund', 'confirmManualPaymentRefund', 'failManualPaymentRefund', 'listReconciliationRuns',
  'startReconciliationRun', 'getReconciliationRun', 'listReconciliationFindings', 'resolveReconciliationFinding',
  'listStaticQrReconciliations', 'createStaticQrReconciliation', 'previewStaticQrReconciliation', 'listMerchantAccounts',
  'putMerchantAccount', 'testMerchantAccount', 'getPaymentSettings', 'updatePaymentSettings', 'listPaymentCodes',
  'listPaymentCancelReasons', 'launchEsewaPayment', 'esewaSuccessCallback', 'esewaFailureCallback', 'khaltiReturnCallback',
  'getPaymentResultPage',
] as const;

export const handlers: Readonly<Record<(typeof OPERATION_IDS)[number], Handler>> = Object.freeze(
  Object.fromEntries(OPERATION_IDS.map((op) => [op, wired[op] ?? notYet])) as Record<(typeof OPERATION_IDS)[number], Handler>,
);
