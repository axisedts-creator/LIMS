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
const FOUR = ['listTenants', 'listPlatformIrdAnnexes', 'listPlatformSupportSessions', 'listDeadLetters'];
const kf = (): { operation: string; status: number | string; ref: string }[] =>
  JSON.parse(readFileSync(join(ROOT, 'services/api/test-sweep/known-failures.json'), 'utf8'));

describe('evaluateGate', () => {
  const known = [{ operation: 'a', status: 500, ref: 'LD-267' }];
  it('passes when defects equal the known list', () => {
    expect(evaluateGate([{ operationId: 'a', verdict: 'DEFECT' }, { operationId: 'b', verdict: 'WIRED' }], known)).toEqual({ ok: true, newDefects: [], nowWorking: [] });
  });
  it('fails on a NEW defect', () => {
    const r = evaluateGate([{ operationId: 'a', verdict: 'DEFECT' }, { operationId: 'c', verdict: 'DEFECT' }], known);
    expect(r.ok).toBe(false);
    expect(r.newDefects).toEqual(['c']);
  });
  it('fails when a listed defect starts working', () => {
    const r = evaluateGate([{ operationId: 'a', verdict: 'WIRED' }], known);
    expect(r.ok).toBe(false);
    expect(r.nowWorking).toEqual(['a']);
  });
});

describe('known-failures.json', () => {
  it('lists the four platform defects, each with a status and a CR/task/LD reference', () => {
    const list = kf();
    for (const id of FOUR) {
      const e = list.find((x) => x.operation === id);
      expect(e, id).toBeDefined();
      expect(String(e!.ref)).toMatch(/\S/);
      expect(e!.status).toBeDefined();
    }
  });
});

describe('package.json', () => {
  it('has the sweep script', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'services/api/package.json'), 'utf8'));
    expect(pkg.scripts.sweep).toMatch(/test-sweep/);
  });
});

describe('first-run artifacts (written by `pnpm --filter @lims/api sweep`, which verify.cmd runs first)', () => {
  const p = join(ROOT, '.orchestra/notes/T0B-SWEEP-1-results.json');
  it('results.json records valid session kinds and the four known defects as DEFECT', () => {
    expect(existsSync(p)).toBe(true);
    const { rows } = JSON.parse(readFileSync(p, 'utf8')) as { rows: { operationId: string; sessionKind: string; status: number; verdict: string }[] };
    expect(rows.length).toBeGreaterThan(100);
    for (const r of rows) {
      expect(SESSION_KINDS).toContain(r.sessionKind);
      expect(['WIRED', 'DEFECT']).toContain(r.verdict);
      expect(typeof r.status).toBe('number');
    }
    for (const id of FOUR) expect(rows.find((r) => r.operationId === id)?.verdict, id).toBe('DEFECT');
    const known = new Set(kf().map((k) => k.operation));
    expect(rows.filter((r) => r.verdict === 'DEFECT').filter((r) => !known.has(r.operationId))).toEqual([]);
  });
  it('results.md has a table per module and ends with a defect count by root-cause guess', () => {
    const md = readFileSync(join(ROOT, '.orchestra/notes/T0B-SWEEP-1-results.md'), 'utf8');
    expect(md).toMatch(/\| operation \| session kind \| status \| error_code \| verdict \|/i);
    expect(md.slice(-1500)).toMatch(/root.cause/i);
  });
});
