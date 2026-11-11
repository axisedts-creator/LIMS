// FD-T02 trf.state.ts (03-APP-FLOW §1.4; US-FD-09.2/09.4 domain part). Exhaustive 4x4 matrix.
// Assumed API: TRF_SCAN_STATES, canTransition(from,to), canServeContent(state), contentErrorCode(state), uiScanState(state).
import { describe, expect, it } from 'vitest';
import { TRF_SCAN_STATES, canServeContent, canTransition, contentErrorCode, uiScanState } from '../trf.state.js';

const ALLOWED: Record<string, string[]> = {
  pending: ['clean', 'quarantined', 'failed'],
  clean: [],
  quarantined: [],
  failed: ['pending'],
};

describe('trf scan_state table', () => {
  it('has the four DB states', () => {
    expect([...TRF_SCAN_STATES].sort()).toEqual(['clean', 'failed', 'pending', 'quarantined']);
  });
  const pairs = TRF_SCAN_STATES.flatMap((f) => TRF_SCAN_STATES.map((t) => [f, t] as const));
  it.each(pairs)('%s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(ALLOWED[from]!.includes(to));
  });
  it('quarantined is terminal; clean never goes back to pending', () => {
    for (const to of TRF_SCAN_STATES) expect(canTransition('quarantined', to)).toBe(false);
    expect(canTransition('clean', 'pending')).toBe(false);
  });
  it('rejects unknown states', () => {
    expect(canTransition('bogus' as never, 'clean')).toBe(false);
    expect(canTransition('pending', 'bogus' as never)).toBe(false);
  });
});

describe('content gate (F21a)', () => {
  it('serves content only when clean', () => {
    expect(TRF_SCAN_STATES.filter((s) => canServeContent(s))).toEqual(['clean']);
  });
  it('quarantined -> common.upload_quarantined', () => {
    expect(contentErrorCode('quarantined')).toBe('common.upload_quarantined');
  });
  it('clean has no error code', () => {
    expect(contentErrorCode('clean')).toBeUndefined();
  });
});

describe('UI mapping (FileUpload.scanState)', () => {
  it.each([['pending', 'pending'], ['clean', 'clean'], ['quarantined', 'infected'], ['failed', 'unavailable']] as const)('%s -> %s', (s, ui) => {
    expect(uiScanState(s)).toBe(ui);
  });
});
