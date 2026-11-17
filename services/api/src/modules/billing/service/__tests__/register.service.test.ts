// BL-T15 registers: B24 sales, B25 cancelled invoices, B26 credit notes, B27 audit trail (register.service.ts). Spec: PRD US-BL-12.1-12.3, 12.7; 02-TRD §5 B24-B27 + SalesRegisterRow / CreditNoteRegisterRow;
// contracts/openapi/billing.yaml rows (additionalProperties:false, Money = {amount_paisa, currency}); 07-SECURITY tenant isolation (list endpoints B24-B27: zero other-tenant rows); 08 P-15 Asia/Kathmandu dates.
// Fails now: service/register.service.ts does not exist. Seams are ASSUMED, see t15.helpers.ts header (writer: dispute if wrong).
// Gaps (spec): openapi CancelledInvoiceRow has no `cancelled_by` although US-BL-12.2 lists it (additionalProperties:false) -> asserted as the openapi keys only; see notes.
import { describe, expect, it } from 'vitest';
import { actRow, CENTRE, cnRow, code, id, invRow, makeWorld, MEMBERSHIP, OTHER_MEMBERSHIP, TENANT_A, TENANT_B, USER, type World } from './t15.helpers.js';
import { createRegisterService } from '../register.service.js';

const money = (n: number) => ({ amount_paisa: n, currency: 'NPR' });
const svcOf = (w: World) => createRegisterService({ repo: w.repo as never }) as any;
const setup = (o: Parameters<typeof makeWorld>[0] = {}) => { const w = makeWorld(o); return { w, svc: svcOf(w) }; };
const SALES_KEYS = ['exempt', 'invoice_date_ad', 'invoice_date_bs', 'invoice_no', 'other_tax', 'sn', 'status', 'taxable', 'total', 'vat'];
const CN_KEYS = ['credit_note_date_ad', 'credit_note_date_bs', 'credit_note_no', 'exempt', 'invoice_no', 'kind', 'net', 'other_tax', 'reason_code', 'sn', 'taxable', 'vat'];

describe('US-BL-12.1 B24 sales register: columns, cancelled present and marked', () => {
  it('row = SN, B.S. date, A.D. date, invoice no, buyer, PAN, total, exempt, taxable, VAT, other tax, status; nothing else (no ids, no patient)', async () => {
    const { w, svc } = setup({ invoices: [invRow(1, { exempt_paisa: 5000, taxable_paisa: 100000, vat_paisa: 13000, other_tax_paisa: 700, net_paisa: 118700 })] });
    const r = await w.inTx((ctx) => svc.sales(ctx, {}));
    expect(r.data).toHaveLength(1);
    expect(Object.keys(r.data[0]).sort()).toEqual([...SALES_KEYS, 'buyer_name', 'buyer_pan'].sort());
    expect(r.data[0]).toEqual({ sn: 1, invoice_date_bs: '2083-07-22', invoice_date_ad: '2026-11-08', invoice_no: '083/84-000001', buyer_name: 'Synthetic Buyer 1', buyer_pan: '123456789',
      total: money(118700), exempt: money(5000), taxable: money(100000), vat: money(13000), other_tax: money(700), status: 'issued' });
  });
  it('cancelled invoices are present and marked (status cancelled); sn counts them; a missing PAN means the key is absent (not null)', async () => {
    const { w, svc } = setup({ invoices: [invRow(1), invRow(2, { status: 'cancelled', cancelled_at: '2026-11-08T05:30:00.000Z', buyer_pan: null }), invRow(3)] });
    const r = await w.inTx((ctx) => svc.sales(ctx, {}));
    expect(r.data.map((x: any) => [x.sn, x.invoice_no, x.status])).toEqual([[1, '083/84-000001', 'issued'], [2, '083/84-000002', 'cancelled'], [3, '083/84-000003', 'issued']]);
    expect('buyer_pan' in r.data[1]).toBe(false);
  });
  it('A.D. date is the Asia/Kathmandu calendar date of issued_at (P-15), not the UTC date', async () => {
    const { w, svc } = setup({ invoices: [invRow(1, { issued_at: '2026-11-07T19:00:00.000Z' }), invRow(2, { issued_at: '2026-11-08T18:14:00.000Z' })] }); // 00:45 and 23:59 NPT on 2026-11-08
    const r = await w.inTx((ctx) => svc.sales(ctx, {}));
    expect(r.data.map((x: any) => x.invoice_date_ad)).toEqual(['2026-11-08', '2026-11-08']);
  });
  it('pg bigint strings become integer paisa (never a string, never a float)', async () => {
    const { w, svc } = setup({ invoices: [invRow(1, { exempt_paisa: '0', taxable_paisa: '9007199254740', vat_paisa: '1170935903062', other_tax_paisa: '0', net_paisa: '10178135157802' })] });
    const r = await w.inTx((ctx) => svc.sales(ctx, {}));
    expect(r.data[0].total).toEqual(money(10178135157802));
    expect(Number.isInteger(r.data[0].vat.amount_paisa)).toBe(true);
  });
  it('filters reach the repo: tenant from ctx only, FY, issued_at range, centre; a foreign tenantId in the query is ignored', async () => {
    const { w, svc } = setup({ invoices: [invRow(1)] });
    await w.inTx((ctx) => svc.sales(ctx, { tenantId: TENANT_B, fiscalYearBs: '2083/84', issuedAtFrom: '2026-11-01T00:00:00.000Z', issuedAtTo: '2026-11-30T23:59:59.000Z', centreId: CENTRE, limit: 20 }));
    const c = w.calls.find((x) => x.name === 'listSalesRegister')!;
    expect(c.args).toMatchObject({ tenantId: TENANT_A, fiscalYearBs: '2083/84', issuedAtFrom: '2026-11-01T00:00:00.000Z', issuedAtTo: '2026-11-30T23:59:59.000Z', centreId: CENTRE });
    expect(c.args.limit).toBeGreaterThanOrEqual(20);
    expect(w.calls.every((x) => x.args.tenantId === TENANT_A || x.args.tenant_id === TENANT_A)).toBe(true);
  });
  it('tenant isolation: other tenant rows never appear (07 list endpoints B24-B27); reads write nothing', async () => {
    const { w, svc } = setup({ invoices: [invRow(1), invRow(2, { tenant_id: TENANT_B, invoice_no: 'B-ONLY' })] });
    const r = await w.inTx((ctx) => svc.sales(ctx, {}));
    expect(JSON.stringify(r)).not.toContain('B-ONLY');
    expect(w.writes()).toEqual([]); expect(w.s.access).toHaveLength(0);
  });
  it('paging: limit 2 over 5 rows -> pages 2,2,1 following page.next_cursor, no row repeated or skipped, last page has no next_cursor; page.limit echoes the limit', async () => {
    const { w, svc } = setup({ invoices: [1, 2, 3, 4, 5].map((n) => invRow(n)) });
    const seen: string[] = []; let cursor: string | undefined; const sizes: number[] = []; let last: any;
    for (let i = 0; i < 6; i++) {
      last = await w.inTx((ctx) => svc.sales(ctx, { limit: 2, ...(cursor ? { cursor } : {}) }));
      sizes.push(last.data.length); seen.push(...last.data.map((x: any) => x.invoice_no));
      if (i === 0) expect(last.data.map((x: any) => x.sn)).toEqual([1, 2]);
      expect(last.page.limit).toBe(2);
      cursor = last.page.next_cursor; if (!cursor) break;
    }
    expect(sizes).toEqual([2, 2, 1]); expect(seen).toEqual([1, 2, 3, 4, 5].map((n) => `083/84-00000${n}`)); expect('next_cursor' in last.page).toBe(false);
  });
  it.each([0, 201, 1.5, -1, 'x'])('limit %s -> common.validation_failed, no repo read', async (limit) => {
    const { w, svc } = setup();
    expect((await code(w.inTx((ctx) => svc.sales(ctx, { limit })))).code).toBe('common.validation_failed'); expect(w.calls).toHaveLength(0);
  });
  it.each(['!!!', 'a'.repeat(600), '{"x":1}'])('cursor %j -> common.invalid_cursor (B26 x-error-codes)', async (cursor) => {
    const { w, svc } = setup();
    expect((await code(w.inTx((ctx) => svc.creditNotes(ctx, { cursor })))).code).toBe('common.invalid_cursor');
  });
  it.each([
    [{ fiscalYearBs: '83/84' }], [{ fiscalYearBs: "2083/84' OR 1=1" }], [{ issuedAtFrom: 'yesterday' }], [{ issuedAtFrom: '2026-12-01T00:00:00.000Z', issuedAtTo: '2026-11-01T00:00:00.000Z' }], [{ centreId: 'not-a-uuid' }],
  ])('bad filter %j -> common.validation_failed before any read', async (q) => {
    const { w, svc } = setup();
    for (const op of ['sales', 'cancelled', 'creditNotes']) expect((await code(w.inTx((ctx) => svc[op](ctx, q)))).code, op).toBe('common.validation_failed');
    expect(w.calls).toHaveLength(0);
  });
  it('no tenant on ctx -> auth.unauthenticated (never an unscoped query)', async () => {
    const { w, svc } = setup({ invoices: [invRow(1)] });
    expect((await code(w.inTx((ctx) => svc.sales(ctx, {}), { tenantId: undefined }))).code).toBe('auth.unauthenticated'); expect(w.calls).toHaveLength(0);
  });
});

describe('US-BL-12.2 B25 cancelled-invoice register', () => {
  it('lists only cancelled invoices with number, date (B.S. and A.D.), reason, credit-note no, buyer, total', async () => {
    const { w, svc } = setup({ invoices: [invRow(1), invRow(2, { status: 'cancelled', cancelled_at: '2026-11-08T05:30:00.000Z', cancelled_date_bs: '2083-07-22', cancel_reason_code: 'billing_error', credit_note_no: '083/84-CN-000001' })] });
    const r = await w.inTx((ctx) => svc.cancelled(ctx, {}));
    expect(r.data).toEqual([{ sn: 1, cancelled_date_bs: '2083-07-22', cancelled_date_ad: '2026-11-08', invoice_no: '083/84-000002', credit_note_no: '083/84-CN-000001', buyer_name: 'Synthetic Buyer 2', buyer_pan: '123456789',
      total: money(113000), reason_code: 'billing_error' }]);
  });
  it('tenant isolation + read-only', async () => {
    const { w, svc } = setup({ invoices: [invRow(2, { tenant_id: TENANT_B, status: 'cancelled', cancelled_at: '2026-11-08T05:30:00.000Z', invoice_no: 'B-ONLY' })] });
    expect((await w.inTx((ctx) => svc.cancelled(ctx, {}))).data).toEqual([]); expect(w.writes()).toEqual([]);
  });
});

describe('US-BL-12.7 B26 credit-note register (C8 R1 reconciliation input)', () => {
  const rows = [cnRow(1), cnRow(2), cnRow(3), cnRow(4, { kind: 'partial', other_tax_paisa: 50, net_paisa: 1000 * 4 + 130 * 4 + 50 })];
  it('published CreditNoteRegisterRow shape: both kinds, field `net`, one row per credit note, ordered by credit_note_seq', async () => {
    const { w, svc } = setup({ creditNotes: [rows[2], rows[0], rows[3], rows[1]] });
    const r = await w.inTx((ctx) => svc.creditNotes(ctx, {}));
    expect(r.data.map((x: any) => x.credit_note_no)).toEqual(['083/84-CN-000001', '083/84-CN-000002', '083/84-CN-000003', '083/84-CN-000004']);
    expect(r.data.map((x: any) => x.kind)).toEqual(['cancellation', 'partial', 'cancellation', 'partial']);
    for (const x of r.data) expect(Object.keys(x).sort()).toEqual([...CN_KEYS, 'buyer_name', 'buyer_pan'].sort());
    expect(r.data[0]).toEqual({ sn: 1, credit_note_date_bs: '2083-07-22', credit_note_date_ad: '2026-11-08', credit_note_no: '083/84-CN-000001', kind: 'cancellation', invoice_no: '083/84-000001',
      buyer_name: 'Synthetic Buyer 1', buyer_pan: '123456789', reason_code: 'billing_error', exempt: money(0), taxable: money(1000), vat: money(130), other_tax: money(0), net: money(1130) });
  });
  it('Σ net over the range equals Σ net_paisa of the credit notes in the same issued_at range and centre; each net = exempt + taxable + vat + other_tax', async () => {
    const all = [...rows, cnRow(5, { issued_at: '2026-12-20T05:00:00.000Z' }), cnRow(6, { centre_id: null }), cnRow(7, { tenant_id: TENANT_B })];
    const { w, svc } = setup({ creditNotes: all });
    const q = { issuedAtFrom: '2026-11-01T00:00:00.000Z', issuedAtTo: '2026-11-30T23:59:59.000Z', centreId: CENTRE };
    const r = await w.inTx((ctx) => svc.creditNotes(ctx, q));
    const expected = rows.reduce((t, x) => t + x.net_paisa, 0);
    expect(r.data.reduce((t: number, x: any) => t + x.net.amount_paisa, 0)).toBe(expected);
    for (const x of r.data) expect(x.net.amount_paisa).toBe(x.exempt.amount_paisa + x.taxable.amount_paisa + x.vat.amount_paisa + x.other_tax.amount_paisa);
    expect(w.calls.find((c) => c.name === 'listCreditNoteRegister')!.args).toMatchObject({ tenantId: TENANT_A, centreId: CENTRE, issuedAtFrom: q.issuedAtFrom, issuedAtTo: q.issuedAtTo });
  });
  it('a stored row whose net does not equal the sum of its parts is not silently "fixed": net is passed through as stored (CHECK credit_notes__totals__ck lives in the DB)', async () => {
    const { w, svc } = setup({ creditNotes: [cnRow(1, { net_paisa: 999 })] });
    expect((await w.inTx((ctx) => svc.creditNotes(ctx, {}))).data[0].net).toEqual(money(999));
  });
});

describe('US-BL-12.3 B27 audit trail', () => {
  const actions = ['invoice_issued', 'invoice_printed', 'invoice_cancelled', 'credit_note_issued', 'credit_note_printed', 'payment_reversed', 'refund_recorded', 'export_created', 'export_downloaded', 'cbms_submitted'];
  const mk = () => actions.map((a, i) => actRow(i % 9 + 1, { id: id(3100 + i), action: a, occurred_at: `2026-11-08T0${i % 9}:30:00.000Z`, document_no: `DOC-${i}`, actor_membership_id: i < 7 ? MEMBERSHIP : OTHER_MEMBERSHIP }));
  it('filtered by user: every issue/print/cancel/credit/reversal/refund/export/CBMS action of that user appears with timestamp, action and document no; other users and tenants do not', async () => {
    const { w, svc } = setup({ activity: [...mk(), actRow(1, { id: id(3200), tenant_id: TENANT_B, document_no: 'B-ONLY' })] });
    const r = await w.inTx((ctx) => svc.auditTrail(ctx, { actorMembershipId: MEMBERSHIP, limit: 100 }));
    expect(r.data.map((x: any) => x.action).sort()).toEqual(actions.slice(0, 7).sort());
    for (const x of r.data) { expect(x.occurred_at).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/); expect(x.summary).toContain('DOC-'); }
    expect(JSON.stringify(r)).not.toContain('B-ONLY');
    expect(w.calls.find((c) => c.name === 'listAuditTrail')!.args).toMatchObject({ tenantId: TENANT_A, actorMembershipId: MEMBERSHIP });
  });
  it('every whitelisted action maps to an ActivityRow (occurred_at, actor, action, entity_type, entity_id?, summary?) - openapi has additionalProperties:false', async () => {
    const { w, svc } = setup({ activity: mk() });
    const r = await w.inTx((ctx) => svc.auditTrail(ctx, { limit: 100 }));
    expect(r.data).toHaveLength(actions.length);
    for (const x of r.data) {
      expect(Object.keys(x).every((k) => ['occurred_at', 'actor', 'action', 'entity_type', 'entity_id', 'summary'].includes(k)), JSON.stringify(Object.keys(x))).toBe(true);
      expect(typeof x.actor).toBe('object'); expect(typeof x.entity_type).toBe('string');
    }
  });
  it('raw `details` jsonb, request ids, actor_id/user ids and the centre never leak into a row beyond the declared keys', async () => {
    const { w, svc } = setup({ activity: [actRow(1)] });
    const s = JSON.stringify(await w.inTx((ctx) => svc.auditTrail(ctx, {})));
    expect(s).not.toContain('PHI-LIKE-DETAIL'); expect(s).not.toContain('secret_note'); expect(s).not.toContain(id(9001)); expect(s).not.toContain(USER);
  });
  it('occurred_at range and action filters reach the repo; an unknown action or non-uuid actor is common.validation_failed', async () => {
    const { w, svc } = setup({ activity: mk() });
    await w.inTx((ctx) => svc.auditTrail(ctx, { action: 'invoice_printed', occurredAtFrom: '2026-11-08T00:00:00.000Z', occurredAtTo: '2026-11-08T23:59:59.000Z' }));
    expect(w.calls.find((c) => c.name === 'listAuditTrail')!.args).toMatchObject({ action: 'invoice_printed', occurredAtFrom: '2026-11-08T00:00:00.000Z', occurredAtTo: '2026-11-08T23:59:59.000Z' });
    const n = w.calls.length;
    for (const q of [{ action: "x'; DROP TABLE billing.activity_log;--" }, { actorMembershipId: 'nope' }, { limit: 500 }]) expect((await code(w.inTx((ctx) => svc.auditTrail(ctx, q)))).code).toBe('common.validation_failed');
    expect(w.calls).toHaveLength(n);
  });
  it('newest first, keyset paging without repeats; reads write nothing', async () => {
    const { w, svc } = setup({ activity: [1, 2, 3].map((n) => actRow(n)) });
    const p1 = await w.inTx((ctx) => svc.auditTrail(ctx, { limit: 2 })); const p2 = await w.inTx((ctx) => svc.auditTrail(ctx, { limit: 2, cursor: p1.page.next_cursor }));
    expect([...p1.data, ...p2.data].map((x: any) => x.occurred_at)).toEqual(['2026-11-08T03:00:00.000Z', '2026-11-08T02:00:00.000Z', '2026-11-08T01:00:00.000Z']);
    expect(w.writes()).toEqual([]);
  });
});
