// C6-T02 version.state.ts (03-IC §10.3 + discarded CR-C6-005; 05-SCHEMA tg_report_versions_guard; AC-06.6). Exhaustive 6x6.
// Assumed API: VERSION_STATUSES, canTransition(from,to), checkRelease({status, versionNo, latestVersionNo}), supersedesVersionNo(prev).
import { describe, expect, it } from 'vitest';
import { VERSION_STATUSES, canTransition, checkRelease, supersedesVersionNo } from '../version.state.js';

const ALLOWED: Record<string, string[]> = {
  rendering: ['rendered', 'render_failed', 'discarded'],
  render_failed: ['rendering', 'discarded'],
  rendered: ['released', 'discarded'],
  released: ['superseded'],
  superseded: [],
  discarded: [],
};

describe('report_versions.status table', () => {
  it('has the six DB states', () => {
    expect([...VERSION_STATUSES].sort()).toEqual(['discarded', 'released', 'render_failed', 'rendered', 'rendering', 'superseded']);
  });
  const pairs = VERSION_STATUSES.flatMap((f) => VERSION_STATUSES.map((t) => [f, t] as const));
  it.each(pairs)('%s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(ALLOWED[from]!.includes(to));
  });
  it('named forbidden transitions', () => {
    expect(canTransition('released', 'discarded')).toBe(false); // released is only ever superseded
    expect(canTransition('rendering', 'released')).toBe(false); // must be rendered first
    expect(canTransition('rendered', 'rendering')).toBe(false);
    expect(canTransition('superseded', 'released')).toBe(false);
  });
  it('superseded and discarded are terminal', () => {
    for (const to of VERSION_STATUSES) {
      expect(canTransition('superseded', to)).toBe(false);
      expect(canTransition('discarded', to)).toBe(false);
    }
  });
  it('rejects unknown states', () => {
    expect(canTransition('bogus' as never, 'rendered')).toBe(false);
    expect(canTransition('rendering', 'bogus' as never)).toBe(false);
  });
});

describe('checkRelease (AC-06.6, 02-TRD §4.6 rule 1)', () => {
  it('latest rendered version -> ok', () => {
    expect(checkRelease({ status: 'rendered', versionNo: 2, latestVersionNo: 2 })).toEqual({ ok: true });
  });
  it.each(['rendering', 'render_failed', 'released', 'superseded'] as const)('status %s -> reporting.release_not_ready', (status) => {
    expect(checkRelease({ status, versionNo: 2, latestVersionNo: 2 })).toEqual({ ok: false, code: 'reporting.release_not_ready' });
  });
  it('discarded -> reporting.release_not_ready even though a newer version exists (CR-C6-005)', () => {
    expect(checkRelease({ status: 'discarded', versionNo: 1, latestVersionNo: 2 })).toEqual({ ok: false, code: 'reporting.release_not_ready' });
  });
  it('rendered but a newer version exists -> reporting.version_not_latest (CR-C6-004)', () => {
    expect(checkRelease({ status: 'rendered', versionNo: 1, latestVersionNo: 2 })).toEqual({ ok: false, code: 'reporting.version_not_latest' });
  });
});

describe('supersedes_version_no is decided at release (AC-02.6)', () => {
  it('previously released v1 -> v2 supersedes 1', () => {
    expect(supersedesVersionNo(1)).toBe(1);
  });
  it('first release supersedes nothing', () => {
    expect(supersedesVersionNo(undefined)).toBeUndefined();
  });
});
