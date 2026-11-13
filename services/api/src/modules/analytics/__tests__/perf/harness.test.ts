// AN-T23 — perf harness contract (TRD §12). Unit level, no DB. The harness (./harness.ts, owned by the tester, LD-136) exports:
//   TARGETS: readonly { key, limitMs }[]   in TRD §12 row order (8 rows: dashboard_31d, report_31d, report_366d, tat_366d, pending_summary, export_10k, refresh_lag, sweep_recent)
//   SWEEP_ESCALATION_MS = 120_000          TRD §12 last paragraph
//   p95(samples)                           nearest-rank p95, throws on empty / non-finite
//   decideSweepInterval(sweepRecentWallMs1x) -> { intervalMinutes: 10 | 30, cron }
//   violations(report, targets?)           -> string[] (empty = every target met and every target measured)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SWEEP_ESCALATION_MS, TARGETS, decideSweepInterval, p95, violations } from './harness.js';

const TRD = readFileSync(fileURLToPath(new URL('../../../../../../../spec/chunks/C8-analytics-mis/02-TRD.md', import.meta.url)), 'utf8');
const KEYS = ['dashboard_31d', 'report_31d', 'report_366d', 'tat_366d', 'pending_summary', 'export_10k', 'refresh_lag', 'sweep_recent'];

/** Target column of the §12 operations table -> ms, in row order (independent of harness.ts). Only the 8 latency/wall rows. */
function trdTargetsMs(): number[] {
  const sec = TRD.split(/^## 12\. /m)[1]!.split(/^## 13\. /m)[0]!;
  const rows = sec.split('\n').filter((l) => /^\| [^|]+\| (?:ready )?≤ [\d.]+ (ms|s|min)\b/.test(l));
  expect(rows).toHaveLength(8);
  return rows.map((l) => {
    const m = /≤ ([\d.]+) (ms|s|min)/.exec(l.split('|')[2]!)!;
    return Number(m[1]) * ({ ms: 1, s: 1000, min: 60_000 } as const)[m[2] as 'ms' | 's' | 'min'];
  });
}
const mkReport = (over: Record<string, number> = {}) => ({
  scale: '1x' as const, generatedAt: '2026-11-10T00:00:00Z', seed: 'synthetic-1',
  results: TARGETS.map((t) => ({ key: t.key, samples: 30, p95Ms: over[t.key] ?? t.limitMs / 2 })),
  sourceViewScans: [{ view: 'frontdesk.v_pub_order_daily', ms: 12 }],
});

describe('TARGETS mirror TRD §12', () => {
  it('has the 8 measured operations in TRD order', () => expect(TARGETS.map((t) => t.key)).toEqual(KEYS));
  it('the TRD §12 table parser sees exactly 8 target rows', () => expect(trdTargetsMs()).toHaveLength(8));
  it('limits equal the TRD §12 Target p95 column', () => expect(TARGETS.map((t) => t.limitMs)).toEqual(trdTargetsMs()));
  it('cannot be mutated away at runtime', () => expect(() => { (TARGETS as any)[0].limitMs = 1e9; }).toThrow());
});

describe('p95', () => {
  it('nearest rank', () => {
    expect(p95(Array.from({ length: 100 }, (_, i) => i + 1))).toBe(95);
    expect(p95([5, 1, 3])).toBe(5);
    expect(p95([7])).toBe(7);
  });
  it('does not mutate its input and rejects garbage', () => {
    const xs = [3, 1, 2]; p95(xs); expect(xs).toEqual([3, 1, 2]);
    expect(() => p95([])).toThrow();
    expect(() => p95([1, NaN])).toThrow();
  });
});

describe('decideSweepInterval (TRD §12: > 120 s per tenant at 1x -> 30 min)', () => {
  it('keeps */10 up to and including the threshold', () => {
    expect(SWEEP_ESCALATION_MS).toBe(120_000);
    expect(decideSweepInterval(0)).toEqual({ intervalMinutes: 10, cron: '*/10 * * * *' });
    expect(decideSweepInterval(120_000)).toEqual({ intervalMinutes: 10, cron: '*/10 * * * *' });
  });
  it('raises to */30 above it', () => expect(decideSweepInterval(120_001)).toEqual({ intervalMinutes: 30, cron: '*/30 * * * *' }));
  it('rejects negative / non-finite input', () => { expect(() => decideSweepInterval(-1)).toThrow(); expect(() => decideSweepInterval(NaN)).toThrow(); });
});

describe('violations', () => {
  it('none when every target is met (boundary equal passes)', () => {
    expect(violations(mkReport())).toEqual([]);
    expect(violations(mkReport({ dashboard_31d: 300 }))).toEqual([]);
  });
  it('names each target that is exceeded', () => {
    const v = violations(mkReport({ dashboard_31d: 301, tat_366d: 2001 }));
    expect(v).toHaveLength(2);
    expect(v.join('\n')).toMatch(/dashboard_31d/); expect(v.join('\n')).toMatch(/tat_366d/);
  });
  it('a target that was never measured is a violation, not a pass', () => {
    const r = mkReport(); r.results = r.results.filter((x) => x.key !== 'pending_summary');
    expect(violations(r).join('\n')).toMatch(/pending_summary/);
  });
  it('a NaN / negative measurement is a violation', () => {
    expect(violations(mkReport({ report_31d: NaN })).join('\n')).toMatch(/report_31d/);
    expect(violations(mkReport({ report_31d: -5 })).join('\n')).toMatch(/report_31d/);
  });
});
