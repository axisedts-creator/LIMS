// C5 T-17 — domain/readiness.ts (02-TRD §4.7; 03-IC §3.12 + §4.5 fake spec; 08 A13 D-5; PRD AC-16.5, AC-16.6, AC-17.1). Pure: no ports, no clock, no DB.
// ACs: AC-16.5 (complete -> one event, approved_set_hash; the same set again emits nothing), AC-16.6 (partial release per department), AC-17.1 (an amendment changes the hash, contains_amendment = true).
// SEAM (spec fixes behaviour, not names) — ../readiness.ts must export:
//   approvedSetHash(set: { result_id: string; version_no: number }[]): string        SHA-256 hex over `result_id:version_no` lines, sorted ascending, joined by "\n" — equal to events/publish.ts
//                                                                                    approvedSetHash and to the fake LabPort's hash (packages/fakes/src/LabPort.fake.ts hashOf).
//   evaluateReadiness(input): ReadinessDecision | null
//     input = { orderTests: { id, orderItemId, departmentId, status }[]        status = lab.order_tests.status (awaiting_collection … approved | cancelled | excluded | outsourced)
//             , results: { id, orderTestId, status, isReportable, currentVersionNo }[]
//             , partialReleaseAllowed: boolean
//             , last?: { hash?: string; completeness?: 'complete' | 'partial'; departmentHashes?: Record<string, string> } }      (lab.order_readiness)
//     decision = { completeness: 'complete' | 'partial'; orderItemIds: string[]; departmentIds?: string[] (partial only); approvedSet: { result_id, version_no }[]; approvedSetHash: string;
//                  containsAmendment: boolean; departmentHashes: Record<string, string> }     null = nothing to emit.
//   Approved set = reportable results with status approved of order tests that are not excluded / outsourced / cancelled (D-5), as `result_id:current_version_no`.
//   Complete = at least one eligible order test, and every eligible order test has all its reportable, non-cancelled results approved (and at least one). Partial (only when partialReleaseAllowed and not complete)
//   = >= 1 department whose eligible tests are all complete and whose own set hash differs from last.departmentHashes[department]; payload lists that department's item ids / department id(s).
//   Emit only when (completeness, set hash) differs from last (hash + completeness).
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { approvedSetHash as publishHash } from '../../events/publish.js';
import { approvedSetHash, evaluateReadiness } from '../readiness.js';

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const id = (n: number) => `01a1a98a-ac40-7000-8000-0000000a${n.toString(16).padStart(4, '0')}`;
const R1 = id(1), R2 = id(2);
const DEPT_A = id(0xd1), DEPT_B = id(0xd2);
const ITEM1 = id(0x11), ITEM2 = id(0x12), ITEM3 = id(0x13);

const ot = (n: number, over: Record<string, unknown> = {}) => ({ id: id(0x100 + n), orderItemId: ITEM1, departmentId: DEPT_A, status: 'approved', ...over });
const res = (n: number, testN: number, over: Record<string, unknown> = {}) => ({ id: id(n), orderTestId: id(0x100 + testN), status: 'approved', isReportable: true, currentVersionNo: 1, ...over });
const ev = (orderTests: unknown[], results: unknown[], over: Record<string, unknown> = {}) => evaluateReadiness({ orderTests, results, partialReleaseAllowed: false, ...over } as never);

describe('T-17 approvedSetHash — equals the fake spec (06 T-17 "hash equals fake spec")', () => {
  it('SHA-256 hex of the ascending `result_id:version_no` lines joined by \\n — fixed vectors', () => {
    expect(approvedSetHash([{ result_id: R1, version_no: 1 }, { result_id: R2, version_no: 2 }])).toBe('d70c35fc6f5bb096134e60df51056816760e2ce3c30d022aaf006e67155c8de9');
    expect(approvedSetHash([{ result_id: R1, version_no: 1 }])).toBe('f50394bfe48c112cbdd868a03cc8fd21e2c19ffdad68a74fd891bcf6f921f982');
  });
  it('independent of input order and equal to the independent formula and to events/publish.ts', () => {
    const set = [{ result_id: R2, version_no: 2 }, { result_id: R1, version_no: 1 }];
    expect(approvedSetHash(set)).toBe(sha(`${R1}:1\n${R2}:2`));
    expect(approvedSetHash(set)).toBe(publishHash(set));
    expect(approvedSetHash([...set].reverse())).toBe(approvedSetHash(set));
  });
  it('a version change changes the hash (the amendment re-emit rule); the empty set is the SHA-256 of the empty string', () => {
    expect(approvedSetHash([{ result_id: R1, version_no: 2 }])).not.toBe(approvedSetHash([{ result_id: R1, version_no: 1 }]));
    expect(approvedSetHash([])).toBe(sha(''));
  });
  it('sorts the joined lines as strings (ascending): the result id decides, not the version number', () => {
    expect(approvedSetHash([{ result_id: R2, version_no: 1 }, { result_id: R1, version_no: 9 }])).toBe(sha(`${R1}:9\n${R2}:1`));
  });
});

describe('T-17 AC-16.5 complete readiness', () => {
  it('every reportable result of every eligible order test approved -> complete, all item ids, hash of the set, contains_amendment false', () => {
    const d = ev([ot(1), ot(2, { orderItemId: ITEM2 })], [res(1, 1), res(2, 2)])!;
    expect(d.completeness).toBe('complete');
    expect([...d.orderItemIds].sort()).toEqual([ITEM1, ITEM2].sort());
    expect(d.approvedSetHash).toBe(approvedSetHash([{ result_id: R1, version_no: 1 }, { result_id: R2, version_no: 1 }]));
    expect(d.approvedSet).toHaveLength(2);
    expect(d.containsAmendment).toBe(false);
  });
  it('one reportable result still resulted/verified/pending -> nothing to emit (partial release off)', () => {
    for (const status of ['pending', 'resulted', 'verified']) expect(ev([ot(1), ot(2, { status: 'resulted' })], [res(1, 1), res(2, 2, { status })]), status).toBeNull();
  });
  it('AC-16.5: the same set that was already emitted emits nothing; a different set emits again', () => {
    const tests = [ot(1)], results = [res(1, 1)];
    const first = ev(tests, results)!;
    expect(ev(tests, results, { last: { hash: first.approvedSetHash, completeness: 'complete' } })).toBeNull();
    expect(ev(tests, [res(1, 1), res(2, 1)], { last: { hash: first.approvedSetHash, completeness: 'complete' } })?.completeness).toBe('complete');
  });
  it('an order test with several reportable results needs all of them approved', () => {
    expect(ev([ot(1)], [res(1, 1), res(2, 1, { status: 'verified' })])).toBeNull();
    expect(ev([ot(1)], [res(1, 1), res(2, 1)])!.approvedSet).toHaveLength(2);
  });
  it('non-reportable results (formula inputs) neither block readiness nor enter the set', () => {
    const d = ev([ot(1)], [res(1, 1), res(2, 1, { isReportable: false, status: 'resulted' })])!;
    expect(d.completeness).toBe('complete');
    expect(d.approvedSet).toEqual([{ result_id: R1, version_no: 1 }]);
  });
  it('a cancelled result (R8) is ignored', () => {
    const d = ev([ot(1)], [res(1, 1), res(2, 1, { status: 'cancelled' })])!;
    expect(d.completeness).toBe('complete');
    expect(d.approvedSet).toEqual([{ result_id: R1, version_no: 1 }]);
  });
  it('excluded and outsourced order tests are ignored (they never produce results here)', () => {
    for (const status of ['excluded', 'outsourced']) {
      const d = ev([ot(1), ot(2, { status, orderItemId: ITEM2 })], [res(1, 1)])!;
      expect(d.completeness, status).toBe('complete');
      expect(d.orderItemIds, status).toEqual([ITEM1]);
    }
  });
  it('nothing eligible (no order tests, or none with an approved reportable result) -> null, never an empty "complete"', () => {
    expect(ev([], [])).toBeNull();
    expect(ev([ot(1, { status: 'cancelled' })], [])).toBeNull();
  });
});

describe('T-17 D-5 readiness excludes cancelled order tests', () => {
  it('an order test cancelled because its specimen was rejected without recollection does not block completeness and is not in the set or the item ids', () => {
    const d = ev([ot(1), ot(2, { status: 'cancelled', orderItemId: ITEM2 })], [res(1, 1), res(2, 2, { status: 'cancelled' })])!;
    expect(d.completeness).toBe('complete');
    expect(d.orderItemIds).toEqual([ITEM1]);
    expect(d.approvedSet).toEqual([{ result_id: R1, version_no: 1 }]);
  });
  it('a cancelled order test never contributes even when a stray approved result row points to it', () => {
    const d = ev([ot(1), ot(2, { status: 'cancelled', orderItemId: ITEM2 })], [res(1, 1), res(2, 2)])!;
    expect(d.approvedSet).toEqual([{ result_id: R1, version_no: 1 }]);
    expect(d.orderItemIds).toEqual([ITEM1]);
  });
  it('a re-opened order test (late recollection, status no longer cancelled) blocks completeness again', () => {
    expect(ev([ot(1), ot(2, { status: 'awaiting_receipt', orderItemId: ITEM2 })], [res(1, 1), res(2, 2, { status: 'pending' })])).toBeNull();
  });
});

describe('T-17 AC-17.1 amendment', () => {
  it('current_version_no >= 2 in the set -> contains_amendment true and a different hash than v1', () => {
    const v1 = ev([ot(1)], [res(1, 1)])!;
    const v2 = ev([ot(1)], [res(1, 1, { currentVersionNo: 2 })], { last: { hash: v1.approvedSetHash, completeness: 'complete' } })!;
    expect(v2.containsAmendment).toBe(true);
    expect(v2.approvedSetHash).not.toBe(v1.approvedSetHash);
    expect(v2.approvedSet).toEqual([{ result_id: R1, version_no: 2 }]);
  });
  it('the amended version of one result among several flags the whole event', () => {
    const d = ev([ot(1), ot(2, { orderItemId: ITEM2 })], [res(1, 1), res(2, 2, { currentVersionNo: 3 })])!;
    expect(d.containsAmendment).toBe(true);
  });
});

describe('T-17 AC-16.6 partial readiness', () => {
  const tests = [ot(1), ot(2, { orderItemId: ITEM2, departmentId: DEPT_B, status: 'resulted' })];
  const results = [res(1, 1), res(2, 2, { status: 'resulted' })];
  it('partialReleaseAllowed false -> null while another department is open', () => {
    expect(ev(tests, results)).toBeNull();
  });
  it('partialReleaseAllowed true and one department fully approved -> partial with that department item ids and department id; hash is the set of its results', () => {
    const d = ev(tests, results, { partialReleaseAllowed: true })!;
    expect(d.completeness).toBe('partial');
    expect(d.orderItemIds).toEqual([ITEM1]);
    expect(d.departmentIds).toEqual([DEPT_A]);
    expect(d.approvedSetHash).toBe(approvedSetHash([{ result_id: R1, version_no: 1 }]));
    expect(d.departmentHashes[DEPT_A]).toBe(approvedSetHash([{ result_id: R1, version_no: 1 }]));
    expect(d.departmentHashes[DEPT_B]).toBeUndefined();
  });
  it('the department set already emitted -> nothing; a department with an approved result but an open sibling test is not ready', () => {
    const first = ev(tests, results, { partialReleaseAllowed: true })!;
    expect(ev(tests, results, { partialReleaseAllowed: true, last: { hash: first.approvedSetHash, completeness: 'partial', departmentHashes: first.departmentHashes } })).toBeNull();
    const openSibling = [ot(1), ot(3, { orderItemId: ITEM3, status: 'resulted' })];
    expect(ev(openSibling, [res(1, 1), res(3, 3, { status: 'resulted' })], { partialReleaseAllowed: true })).toBeNull();
  });
  it('when the second department completes the order the event is complete (not partial) for all items', () => {
    const d = ev([ot(1), ot(2, { orderItemId: ITEM2, departmentId: DEPT_B })], [res(1, 1), res(2, 2)], {
      partialReleaseAllowed: true, last: { hash: approvedSetHash([{ result_id: R1, version_no: 1 }]), completeness: 'partial', departmentHashes: { [DEPT_A]: approvedSetHash([{ result_id: R1, version_no: 1 }]) } },
    })!;
    expect(d.completeness).toBe('complete');
    expect([...d.orderItemIds].sort()).toEqual([ITEM1, ITEM2].sort());
    expect('departmentIds' in d ? d.departmentIds : undefined).toBeUndefined();
  });
  it('a cancelled order test of a department does not keep that department from being ready (D-5)', () => {
    const d = ev([ot(1), ot(4, { status: 'cancelled', orderItemId: ITEM3 }), ot(2, { orderItemId: ITEM2, departmentId: DEPT_B, status: 'resulted' })],
      [res(1, 1), res(4, 4, { status: 'cancelled' }), res(2, 2, { status: 'resulted' })], { partialReleaseAllowed: true })!;
    expect(d.completeness).toBe('partial');
    expect(d.departmentIds).toEqual([DEPT_A]);
  });
});
