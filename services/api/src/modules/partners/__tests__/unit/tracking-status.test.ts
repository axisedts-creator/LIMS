// C13 T04 — tracking-status derivation T1–T7 incl. precedence (03-APP-FLOW §3). ACs: US-07.1 (received -> in_lab), US-07.5 (rejected -> action_needed
// until a replacement is received), plus 4.3 (unknown report kind = amended, 02-CV §7.2). First matching rule wins.
// SEAMS (spec fixes rules + labels, not signatures): ../../domain/tracking-status.ts exports
//   deriveTrackingStatus({ lineState: string, specimens: { id, status, replacesSpecimenId?: string | null }[],
//                          reports: { kind: string, status: 'valid' | 'superseded' }[] }): TrackingStatus   (pure; never mutates input)
//   TRACKING_STATUSES readonly tuple of the 7 values; TRACKING_LABELS: Record<TrackingStatus, string> (the "Partner label" column).
// Specimen statuses = 05-SCHEMA tracked_specimens__status__ck; unknown statuses are ignored (fall through to T7).
// Fails now: ../../domain/tracking-status.js does not exist.
import { describe, expect, it } from 'vitest';
import { TRACKING_LABELS, TRACKING_STATUSES, deriveTrackingStatus } from '../../domain/tracking-status.js';

type Sp = { id: string; status: string; replacesSpecimenId?: string | null };
type Rp = { kind: string; status: 'valid' | 'superseded' };
const sp = (id: string, status: string, replacesSpecimenId: string | null = null): Sp => ({ id, status, replacesSpecimenId });
const rp = (kind: string, status: 'valid' | 'superseded' = 'valid'): Rp => ({ kind, status });
const derive = (o: { lineState?: string; specimens?: Sp[]; reports?: Rp[] }) =>
  deriveTrackingStatus({ lineState: o.lineState ?? 'converted', specimens: o.specimens ?? [], reports: o.reports ?? [] });

describe('labels', () => {
  it('has the 7 statuses with the partner labels of §3', () => {
    expect([...TRACKING_STATUSES].sort()).toEqual(['action_needed', 'cancelled', 'in_lab', 'in_transit', 'partially_reported', 'registered', 'reported']);
    expect(TRACKING_LABELS).toEqual({
      cancelled: 'Cancelled by lab', reported: 'Report ready', partially_reported: 'Partly reported', action_needed: 'New sample needed',
      in_lab: 'In lab', in_transit: 'On the way to lab', registered: 'Registered',
    });
  });
});

describe('T1 line cancelled', () => {
  it('-> cancelled, with or without anything else', () => {
    expect(derive({ lineState: 'cancelled' })).toBe('cancelled');
    expect(derive({ lineState: 'cancelled', specimens: [sp('a', 'received')], reports: [rp('final')] })).toBe('cancelled'); // T1 beats T2/T5
  });
});

describe('T2 valid final/amended/addendum report', () => {
  it.each(['final', 'amended', 'addendum'])('%s -> reported', (kind) => expect(derive({ reports: [rp(kind)] })).toBe('reported'));
  it('an unknown future kind is treated as amended -> reported (02-CV §7.2)', () => expect(derive({ reports: [rp('corrected_v2')] })).toBe('reported'));
  it('superseded versions are ignored', () => {
    expect(derive({ reports: [rp('final', 'superseded')] })).toBe('registered');
    expect(derive({ reports: [rp('final', 'superseded'), rp('partial')] })).toBe('partially_reported');
  });
  it('amended report: new version valid, old superseded -> still reported', () =>
    expect(derive({ reports: [rp('final', 'superseded'), rp('amended')] })).toBe('reported'));
});

describe('T3 valid partial/preliminary report', () => {
  it.each(['partial', 'preliminary'])('%s -> partially_reported', (kind) => expect(derive({ reports: [rp(kind)] })).toBe('partially_reported'));
});

describe('T4 rejected / recollection_ordered without a received replacement (US-07.5)', () => {
  it.each(['rejected', 'recollection_ordered'])('%s with no replacement -> action_needed', (status) =>
    expect(derive({ specimens: [sp('a', status)] })).toBe('action_needed'));
  it.each(['ordered', 'collected', 'in_transit'])('replacement still %s (not yet >= received) -> action_needed', (status) =>
    expect(derive({ specimens: [sp('a', 'rejected'), sp('b', status, 'a')] })).toBe('action_needed'));
  it('a replacement that is itself rejected is not received -> action_needed', () =>
    expect(derive({ specimens: [sp('a', 'rejected'), sp('b', 'rejected', 'a')] })).toBe('action_needed'));
  it('an unrelated received specimen does not count as the replacement', () =>
    expect(derive({ specimens: [sp('a', 'rejected'), sp('c', 'received')] })).toBe('action_needed')); // T4 beats T5
  it('a replacement pointing at a different specimen does not clear this one', () =>
    expect(derive({ specimens: [sp('a', 'rejected'), sp('x', 'received', 'other')] })).toBe('action_needed'));
});

describe('T5 any specimen received..stored', () => {
  it.each(['received', 'aliquoted', 'in_process', 'resulted', 'verified', 'approved', 'reported', 'stored'])('%s -> in_lab (US-07.1)', (status) =>
    expect(derive({ specimens: [sp('a', status)] })).toBe('in_lab'));
  it.each(['received', 'aliquoted', 'in_process', 'resulted', 'verified', 'approved', 'reported', 'stored'])(
    'rejected specimen whose replacement is %s -> in_lab (replacement received clears T4)', (status) =>
      expect(derive({ specimens: [sp('a', 'rejected'), sp('b', status, 'a')] })).toBe('in_lab'));
  it('recollection_ordered with a received replacement -> in_lab', () =>
    expect(derive({ specimens: [sp('a', 'recollection_ordered'), sp('b', 'received', 'a')] })).toBe('in_lab'));
  it('mixed: one received + one collected -> in_lab (T5 beats T6)', () =>
    expect(derive({ specimens: [sp('a', 'collected'), sp('b', 'received')] })).toBe('in_lab'));
});

describe('T6 any specimen collected / in_transit', () => {
  it.each(['collected', 'in_transit'])('%s -> in_transit', (status) => expect(derive({ specimens: [sp('a', status)] })).toBe('in_transit'));
  it('in_transit + ordered -> in_transit (T6 beats T7)', () => expect(derive({ specimens: [sp('a', 'ordered'), sp('b', 'in_transit')] })).toBe('in_transit'));
});

describe('T7 otherwise', () => {
  it('no specimens, no reports -> registered', () => expect(derive({})).toBe('registered'));
  it('only ordered specimens -> registered', () => expect(derive({ specimens: [sp('a', 'ordered')] })).toBe('registered'));
  it('only discarded specimens (not in any rule) -> registered', () => expect(derive({ specimens: [sp('a', 'discarded')] })).toBe('registered'));
  it('an unknown specimen status is ignored, not thrown on', () => expect(derive({ specimens: [sp('a', 'teleported')] })).toBe('registered'));
});

describe('precedence (first matching rule wins)', () => {
  it('T2 beats T3', () => expect(derive({ reports: [rp('partial'), rp('final')] })).toBe('reported'));
  it('T2 beats T4', () => expect(derive({ reports: [rp('final')], specimens: [sp('a', 'rejected')] })).toBe('reported'));
  it('T3 beats T4', () => expect(derive({ reports: [rp('preliminary')], specimens: [sp('a', 'rejected')] })).toBe('partially_reported'));
  it('T2 beats T5/T6', () => expect(derive({ reports: [rp('addendum')], specimens: [sp('a', 'received'), sp('b', 'collected')] })).toBe('reported'));
  it('T4 beats T5 and T6', () =>
    expect(derive({ specimens: [sp('a', 'rejected'), sp('b', 'received'), sp('c', 'in_transit')] })).toBe('action_needed'));
  it('rejected specimen with a received replacement -> T5 (in_lab), not T4', () =>
    expect(derive({ specimens: [sp('a', 'rejected'), sp('b', 'received', 'a')] })).toBe('in_lab'));
  it('T1 beats everything', () =>
    expect(derive({ lineState: 'cancelled', reports: [rp('final'), rp('partial')], specimens: [sp('a', 'rejected')] })).toBe('cancelled'));
});

describe('purity', () => {
  it('does not mutate its input and is order-independent', () => {
    const specimens = Object.freeze([Object.freeze(sp('a', 'rejected')), Object.freeze(sp('b', 'received', 'a'))]) as unknown as Sp[];
    const reports = Object.freeze([Object.freeze(rp('partial'))]) as unknown as Rp[];
    const input = Object.freeze({ lineState: 'converted', specimens, reports });
    const first = deriveTrackingStatus(input as any);
    expect(deriveTrackingStatus(input as any)).toBe(first);
    expect(deriveTrackingStatus({ ...input, specimens: [...specimens].reverse() } as any)).toBe(first);
    expect(first).toBe('partially_reported');
  });
});
