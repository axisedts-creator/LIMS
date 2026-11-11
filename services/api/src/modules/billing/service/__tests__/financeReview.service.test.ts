// BL-T11 B36 finance review items: listFinanceReviewItems / resolveFinanceReviewItem (PRD US-BL-09.2 "finance review item ... resolved by refund or kept as advance"; 02-TRD §5 B36, §8 note;
// 05-SCHEMA billing.finance_review_items; openapi FinanceReviewItem / ResolveFinanceReviewItemRequest). Raising the items belongs to the consumers (BL-T16) and is NOT tested here.
// Fails now: ../refund.service.js does not exist.
// ASSUMED API (writer: object via a dispute if wrong; same service object as refund.service.test.ts):
//   createRefundService({repo,events}).listFinanceReviewItems(ctx, { status?, cursor?, limit? }) -> { data: FinanceReviewItem[], page: { limit, next_cursor? } }
//   createRefundService(...).resolveFinanceReviewItem(ctx, { itemId, expectedVersion, resolutionCode, note?, refundLedgerEntryId? }) -> FinanceReviewItem (status 'resolved', resolved_by = caller)
//   Resolving only closes the work item: it never writes a ledger row (money moves through B10/B10a) and never changes the balance. refund_ledger_entry_id, when given, must be a refund row of the same order and tenant.
import { describe, expect, it } from 'vitest';
import { createBillingEvents } from '../../events/publish.js';
import { createRefundService } from '../refund.service.js';
import { BL, errCode, F1, F2, IDS, makeRefundWorld, money, OTHER_TENANT, REVIEW, TENANT_A, type RefundWorld } from './t11.helpers.js';

const svcOf = (w: RefundWorld) => createRefundService({ repo: w.repo as never, events: createBillingEvents(w.events) as never });
async function setup() {
  const w = makeRefundWorld();
  w.seedPayment(1, { capture_kind: 'home_collection', amount_paisa: 275000 }); // paid 2,750.00 against 2,250.00 invoiced: 500.00 over
  await w.seedBalance();
  return { w, svc: svcOf(w), f1: w.ctx(), f2: w.ctxF2() };
}
const resolve = (w: RefundWorld, svc: ReturnType<typeof svcOf>, ctx: never, id: string, over: Record<string, unknown> = {}) =>
  w.tx(() => svc.resolveFinanceReviewItem(ctx, { itemId: id, expectedVersion: 1, resolutionCode: 'kept_as_advance', ...over } as never) as Promise<any>);
const list = (w: RefundWorld, svc: ReturnType<typeof svcOf>, ctx: never, query: Record<string, unknown> = {}) => w.tx(() => svc.listFinanceReviewItems(ctx, query as never) as Promise<any>);

describe('US-BL-09.2 resolve a home_payment_exceeds_due item: kept as advance, or refunded', () => {
  it('1: kept_as_advance with a note -> resolved v2 by the caller; no ledger row, no balance write or event', async () => {
    const { w, svc, f1 } = await setup();
    const id = w.seedReviewItem(1);
    const mark = w.repoCalls.length, ev = w.balanceEvents().length, rows = w.ledger().length;
    const dto = await resolve(w, svc, f1, id, { note: 'Synthetic: patient keeps the advance' });
    expect(dto).toMatchObject({ id, order_id: IDS.order, kind: 'home_payment_exceeds_due', status: 'resolved', amount: money(50000), resolution_code: 'kept_as_advance', note: 'Synthetic: patient keeps the advance', version: 2 });
    expect(dto.resolved_by.membership_id).toBe(F1);
    expect(typeof dto.resolved_at).toBe('string');
    expect(w.reviewItems()[0]).toMatchObject({ status: 'resolved', resolution_code: 'kept_as_advance', version: 2, refund_ledger_entry_id: null });
    expect(w.ledger()).toHaveLength(rows);
    expect(w.balanceEvents()).toHaveLength(ev);
    expect(w.names().slice(mark)).not.toContain('insertLedgerEntry');
    expect(w.names().slice(mark)).not.toContain('upsertOrderBalance');
  });
  it('2: refunded pointing at the order\'s refund ledger row -> resolved, refund_ledger_entry_id stored', async () => {
    const { w, svc, f1 } = await setup();
    const id = w.seedReviewItem(1);
    w.addLedger({ id: BL(50), entry_kind: 'refund', amount_paisa: -50000, approved_by_membership_id: F2, reason_code: 'SYN_REASON', refund_request_id: null, cash_session_id: null });
    const dto = await resolve(w, svc, f1, id, { resolutionCode: 'refunded', refundLedgerEntryId: BL(50) });
    expect(dto).toMatchObject({ status: 'resolved', resolution_code: 'refunded', refund_ledger_entry_id: BL(50) });
    expect(w.reviewItems()[0]).toMatchObject({ resolution_code: 'refunded', refund_ledger_entry_id: BL(50) });
  });
  const wrongRefs: Array<[string, (w: RefundWorld) => string]> = [
    ['an unknown id', () => BL(99)],
    ['another tenant\'s refund row', (w) => { w.addLedger({ id: BL(51), tenant_id: OTHER_TENANT, entry_kind: 'refund', amount_paisa: -1, approved_by_membership_id: F2, reason_code: 'R' }); return BL(51); }],
    ['a refund row of another order', (w) => { w.addLedger({ id: BL(52), order_id: IDS.order2, entry_kind: 'refund', amount_paisa: -1, approved_by_membership_id: F2, reason_code: 'R' }); return BL(52); }],
    ['a payment row, not a refund', () => BL(1)],
  ];
  for (const [name, mk] of wrongRefs) {
    it(`3: refunded pointing at ${name} -> common.validation_failed (/refundLedgerEntryId), item stays open`, async () => {
      const { w, svc, f1 } = await setup();
      const id = w.seedReviewItem(1);
      const ref = mk(w);
      const mark = w.repoCalls.length;
      const e = await errCode(resolve(w, svc, f1, id, { resolutionCode: 'refunded', refundLedgerEntryId: ref }));
      expect(e.code).toBe('common.validation_failed');
      expect(JSON.stringify(e.errors ?? [])).toContain('/refundLedgerEntryId');
      expect(w.writes(mark)).toEqual([]);
      expect(w.reviewItems()[0]).toMatchObject({ status: 'open', version: 1 });
    });
  }
});

describe('B36 resolve: state, validation, scoping', () => {
  it('4: already resolved -> common.immutable_record; stale version -> common.version_conflict; unknown / other tenant -> common.not_found', async () => {
    const { w, svc, f1 } = await setup();
    const id = w.seedReviewItem(1);
    expect((await errCode(resolve(w, svc, f1, id, { expectedVersion: 9 }))).code).toBe('common.version_conflict');
    await resolve(w, svc, f1, id);
    expect((await errCode(resolve(w, svc, f1, id, { expectedVersion: 2 }))).code).toBe('common.immutable_record');
    expect((await errCode(resolve(w, svc, f1, REVIEW(404)))).code).toBe('common.not_found');
    const other = w.seedReviewItem(2);
    expect((await errCode(resolve(w, svc, w.ctx({ tenantId: OTHER_TENANT }), other))).code).toBe('common.not_found');
    expect(w.reviewItems().find((i: any) => i.id === other)).toMatchObject({ status: 'open', version: 1 });
  });
  for (const [name, over] of [['resolutionCode unknown', { resolutionCode: 'bogus' }], ['resolutionCode missing', { resolutionCode: undefined }], ['note 501 chars', { note: 'x'.repeat(501) }], ['itemId not a uuid', { itemId: 'nope' }]] as Array<[string, Record<string, unknown>]>) {
    it(`5: ${name} -> common.validation_failed, item stays open`, async () => {
      const { w, svc, f1 } = await setup();
      const id = w.seedReviewItem(1);
      const mark = w.repoCalls.length;
      expect((await errCode(w.tx(() => svc.resolveFinanceReviewItem(f1, { itemId: id, expectedVersion: 1, resolutionCode: 'other', ...over } as never) as Promise<any>))).code).toBe('common.validation_failed');
      expect(w.writes(mark)).toEqual([]);
      expect(w.reviewItems()[0].status).toBe('open');
    });
  }
  it('6: the resolver is the caller (a resolvedBy / tenantId in the input is ignored); every repo call carries the ctx tenant', async () => {
    const { w, svc, f2 } = await setup();
    const id = w.seedReviewItem(1);
    const mark = w.repoCalls.length;
    const dto = await resolve(w, svc, f2, id, { resolvedBy: F1, tenantId: OTHER_TENANT });
    expect(dto.resolved_by.membership_id).toBe(F2);
    for (const c of w.repoCalls.slice(mark)) expect(c.args.tenantId ?? c.args.tenant_id, c.name).toBe(TENANT_A);
  });
});

describe('B36 list', () => {
  it('7: status filter; newest first; the resolved item leaves the open list; tenant isolation; page shape', async () => {
    const { w, svc, f1 } = await setup();
    const a = w.seedReviewItem(1), b = w.seedReviewItem(2, { kind: 'home_payment_method_inactive' }), c = w.seedReviewItem(3, { tenant_id: OTHER_TENANT });
    expect(c).toBeDefined();
    const open = await list(w, svc, f1, { status: 'open' });
    expect(open.data.map((i: any) => i.id)).toEqual([b, a]);
    expect(open.page).toEqual({ limit: 50 });
    expect(open.data[1]).toMatchObject({ id: a, order_id: IDS.order, kind: 'home_payment_exceeds_due', status: 'open', amount: money(50000), version: 1 });
    await resolve(w, svc, f1, a);
    expect((await list(w, svc, f1, { status: 'open' })).data.map((i: any) => i.id)).toEqual([b]);
    expect((await list(w, svc, f1, { status: 'resolved' })).data.map((i: any) => i.id)).toEqual([a]);
  });
  it('8: keyset pagination limit 2 over 3 items -> 2 pages, no overlap; malformed cursor -> common.invalid_cursor; bad status / limit -> common.validation_failed', async () => {
    const { w, svc, f1 } = await setup();
    const ids = [1, 2, 3].map((i) => w.seedReviewItem(i));
    const p1 = await list(w, svc, f1, { status: 'open', limit: 2 });
    expect(p1.data.map((i: any) => i.id)).toEqual([ids[2], ids[1]]);
    expect(typeof p1.page.next_cursor).toBe('string');
    const p2 = await list(w, svc, f1, { status: 'open', limit: 2, cursor: p1.page.next_cursor });
    expect(p2.data.map((i: any) => i.id)).toEqual([ids[0]]);
    expect(p2.page.next_cursor).toBeUndefined();
    expect((await errCode(list(w, svc, f1, { cursor: 'garbage' }))).code).toBe('common.invalid_cursor');
    for (const q of [{ status: 'bogus' }, { limit: 0 }, { limit: 201 }]) expect((await errCode(list(w, svc, f1, q))).code, JSON.stringify(q)).toBe('common.validation_failed');
  });
});
