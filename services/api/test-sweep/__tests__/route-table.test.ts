// T0B-SWEEP-1: the sweep calls EVERY operation of the generated route table (contracts/openapi/*.yaml).
// Implementation: services/api/test-sweep/ops.ts
// export function loadOperations(repoRoot: string): { operationId: string; method: string; path: string; module: string }[]
//   every operation in contracts/openapi/<m>.yaml (core.yaml included), sorted by module then operationId
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { loadOperations } from '../ops.js';

const ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');
const HTTP = new Set(['get', 'put', 'post', 'delete', 'patch', 'head', 'options']);

describe('route table enumeration', () => {
  it('returns every operationId declared in contracts/openapi, exactly once', () => {
    const expected: string[] = [];
    for (const f of readdirSync(join(ROOT, 'contracts', 'openapi')).filter((x) => x.endsWith('.yaml'))) {
      const doc = parse(readFileSync(join(ROOT, 'contracts', 'openapi', f), 'utf8')) as { paths?: Record<string, Record<string, { operationId?: string }>> };
      for (const item of Object.values(doc.paths ?? {})) for (const [m, op] of Object.entries(item)) if (HTTP.has(m) && op?.operationId) expected.push(op.operationId);
    }
    expect(expected.length).toBeGreaterThan(100);
    const got = loadOperations(ROOT);
    expect(got.map((o) => o.operationId).sort()).toEqual([...expected].sort());
    expect(new Set(got.map((o) => o.operationId)).size).toBe(got.length);
    for (const o of got) { expect(o.method).toMatch(/^(get|put|post|delete|patch)$/); expect(o.path.startsWith('/')).toBe(true); expect(o.module).toMatch(/\S/); }
  });
  it('includes the four platform operations of 2026-11-16', () => {
    const ids = new Set(loadOperations(ROOT).map((o) => o.operationId));
    for (const id of ['listTenants', 'listPlatformIrdAnnexes', 'listPlatformSupportSessions', 'listDeadLetters']) expect(ids.has(id), id).toBe(true);
  });
});
