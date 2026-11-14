// C3 T-02 — import state machine (domain/import.state.ts). Spec: 03-APP-FLOW §2.2 (diagram, table, terminal list), 02-TRD §5.2 #102/#103, §10 (final-attempt mapping), 05-SCHEMA imports.status.
// Interface expected from the writer — SEAMS (spec fixes behaviour, not names):
//   export const IMPORT_STATUSES: readonly ImportStatus[]   the 12 values of catalog.imports.status
//   export function importTransition(from: ImportStatus|null, to: ImportStatus): void
//        pure; from===null = absent (∅ -> uploaded). Throws LimsError('catalog.import_not_committable') (409) for any pair not in the §2.2 diagram
//        (the only 409 import code in the registry; C3 never returns catalog.import_invalid — 02-TRD §5.0).
//   export function isImportTransitionAllowed(from, to): boolean       same table, no throw
//   export function isTerminalImportStatus(s): boolean                 committed, commit_failed, invalid, quarantined, discarded, expired, failed
//   export function finalFailureStatus(current: ImportStatus, lastErrorCode?: string): 'quarantined'|'commit_failed'|'failed'
//        worker final-attempt mapping: scanning + 'scan_unavailable' -> quarantined; committing -> commit_failed; uploaded|scanning|validating otherwise -> failed;
//        any other current status throws LimsError('catalog.import_not_committable').
//   export function assertCommittable(o: { status: ImportStatus; expiresAt: Date }, now: Date): void
//        commitImport guard: status must be 'validated' and expiresAt >= now (cron expires on `expires_at < now`), else LimsError('catalog.import_not_committable').
import { describe, expect, it } from 'vitest';
import { isLimsError } from '../../../../core/errors.js';
import {
  assertCommittable, finalFailureStatus, IMPORT_STATUSES, importTransition, isImportTransitionAllowed, isTerminalImportStatus,
} from '../import.state.js';

type S = (typeof IMPORT_STATUSES)[number];
/** The whole of 03-APP-FLOW §2.2 as data. Anything not listed must be forbidden. */
const ALLOWED: Array<[S | null, S]> = [
  [null, 'uploaded'],
  ['uploaded', 'scanning'],
  ['scanning', 'quarantined'],
  ['scanning', 'validating'],
  ['validating', 'invalid'],
  ['validating', 'validated'],
  ['validated', 'committing'],
  ['committing', 'committed'],
  ['committing', 'commit_failed'],
  ['validated', 'discarded'],
  ['invalid', 'discarded'],
  ['validated', 'expired'],
  ['invalid', 'expired'],
  ['uploaded', 'failed'],
  ['scanning', 'failed'],
  ['validating', 'failed'],
];
const isAllowed = (f: S | null, t: S) => ALLOWED.some(([a, b]) => a === f && b === t);
const FROMS: Array<S | null> = [null, ...IMPORT_STATUSES];
const catchErr = (fn: () => unknown): unknown => { try { fn(); } catch (e) { return e; } return undefined; };

describe('importTransition — exhaustive matrix (done_when: 100 % branch coverage of the table)', () => {
  it('statuses are exactly the twelve of 05-SCHEMA imports.status', () => {
    expect([...IMPORT_STATUSES].sort()).toEqual(
      ['commit_failed', 'committed', 'committing', 'discarded', 'expired', 'failed', 'invalid', 'quarantined', 'scanning', 'uploaded', 'validated', 'validating'],
    );
  });

  for (const from of FROMS) {
    for (const to of IMPORT_STATUSES) {
      const label = `${from ?? '∅'} -> ${to}`;
      if (isAllowed(from, to)) {
        it(`ALLOWED ${label}`, () => {
          expect(() => importTransition(from, to)).not.toThrow();
          expect(isImportTransitionAllowed(from, to)).toBe(true);
        });
      } else {
        it(`FORBIDDEN ${label} -> 409 catalog.import_not_committable`, () => {
          const e = catchErr(() => importTransition(from, to));
          expect(isLimsError(e, 'catalog.import_not_committable')).toBe(true);
          expect((e as { statusCode: number }).statusCode).toBe(409);
          expect(isImportTransitionAllowed(from, to)).toBe(false);
        });
      }
    }
  }

  it('exactly the 16 spec pairs are allowed', () => {
    const n = FROMS.flatMap((f) => IMPORT_STATUSES.map((t) => [f, t] as const)).filter(([f, t]) => isImportTransitionAllowed(f, t)).length;
    expect(n).toBe(16);
  });

  it('named forbidden examples: no resurrection of terminals, no skipping stages, no self-loops', () => {
    expect(isImportTransitionAllowed('committed', 'discarded')).toBe(false);
    expect(isImportTransitionAllowed('committed', 'committing')).toBe(false);
    expect(isImportTransitionAllowed('commit_failed', 'committing')).toBe(false); // retry = upload again (new import)
    expect(isImportTransitionAllowed('failed', 'uploaded')).toBe(false);
    expect(isImportTransitionAllowed('quarantined', 'validating')).toBe(false);
    expect(isImportTransitionAllowed('uploaded', 'validated')).toBe(false);
    expect(isImportTransitionAllowed('scanning', 'validated')).toBe(false);
    expect(isImportTransitionAllowed('invalid', 'committing')).toBe(false); // invalid imports can never be committed
    expect(isImportTransitionAllowed('uploaded', 'committing')).toBe(false);
    expect(isImportTransitionAllowed('committing', 'discarded')).toBe(false); // discard only validated/invalid
    expect(isImportTransitionAllowed('committing', 'expired')).toBe(false);
    for (const s of IMPORT_STATUSES) expect(isImportTransitionAllowed(s, s)).toBe(false);
  });

  it('adversarial: unknown strings / prototype keys fail closed', () => {
    for (const b of ['', 'Uploaded', 'VALIDATED', '__proto__', 'constructor', 'toString'] as unknown as S[]) {
      expect(isImportTransitionAllowed(b, 'discarded')).toBe(false);
      expect(isImportTransitionAllowed('validated', b)).toBe(false);
      expect(isLimsError(catchErr(() => importTransition(b, 'validated')), 'catalog.import_not_committable')).toBe(true);
    }
  });
});

describe('isTerminalImportStatus (03-APP-FLOW §2.2 "Terminal:" list)', () => {
  const TERMINAL: S[] = ['committed', 'commit_failed', 'invalid', 'quarantined', 'discarded', 'expired', 'failed'];
  it.each(IMPORT_STATUSES.map((s) => [s]))('%s', (s) => {
    expect(isTerminalImportStatus(s)).toBe(TERMINAL.includes(s));
  });
  it('invalid is terminal yet may still go to discarded/expired', () => {
    expect(isTerminalImportStatus('invalid')).toBe(true);
    expect(isImportTransitionAllowed('invalid', 'discarded')).toBe(true);
    expect(isImportTransitionAllowed('invalid', 'expired')).toBe(true);
  });
});

describe('finalFailureStatus — worker final-attempt mapping (§2.2 last row, 02-TRD §10)', () => {
  it('scanning + scan_unavailable -> quarantined (fail closed)', () => { expect(finalFailureStatus('scanning', 'scan_unavailable')).toBe('quarantined'); });
  it('scanning with any other / no error -> failed', () => {
    for (const c of [undefined, 'timeout', 'internal', '', 'SCAN_UNAVAILABLE', 'scan_unavailable ']) expect(finalFailureStatus('scanning', c)).toBe('failed');
  });
  it('committing -> commit_failed regardless of error code', () => {
    for (const c of [undefined, 'scan_unavailable', 'x']) expect(finalFailureStatus('committing', c)).toBe('commit_failed');
  });
  it('uploaded / validating -> failed, even with scan_unavailable', () => {
    for (const s of ['uploaded', 'validating'] as const) for (const c of [undefined, 'scan_unavailable', 'x']) expect(finalFailureStatus(s, c)).toBe('failed');
  });
  it('every mapped result is a legal transition from the current status', () => {
    for (const s of ['uploaded', 'scanning', 'validating', 'committing'] as const) for (const c of [undefined, 'scan_unavailable']) {
      expect(isImportTransitionAllowed(s, finalFailureStatus(s, c))).toBe(true);
    }
  });
  it.each(['validated', 'invalid', 'quarantined', 'committed', 'commit_failed', 'discarded', 'expired', 'failed'] as const)('%s is not a work-in-progress status -> 409', (s) => {
    expect(isLimsError(catchErr(() => finalFailureStatus(s, 'x')), 'catalog.import_not_committable')).toBe(true);
  });
});

describe('assertCommittable — commitImport guard (#102: not validated, expired, or already committed -> 409 catalog.import_not_committable)', () => {
  const now = new Date('2026-11-07T10:00:00.000Z');
  const future = new Date(now.getTime() + 3_600_000);
  it('validated and not expired -> ok (expires_at == now is not yet expired: cron uses expires_at < now)', () => {
    expect(() => assertCommittable({ status: 'validated', expiresAt: future }, now)).not.toThrow();
    expect(() => assertCommittable({ status: 'validated', expiresAt: now }, now)).not.toThrow();
  });
  it('validated but expires_at < now (cron has not run yet) -> 409', () => {
    const e = catchErr(() => assertCommittable({ status: 'validated', expiresAt: new Date(now.getTime() - 1) }, now));
    expect(isLimsError(e, 'catalog.import_not_committable')).toBe(true);
    expect((e as { statusCode: number }).statusCode).toBe(409);
  });
  it.each(IMPORT_STATUSES.filter((s) => s !== 'validated').map((s) => [s]))('status %s -> 409 even when not expired', (s) => {
    expect(isLimsError(catchErr(() => assertCommittable({ status: s, expiresAt: future }, now)), 'catalog.import_not_committable')).toBe(true);
  });
  it('invalid Date for expires_at fails closed', () => {
    expect(isLimsError(catchErr(() => assertCommittable({ status: 'validated', expiresAt: new Date('x') }, now)), 'catalog.import_not_committable')).toBe(true);
  });
});
