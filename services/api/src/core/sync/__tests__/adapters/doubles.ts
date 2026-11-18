// T0B-SYNC-3 test doubles (not a test). Synthetic data only. Pinned surface the writer must implement (every item may be overruled by the lead/arbiter, then the tests follow):
//  ADAPTER FILES (additive, one per op type; each exports the default instance named below, the lab ones also a factory with a seam):
//    modules/frontdesk/sync/registration.adapter.ts : `registrationCreateOrderAdapter`  (opType registration.create_order, permission frontdesk.registration.create)
//    modules/billing/sync/receipt.adapter.ts        : `billingRecordReceiptAdapter`     (billing.record_receipt, billing.payment.record)
//    modules/lab/sync/collection.adapter.ts         : `collectionMarkCollectedAdapter` + `createCollectionMarkCollectedAdapter(deps?: { readSpecimen? })`  (collection.mark_collected, lab.specimen.collect)
//    modules/lab/sync/accession.adapter.ts          : `accessionReceiveAdapter` + `createAccessionReceiveAdapter(deps?: { readSpecimen? })`  (accession.receive, lab.specimen.receive)
//    readSpecimen(ctx, specimenId) -> Promise<{ status: string; version: number } | undefined>   default = SELECT status, version FROM lab.specimens through ctx.tx (RLS decides visibility)
//  SERVICE LAYER (called, never HTTP, never a copy of the rules): frontdesk/service/registration.service.js `create(ctx, body)` and `quote(ctx, draft)`;
//    billing/service/ledger.service.js `createLedgerService(...).recordPayment(ctx, input)` (the way ledger.handlers.ts builds it);
//    lab/service/specimen.service.js `collectSpecimen(ctx, params, headers, body)` / `receiveSpecimen(ctx, params, headers, body)`.
//    The adapters pass the SAME actor / tenant / tx (property equal) so the online counterpart's permission, validation and audit events run unchanged.
//  ENGINE (core/sync/engine.ts, additive): SyncOp gains `deviceId` (always) and `reservedNumbers?: { patientId?: number; labCodes?: number[] }`, read from the op envelope key
//    `reserved_numbers: { patient_id?: int, lab_codes?: int[] }` (accepted for registration.create_order and accession.receive only, part of the payload hash);
//    SyncAdapter.execute may return `outcome: 'duplicate'` -> result status 'duplicate' (entity_id kept, no error_code);
//    `SyncConflictError({ entityType, entityId?, serverPayload, errorCode })` exported from engine.ts: thrown by execute -> that operation's SAVEPOINT is rolled back, a core.sync_conflict row is
//    written (local_payload = op payload, server_payload = serverPayload) and the result is { status: 'conflict', error_code: errorCode, conflict_id }.
//  createSyncPart2Handlers / syncPart2Handlers: the four adapters above are the DEFAULT registry (an `adapters` entry still replaces its opType).
//  PROVISIONAL NUMBERS: no field of the wrapped payloads carries them (additionalProperties false), so the adapter derives them from (device id, op id) only: `OFF-...` matching ^OFF-[A-Za-z0-9-]+$,
//  max 60, deterministic (a replay returns the identical mapping), unique per document of an operation. Mappings: registration = invoice (+ receipt when a payment line exists), receipt op = receipt.
import { LimsError } from '../../../errors.js';
import { ownerRows, superTx, uid, ensureEffectTable } from '../helpers2.js';

export const MODS = {
  registration: '../../../../modules/frontdesk/service/registration.service.js',
  ledger: '../../../../modules/billing/service/ledger.service.js',
  specimen: '../../../../modules/lab/service/specimen.service.js',
} as const;

// ------------------------------------------------------------ recorded calls and per test behaviours
export interface Call { ctx: any; args: any[] }
export const calls = { create: [] as Call[], quote: [] as Call[], recordPayment: [] as Call[], collect: [] as Call[], receive: [] as Call[] };
export const reset = (): void => { for (const k of Object.keys(calls) as Array<keyof typeof calls>) calls[k].length = 0; Object.assign(behave, defaults()); orders.clear(); };

const pad = (n: number): string => String(n).padStart(6, '0');
let counterReady = false;
export async function ensureCounter(): Promise<void> {
  if (counterReady) return;
  await ensureEffectTable();
  await superTx(async (tx) => {
    await tx.query(`CREATE TABLE IF NOT EXISTS sync2_test.numbers (tenant_id uuid NOT NULL, series text NOT NULL, last_no bigint NOT NULL DEFAULT 0, PRIMARY KEY (tenant_id, series))`);
    await tx.query(`CREATE TABLE IF NOT EXISTS sync2_test.receipts (tenant_id uuid NOT NULL, idem text NOT NULL, order_id text NOT NULL, receipt_no text NOT NULL, PRIMARY KEY (tenant_id, idem))`);
    await tx.query('GRANT ALL ON ALL TABLES IN SCHEMA sync2_test TO PUBLIC');
  });
  counterReady = true;
}
/** Gap free allocation like the real counter: a row lock held to the end of the caller's transaction, so a rolled back operation gives its number back. */
export async function nextNo(ctx: any, series: string): Promise<number> {
  const r = await ctx.tx.query(`INSERT INTO sync2_test.numbers (tenant_id, series, last_no) VALUES ($1, $2, 1)
    ON CONFLICT (tenant_id, series) DO UPDATE SET last_no = sync2_test.numbers.last_no + 1 RETURNING last_no`, [ctx.tenantId, series]);
  return Number(r.rows[0].last_no);
}
export const lastNo = async (tenant: string, series: string): Promise<number> =>
  Number((await ownerRows('SELECT last_no FROM sync2_test.numbers WHERE tenant_id = $1 AND series = $2', [tenant, series]))[0]?.last_no ?? 0);
export const effectRows = (opIds: string[]): Promise<any[]> => ownerRows('SELECT * FROM sync2_test.effect WHERE idempotency_key = ANY($1::uuid[]) OR op_id = ANY($1::uuid[]) ORDER BY n', [opIds]);

/** order money world of the receipt double: invoiced / paid per order id (default 100000 invoiced, 0 paid). */
export const orders = new Map<string, { invoiced: number; paid: number; invoiceCount: number }>();
export const orderOf = (id: string) => { let o = orders.get(id); if (!o) { o = { invoiced: 100_000, paid: 0, invoiceCount: 1 }; orders.set(id, o); } return o; };

const effect = (ctx: any, tag: string, entityId?: string) =>
  ctx.tx.query(`INSERT INTO sync2_test.effect (tenant_id, op_id, op_type, entity_id, actor_id, idempotency_key, tag) VALUES ($1, $2, 'svc', $3, $4, $5, $6)`,
    [ctx.tenantId, uid(), entityId ?? null, ctx.actor.id, uid(), tag]);

function defaults() {
  return {
    async create(ctx: any, body: any) {
      await effect(ctx, 'create');
      const inv = await nextNo(ctx, 'INV');
      const pays = Array.isArray(body?.payments) ? body.payments : [];
      const rc = pays.length ? await nextNo(ctx, 'RC') : undefined;
      return { status: 201, body: { order: { id: uid(), registration_no: `R${pad(inv)}` }, invoice: { id: uid(), invoice_no: `INV-2083-${pad(inv)}` },
        ledger_entries: rc === undefined ? [] : [{ id: uid(), receipt_no: `RC-2083-${pad(rc)}` }] } };
    },
    async quote(_ctx: any, _draft: any) { return { status: 200, body: { quote_fingerprint: 'e'.repeat(64), totals: { net: { amount_paisa: 120_000, currency: 'NPR' } } } }; },
    async recordPayment(ctx: any, input: any) {
      const hit = await ctx.tx.query('SELECT receipt_no FROM sync2_test.receipts WHERE tenant_id = $1 AND idem = $2', [ctx.tenantId, input.idempotencyKey]);
      if (hit.rows[0]) return { ledgerEntryId: uid(), receiptNo: hit.rows[0].receipt_no, duplicate: true };
      const o = orderOf(input.orderId);
      if (o.invoiceCount === 0) throw new LimsError('billing.order_not_invoiced');
      if (input.amount.amountPaisa > o.invoiced - o.paid) throw new LimsError('billing.payment_exceeds_due');
      const no = `RC-2083-${pad(await nextNo(ctx, 'RC'))}`;
      await ctx.tx.query('INSERT INTO sync2_test.receipts (tenant_id, idem, order_id, receipt_no) VALUES ($1, $2, $3, $4)', [ctx.tenantId, input.idempotencyKey, input.orderId, no]);
      await effect(ctx, `receipt:${no}`, input.orderId);
      o.paid += input.amount.amountPaisa;
      return { ledgerEntryId: uid(), receiptNo: no, duplicate: false };
    },
    async collect(ctx: any, params: any) { await effect(ctx, 'collect', params.specimen_id); return { status: 200, body: { id: params.specimen_id } }; },
    async receive(ctx: any, params: any) { await effect(ctx, 'receive', params.specimen_id); return { status: 200, body: { id: params.specimen_id } }; },
  };
}
export const behave: ReturnType<typeof defaults> = defaults();

// ------------------------------------------------------------ module mock factories (vi.mock(path, (orig) => registrationMock(orig)))
export const registrationMock = async (orig: () => Promise<any>) => ({ ...(await orig()),
  create: (ctx: any, ...a: any[]) => { calls.create.push({ ctx, args: a }); return behave.create(ctx, a[0]); },
  quote: (ctx: any, ...a: any[]) => { calls.quote.push({ ctx, args: a }); return behave.quote(ctx, a[0]); } });
export const ledgerMock = async (orig: () => Promise<any>) => ({ ...(await orig()),
  createLedgerService: () => ({ recordPayment: (ctx: any, input: any) => { calls.recordPayment.push({ ctx, args: [input] }); return behave.recordPayment(ctx, input); },
    reverseEntry: async () => { throw new Error('the receipt adapter must never reverse'); } }) });
export const specimenMock = async (orig: () => Promise<any>) => ({ ...(await orig()),
  collectSpecimen: (ctx: any, ...a: any[]) => { calls.collect.push({ ctx, args: a }); return behave.collect(ctx, a[1]); },
  receiveSpecimen: (ctx: any, ...a: any[]) => { calls.receive.push({ ctx, args: a }); return behave.receive(ctx, a[1]); } });
// every test file repeats these three lines at its top (vi.mock is hoisted per test file, never from a helper):
//   vi.mock('../../../../modules/frontdesk/service/registration.service.js', async (orig) => (await import('./doubles.js')).registrationMock(orig as never));
//   vi.mock('../../../../modules/billing/service/ledger.service.js', async (orig) => (await import('./doubles.js')).ledgerMock(orig as never));
//   vi.mock('../../../../modules/lab/service/specimen.service.js', async (orig) => (await import('./doubles.js')).specimenMock(orig as never));

// ------------------------------------------------------------ synthetic payloads (shapes of the wrapped request schemas; no real person)
export const NEW_PATIENT = { full_name: 'Sync Testperson Alpha (SYNTHETIC)', sex: 'female', birth_on: '1990-01-01', phone_e164: '+97798000000001' };
export const registrationPayload = (centreId: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  patient: { new_patient: { ...NEW_PATIENT } }, centre_id: centreId, visit_type: 'opd', billing_mode: 'cash', items: [{ orderable_id: uid(), priority: 'routine' }],
  quote_fingerprint: 'a'.repeat(64), payments: [{ method_code: 'cash', amount_paisa: 50_000 }], ...over });
export const receiptPayload = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ method_code: 'cash', amount_received_paisa: 1_000, ...over });

/** fake readSpecimen seam for the lab adapters */
export const specimens = new Map<string, { status: string; version: number }>();
export const readSpecimen = async (_ctx: any, id: string) => specimens.get(id);
