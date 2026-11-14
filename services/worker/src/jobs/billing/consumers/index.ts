// BL-T16 billing consumers (02-TRD §8; PRD US-BL-08.1/.2, US-BL-09.1-.4; 03-IC §3.20/§3.23; 08 A19 D-120/D-128; 07-SECURITY consumer probes).
//   payments.intent.settled.v1          X3 safety net: BillingPort.recordGatewayPayment (allowExceedsDue) - a row written earlier by C15 is a no-op replay.
//   homecollection.collection.synced.v1 one BillingCommandPort.recordPayment(captureKind 'home_collection') per payments[]; key = client_mutation_id.
// Handlers run in the C0 wrapper's transaction (ctx.tx) and open none. The tenant comes from ctx only: an envelope naming another tenant writes nothing.
// A collected payment is never rejected for its method or amount (D-128): it is recorded and a finance review item is raised in the same transaction.
// Unknown payload fields (booking_id, ...) are never read.
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { LimsError, type FieldError } from '../../../../../api/src/core/errors.js';
import { createEvents } from '../../../../../api/src/core/events/publish.js';
import { createBillingPort } from '../../../../../api/src/modules/billing/ports/BillingPort.impl.js';
import { createBillingEvents, type BillingEvents } from '../../../../../api/src/modules/billing/events/publish.js';
import { billingRepo, type BillingRepo } from '../../../../../api/src/modules/billing/repository/index.js';
import { createCounterService } from '../../../../../api/src/modules/billing/service/counter.service.js';
import { createLedgerService } from '../../../../../api/src/modules/billing/service/ledger.service.js';
import type { ConsumerHandler } from '../../../core/manifest.js';

export const INTENT_SETTLED = 'payments.intent.settled.v1';
export const COLLECTION_SYNCED = 'homecollection.collection.synced.v1';

const rec = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);
const invalid = (...paths: string[]): LimsError => new LimsError('common.validation_failed', undefined, paths.map((path): FieldError => ({ path, code: 'common.field_invalid', message: 'Field invalid' })));
const CARD_DIGITS = /[0-9]{13,19}/, CONTROL = /[\u0000-\u001f\u007f]/;

/** Same-tenant guard: the envelope may repeat the tenant, never choose it. Returns false (and writes nothing) on a mismatch. */
function sameTenant(env: any, ctx: any): boolean {
  if (typeof ctx?.tenantId === 'string' && env?.tenant_id === ctx.tenantId) return true;
  ctx?.log?.warn?.({ event: 'billing_consumer_skipped', reason: 'tenant_mismatch', event_type: env?.event_type });
  return false;
}

/** A reference the ledger would refuse (card digits, control chars, too long) is dropped, not allowed to block money already collected. */
function cleanReference(r: unknown): string | undefined {
  if (typeof r !== 'string') return undefined;
  const t = r.trim();
  return t === '' || t.length > 100 || CONTROL.test(t) || CARD_DIGITS.test(t) ? undefined : t;
}

export function createBillingConsumers(deps: { repo?: BillingRepo; counter: any; events: BillingEvents }) {
  const repo = deps.repo ?? billingRepo;
  const ledger = createLedgerService({ repo, counter: deps.counter, events: deps.events });
  const port = createBillingPort({ repo, events: deps.events });

  const onIntentSettled: ConsumerHandler = async (env, ctx) => {
    if (!sameTenant(env, ctx)) return;
    const p = env.payload;
    if (!rec(p) || !rec(p['amount'])) throw invalid('/payload');
    await port.recordGatewayPayment(ctx as never, {
      intentId: p['intent_id'], orderId: p['order_id'], ...(p['invoice_id'] === undefined ? {} : { invoiceId: p['invoice_id'] }), gateway: p['gateway'], gatewayTxnRef: p['gateway_txn_ref'],
      amount: { amountPaisa: p['amount']['amount_paisa'], currency: p['amount']['currency'] }, verifiedAt: p['verified_at'], allowExceedsDue: true,   // the money is already taken
    });                                                                          // replay of an existing row (C15 or an earlier delivery) = no write, no event
  };

  const onCollectionSynced: ConsumerHandler = async (env, ctx) => {
    if (!sameTenant(env, ctx)) return;
    const p = env.payload;
    if (!rec(p) || !Array.isArray(p['payments'])) throw invalid('/payload');
    const c = ctx as any, tx = c.tx, tenantId: string = c.tenantId;
    for (const [n, x] of (p['payments'] as unknown[]).entries()) {
      if (!rec(x) || !rec(x['amount'])) throw invalid(`/payments/${n}`);
      const amountPaisa = x['amount']['amount_paisa'];
      const reference = cleanReference(x['reference']);
      const r = await ledger.recordPayment(c, {
        orderId: p['order_id'], methodCode: x['payment_method_code'], amount: { amountPaisa, currency: x['amount']['currency'] }, ...(reference === undefined ? {} : { reference }),
        captureKind: 'home_collection', idempotencyKey: x['client_mutation_id'], collectedByMembershipId: p['phlebotomist_membership_id'], capturedAt: x['captured_at_device'], issueReceiptNo: false,
      });
      if (r.duplicate) continue;                                                   // review items were raised with the first delivery
      const method = await repo.getPaymentMethod(tx, { tenantId, code: x['payment_method_code'] });
      const inactive = !method || method.is_active !== true;
      const dueBefore = r.balance.balanceDue.amountPaisa + amountPaisa;
      if (!r.exceedsDue && !inactive) continue;
      const totals = await repo.readOrderTotals(tx, { tenantId, orderId: p['order_id'] });
      const centreId = totals?.centre_id;
      if (typeof centreId !== 'string') throw new LimsError('common.internal');
      const item = (kind: string, amount: number) => repo.insertFinanceReviewItem(tx, { id: uuidv7(), tenantId, centreId, orderId: p['order_id'], kind, ledgerEntryId: r.ledgerEntryId, amountPaisa: amount, userId: c.actor.id });
      if (r.exceedsDue) await item('home_payment_exceeds_due', amountPaisa - Math.max(dueBefore, 0));
      if (inactive) await item('home_payment_method_inactive', amountPaisa);
    }
  };

  return { onIntentSettled, onCollectionSynced };
}

/** Production wiring for the manifest: real repo/counter/event publisher, built on first use (no I/O at import time). */
let built: ReturnType<typeof createBillingConsumers> | undefined;
const real = () => (built ??= createBillingConsumers({ counter: createCounterService(), events: createBillingEvents(createEvents({ producer: 'billing' }) as never) }));
export const onIntentSettled: ConsumerHandler = (e, c) => real().onIntentSettled(e, c);
export const onCollectionSynced: ConsumerHandler = (e, c) => real().onCollectionSynced(e, c);
