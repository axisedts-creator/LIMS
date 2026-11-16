// T0B-SWEEP-1 review item 1: the "first log line or stack of the failure" must be captured.
// The shared logger writes `level` as a string label ("error"), not a number (packages/shared-ts/src/logger/index.ts:99).
// Implementation file: services/api/test-sweep/detail.ts
// export function failureDetail(logLines: string[], fallback?: string): string
//   logLines = raw JSON log lines correlated by request_id; keeps level warn/error/fatal (label or pino number >= 40);
//   returns err.stack ?? err.message ?? [msg, error_code, err_name].filter(Boolean).join(' ') of the first entry with `err`, else the first kept entry,
//   at most 3 lines joined by ' / '; when nothing is kept returns String(fallback ?? '').
import { describe, expect, it } from 'vitest';
import { failureDetail } from '../detail.js';

const L = (o: object) => JSON.stringify({ request_id: 'r1', ...o });

describe('failureDetail (review item 1: empty detail on every row)', () => {
  it('captures an error line whose level is the string label', () => {
    const d = failureDetail([L({ level: 'error', msg: 'request_failed', error_code: 'common.internal', err_name: 'TypeError' })]);
    expect(d).toMatch(/request_failed/);
    expect(d).toMatch(/common\.internal/);
  });
  it('prefers the stack of an entry with err over an earlier plain warn', () => {
    const d = failureDetail([L({ level: 'warn', msg: 'slow' }), L({ level: 'error', msg: 'x', err: { message: 'boom', stack: 'Error: boom\n    at a\n    at b\n    at c' } })]);
    expect(d).toMatch(/Error: boom/);
    expect(d.split(' / ').length).toBeLessThanOrEqual(3);
  });
  it('still accepts numeric pino levels and ignores info/debug', () => {
    expect(failureDetail([L({ level: 50, msg: 'numeric error' })])).toMatch(/numeric error/);
    expect(failureDetail([L({ level: 'info', msg: 'noise' }), L({ level: 30, msg: 'noise' })], 'fallback text')).toBe('fallback text');
  });
  it('ignores non-JSON lines and returns the fallback when nothing qualifies', () => {
    expect(failureDetail(['not json'], 'fb')).toBe('fb');
    expect(failureDetail([])).toBe('');
  });
});
