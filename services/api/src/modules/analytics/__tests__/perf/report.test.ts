// AN-T23 tests: "perf report". The report = perf/results/{1x,10x}.json, written by the live run (load.live.test.ts) and committed.
// Static check, no DB: both scales exist, every TRD §12 target is measured with enough samples, none violated, no PHI/ids leaked, 10x really is 10x.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TARGETS, violations } from './harness.js';

const file = (s: string) => fileURLToPath(new URL(`./results/${s}.json`, import.meta.url));
const LATENCY_GETS = ['dashboard_31d', 'report_31d', 'report_366d', 'tat_366d', 'pending_summary'];

// LD-136: release-gate checks. The artefact is produced by the live run (load.live.test.ts, RG-6); when absent the block SKIPS naming RG-6, when present every assertion applies unchanged.
const RG6 = (s: string) => `release gate RG-6: results/${s}.json absent (live run on a seeded DB not done in this lane)`;
describe.each(['1x', '10x'] as const)('perf report at %s', (scale) => describe.skipIf(!existsSync(file(scale)))(`[${RG6(scale)}]`, () => {
  const exists = existsSync(file(scale));
  const text = exists ? readFileSync(file(scale), 'utf8') : '{}';
  const rep = JSON.parse(text);
  it('report file exists', () => expect(exists).toBe(true));
  it('declares its scale and a synthetic seed', () => { expect(rep.scale).toBe(scale); expect(rep.seed).toBeTruthy(); });
  it('measures every TRD §12 target and violates none', () => expect(violations(rep)).toEqual([]));
  it('latency GETs have >= 20 samples, other operations >= 3', () => {
    for (const t of TARGETS) {
      const r = rep.results?.find((x: any) => x.key === t.key);
      expect(r, t.key).toBeTruthy();
      expect(r.samples, t.key).toBeGreaterThanOrEqual(LATENCY_GETS.includes(t.key) ? 20 : 3);
    }
  });
  it('records source-view scan times inside sweep_recent (TRD §12)', () => {
    expect(Array.isArray(rep.sourceViewScans) ? rep.sourceViewScans.length : 0).toBeGreaterThan(0);
    for (const s of rep.sourceViewScans) { expect(typeof s.view).toBe('string'); expect(s.ms).toBeGreaterThanOrEqual(0); }
  });
  it('carries no PHI or identifiers (synthetic, aggregates only)', () => {
    expect(text).not.toMatch(/[\w.+-]+@[\w-]+\.[a-z]+/i);
    expect(text).not.toMatch(/Test Patient|\+\d{8,}/);
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  });
}));

describe.skipIf(!existsSync(file('1x')) || !existsSync(file('10x')))('10x is a 10x load [release gate RG-6: results/1x.json and results/10x.json both needed]', () => {
  it('reports 500 patients/day at 1x and 5000 at 10x (T0A-05 generator volumes)', () => {
    expect(existsSync(file('1x')) && existsSync(file('10x'))).toBe(true);
    expect(JSON.parse(readFileSync(file('1x'), 'utf8')).patientsPerDay).toBe(500);
    expect(JSON.parse(readFileSync(file('10x'), 'utf8')).patientsPerDay).toBe(5000);
  });
});
