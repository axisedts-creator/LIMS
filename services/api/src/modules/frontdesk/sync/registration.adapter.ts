// T0B-SYNC-3 (LD-322 decision 1, LD-325 b; design C:/LIMS-state/offline-design-20261117.md sections 4 and 8): offline adapter of
// registration.create_order = createRegistration (frontdesk.registration.create). Calls the SAME service function as the online handler
// (registration.service.js create) as the signed in user on the operation's SAVEPOINT, so its permission checks, duplicate patient rule,
// pricing, discount and limit rules, numbering and audit events run unchanged; the engine ledger makes the op id the idempotency key.
//   reserved_numbers (patient id, lab codes) must lie in a block of this device, else sync.number_out_of_block (validated only: the
//     service allocates its own numbers, open point in the impl note);
//   a patient registered on the server meanwhile (frontdesk.patient_duplicate_suspected) -> CONFLICT with a merge suggestion, never a second patient;
//   a price change on the server (common.version_conflict from the quote fingerprint) -> CONFLICT with the server quote next to the stored
//     offline payload, never a silent money change; every conflict rolls the operation back (no order, no number);
//   numbers printed offline (OFF-, provisional) come back mapped to the final invoice / receipt numbers.
import { join } from 'node:path';
import { LimsError } from '../../../core/errors.js';
import { loadSpec, REPO_ROOT } from '../../../core/module.js';
import { assertReservedInDeviceBlocks } from '../../../core/sync/blocks.service.js';
import { SyncConflictError, payloadShape, provisionalNumber, type NumberMapping, type SyncAdapter } from '../../../core/sync/engine.js';
import { create, quote } from '../service/registration.service.js';

let draftKeys: readonly string[] | undefined;
/** The quote draft = the RegistrationDraft part of the create body (contracts/openapi/frontdesk.yaml), so the server total is priced as online. */
const draftOf = (body: Record<string, unknown>): Record<string, unknown> => {
  draftKeys ??= Object.keys((loadSpec(join(REPO_ROOT, 'contracts', 'openapi', 'frontdesk.yaml')) as any).components.schemas.RegistrationDraft.properties);
  return Object.fromEntries(Object.entries(body).filter(([k]) => draftKeys!.includes(k)));
};
const rec = (v: unknown): Record<string, any> => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : {});

export const registrationCreateOrderAdapter: SyncAdapter = {
  opType: 'registration.create_order', permission: 'frontdesk.registration.create',
  validate: payloadShape('frontdesk.yaml', 'CreateRegistrationRequest'),
  async execute(ctx, op) {
    await assertReservedInDeviceBlocks(ctx as never, op);
    let res: { status: number; body?: unknown };
    try {
      res = await create(ctx, op.payload) as never;
    } catch (e) {
      if (!(e instanceof LimsError)) throw e;
      if (e.code === 'frontdesk.patient_duplicate_suspected') {
        // ids and codes only: the server version never repeats a name or phone (design section 6)
        const cands = (Array.isArray((e as any).candidates) ? (e as any).candidates : []).map(rec).filter((c: any) => typeof c.id === 'string')
          .slice(0, 5).map((c: any) => ({ patient_id: c.id, ...(typeof c.patient_code === 'string' ? { patient_code: c.patient_code } : {}) }));
        throw new SyncConflictError({ entityType: 'patient', entityId: cands[0]?.patient_id, errorCode: e.code,
          serverPayload: { ...(cands[0] ? { merge_suggestion: cands[0] } : {}), candidates: cands } });
      }
      if (e.code === 'common.version_conflict') {
        const q = rec((await quote(ctx, draftOf(op.payload)) as { body?: unknown }).body);
        throw new SyncConflictError({ entityType: 'order', errorCode: e.code,
          serverPayload: { reason: 'price_changed', ...(q.quote_fingerprint ? { quote_fingerprint: q.quote_fingerprint } : {}), ...(q.totals ? { totals: q.totals } : {}) } });
      }
      throw e;
    }
    const body = rec(res.body);
    const orderId = rec(body.order).id as string | undefined;
    const maps: NumberMapping[] = [];
    const invoiceNo = rec(body.invoice).invoice_no;
    if (typeof invoiceNo === 'string') maps.push({ document_type: 'invoice', provisional_number: provisionalNumber(op.deviceId, op.opId, 'INV'), final_number: invoiceNo });
    const receipts = (Array.isArray(body.ledger_entries) ? body.ledger_entries : []).map((x: unknown) => rec(x).receipt_no).filter((n: unknown): n is string => typeof n === 'string');
    receipts.forEach((n: string, i: number) => maps.push({ document_type: 'receipt', provisional_number: provisionalNumber(op.deviceId, op.opId, `RC${i ? i + 1 : ''}`), final_number: n }));
    if (orderId) {
      // the order has no captured time field: the device time goes into the audit event of the operation (done_when 1).
      // [CR .orchestra/cr/T0B-SYNC-3.md] no sync access action exists; patient.view is the nearest code, as the LD-25 back entry above uses.
      await (ctx as any).audit.access({ action: 'patient.view', entityType: 'order', entityId: orderId, outcome: 'allowed',
        detail: { event: 'sync_operation_applied', op_id: op.opId, op_type: op.opType, device_created_at: op.deviceCreatedAt } });
    }
    return { ...(orderId ? { entityId: orderId } : {}), ...(maps.length ? { numberMappings: maps } : {}) };
  },
};
