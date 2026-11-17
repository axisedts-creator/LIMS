// AN-T23 live load run (TRD §12; DoD §3.5). Skipped unless a migrated DB seeded at the scale is given, like repository/__tests__/refresh.live.test.ts:
//   LIMS_TEST_DATABASE_URL / LIMS_TEST_APP_DATABASE_URL  as in refresh.live.test.ts
//   LIMS_TEST_PERF_SCALE = 1x | 10x                      the scale the DB was seeded at (`pnpm db:seed --scale 1|10`)
// Runs every TRD §12 operation against the real handlers/engine, asserts no target is violated and writes perf/results/<scale>.json (the committed perf report).
// `runPerf` (harness.ts, implementer) -> { scale, generatedAt, seed, patientsPerDay, results[{key,samples,p95Ms}], sourceViewScans[{view,ms}] }.
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SU = process.env['LIMS_TEST_DATABASE_URL'], APP = process.env['LIMS_TEST_APP_DATABASE_URL'];
const SCALE = process.env['LIMS_TEST_PERF_SCALE'];

describe.skipIf(!SU || !APP || (SCALE !== '1x' && SCALE !== '10x'))(`analytics TRD §12 targets at ${SCALE}`, () => {
  it('meets every target and records the report', async () => {
    const { runPerf, violations } = await import('./harness.js');
    const report = await runPerf({ scale: SCALE as '1x' | '10x', superUserUrl: SU!, appUrl: APP! });
    expect(report.scale).toBe(SCALE);
    mkdirSync(fileURLToPath(new URL('./results/', import.meta.url)), { recursive: true });
    writeFileSync(fileURLToPath(new URL(`./results/${SCALE}.json`, import.meta.url)), JSON.stringify(report, null, 2) + '\n');
    expect(violations(report)).toEqual([]);
  }, 30 * 60_000);
});
