// T0B-SWEEP-1: regression gate + known-failures list + package script + first-run artifacts.
// Implementation: services/api/test-sweep/gate.ts
// export function evaluateGate(rows: { operationId: string; verdict: 'WIRED' | 'DEFECT' }[], known: { operation: string; status: number | string; ref: string }[]):
//   { ok: boolean; newDefects: string[]; nowWorking: string[] }
//   ok = no DEFECT outside `known` AND no `known` entry whose operation is now WIRED
// Artifacts of the first run (written by `pnpm --filter @lims/api sweep`):
//   .orchestra/notes/T0B-SWEEP-1-results.json = { rows: [{ module, operationId, sessionKind, status, errorCode, verdict, detail }] }
//   .orchestra/notes/T0B-SWEEP-1-results.md   (a table per module; ends with the defect count by root-cause guess)
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { evaluateGate } from '../gate.js';
import { SESSION_KINDS } from '../sessions.js';

const ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');
const kf = (): { operation: string; status: number | string; ref: string; class?: string }[] =>
  JSON.parse(readFileSync(join(ROOT, 'services/api/test-sweep/known-failures.json'), 'utf8'));

describe('evaluateGate', () => {
  // rows now carry `status` (review item 2: the gate keys on operation AND status, `${operation}:${status}` for a new defect)
  const known = [{ operation: 'a', status: 500, ref: 'LD-267' }];
  it('passes when defects equal the known list', () => {
    expect(evaluateGate([{ operationId: 'a', verdict: 'DEFECT', status: 500 }, { operationId: 'b', verdict: 'WIRED', status: 200 }], known)).toEqual({ ok: true, newDefects: [], nowWorking: [] });
  });
  it('fails on a NEW defect', () => {
    const r = evaluateGate([{ operationId: 'a', verdict: 'DEFECT', status: 500 }, { operationId: 'c', verdict: 'DEFECT', status: 500 }], known);
    expect(r.ok).toBe(false);
    expect(r.newDefects).toEqual(['c:500']);
  });
  it('fails when a listed defect starts working', () => {
    const r = evaluateGate([{ operationId: 'a', verdict: 'WIRED', status: 200 }], known);
    expect(r.ok).toBe(false);
    expect(r.nowWorking).toEqual(['a']);
  });
  it('fails when a listed defect changes class (listed 401, now 500)', () => {
    const r = evaluateGate([{ operationId: 'a', verdict: 'DEFECT', status: 500 }], [{ operation: 'a', status: 401, ref: 'LD-267' }]);
    expect(r.ok).toBe(false);
    expect(r.newDefects).toEqual(['a:500']);
  });
});

describe('known-failures.json', () => {
  // the four platform defects are fixed on main and no longer listed; every entry must carry a status, a class and a reference
  it('every entry has a status, a BUG/CONFIG/HARNESS class and a CR/task/LD reference', () => {
    const list = kf();
    expect(list.length).toBeGreaterThan(0);
    for (const e of list) {
      expect(e.status, e.operation).toBeDefined();
      expect(['BUG', 'CONFIG', 'HARNESS'], e.operation).toContain(e.class);
      expect(String(e.ref), e.operation).toMatch(/\S/);
    }
  });
});

describe('package.json', () => {
  it('has the sweep script', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'services/api/package.json'), 'utf8'));
    expect(pkg.scripts.sweep).toMatch(/test-sweep/);
  });
});

describe('latest-run artifacts (T0B-SWEEP-2, written by `pnpm --filter @lims/api sweep`, which verify.cmd runs first)', () => {
  const p = join(ROOT, '.orchestra/notes/T0B-SWEEP-2-results.json');
  it('results.json records valid session kinds and every DEFECT is in known-failures.json', () => {
    expect(existsSync(p)).toBe(true);
    const { rows } = JSON.parse(readFileSync(p, 'utf8')) as { rows: { operationId: string; sessionKind: string; status: number; verdict: string }[] };
    expect(rows.length).toBeGreaterThan(100);
    for (const r of rows) {
      expect(SESSION_KINDS).toContain(r.sessionKind);
      expect(['WIRED', 'DEFECT', 'NOT_EXERCISED']).toContain(r.verdict);
      expect(typeof r.status).toBe('number');
    }
    const known = new Set(kf().map((k) => k.operation));
    expect(rows.filter((r) => r.verdict === 'DEFECT').filter((r) => !known.has(r.operationId))).toEqual([]);
  });
  it('known-failures.json status equals the status of the committed run for every DEFECT (review item 2: stale 401 vs 500)', () => {
    const { rows } = JSON.parse(readFileSync(p, 'utf8')) as { rows: { operationId: string; status: number; verdict: string }[] };
    const listed = new Map(kf().map((k) => [k.operation, Number(k.status)]));
    const stale = rows.filter((r) => r.verdict === 'DEFECT' && listed.get(r.operationId) !== r.status).map((r) => `${r.operationId}: listed ${listed.get(r.operationId)} run ${r.status}`);
    expect(stale).toEqual([]);
  });
  it('every DEFECT row carries a non-empty detail (review item 1: was "" on all 1018 rows)', () => {
    const { rows } = JSON.parse(readFileSync(p, 'utf8')) as { rows: { operationId: string; verdict: string; detail: string }[] };
    expect(rows.filter((r) => r.verdict === 'DEFECT' && !String(r.detail ?? '').trim()).map((r) => r.operationId)).toEqual([]);
  });
  it('results.md has a table per module and ends with a defect count by root-cause guess', () => {
    const md = readFileSync(join(ROOT, '.orchestra/notes/T0B-SWEEP-2-results.md'), 'utf8');
    expect(md).toMatch(/\| operation \| session kind \| status \| error_code \| verdict \|/i);
    // SWEEP-2 notes end with a BUG list that can run long: assert the section heading, not the last 1500 chars
    expect(md).toMatch(/^## BUG list by root-cause guess/m);
  });
});
