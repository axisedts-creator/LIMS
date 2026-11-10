// B24 getSalesRegister, B25 getCancelledInvoiceRegister, B26 getCreditNoteRegister, B27 getAuditTrail (02-TRD §5; contracts/openapi/billing.yaml SalesRegisterRow /
// CancelledInvoiceRow / CreditNoteRegisterRow / ActivityRow; PRD US-BL-12.1-12.3, 12.7). Read-only. Tenant comes from ctx only; every user value is validated first, then only a bound parameter.
// [CONV] sn = position in the filtered list (running count carried in the cursor), not the fiscal sequence; A.D. dates are the Asia/Kathmandu calendar date (08 P-15);
// cancelled_date_bs is derived from cancelled_at (invoices has no such column). Cursor = base64url JSON {s,t,i,k,n}: sort name, keyset time, keyset id, repo key, rows already served.
// [CONV] ActivityRow: entity_type = document_kind (else 'billing'), summary = "<action> <document_no>", actor = {membership_id, display_name}; `details`, request id and user ids never leave.
import { LimsError } from '../../../core/errors.js';
import { moneyOf, toPaisa } from '../domain/money/paisa.js';
import { billingRepo, type BillingRepo } from '../repository/index.js';
import type { BalanceCtx } from './balance.service.js';
import { bsText, DEFAULT_TZ, localDate, names } from './ledgerDto.js';
import { bad, isRec, iso, limitOf, present, STAFF_DISPLAY, UTC_INSTANT, UUID, uuid } from './invoiceRead.service.js';

type RegisterRepo = Pick<BillingRepo, 'listSalesRegister' | 'listCancelledInvoices' | 'listCreditNoteRegister' | 'listAuditTrail'>;
type Row = Record<string, any>;
const FY = /^[0-9]{4}\/[0-9]{2}$/;
const CURSOR = /^[A-Za-z0-9_-]{1,512}$/;
/** billing.activity_log__action__ck */
export const ACTIVITY_ACTIONS = ['invoice_issued', 'invoice_printed', 'invoice_cancelled', 'credit_note_issued', 'credit_note_printed', 'payment_recorded', 'payment_reversed', 'refund_requested',
  'refund_rejected', 'refund_recorded', 'receipt_printed', 'override_created', 'export_created', 'export_downloaded', 'cbms_submitted', 'credit_account_changed', 'periodic_invoice_issued',
  'settings_changed', 'cash_session_closed', 'finance_review_resolved'];

interface Cursor { s: string; t: string; i: string; k: string; n: number; f?: string }   // f = fiscal_year_bs of the last row (B26 keyset)
const encode = (c: Cursor): string => Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
function decode(raw: unknown, sort: string): Cursor {
  const invalid = () => new LimsError('common.invalid_cursor');
  if (typeof raw !== 'string' || !CURSOR.test(raw)) throw invalid();
  let v: any;
  try { v = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')); } catch { throw invalid(); }
  if (!isRec(v) || v['s'] !== sort || typeof v['t'] !== 'string' || !UTC_INSTANT.test(v['t']) || typeof v['i'] !== 'string' || !UUID.test(v['i'])
    || typeof v['k'] !== 'string' || v['k'].length < 1 || v['k'].length > 64 || !Number.isSafeInteger(v['n']) || v['n'] < 0
    || (v['f'] !== undefined && (typeof v['f'] !== 'string' || !FY.test(v['f'])))) throw invalid();
  return { s: sort, t: v['t'], i: v['i'], k: v['k'], n: v['n'], ...(v['f'] === undefined ? {} : { f: v['f'] }) };
}

function scope(ctx: BalanceCtx): { tx: never; tenantId: string } {
  if (typeof ctx?.tenantId !== 'string' || typeof ctx.actor?.id !== 'string' || !ctx.tx) throw new LimsError('auth.unauthenticated');
  return { tx: ctx.tx as never, tenantId: ctx.tenantId };
}
function instant(q: Row, k: string): string | undefined {
  const v = q[k];
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || !UTC_INSTANT.test(v) || Number.isNaN(Date.parse(v))) throw bad(`/${k}`);
  return v;
}
function range(q: Row, from: string, to: string): { from?: string; to?: string } {
  const a = instant(q, from), b = instant(q, to);
  if (a !== undefined && b !== undefined && Date.parse(a) > Date.parse(b)) throw bad(`/${from}`);
  return { ...(a === undefined ? {} : { from: a }), ...(b === undefined ? {} : { to: b }) };
}

const dateAd = (v: unknown) => localDate(iso(v), DEFAULT_TZ);
const money = (v: unknown) => moneyOf(toPaisa(v));

export function createRegisterService(deps: { repo?: RegisterRepo } = {}) {
  const db = deps.repo ?? billingRepo;

  /** Shared B24-B26 shape: validate, read limit+1 rows after the cursor, map, cut the page. */
  async function list(ctx: BalanceCtx, rawQuery: unknown, o: {
    sort: string; read: (a: any) => Promise<Row[]>; timeOf: (r: Row) => unknown; keyOf: (r: Row) => string; dto: (r: Row, sn: number) => Row; fyKey?: boolean;
  }) {
    const { tx, tenantId } = scope(ctx);
    const q = isRec(rawQuery) ? rawQuery : {};
    const limit = limitOf(q['limit']);
    const fy = q['fiscalYearBs'];
    if (fy !== undefined && (typeof fy !== 'string' || !FY.test(fy))) throw bad('/fiscal_year_bs');
    const centreId = q['centreId'] === undefined ? undefined : uuid(q['centreId'], '/centre_id');
    const r = range(q, 'issuedAtFrom', 'issuedAtTo');
    const after = q['cursor'] === undefined ? undefined : decode(q['cursor'], o.sort);
    if (o.fyKey && after && (after.f === undefined || !/^[0-9]{1,9}$/.test(after.k))) throw new LimsError('common.invalid_cursor');
    const rows = await o.read({
      tx, tenantId, limit: limit + 1,
      ...(fy === undefined ? {} : { fiscalYearBs: fy }), ...(centreId === undefined ? {} : { centreId }),
      ...(r.from === undefined ? {} : { issuedAtFrom: r.from }), ...(r.to === undefined ? {} : { issuedAtTo: r.to }),
      ...(after === undefined ? {} : { afterKey: after.k, afterTime: after.t, afterId: after.i }), ...(after?.f === undefined ? {} : { afterFy: after.f }),
    });
    const data = rows.slice(0, limit);
    const last = data[data.length - 1];
    const served = (after?.n ?? 0) + data.length;
    const page: { limit: number; next_cursor?: string } = { limit };
    if (rows.length > limit && last) page.next_cursor = encode({ s: o.sort, t: iso(o.timeOf(last)), i: String(last['id']), k: o.keyOf(last), n: served,
      ...(o.fyKey && typeof last['fiscal_year_bs'] === 'string' ? { f: last['fiscal_year_bs'] } : {}) });
    return { data: data.map((x, i) => o.dto(x, (after?.n ?? 0) + i + 1)), page };
  }

  const sales = (ctx: BalanceCtx, q: unknown) => list(ctx, q, {
    sort: 'issued_at', read: ({ tx, ...a }) => db.listSalesRegister(tx, a), timeOf: (r) => r['issued_at'], keyOf: (r) => String(r['invoice_seq']),
    dto: (r, sn) => present({
      sn, invoice_date_bs: r['invoice_date_bs'], invoice_date_ad: dateAd(r['issued_at']), invoice_no: r['invoice_no'], buyer_name: r['buyer_name'], buyer_pan: r['buyer_pan'],
      total: money(r['net_paisa']), exempt: money(r['exempt_paisa']), taxable: money(r['taxable_paisa']), vat: money(r['vat_paisa']), other_tax: money(r['other_tax_paisa']), status: r['status'],
    }),
  });

  const cancelled = (ctx: BalanceCtx, q: unknown) => list(ctx, q, {
    sort: 'cancelled_at', read: ({ tx, ...a }) => db.listCancelledInvoices(tx, a), timeOf: (r) => r['cancelled_at'], keyOf: (r) => String(r['invoice_seq']),
    dto: (r, sn) => present({
      sn, cancelled_date_bs: bsText(dateAd(r['cancelled_at'])), cancelled_date_ad: dateAd(r['cancelled_at']), invoice_no: r['invoice_no'], credit_note_no: r['credit_note_no'],
      buyer_name: r['buyer_name'], buyer_pan: r['buyer_pan'], total: money(r['net_paisa']), reason_code: r['cancel_reason_code'],
    }),
  });

  const creditNotes = (ctx: BalanceCtx, q: unknown) => list(ctx, q, {
    sort: 'issued_at', read: ({ tx, ...a }) => db.listCreditNoteRegister(tx, a), timeOf: (r) => r['issued_at'], keyOf: (r) => String(r['credit_note_seq']), fyKey: true,   // ordered by (fiscal_year_bs, credit_note_seq): 02-TRD §5.2
    dto: (r, sn) => present({
      sn, credit_note_date_bs: r['credit_note_date_bs'], credit_note_date_ad: dateAd(r['issued_at']), credit_note_no: r['credit_note_no'], kind: r['kind'], invoice_no: r['invoice_no'],
      buyer_name: r['buyer_name'], buyer_pan: r['buyer_pan'], reason_code: r['reason_code'],
      exempt: money(r['exempt_paisa']), taxable: money(r['taxable_paisa']), vat: money(r['vat_paisa']), other_tax: money(r['other_tax_paisa']), net: money(r['net_paisa']),
    }),
  });

  async function auditTrail(ctx: BalanceCtx, rawQuery: unknown) {
    const { tx, tenantId } = scope(ctx);
    const q = isRec(rawQuery) ? rawQuery : {};
    const limit = limitOf(q['limit']);
    const actor = q['actorMembershipId'] === undefined ? undefined : uuid(q['actorMembershipId'], '/actor_membership_id');
    const action = q['action'];
    if (action !== undefined && (typeof action !== 'string' || !ACTIVITY_ACTIONS.includes(action))) throw bad('/action');
    const r = range(q, 'occurredAtFrom', 'occurredAtTo');
    const after = q['cursor'] === undefined ? undefined : decode(q['cursor'], '-occurred_at');
    const rows = await db.listAuditTrail(tx, {
      tenantId, limit: limit + 1, ...(actor === undefined ? {} : { actorMembershipId: actor }), ...(action === undefined ? {} : { action }),
      ...(r.from === undefined ? {} : { occurredAtFrom: r.from }), ...(r.to === undefined ? {} : { occurredAtTo: r.to }),
      ...(after === undefined ? {} : { afterKey: after.k, afterTime: after.t, afterId: after.i }), ...(after?.f === undefined ? {} : { afterFy: after.f }),
    });
    const data = rows.slice(0, limit);
    const last = data[data.length - 1];
    const page: { limit: number; next_cursor?: string } = { limit };
    if (rows.length > limit && last) page.next_cursor = encode({ s: '-occurred_at', t: iso(last['occurred_at']), i: String(last['id']), k: String(last['id']), n: (after?.n ?? 0) + data.length });
    const display = await names(ctx, data.map((x) => x['actor_membership_id']));
    return {
      data: data.map((x) => {
        const membership = typeof x['actor_membership_id'] === 'string' ? x['actor_membership_id'] : String(x['actor_id']); // a system actor has no membership; its id is a service principal
        return present({
          occurred_at: iso(x['occurred_at']), actor: { membership_id: membership, display_name: display.get(membership) ?? STAFF_DISPLAY }, action: x['action'],
          entity_type: x['document_kind'] ?? 'billing', entity_id: x['document_id'],
          summary: typeof x['document_no'] === 'string' ? `${String(x['action']).replace(/_/g, ' ')} ${x['document_no']}`.slice(0, 500) : undefined,
        });
      }),
      page,
    };
  }
  return { sales, cancelled, creditNotes, auditTrail };
}
export type RegisterService = ReturnType<typeof createRegisterService>;
