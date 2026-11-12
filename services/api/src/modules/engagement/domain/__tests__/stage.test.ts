// C16 T-02 stage.ts (02-TRD §4.5; 03-IC §10.1 specimen statuses; US-EN-07.1, 07.4).
// Assumed API: SPECIMEN_STATUSES (14), specimenStage(status, {recollectionRequired?}) -> stage | null (null = ignored),
//   orderStage({orderStatus, specimens:[{status, recollectionRequired?}], reports:[{kind, status}]}) -> stage,
//   isPaymentDue({balanceDuePaisa, releaseBasis}) -> boolean
import { describe, expect, it } from 'vitest';
import { SPECIMEN_STATUSES, isPaymentDue, orderStage, specimenStage } from '../stage.js';

const SPECIMEN_TABLE: Array<[string, string | null]> = [
  ['ordered', 'registered'],
  ['collected', 'sample_collected'],
  ['in_transit', 'sample_collected'],
  ['received', 'in_lab'],
  ['aliquoted', 'in_lab'],
  ['in_process', 'in_lab'],
  ['resulted', 'in_lab'],
  ['verified', 'in_lab'],
  ['approved', 'in_lab'],
  ['reported', 'in_lab'],
  ['stored', 'in_lab'],
  ['rejected', 'in_lab'], // no recollection_required flag -> in_lab (see next block for the flag)
  ['recollection_ordered', 'recollection_needed'],
  ['discarded', null],
];

describe('specimen stage table — all 14 specimen statuses', () => {
  it('SPECIMEN_STATUSES is exactly the 14 of 03-IC §10.1', () =>
    expect([...SPECIMEN_STATUSES].sort()).toEqual(SPECIMEN_TABLE.map(([s]) => s).sort()));
  it.each(SPECIMEN_TABLE)('%s -> %s', (status, stage) => expect(specimenStage(status as never)).toBe(stage));
  it('rejected + recollection_required -> recollection_needed (US-EN-07.4)', () =>
    expect(specimenStage('rejected' as never, { recollectionRequired: true })).toBe('recollection_needed'));
  it('rejected + recollection_required=false -> in_lab', () =>
    expect(specimenStage('rejected' as never, { recollectionRequired: false })).toBe('in_lab'));
});

const sp = (status: string, recollectionRequired?: boolean) => ({ status, recollectionRequired });
const base = { orderStatus: 'registered', specimens: [] as never[], reports: [] as never[] };

describe('order stage (priority order, TRD §4.5)', () => {
  it('no specimens -> registered; pre_registered booking order shows registered', () => {
    expect(orderStage({ ...base } as never)).toBe('registered');
    expect(orderStage({ ...base, orderStatus: 'pre_registered' } as never)).toBe('registered');
  });
  it('US-EN-07.1: ordered -> collected -> received', () => {
    expect(orderStage({ ...base, specimens: [sp('ordered'), sp('ordered')] } as never)).toBe('registered');
    expect(orderStage({ ...base, specimens: [sp('collected'), sp('collected')] } as never)).toBe('sample_collected');
    expect(orderStage({ ...base, specimens: [sp('received'), sp('received')] } as never)).toBe('in_lab');
  });
  it('mixed specimens: highest of (in_lab > sample_collected > registered)', () => {
    expect(orderStage({ ...base, specimens: [sp('ordered'), sp('collected')] } as never)).toBe('sample_collected');
    expect(orderStage({ ...base, specimens: [sp('collected'), sp('in_process')] } as never)).toBe('in_lab');
  });
  it('discarded specimens are ignored for the order stage', () =>
    expect(orderStage({ ...base, specimens: [sp('discarded'), sp('collected')] } as never)).toBe('sample_collected'));
  it('any recollection specimen -> recollection_needed (US-EN-07.4)', () => {
    expect(orderStage({ ...base, specimens: [sp('rejected', true), sp('received')] } as never)).toBe('recollection_needed');
    expect(orderStage({ ...base, specimens: [sp('recollection_ordered'), sp('received')] } as never)).toBe('recollection_needed');
  });
  it('rejected without recollection stays in_lab', () =>
    expect(orderStage({ ...base, specimens: [sp('rejected', false)] } as never)).toBe('in_lab'));
  it('partial/preliminary only -> partial_report; final/amended/addendum -> report_ready', () => {
    const r = (kind: string, status = 'valid') => ({ kind, status });
    const s = [sp('approved')];
    expect(orderStage({ ...base, specimens: s, reports: [r('partial')] } as never)).toBe('partial_report');
    expect(orderStage({ ...base, specimens: s, reports: [r('preliminary')] } as never)).toBe('partial_report');
    for (const k of ['final', 'amended', 'addendum']) expect(orderStage({ ...base, specimens: s, reports: [r(k)] } as never)).toBe('report_ready');
    expect(orderStage({ ...base, specimens: s, reports: [r('partial'), r('final')] } as never)).toBe('report_ready');
  });
  it('unknown report kind counts as neither: order stays in_lab', () =>
    expect(orderStage({ ...base, specimens: [sp('approved')], reports: [{ kind: 'x_new_kind', status: 'valid' }] } as never)).toBe('in_lab'));
  it('superseded reports do not count', () =>
    expect(orderStage({ ...base, specimens: [sp('approved')], reports: [{ kind: 'final', status: 'superseded' }] } as never)).toBe('in_lab'));
  it('report beats recollection; cancelled beats everything', () => {
    expect(orderStage({ ...base, specimens: [sp('recollection_ordered')], reports: [{ kind: 'final', status: 'valid' }] } as never)).toBe('report_ready');
    expect(orderStage({ ...base, orderStatus: 'cancelled', specimens: [sp('received')], reports: [{ kind: 'final', status: 'valid' }] } as never)).toBe('cancelled');
  });
});

describe('payment_due flag: balance_due_paisa > 0 AND release_basis = due_outstanding', () => {
  it.each([
    [225000, 'due_outstanding', true],
    [1, 'due_outstanding', true],
    [0, 'due_outstanding', false],
    [225000, 'other_basis', false],
    [225000, null, false],
  ])('balance %i, basis %s -> %s', (balanceDuePaisa, releaseBasis, expected) =>
    expect(isPaymentDue({ balanceDuePaisa, releaseBasis } as never)).toBe(expected));
});
