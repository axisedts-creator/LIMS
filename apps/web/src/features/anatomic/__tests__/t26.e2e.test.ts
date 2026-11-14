// C11.T-26 — guard for the nightly E2E + perf suite (e2e/anatomic.e2e.ts, e2e/flow.ts, e2e/perf.ts). Runs WITHOUT the compose stack.
// Proves: perf targets = 02-TRD §11 table (parsed live), seed plan = §11 derivation (1×/10×), percentile math, the scenario covers every
// 02-TRD §14 E2E step in order against real 02-TRD §5 routes, and the 07-SECURITY §5.6 planted values. The scenario itself needs the stack (nightly).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { lifecycleRuns, percentile, SCALES, seedPlan, TARGETS_MS, Timings } from './e2e/perf';

const root = fileURLToPath(new URL('../../../../../../', import.meta.url));
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const trd = read('spec/chunks/C11-specialty-pathology/02-TRD.md');
const sec = read('spec/chunks/C11-specialty-pathology/07-SECURITY.md');
const dir = 'apps/web/src/features/anatomic/__tests__/e2e/';
const scenario = read(`${dir}anatomic.e2e.ts`);
const flow = read(`${dir}flow.ts`);

const section11 = trd.slice(trd.indexOf('## 11. Performance targets'), trd.indexOf('## 12. Observability'));
const ms = (op: string) => {
  const m = section11.match(new RegExp('^\\| `?' + op + '`?[^|]*\\| ≤ (\\d+) ms', 'm'));
  return m ? Number(m[1]) : undefined;
};

describe('T-26 perf targets = 02-TRD §11', () => {
  it.each([
    ['listAnatomicCases', 'listAnatomicCases'],
    ['getAnatomicCase', 'getAnatomicCase'],
    ['lookupAnatomicObject', 'lookupAnatomicObject'],
    ['signOutAnatomicCase', 'signOutAnatomicCase'],
  ] as const)('%s p95 matches the TRD row', (op, row) => {
    expect(ms(row), `TRD row ${row} not found`).toBeDefined();
    expect(TARGETS_MS[op]).toBe(ms(row));
  });
  it('draft/gross saves row (≤ 150 ms) covers gross and report-draft saves', () => {
    expect(section11).toMatch(/\| draft\/gross saves \| ≤ 150 ms/);
    expect(TARGETS_MS.saveAnatomicGross).toBe(150);
    expect(TARGETS_MS.saveAnatomicReportDraft).toBe(150);
  });
  it('consumer per event row (≤ 300 ms) is gated', () => {
    expect(section11).toMatch(/\| consumer per event \| ≤ 300 ms/);
    expect(TARGETS_MS.consumerPerEvent).toBe(300);
  });
  it('image upload accept (≤ 2 s) and processing p95 (≤ 30 s) rows are gated', () => {
    expect(section11).toMatch(/\| image upload accept \(15 MB\) \| ≤ 2 s excluding network; processing p95 ≤ 30 s/);
    expect(TARGETS_MS.imageUploadAccept).toBe(2000);
    expect(TARGETS_MS.imageProcessing).toBe(30_000);
  });
  it('every §11 row maps to a TARGETS_MS entry (6 table rows + draft/gross split = 9 ops)', () => {
    const rows = section11.split('\n').filter((l) => /^\| (`|draft|consumer|image)/.test(l));
    expect(rows).toHaveLength(7);
    expect(Object.keys(TARGETS_MS)).toHaveLength(9);
  });
  it('every op in TARGETS_MS is measured by the scenario (op: name appears in flow/scenario)', () => {
    for (const op of Object.keys(TARGETS_MS)) expect(flow + scenario, op).toContain(`'${op}'`);
  });
});

describe('T-26 reference dataset (05-DoD §3.5: seed generator at 1× and 10×)', () => {
  it('scales are exactly 1 and 10', () => expect([...SCALES]).toEqual([1, 10]));
  it('25 cases/day/lab at 1×, 250 at 10×; ≤ 10 images/case (TRD §11)', () => {
    expect(seedPlan(1)).toMatchObject({ casesPerDay: 25, maxImagesPerCase: 10 });
    expect(seedPlan(10).casesPerDay).toBe(250);
    expect(section11).toContain('≤ 25 cases/day/lab');
    expect(section11).toContain('≤ 10 per case');
  });
  it('lifecycle runs grow with scale; scenario honours LIMS_E2E_SCALE', () => {
    expect(lifecycleRuns(10)).toBeGreaterThan(lifecycleRuns(1));
    expect(lifecycleRuns(1)).toBeGreaterThanOrEqual(20); // p95 needs more than a handful of points
    expect(scenario).toContain('LIMS_E2E_SCALE');
  });
});

describe('T-26 percentile / Timings', () => {
  it('nearest-rank p95', () => {
    const s = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(s, 95)).toBe(95);
    expect(percentile([5], 95)).toBe(5);
    expect(percentile([3, 1, 2], 100)).toBe(3);
    expect(percentile([1, 2, 3, 4, 100], 95)).toBe(100); // an outlier in 5 samples is the p95
  });
  it('no samples can never pass', () => {
    expect(() => percentile([], 95)).toThrow();
    expect(() => new Timings().p95('signOutAnatomicCase')).toThrow();
  });
  it('Timings.report lists op, count, target', () => {
    const t = new Timings();
    t.add('signOutAnatomicCase', 500);
    expect(t.report()).toContain('signOutAnatomicCase n=1 p95=500ms (target 600)');
  });
});

describe('T-26 scenario = 02-TRD §14 E2E row, in order, on real 02-TRD §5 routes', () => {
  const code = flow + '\n' + scenario;
  const steps = [
    "'receive_specimen'", // received event
    '/accession', // accession
    '/gross', // gross
    '/blocks', // blocks
    '/slides', // slides
    '/slides/bulk-mark-ready', // ready (slides)
    '/mark-ready', // ready (case)
    '/report-draft', // draft
    '/sign-out', // sign-out
    "'c5_verify_approve'", // C5 fake verify/approve
    "'view_row'", // view row
    '/changes', // amendment
    '/addenda', // addendum
  ];
  it('contains every step', () => steps.forEach((s) => expect(code, s).toContain(s)));
  it('steps appear in lifecycle order (flow, then scenario)', () => {
    const idx = steps.map((s) => code.indexOf(s));
    expect(idx.every((i) => i >= 0)).toBe(true);
    const order = ["hook(req, 'receive_specimen'", '/accession', '/blocks', '/report-draft', '/sign-out', "hook(api.req, 'c5_verify_approve'", "hook(api.req, 'view_row'", '/changes', '/addenda'];
    const pos = order.map((s) => code.indexOf(s));
    expect([...pos].sort((a, b) => a - b)).toEqual(pos);
  });
  it.each([
    ['A4', '/cases/{case_id}/accession'],
    ['A8', '/cases/{case_id}/parts/{part_id}/gross'],
    ['M1', '/cases/{case_id}/blocks'],
    ['M2', '/cases/{case_id}/slides'],
    ['M3', '/slides/bulk-mark-ready'],
    ['A10', '/cases/{case_id}/mark-ready'],
    ['R2', '/cases/{case_id}/report-draft'],
    ['R3', '/cases/{case_id}/sign-out'],
    ['R4', '/cases/{case_id}/changes'],
    ['R8', '/cases/{case_id}/addenda'],
    ['R10', '/addenda/{addendum_id}/sign'],
    ['R7', '/cases/{case_id}/versions/{version_no}'],
  ])('%s route exists in the TRD (%s)', (_id, route) => expect(trd).toContain('`' + route + '`'));
  it('asserts version/kind progression original→amendment→addendum with scope', () => {
    for (const s of ["version_kind: 'original'", "version_kind: 'amendment'", "version_kind: 'addendum'", "scope: 'addendum_only'", 'change_reason_code'])
      expect(scenario, s).toContain(s);
    expect(scenario).toContain("kind).toBe('amendment')"); // approved target ⇒ amendment (not revision)
  });
  it('never hardcodes a system reason code (08 R1 reserved codes)', () => {
    for (const c of ['module_phase_progression', 'module_preliminary_update', 'supplementary_report']) expect(code).not.toContain(c);
  });
  it('asserts the signed-out lock (AC-03.5) and signed-addendum immutability', () => {
    expect(scenario).toContain('anatomic.signout_locked');
    expect(scenario).toContain('/addenda/${a.id}');
  });
  it('is a Playwright serial suite that fails (not skips) when the stack hooks are missing', () => {
    expect(scenario).toContain('test.describe.serial');
    expect(flow).toContain('NEEDS: LIMS_E2E_HOOKS_URL');
    expect(code).not.toMatch(/test\.skip|\.skip\(/);
  });
});

describe('T-26 review fixes (C11.T-26-review items 1–4)', () => {
  it('I1 route exists in the TRD and the scenario uploads through it with the planted caption', () => {
    expect(trd).toContain('`/cases/{case_id}/images`');
    expect(flow).toContain('/images`');
    expect(flow).toContain('caption: PLANTED.caption');
    expect(flow).toContain("'imageUploadAccept'");
    expect(flow).toContain("'imageProcessing'");
    expect(flow.indexOf('/images`')).toBeLessThan(flow.indexOf('/mark-ready`')); // uploaded before mark-ready
  });
  it('consumer handling time comes from the receive_specimen hook (handling_ms)', () => {
    expect(flow).toContain('handling_ms');
    expect(flow).toContain("'consumerPerEvent'");
  });
  it('planted accession is asserted on the case, not just sent as a hint', () => {
    expect(scenario).toContain('expect(accession).toBe(PLANTED.accession)');
  });
  it('R10 addendum sign is not timed as signOutAnatomicCase', () => {
    const line = scenario.split('\n').find((l) => l.includes('/addenda/${a.id}/sign'))!;
    expect(line).toBeDefined();
    expect(line).not.toContain('signOutAnatomicCase');
  });
  it('synthetic PNG is valid: signature, IHDR first, IEND last, padding stays ≤ 15 MB', async () => {
    const { syntheticPng } = await import('./e2e/flow');
    const p = syntheticPng(14 * 1024 * 1024);
    expect(p.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(p.subarray(12, 16).toString('latin1')).toBe('IHDR');
    expect(p.subarray(-8, -4).toString('latin1')).toBe('IEND');
    expect(p.length).toBeLessThan(15 * 1024 * 1024);
    expect(p.length).toBeGreaterThan(14 * 1024 * 1024);
  });
});

describe('T-26 log scan (07-SECURITY §5.6)', () => {
  it('planted values equal the security doc', () => {
    for (const v of ['S26-9999', 'Test Patient 0042 left arm', 'PHI-MARKER-GROSS', 'LOC-0001']) {
      expect(sec).toContain(v);
      expect(flow).toContain(v);
    }
  });
  it('scenario scans captured logs for all four and checks problem detail', () => {
    expect(scenario).toContain("'captured_logs'");
    for (const k of ['accession', 'caption', 'gross', 'diagnosis']) expect(scenario).toContain(`PLANTED.${k}`);
  });
});
