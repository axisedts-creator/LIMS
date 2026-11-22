// T0D-FIX-7 (LD-455): payments list filters must accept the array the request validator hands the handler.
// contracts/openapi/payments.yaml declares status and gateway of listPaymentIntents (and listPaymentRefunds) as array, style form, explode false, so GET ?status=held_for_review
// reaches the handler as ['held_for_review']. intents.ts csv() took strings only -> 400 common.validation_failed on /payments/review and /payments/reconciliation
// (live request ids 01a20340-..., 01a20344-..., 01a2034a-...; error references 3891220841, 4130873109).
// Fails now: csv() answers invalid() for every array. Synthetic data only; no gateway or outside call.
import { beforeEach, describe, expect, it } from 'vitest';
import { FIXED_NOW } from '../../../../../../../packages/fakes/src/base';
import { CENTRE_2, makeStaffHarness, uid, type StaffHarness } from '../helpers/staffHarness';
import { makeRefundHarness, uid as rid } from '../helpers/refundHarness';

let t: StaffHarness;
beforeEach(async () => { t = await makeStaffHarness(); t.seedCodes(); });

const sec = (s: number) => new Date(Date.parse(FIXED_NOW) + s * 1000).toISOString();
const ID = (n: number) => uid(n);
const list = (query: Record<string, unknown> = {}, o: { as?: any; tenant?: 'A' | 'B' } = {}) => t.call('listPaymentIntents', { query, ...o });
const ids = (r: any) => (r.body.data as any[]).map((x) => x.id);
const seed = () => {
  t.add({ id: ID(1), status: 'held_for_review', gateway: 'esewa', createdAt: sec(-500), holdReason: 'amount_mismatch' });
  t.add({ id: ID(2), status: 'settled', gateway: 'khalti', createdAt: sec(-400) });
  t.add({ id: ID(3), status: 'failed', gateway: 'esewa', createdAt: sec(-300), centre: CENTRE_2 });
  t.add({ id: ID(4), status: 'pending', gateway: 'khalti', createdAt: sec(-200), centre: CENTRE_2 });
  t.add({ id: ID(5), status: 'held_for_review', gateway: 'khalti', createdAt: sec(-100), holdReason: 'exceeds_due' });
};
const codes = (n: number) => Array.from({ length: n }, (_, i) => `code_${String(i).padStart(2, '0')}`);

describe('T0D-FIX-7 listPaymentIntents takes an array or a comma string for status, gateway and hold_reason', () => {
  it.each([
    ['status one item array', { status: ['held_for_review'] }, [5, 1]],
    ['status multi item array', { status: ['held_for_review', 'failed'] }, [5, 3, 1]],
    ['status comma string (unchanged)', { status: 'held_for_review,failed' }, [5, 3, 1]],
    ['status single string (unchanged)', { status: 'held_for_review' }, [5, 1]],
    ['status array with a duplicate', { status: ['failed', 'failed'] }, [3]],
    ['gateway one item array', { gateway: ['khalti'] }, [5, 4, 2]],
    ['gateway multi item array', { gateway: ['khalti', 'esewa'] }, [5, 4, 3, 2, 1]],
    ['gateway comma string (unchanged)', { gateway: 'khalti,esewa' }, [5, 4, 3, 2, 1]],
    ['hold_reason one item array', { hold_reason: ['exceeds_due'] }, [5]],
    ['hold_reason multi item array', { hold_reason: ['exceeds_due', 'amount_mismatch'] }, [5, 1]],
    ['hold_reason comma string (unchanged)', { hold_reason: 'exceeds_due,amount_mismatch' }, [5, 1]],
    ['all three arrays combined', { status: ['held_for_review'], gateway: ['khalti'], hold_reason: ['exceeds_due'] }, [5]],
  ])('%s -> 200 with the matching rows', async (_n, query, expected) => {
    seed();
    const r = await list(query as any);
    expect(r.status).toBe(200);
    expect(ids(r)).toEqual(expected.map(ID));
  });

  it('the reconciliation page request exactly as the web sends it (status=held_for_review&limit=50&sort=-created_at), as string and as validator array', async () => {
    seed();
    for (const status of ['held_for_review', ['held_for_review']]) {
      for (const limit of [50, '50']) {
        const r = await list({ status, limit, sort: '-created_at' });
        expect(r.status, JSON.stringify({ status, limit })).toBe(200);
        expect(ids(r)).toEqual([ID(5), ID(1)]);
        expect(r.body.page).toMatchObject({ limit: 50 });
      }
    }
  });

  it('duplicates are removed before the query: one value reaches SQL, not two', async () => {
    seed();
    await list({ status: ['failed', 'failed', 'failed'] });
    const sent = t.h.db.stmts.flatMap((s) => s.values ?? []).filter((v: unknown) => Array.isArray(v));
    expect(sent).toContainEqual(['failed']);
    expect(sent).not.toContainEqual(['failed', 'failed']);
  });

  it('an empty page is 200 with empty data and no cursor, for an array filter too', async () => {
    seed();
    const r = await list({ status: ['expired'] });
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual([]);
    expect(r.body.page.next_cursor).toBeUndefined();
    const none = await t.call('listPaymentIntents', { query: { status: ['held_for_review'] }, tenant: 'B' });
    expect(none.status).toBe(200);
    expect(none.body.data).toEqual([]);
  });

  it.each([
    ['status array with one bad value', { status: ['held_for_review', 'exploded'] }],
    ['status array of only a bad value', { status: ['exploded'] }],
    ['gateway array with a bad value', { gateway: ['khalti', 'paypal'] }],
    ['hold_reason array with a bad value', { hold_reason: ['exceeds_due', "x'; DROP TABLE payments.intents;--"] }],
    ['status empty array', { status: [] }],
    ['gateway empty array', { gateway: [] }],
    ['hold_reason empty array', { hold_reason: [] }],
    ['status empty string', { status: '' }],
    ['gateway empty string', { gateway: '' }],
    ['hold_reason empty string', { hold_reason: '' }],
    ['status array holding an empty string', { status: [''] }],
    ['status array with a number', { status: [1] }],
    ['status array with null', { status: [null] }],
    ['status array with a nested array', { status: [['settled']] }],
    ['status as an object', { status: { 0: 'settled' } }],
    ['status as a number', { status: 5 }],
    ['hold_reason array of 21 distinct codes (limit is 20)', { hold_reason: codes(21) }],
    ['hold_reason comma string of 21 distinct codes (limit is 20)', { hold_reason: codes(21).join(',') }],
  ])('bad input (%s) -> typed 400 common.validation_failed, never 500, no SQL built from it', async (_n, query) => {
    seed();
    const before = t.h.db.stmts.length;
    const r = await list(query as any);
    expect(r.code).toBe('common.validation_failed');
    expect(r.status).toBe(400);
    expect(JSON.stringify(t.h.db.stmts.slice(before).map((s) => s.values))).not.toMatch(/exploded|paypal|DROP TABLE/);
  });

  it('hold_reason array of exactly 20 distinct codes is accepted (same 20 item limit as the comma form)', async () => {
    seed();
    const r = await list({ hold_reason: codes(20) });
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual([]);
  });

  it('forbidden: a caller without payments.reconciliation.read gets auth.forbidden for an array filter and no intent is read', async () => {
    seed();
    for (const as of ['front_desk', 'nobody'] as const) {
      const before = t.h.db.stmts.length;
      const r = await list({ status: ['held_for_review'] }, { as });
      expect(r.code).toBe('auth.forbidden');
      expect(t.readStmts(before)).toEqual([]);
    }
  });

  it('other tenant: tenant B never sees tenant A rows through an array filter, and A never sees B rows', async () => {
    seed();
    t.add({ id: ID(60), tenant: 'B', status: 'held_for_review', gateway: 'khalti', createdAt: sec(-50) });
    const a = await list({ status: ['held_for_review'], gateway: ['khalti', 'esewa'] });
    expect(ids(a)).toEqual([ID(5), ID(1)]);
    const b = await list({ status: ['held_for_review'], gateway: ['khalti', 'esewa'] }, { tenant: 'B' });
    expect(ids(b)).toEqual([ID(60)]);
  });
});

describe('T0D-FIX-7 audit: listPaymentRefunds (the other payments list with array status and gateway) stays correct', () => {
  it('status and gateway as arrays or comma strings filter; bad, empty or non-string values are 400; forbidden stays auth.forbidden; other tenant is invisible', async () => {
    const r = await makeRefundHarness({ intents: [{ gateway: 'khalti' }, { gateway: 'esewa' }, { tenant: 'B', gateway: 'khalti' }] });
    r.addRefund({ id: rid(601), intent: r.seeds[0]!.id, status: 'requested', gateway: 'khalti' });
    r.addRefund({ id: rid(602), intent: r.seeds[1]!.id, status: 'rejected', gateway: 'esewa' });
    r.addRefund({ id: rid(603), intent: r.seeds[1]!.id, status: 'requested', gateway: 'esewa' });
    r.addRefund({ id: rid(604), intent: r.seeds[2]!.id, status: 'requested', tenant: 'B', gateway: 'khalti' });
    const got = async (q: Record<string, unknown>) => ((await r.call('listPaymentRefunds', q, { as: 'reader' })).value?.data ?? []).map((x: any) => x.id).sort();
    expect(await got({ status: ['requested'], gateway: ['khalti'] })).toEqual([rid(601)]);
    expect(await got({ status: 'requested', gateway: 'esewa' })).toEqual([rid(603)]);
    expect(await got({ status: ['requested', 'rejected'], gateway: ['esewa', 'khalti'] })).toEqual([rid(601), rid(602), rid(603)]);
    for (const q of [{ gateway: ['paypal'] }, { gateway: [] }, { status: [] }, { status: '' }, { status: [1] }, { gateway: [null] }])
      expect((await r.call('listPaymentRefunds', q, { as: 'reader' })).code, JSON.stringify(q)).toBe('common.validation_failed');
    expect((await r.call('listPaymentRefunds', { status: ['requested'] }, { as: 'front_desk' })).code).toBe('auth.forbidden');
  });
});

// AUDIT RESULT (tester, read of contracts/openapi/payments.yaml): only four parameters are declared array + form + explode false:
// listPaymentIntents status, gateway; listPaymentRefunds status, gateway. hold_reason (listPaymentIntents) and kind (listReconciliationFindings) are declared string "Comma-separated codes".
// listPaymentRefunds already takes both shapes (refund.service.ts list()). listReconciliationRuns / Findings declare scalar status and severity, so no array reaches them.
// Writer: the fix is csv() in handlers/intents.ts only; modules outside payments with the same pattern go to .orchestra/notes/T0D-FIX-7-left.md, not edited.
