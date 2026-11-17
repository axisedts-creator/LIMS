// BL-T06 test helpers (not a test file). In-memory "billing world" + the REAL core event publisher (createEvents) over the core makeEventDb tx fake,
// so every published envelope is validated by the real contracts/events/*.schema.json.
// ASSUMED seams (spec fixes behaviour, not signatures; writer: object via a dispute if wrong) — all repo fns take (tx, args) and carry tenantId from ctx only:
//   repo.getBillingSettings(tx,{tenantId})                      -> {invoice_series_scope,'tenant'|'branch', prices_include_tax, abbreviated_invoice_enabled, version} | undefined
//   repo.insertInvoice(tx,row)                                  -> row   (snake_case = billing.invoices columns; 23505 on invoices__tenant_id_order_registration__p_uq)
//   repo.insertInvoiceLines(tx,rows[])                          -> void  (snake_case = billing.invoice_lines columns)
//   repo.insertActivity(tx,row)                                 -> void  (snake_case = billing.activity_log columns)
//   repo.enqueueCbmsSync(tx,{tenantId,documentKind,documentId}) -> void  (job billing.cbms_sync, job_key cbms:<kind>:<id>, 02-TRD §9)
//   repo.readOrderTotals(tx,{tenantId,orderId})                 -> {invoiced_paisa,paid_paisa,credited_paisa (bigint as string), issued_invoice_count, centre_id, billing_mode} | undefined
//   repo.getOrderBalance(tx,{tenantId,orderId})                 -> existing balances.repo.ts
//   repo.upsertOrderBalance(tx,{tenantId,orderId,centreId,billingMode,invoicedPaisa,paidPaisa,creditedPaisa,balanceVersion,releaseBasis,userId}) -> row
//   repo.findActiveOverride(tx,{tenantId,orderId,at})           -> row | undefined
//   counter.allocate(tx,input)                                  -> {lastNo, allocatedAt}   (= counter.service.ts createCounterService().allocate)
// Synthetic data only.
import { LimsError } from '../../../../core/errors.js';
import { ctxFor, makeEventDb, pgError } from '../../../../core/events/__tests__/helpers.js';
import { createEvents } from '../../../../core/events/publish.js';
import { computeQuote } from '../quote.service.js';

export { TENANT_A, USER, MEMBERSHIP, REQ_ID, rejection } from '../../../../core/events/__tests__/helpers.js';
export const V7 = (n: string) => `01a1a98a-ac40-7000-8000-${n}`;
export const IDS = {
  order: V7('000000050001'), order2: V7('000000050002'), patient: V7('000000040001'), branch: V7('000000010001'), centre: V7('000000020002'),
  item1: V7('000000060001'), orderable1: V7('000000070001'), priceList: V7('000000080001'),
};
/** Server "now" for tests: 2026-11-08 11:45 NPT -> BS FY 2083/84 (short 083/84). */
export const BASE = '2026-11-08T06:00:00.000Z';
export const FY_LONG = '2083/84';
export const FY_SHORT = '083/84';
export const BUYER = { name: 'Synthetic Buyer One', pan: '123456789', address: 'Synthetic Street 1' };

export const npr = (amountPaisa: number) => ({ amountPaisa, currency: 'NPR' as const });
export const money = (amount_paisa: number) => ({ amount_paisa, currency: 'NPR' });
export const line = (over: Record<string, unknown> = {}) => ({
  lineRef: 'L1', orderItemId: IDS.item1, orderableId: IDS.orderable1, orderableKind: 'test', code: 'CBC', name: 'Complete blood count', priority: 'routine',
  unitPrice: npr(100000), tax: { vat: 'taxable', vatRateBp: 1300 }, priceListId: IDS.priceList, priceListVersion: 1, priceSource: 'tenant_default', ...over,
});

export interface WorldOpts {
  tenantSettings?: Record<string, unknown>;
  billingSettings?: Record<string, unknown> | null;
  counterStart?: number;
}
interface State {
  invoices: any[]; lines: any[]; activity: any[]; cbms: any[]; balances: Record<string, any>; counterNo: number; paid: Record<string, number>; override?: any;
}

export function makeWorld(opts: WorldOpts = {}) {
  const db = makeEventDb();
  let s: State = { invoices: [], lines: [], activity: [], cbms: [], balances: {}, counterNo: opts.counterStart ?? 0, paid: {} };
  const repoCalls: Array<{ name: string; args: any }> = [];
  const counterCalls: any[] = [];
  const idCalls: any[] = [];
  const w = {
    db, repoCalls, counterCalls, idCalls,
    get s() { return s; },
    counterFail: undefined as undefined | (() => Error),
    clockMs: Date.parse(BASE),
    tenantSettings: {
      numbering: { invoiceNoPattern: '{fy}-{seq:6}' }, ird: { pan: '999999999', cbmsRealtimeRequired: true }, branding: { displayName: 'Synthetic Lab Pvt Ltd' },
      timezone: 'Asia/Kathmandu', releaseRequiresPayment: true, ...(opts.tenantSettings ?? {}),
    } as Record<string, any>,
    billingSettings: opts.billingSettings === null ? undefined : { invoice_series_scope: 'tenant', prices_include_tax: false, abbreviated_invoice_enabled: false, version: 1, ...(opts.billingSettings ?? {}) },
  };
  const rec = (name: string, tx: unknown, args: any) => {
    if (typeof args?.tenantId !== 'string' && typeof args?.tenant_id !== 'string') throw new Error(`fake repo: ${name} called without a tenant id`);
    repoCalls.push({ name, args });
    return tx;
  };
  const key = (a: { tenantId: string; orderId: string }) => `${a.tenantId}|${a.orderId}`;
  const repo = {
    async getBillingSettings(tx: unknown, a: any) { rec('getBillingSettings', tx, a); return w.billingSettings; },
    async insertInvoice(tx: unknown, row: any) {
      rec('insertInvoice', tx, row);
      if (row.purpose === 'registration' && s.invoices.some((i) => i.tenant_id === row.tenant_id && i.order_id === row.order_id && i.purpose === 'registration')) {
        throw Object.assign(pgError('23505', 'duplicate key value violates unique constraint "invoices__tenant_id_order_registration__p_uq"'), { constraint: 'invoices__tenant_id_order_registration__p_uq' });
      }
      s.invoices.push(structuredClone(row)); return row;
    },
    async insertInvoiceLines(tx: unknown, rows: any[]) { rec('insertInvoiceLines', tx, { tenantId: rows[0]?.tenant_id ?? 'x' }); s.lines.push(...structuredClone(rows)); },
    async insertActivity(tx: unknown, row: any) { rec('insertActivity', tx, row); s.activity.push(structuredClone(row)); },
    async enqueueCbmsSync(tx: unknown, a: any) { rec('enqueueCbmsSync', tx, a); s.cbms.push(structuredClone(a)); },
    async readOrderTotals(tx: unknown, a: any) {
      rec('readOrderTotals', tx, a);
      const inv = s.invoices.filter((i) => i.tenant_id === a.tenantId && i.order_id === a.orderId);
      if (inv.length === 0 && !s.paid[key(a)]) return undefined;
      return {
        invoiced_paisa: String(inv.reduce((t, i) => t + Number(i.net_paisa), 0)), paid_paisa: String(s.paid[key(a)] ?? 0), credited_paisa: '0',
        issued_invoice_count: inv.length, centre_id: IDS.centre, billing_mode: 'cash',
      };
    },
    async getOrderBalance(tx: unknown, a: any) { rec('getOrderBalance', tx, a); return s.balances[key(a)]; },
    async upsertOrderBalance(tx: unknown, a: any) {
      rec('upsertOrderBalance', tx, a);
      const old = s.balances[key(a)];
      // models billing.order_balances_guard (05-SCHEMA §3): version never decreases; it rises iff one of invoiced/paid/credited changed
      if (old) {
        const amountsChanged = old.invoiced_paisa !== a.invoicedPaisa || old.paid_paisa !== a.paidPaisa || old.credited_paisa !== a.creditedPaisa;
        if (a.balanceVersion < old.balance_version || (a.balanceVersion > old.balance_version) !== amountsChanged) throw Object.assign(pgError('P0001', 'immutable_row'), { detail: 'billing.order_balances' });
      }
      const row = { tenant_id: a.tenantId, order_id: a.orderId, centre_id: a.centreId, billing_mode: a.billingMode, invoiced_paisa: a.invoicedPaisa, paid_paisa: a.paidPaisa,
        credited_paisa: a.creditedPaisa, balance_due_paisa: a.invoicedPaisa - a.creditedPaisa - a.paidPaisa, balance_version: a.balanceVersion, release_basis: a.releaseBasis };
      s.balances[key(a)] = row; return row;
    },
    async findActiveOverride(tx: unknown, a: any) { rec('findActiveOverride', tx, a); return s.override; },
  };
  const counter = {
    async allocate(_tx: unknown, input: any) {
      counterCalls.push({ ...input, atRepoCall: repoCalls.length });
      if (w.counterFail) throw w.counterFail();
      w.clockMs += 1000;
      return { lastNo: ++s.counterNo, allocatedAt: new Date(w.clockMs).toISOString() };
    },
  };
  const events = createEvents({ producer: 'billing' }) as never;
  const ctx = (over: Record<string, unknown> = {}) => ctxFor(db, {
    now: () => BASE,
    ports: { IdentityPort: { async getTenantSettings(_c: unknown, input: unknown) { idCalls.push(input); return w.tenantSettings; } } },
    ...over,
  }) as never;
  /** One DB transaction: events/jobs of the event db AND the in-memory billing state commit or roll back together. */
  async function tx<T>(fn: () => Promise<T>): Promise<T> {
    const snap = structuredClone(s); const clock = w.clockMs;
    try { return await db.transaction(fn); } catch (e) { s = snap; w.clockMs = clock; throw e; }
  }
  const events_of = (type: string) => db.events.filter((e) => e.eventType === type);
  return Object.assign(w, { repo, counter, events, ctx, tx, events_of });
}
export type World = ReturnType<typeof makeWorld>;

/** A valid issue() input; the fingerprint is the real computeQuote one (so "mismatch" tests change it on purpose). */
export async function issueInput(ctx: never, over: Record<string, unknown> = {}) {
  const lines = (over['lines'] as any[]) ?? [line()];
  const discounts = (over['discounts'] as any[]) ?? [];
  const q = await computeQuote(ctx, { lines, discounts });
  return { purpose: 'registration', orderId: IDS.order, patientId: IDS.patient, branchId: IDS.branch, centreId: IDS.centre, buyer: BUYER, lines, discounts, expectedFingerprint: q.fingerprint, ...over };
}
export const errCode = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as LimsError & { statusCode?: number; errors?: any[] }; } throw new Error('expected rejection'); };
