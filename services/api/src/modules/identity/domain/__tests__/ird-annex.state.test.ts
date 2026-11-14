// T3 ird-annex.state.ts — 03-APP-FLOW §2.5 IR1–IR8; AC-E3.1, AC-E3.2, AC-E3.3.
// Assumed API (pure): STATES, canTransition(from: Status | null, to: Status): boolean,
//   checkAnnexTransition(from, to, f: { submittedOn?: string; completedOn?: string; referenceNo?: string; note?: string; today: string /* YYYY-MM-DD */ })
//     -> { ok: true } | { ok: false; code: 'identity.annex_invalid_transition' | 'common.validation_failed' }
import { describe, expect, it } from 'vitest';
import { STATES, canTransition, checkAnnexTransition } from '../ird-annex.state.js';
import { checkStateTable, type Edge } from './state-table.helper.js';

const ALL = ['not_started', 'in_preparation', 'submitted', 'completed', 'rejected', 'superseded'];
const allowed: Edge[] = [
  [null, 'not_started'], // IR1
  ['not_started', 'in_preparation'], // IR2
  ['in_preparation', 'submitted'], // IR3
  ['submitted', 'completed'], // IR4
  ['submitted', 'rejected'], // IR5
  ['rejected', 'in_preparation'], // IR6
  ['completed', 'superseded'], // IR7
  ['in_preparation', 'not_started'], // IR8
];
checkStateTable('ird annex', STATES, ALL, canTransition as never, allowed, true);

const TODAY = '2026-11-07';
const INVALID = { ok: false, code: 'identity.annex_invalid_transition' };
const VALIDATION = { ok: false, code: 'common.validation_failed' };
const chk = (f: string, t: string, x: object = {}) => checkAnnexTransition(f as never, t as never, { today: TODAY, ...x } as never);

describe('annex forbidden (409 identity.annex_invalid_transition)', () => {
  it('AC-E3.3 not_started -> completed', () => expect(chk('not_started', 'completed', { completedOn: TODAY, referenceNo: 'R1' })).toMatchObject(INVALID));
  it('not_started -> submitted', () => expect(chk('not_started', 'submitted', { submittedOn: TODAY })).toMatchObject(INVALID));
  it('completed -> in_preparation', () => expect(chk('completed', 'in_preparation')).toMatchObject(INVALID));
  it.each(ALL)('superseded -> %s', (t) => expect(chk('superseded', t)).toMatchObject(INVALID));
  it('an invalid edge wins over missing fields (409, not 400)', () => expect(chk('not_started', 'completed')).toMatchObject(INVALID));
});

describe('annex field guards (400 common.validation_failed)', () => {
  it('AC-E3.1 in_preparation -> submitted without submitted_on', () => expect(chk('in_preparation', 'submitted')).toMatchObject(VALIDATION));
  it('submitted_on in the future', () => expect(chk('in_preparation', 'submitted', { submittedOn: '2026-11-08' })).toMatchObject(VALIDATION));
  it('submitted_on = today ok', () => expect(chk('in_preparation', 'submitted', { submittedOn: TODAY })).toEqual({ ok: true }));
  it('AC-E3.2 submitted -> completed with reference_no + completed_on', () =>
    expect(chk('submitted', 'completed', { submittedOn: '2026-11-01', completedOn: '2026-11-05', referenceNo: 'IRD-1' })).toEqual({ ok: true }));
  it('completed without reference_no', () =>
    expect(chk('submitted', 'completed', { submittedOn: '2026-11-01', completedOn: '2026-11-05' })).toMatchObject(VALIDATION));
  it('completed without completed_on', () =>
    expect(chk('submitted', 'completed', { submittedOn: '2026-11-01', referenceNo: 'IRD-1' })).toMatchObject(VALIDATION));
  it('completed_on before submitted_on', () =>
    expect(chk('submitted', 'completed', { submittedOn: '2026-11-05', completedOn: '2026-11-04', referenceNo: 'IRD-1' })).toMatchObject(VALIDATION));
  it('completed_on = submitted_on ok', () =>
    expect(chk('submitted', 'completed', { submittedOn: '2026-11-05', completedOn: '2026-11-05', referenceNo: 'IRD-1' })).toEqual({ ok: true }));
  it('rejected requires note', () => expect(chk('submitted', 'rejected')).toMatchObject(VALIDATION));
  it('rejected with note ok', () => expect(chk('submitted', 'rejected', { note: 'missing page' })).toEqual({ ok: true }));
  it.each([['not_started', 'in_preparation'], ['rejected', 'in_preparation'], ['in_preparation', 'not_started'], ['completed', 'superseded']])(
    '%s -> %s needs no fields', (f, t) => expect(chk(f, t)).toEqual({ ok: true }));
});
