// T0B-SYNC-3 (LD-322 decision 1, LD-325 b; design C:/LIMS-state/offline-design-20261117.md section 4): offline adapter of
// billing.record_receipt = recordPayment (billing.payment.record), entity_id = order_id. Calls the SAME service function the online handler
// calls (ledger.handlers.ts), the same way: a manual payment with a receipt number by the signed in cashier (the body never chooses the
// collector, the capture kind or the receipt), on the operation's SAVEPOINT. The service assigns the final gap free receipt number in
// server arrival order inside that transaction (a rejected operation gives its number back), checks the due (held / reversed entries as
// online) and writes its own audit rows. The device time is the captured time of the entry (capturedAt).
// [CONV] idempotency key `<order_id>:pay:<op_id>`: the online namespace with the op id as key, so a replay, or an online retry that used the
// op id as Idempotency-Key, answers the first entry and its final number even when the engine ledger row is gone.
import { createEvents } from '../../../core/events/publish.js';
import { payloadShape, provisionalNumber, type SyncAdapter } from '../../../core/sync/engine.js';
import { createBillingEvents } from '../events/publish.js';
import { createCounterService } from '../service/counter.service.js';
import { createLedgerService } from '../service/ledger.service.js';

let ledger: ReturnType<typeof createLedgerService> | undefined;
const ledgerService = () => (ledger ??= createLedgerService({ counter: createCounterService() as never, events: createBillingEvents(createEvents({ producer: 'billing' }) as never) }));

export const billingRecordReceiptAdapter: SyncAdapter = {
  opType: 'billing.record_receipt', permission: 'billing.payment.record',
  validate: payloadShape('billing.yaml', 'RecordPaymentRequest'),
  async execute(ctx, op) {
    const b = op.payload;
    const orderId = op.entityId!;
    const r = await ledgerService().recordPayment(ctx as never, {
      orderId, methodCode: b['method_code'], amount: { amountPaisa: b['amount_received_paisa'], currency: 'NPR' },
      ...(b['reference'] === undefined ? {} : { reference: b['reference'] }), ...(b['invoice_id'] === undefined ? {} : { invoiceId: b['invoice_id'] }),
      ...(b['card_holder_name'] === undefined ? {} : { cardHolderName: b['card_holder_name'] }), ...(b['payment_remark'] === undefined ? {} : { paymentRemark: b['payment_remark'] }),
      captureKind: 'manual', issueReceiptNo: true, capturedAt: new Date(op.deviceCreatedAt).toISOString() /* engine allows 6 fraction digits, the ledger 3 (review item 2) */, idempotencyKey: `${orderId}:pay:${op.opId}`,
    });
    return {
      entityId: orderId,
      ...(typeof r.receiptNo === 'string' ? { numberMappings: [{ document_type: 'receipt', provisional_number: provisionalNumber(op.deviceId, op.opId, 'RC'), final_number: r.receiptNo }] } : {}),
    };
  },
};
