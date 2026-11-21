// T0B-SWEEP-2 (LD-270): the sweep run itself. verify.cmd runs `pnpm --filter @lims/api sweep` first (needs Docker); it must write
//   .orchestra/notes/T0B-SWEEP-2-results.json = { meta, rows: SweepRow[] }  (row shape: summary.test.ts header)
//   .orchestra/notes/T0B-SWEEP-2-results.md   (renderResults output + a `## Stack-level explanation` section with the two 500s)
// and known-failures.json is rewritten (entries gain `class`: BUG | CONFIG | HARNESS) so the gate is green on that run.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadOperations } from '../ops.js';

const ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');
const JSON_P = join(ROOT, '.orchestra/notes/T0B-SWEEP-2-results.json');
const MD_P = join(ROOT, '.orchestra/notes/T0B-SWEEP-2-results.md');
interface R { module: string; operationId: string; method: string; path: string; status: number; errorCode: string; verdict: string; depth: string; defectClass: string; detail: string; rootCause: string }
const load = () => JSON.parse(readFileSync(JSON_P, 'utf8')) as { rows: R[] };
const known = (): { operation: string; status: number | string; ref: string; class?: string }[] => JSON.parse(readFileSync(join(ROOT, 'services/api/test-sweep/known-failures.json'), 'utf8'));
const WRITE = new Set(['post', 'put', 'patch', 'delete']);

describe('SWEEP-2 run artifacts', () => {
  it('exist, cover every operation once, and use the three verdicts and three depths', () => {
    expect(existsSync(JSON_P) && existsSync(MD_P), 'the sweep did not write T0B-SWEEP-2-results.*').toBe(true);
    const { rows } = load();
    const ops = loadOperations(ROOT);
    expect(rows.length).toBe(ops.length);
    expect(new Set(rows.map((r) => r.operationId)).size).toBe(ops.length);
    for (const r of rows) {
      expect(['WIRED', 'DEFECT', 'NOT_EXERCISED'], r.operationId).toContain(r.verdict);
      expect(['DEEP', 'SHALLOW', 'NOT EXERCISED'], r.operationId).toContain(r.depth);
    }
  });
  it('NO operation is WIRED on a 429; verdict and depth agree on every row', () => {
    const { rows } = load();
    expect(rows.filter((r) => r.status === 429 && r.verdict === 'WIRED').map((r) => r.operationId)).toEqual([]);
    expect(rows.filter((r) => r.status === 429 && r.depth !== 'NOT EXERCISED').map((r) => r.operationId)).toEqual([]);
    expect(rows.filter((r) => r.verdict === 'NOT_EXERCISED' && r.depth !== 'NOT EXERCISED').map((r) => r.operationId)).toEqual([]);
    expect(rows.filter((r) => r.depth === 'NOT EXERCISED' && r.verdict === 'WIRED').map((r) => r.operationId)).toEqual([]);
  });
  it('the rate-limit blind spot is gone: at most 1% of operations still end 429 (SWEEP-1: 339 of 1018)', () => {
    const { rows } = load();
    expect(rows.filter((r) => r.status === 429).length).toBeLessThanOrEqual(Math.floor(rows.length / 100));
  });
  it('write and platform operations go past input validation: at most 10% stay SHALLOW (SWEEP-1: 593 stopped at 400 validation)', () => {
    const { rows } = load();
    const ops = new Map(loadOperations(ROOT).map((o) => [o.operationId, o]));
    const scoped = rows.filter((r) => { const o = ops.get(r.operationId)!; return WRITE.has(o.method) || o.context === 'platform'; });
    expect(scoped.length).toBeGreaterThan(300);
    const shallow = scoped.filter((r) => r.depth === 'SHALLOW');
    expect(shallow.length, `SHALLOW: ${shallow.slice(0, 8).map((r) => r.operationId).join(', ')}`).toBeLessThanOrEqual(Math.floor(scoped.length / 10));
    expect(scoped.filter((r) => r.depth === 'DEEP').length).toBeGreaterThan(scoped.length / 2);
  });
  it('every SHALLOW row says which input field failed (evidence, not an empty body)', () => {
    expect(load().rows.filter((r) => r.depth === 'SHALLOW' && !String(r.detail ?? '').trim()).map((r) => r.operationId)).toEqual([]);
  });
  it('every SHALLOW row is a 400 common.validation_failed (SHALLOW means stopped at input validation)', () => {
    expect(load().rows.filter((r) => r.depth === 'SHALLOW' && !(r.status === 400 && r.errorCode === 'common.validation_failed')).map((r) => r.operationId)).toEqual([]);
  });
  it('the partners operations no longer answer partners.partner_inactive (HARNESS: seeded partner is active)', () => {
    expect(load().rows.filter((r) => r.errorCode === 'partners.partner_inactive').map((r) => r.operationId)).toEqual([]);
  });
  it('every DEFECT is classified BUG, CONFIG or HARNESS and carries evidence', () => {
    const d = load().rows.filter((r) => r.verdict === 'DEFECT');
    expect(d.filter((r) => !['BUG', 'CONFIG', 'HARNESS'].includes(r.defectClass)).map((r) => r.operationId)).toEqual([]);
    expect(d.filter((r) => !String(r.detail ?? '').trim()).map((r) => r.operationId)).toEqual([]);
    expect(d.filter((r) => r.defectClass === 'CONFIG' && ![503, 403, 500].includes(r.status)).map((r) => r.operationId)).toEqual([]);
  });
  it('only DEFECT rows carry a defectClass', () => {
    expect(load().rows.filter((r) => r.verdict !== 'DEFECT' && r.defectClass).map((r) => r.operationId)).toEqual([]);
  });
});

describe('SWEEP-2 results.md', () => {
  const md = () => readFileSync(MD_P, 'utf8');
  it('has the DEPTH column and the depth counts per depth and per module', () => {
    const t = md();
    expect(t).toMatch(/\| operation \| session kind \| status \| error_code \| verdict \| depth \|/i);
    const { rows } = load();
    for (const depth of ['DEEP', 'SHALLOW', 'NOT EXERCISED']) {
      const n = rows.filter((r) => r.depth === depth).length;
      expect(t, depth).toMatch(new RegExp(`${depth}\\D{0,12}\\b${n}\\b`));
    }
    for (const m of new Set(rows.map((r) => r.module))) expect(t).toContain(`## ${m}`);
  });
  it('explains the two 500s at stack level (file:line of the throw)', () => {
    const t = md();
    const i = t.search(/^## Stack-level explanation/m);
    expect(i, 'no "## Stack-level explanation" section').toBeGreaterThanOrEqual(0);
    const sec = t.slice(i).split(/^## /m)[1] ?? '';
    for (const op of ['verifyProviderCallback', 'listDeadLetters']) {
      const at = sec.indexOf(op);
      expect(at, `${op} not explained`).toBeGreaterThanOrEqual(0);
      expect(sec.slice(at, at + 1200), op).toMatch(/\w+\.ts:\d+/);
    }
  });
  it('ends with the BUG list by root-cause guess, naming every BUG operation', () => {
    const t = md();
    const i = t.search(/^## BUG list by root-cause guess/m);
    expect(i, 'no BUG list section').toBeGreaterThanOrEqual(0);
    const tail = t.slice(i);
    expect(tail.slice(3)).not.toMatch(/^## /m);
    for (const r of load().rows.filter((x) => x.defectClass === 'BUG')) expect(tail, r.operationId).toContain(r.operationId);
  });
});

describe('SWEEP-2 regression gate (done_when 5)', () => {
  it('known-failures.json lists exactly the DEFECT rows of the run, with the same status and a class', () => {
    const { rows } = load();
    const defects = rows.filter((r) => r.verdict === 'DEFECT');
    const list = known();
    expect(list.map((k) => `${k.operation}:${k.status}`).sort()).toEqual(defects.map((r) => `${r.operationId}:${r.status}`).sort());
    const cls = new Map(defects.map((r) => [r.operationId, r.defectClass]));
    for (const k of list) {
      expect(String(k.ref), k.operation).toMatch(/\S/);
      expect(k.class, k.operation).toBe(cls.get(k.operation));
    }
  });
  it('no known failure is NOT EXERCISED (a hidden operation cannot hold a place in the list)', () => {
    const ne = new Set(load().rows.filter((r) => r.verdict === 'NOT_EXERCISED').map((r) => r.operationId));
    expect(known().filter((k) => ne.has(k.operation)).map((k) => k.operation)).toEqual([]);
  });
});
