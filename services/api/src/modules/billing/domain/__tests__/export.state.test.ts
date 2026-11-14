// BL-T02 export.state.ts (03-APP-FLOW §1.8; 05-SCHEMA export_jobs__status__ck).
// Assumed API: EXPORT_STATUSES, canTransition(from,to), isTerminal(status)
import { describe, expect, it } from 'vitest';
import { EXPORT_STATUSES, canTransition, isTerminal } from '../export.state.js';

const ALLOWED: Record<string, string[]> = { queued: ['running'], running: ['ready', 'failed'], ready: ['expired'], failed: [], expired: [] };

describe('export job state table', () => {
  it('has the five DB states', () => expect([...EXPORT_STATUSES].sort()).toEqual(['expired', 'failed', 'queued', 'ready', 'running']));
  const pairs = EXPORT_STATUSES.flatMap((f) => EXPORT_STATUSES.map((t) => [f, t] as const));
  it.each(pairs)('%s -> %s', (from, to) => expect(canTransition(from, to)).toBe(ALLOWED[from]!.includes(to)));
  it('forbidden examples: queued -> ready (must run first), ready -> running, failed -> queued, expired -> ready', () => {
    expect(canTransition('queued', 'ready')).toBe(false);
    expect(canTransition('ready', 'running')).toBe(false);
    expect(canTransition('failed', 'queued')).toBe(false);
    expect(canTransition('expired', 'ready')).toBe(false);
  });
  it('rejects unknown statuses', () => expect(canTransition('cancelled' as never, 'running')).toBe(false));
  it('terminal: failed, expired', () => {
    expect(EXPORT_STATUSES.filter((s) => isTerminal(s)).sort()).toEqual(['expired', 'failed']);
  });
});
