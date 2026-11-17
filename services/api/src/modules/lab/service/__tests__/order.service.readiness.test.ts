// C5 T-17 — evaluateOrderReadiness in order.service (02-TRD §4.7, §7.1 key `<order_id>:ready:<approved_set_hash>`; 03-IC §3.12; 08 A13 D-5; PRD AC-16.5, AC-16.6, AC-17.1, AC-17.4 hash).
// Pure rules are tested in domain/__tests__/readiness.test.ts; here: the service around them (lock, settings, event, bookkeeping in lab.order_readiness). In-memory fake, no database.
// SEAM: ../order.service.ts must export evaluateOrderReadiness(ctx, orderId): Promise<ReadinessDecision | null> — called by approve / bulk approve / amend after all their writes, once per order, in the same transaction.
//   ctx store = ReadinessStore (./approve.fixtures.ts header): lockReadiness (row lock first, defaults when absent) -> listReadinessInputs -> evaluateReadiness (domain) -> on a decision: events.publish + saveReadiness.
//   ctx.ports.IdentityPort.getTenantSettings(ctx, { keys: ['partialReleaseAllowed'] }) supplies partialReleaseAllowed. Event via ctx.events.publish(ctx, type, { aggregate, idempotencyKey, payload }) (events/publish.ts createLabEvents.orderReadyForReport).
//   Event: aggregate { type: 'order', id: order_id, seq: readinessSeq + 1 }, key `<order_id>:ready:<hash>`, payload keys = order_id, completeness, order_item_ids, department_ids (partial only), approved_set_hash, contains_amendment, ready_at (server clock).
//   saveReadiness({ orderId, readinessSeq: new seq, lastEmittedHash, lastCompleteness, departmentHashes, emittedAt }) only when an event was emitted.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { evaluateOrderReadiness } from '../order.service.js';
import { id, ITEM, ITEM2, make, NOW, ORDER, TENANT } from './approve.fixtures.js';

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const DEPT_A = id(0xd1), DEPT_B = id(0xd2);
const ot = (n: number, over: Record<string, unknown> = {}) => ({ id: id(0x100 + n), orderItemId: ITEM, departmentId: DEPT_A, status: 'approved', ...over });
const res = (n: number, testN: number, over: Record<string, unknown> = {}) => ({ id: id(n), orderTestId: id(0x100 + testN), status: 'approved', isReportable: true, currentVersionNo: 1, ...over });
const inputs = (orderTests: unknown[], results: unknown[]) => ({ [ORDER]: { orderTests, results } });
const PAYLOAD_KEYS = ['order_id', 'completeness', 'order_item_ids', 'department_ids', 'approved_set_hash', 'contains_amendment', 'ready_at'];
const ev = (m: ReturnType<typeof make>) => evaluateOrderReadiness(m.ctx as never, ORDER);

describe('T-17 AC-16.5 complete readiness event', () => {
  it('all reportable results approved -> one lab.order.ready_for_report.v1: seq 1, key <order>:ready:<hash>, payload per 03-IC §3.12, hash = SHA-256 of the sorted result_id:version_no lines', async () => {
    const m = make({ readyIn: inputs([ot(1), ot(2, { orderItemId: ITEM2 })], [res(1, 1), res(2, 2)]) });
    await ev(m);
    const hash = sha(`${id(1)}:1\n${id(2)}:1`);
    expect(m.readyEvents()).toHaveLength(1);
    const e = m.readyEvents()[0]!.input;
    expect(e.aggregate).toEqual({ type: 'order', id: ORDER, seq: 1 });
    expect(e.idempotencyKey).toBe(`${ORDER}:ready:${hash}`);
    expect(e.payload).toMatchObject({ order_id: ORDER, completeness: 'complete', approved_set_hash: hash, contains_amendment: false, ready_at: NOW.toISOString() });
    expect([...e.payload.order_item_ids].sort()).toEqual([ITEM, ITEM2].sort());
    expect('department_ids' in e.payload).toBe(false);
    for (const k of Object.keys(e.payload)) expect(PAYLOAD_KEYS).toContain(k);
    expect(m.stored('saveReadiness')).toEqual([expect.objectContaining({ orderId: ORDER, readinessSeq: 1, lastEmittedHash: hash, lastCompleteness: 'complete', emittedAt: NOW.toISOString() })]);
  });
  it('the order row is locked before the inputs are read; every store call carries ctx.tx + ctx.tenantId', async () => {
    const m = make({ readyIn: inputs([ot(1)], [res(1, 1)]) });
    await ev(m);
    const order = m.log.map((l) => l.fn);
    expect(order.indexOf('lockReadiness')).toBeLessThan(order.indexOf('listReadinessInputs'));
    for (const l of m.log) { expect(l.tenantId, l.fn).toBe(TENANT); if (l.fn !== 'getTenantSettings') expect(l.tx, l.fn).toBe(m.tx); }
  });
  it('AC-16.5: a second transaction that does not change the set emits nothing and writes nothing', async () => {
    const m = make({ readyIn: inputs([ot(1)], [res(1, 1)]) });
    await ev(m);
    await ev(m);                                         // the fake keeps the saved readiness row
    expect(m.readyEvents()).toHaveLength(1);
    expect(m.of('saveReadiness')).toHaveLength(1);
  });
  it('not every reportable result approved -> nothing emitted, nothing saved', async () => {
    const m = make({ readyIn: inputs([ot(1), ot(2, { status: 'resulted', orderItemId: ITEM2 })], [res(1, 1), res(2, 2, { status: 'resulted' })]) });
    expect(await ev(m)).toBeNull();
    expect(m.readyEvents()).toHaveLength(0); expect(m.of('saveReadiness')).toHaveLength(0);
  });
  it('D-5: an order test cancelled by a rejection without recollection is excluded — the other tests complete the order', async () => {
    const m = make({ readyIn: inputs([ot(1), ot(2, { status: 'cancelled', orderItemId: ITEM2 })], [res(1, 1), res(2, 2, { status: 'cancelled' })]) });
    await ev(m);
    const [e] = m.readyEvents();
    expect(e!.input.payload).toMatchObject({ completeness: 'complete', order_item_ids: [ITEM], approved_set_hash: sha(`${id(1)}:1`) });
  });
  it('a failing store (lost lock / DB error) is not swallowed: the approval transaction rolls back', async () => {
    const m = make({ readyIn: inputs([ot(1)], [res(1, 1)]) });
    (m.ctx as any).store.listReadinessInputs = async () => { throw new Error('db down'); };
    await expect(ev(m)).rejects.toThrow('db down');
    expect(m.readyEvents()).toHaveLength(0);
  });
});

describe('T-17 AC-17.1 / AC-17.4 amendment re-emit', () => {
  it('amended version in the set -> new event with contains_amendment true, new hash, seq 2; the old hash stays recorded history', async () => {
    const v1Hash = sha(`${id(1)}:1`), v2Hash = sha(`${id(1)}:2`);
    const m = make({ readyIn: inputs([ot(1)], [res(1, 1, { currentVersionNo: 2 })]), lastReadiness: { [ORDER]: { readinessSeq: 1, lastEmittedHash: v1Hash, lastCompleteness: 'complete', departmentHashes: {} } } });
    await ev(m);
    const [e] = m.readyEvents();
    expect(m.readyEvents()).toHaveLength(1);
    expect(e!.input.aggregate.seq).toBe(2);
    expect(e!.input.idempotencyKey).toBe(`${ORDER}:ready:${v2Hash}`);
    expect(e!.input.payload).toMatchObject({ completeness: 'complete', contains_amendment: true, approved_set_hash: v2Hash });
    expect(v2Hash).not.toBe(v1Hash);
    expect(m.stored('saveReadiness')[0]).toMatchObject({ readinessSeq: 2, lastEmittedHash: v2Hash });
  });
});

describe('T-17 AC-16.6 partial release', () => {
  const readyIn = inputs([ot(1), ot(2, { orderItemId: ITEM2, departmentId: DEPT_B, status: 'resulted' })], [res(1, 1), res(2, 2, { status: 'resulted' })]);
  it('partialReleaseAllowed true (IdentityPort settings) + one department fully approved -> completeness partial with that department\'s item ids and department id; department hash recorded', async () => {
    const m = make({ readyIn, partialReleaseAllowed: true });
    await ev(m);
    const [e] = m.readyEvents();
    expect(e!.input.payload).toMatchObject({ completeness: 'partial', order_item_ids: [ITEM], department_ids: [DEPT_A], contains_amendment: false });
    expect(m.stored('saveReadiness')[0]).toMatchObject({ lastCompleteness: 'partial', departmentHashes: { [DEPT_A]: sha(`${id(1)}:1`) } });
    expect(m.of('getTenantSettings')[0]!.arg).toMatchObject({ keys: ['partialReleaseAllowed'] });
  });
  it('partialReleaseAllowed false -> nothing for a half-approved order', async () => {
    const m = make({ readyIn, partialReleaseAllowed: false });
    expect(await ev(m)).toBeNull();
    expect(m.readyEvents()).toHaveLength(0);
  });
  it('the same department set is not emitted twice', async () => {
    const m = make({ readyIn, partialReleaseAllowed: true });
    await ev(m); await ev(m);
    expect(m.readyEvents()).toHaveLength(1);
  });
});
