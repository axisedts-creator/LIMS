// C12.T-26 chunk gate, part 1 (no database needed): the contract, the handler map, the D-SCOPE lint and the 07-SECURITY §8 checklist items that can be read from source.
// Spec: 06-IMPLEMENTATION-PLAN T-26, 07-SECURITY §6 / §8 / D-SCOPE, 02-TRD §5 (Scope column), PRD AC-22.1..22.3. See gate.helpers.ts for the seams.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { handlers } from '../../handlers/index.js';
import { OPERATIONS, ROOT } from './gate.helpers.js';

const text = (rel: string) => readFileSync(`${ROOT}${rel}`, 'utf8');
function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === 'dist') continue;
    const p = `${dir}/${e}`;
    statSync(p).isDirectory() ? walk(p, out) : out.push(p);
  }
  return out;
}

describe('T-26 the operation set (AC-22.1: "for every endpoint")', () => {
  it('contracts/openapi/inventory.yaml lists exactly 93 operations with unique ids and the first / last of the TRD', () => {
    expect(OPERATIONS).toHaveLength(93);
    expect(new Set(OPERATIONS.map((o) => o.op)).size).toBe(93);
    expect(OPERATIONS[0]!.op).toBe('listInventoryItems');
    expect(OPERATIONS[91]!.op).toBe('getInventoryReport');
    expect(OPERATIONS[92]!.op).toBe('exportInventoryReport');
  });
  it('every operation has a handler in handlers/index.ts and no handler is the T-01 "not implemented" stub (so a probe of it can mean anything)', async () => {
    const stubs: string[] = [];
    for (const o of OPERATIONS) {
      const h = (handlers as Record<string, (r: unknown, c: unknown) => Promise<unknown>>)[o.op];
      if (!h) { stubs.push(`${o.n} ${o.op}: no handler`); continue; }
      try { await h({ params: {}, query: {}, headers: {} }, { operationId: o.op }); } catch (e) { if (/not implemented/.test(String((e as Error)?.message))) stubs.push(`${o.n} ${o.op}: stub`); }
    }
    expect(stubs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------- D-SCOPE lint (07-SECURITY D-SCOPE, §8 item 2)
describe('T-26 D-SCOPE lint: every store-bound handler goes through scope.service, the rest are on the tenant-scope allowlist (02-TRD §5 Scope column)', () => {
  const trd = text('spec/chunks/C12-inventory/02-TRD.md');
  // TRD §5 rows: | # | operationId | method path | permission | scope | ...   (scope cell = 5th)
  const rows = [...trd.matchAll(/^\| (\d{1,2}) \| (\w+) \| [^|]+\| [^|]+\| ([^|]+)\|/gm)].map((m) => ({ n: Number(m[1]), op: m[2]!, scope: m[3]!.trim() }));
  const branchBound = rows.filter((r) => /\bbranch\(|store\b.*branch|branch of/i.test(r.scope) && !/^tenant/i.test(r.scope)).map((r) => r.op);
  const dir = `${ROOT}services/api/src/modules/inventory/handlers`;
  const files = walk(dir).filter((f) => /\/[^/]+\.ts$/.test(f) && !/__tests__|\.schemas\.ts$|\/index\.ts$/.test(f));

  it('the TRD §5 tables are readable (93 rows) and at least 40 operations are branch-bound', () => {
    expect(rows).toHaveLength(93);
    expect(branchBound.length).toBeGreaterThanOrEqual(40);
  });
  it('every handler file asserts a role (`assertRole`) and every file that names a branch-bound operation imports scope.service (assertStoreAccess / assertTransferAccess / listVisibleBranchIds)', () => {
    const bad: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf8').replace(/\/\/[^\n]*/g, '');
      if (!/assertRole|assert[A-Z]\w*Access|require[A-Z]\w+/.test(src) && !/service\//.test(src)) bad.push(`${f}: no permission gate and no service call`);
      const names = branchBound.filter((op) => new RegExp(`\\b${op}\\b`).test(src));
      if (names.length && !/scope\.service|assertStoreAccess|assertTransferAccess|listVisibleBranchIds|\/service\//.test(src)) bad.push(`${f}: branch-bound ${names.join(', ')} without scope.service`);
    }
    expect(bad).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------- 07-SECURITY §8 checklist (source-readable items)
describe('T-26 07-SECURITY §8 checklist', () => {
  const ddlFiles = walk(`${ROOT}db/migrations`).filter((f) => /inventory/.test(f) && f.endsWith('.sql'));
  const ddl = ddlFiles.length ? ddlFiles.map((f) => readFileSync(f, 'utf8')).join('\n') : text('spec/chunks/C12-inventory/05-SCHEMA.md');
  it('no new SECURITY DEFINER in the inventory DDL (07 §8: triggers and app.purge_inventory_alerts() are INVOKER)', () => {
    const defs = ddl.split('\n').filter((l) => /SECURITY\s+DEFINER/i.test(l) && !/^\s*(--|\*|NO |no |not |never )/i.test(l) && !/no (new )?security definer/i.test(l));
    expect(defs).toEqual([]);
  });
  it('every inventory function / trigger function pins search_path = \'\' (07 §8)', () => {
    const fns = [...ddl.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([\w.]+)\s*\([\s\S]*?(?:\$\$|\$\w+\$)\s*;/gi)].filter((m) => /inventory|purge_inventory_alerts|tg_/.test(m[1]!));
    expect(fns.length).toBeGreaterThan(0);
    const unpinned = fns.filter((m) => !/SET\s+search_path\s*(=|TO)\s*''/i.test(m[0])).map((m) => m[1]);
    expect(unpinned).toEqual([]);
  });
  it('no foreign touchpoint and no new dependency: services/api/package.json and services/worker/package.json do not mention a new inventory-only package; the module imports only core / shared / ports (04 §11)', () => {
    const bad: string[] = [];
    for (const f of walk(`${ROOT}services/api/src/modules/inventory`).filter((x) => x.endsWith('.ts') && !/__tests__/.test(x))) {
      for (const m of readFileSync(f, 'utf8').matchAll(/from '(\.\.\/)+modules\/(\w+)\//g)) if (m[2] !== 'inventory') bad.push(`${f}: imports modules/${m[2]}`);
      for (const m of readFileSync(f, 'utf8').matchAll(/\bFROM\s+(?:lab|billing|frontdesk|identity|reporting|partners)\.(?!v_pub_)\w+/gi)) bad.push(`${f}: reads foreign table ${m[0]}`);
    }
    expect(bad).toEqual([]);
  });
  it('privileged permissions require aal2: operations with auth.mfa_required in the contract are exactly the TRD privileged set (#32 #33 #48 #53 #55 #67 #79 #84 #86 #93, CR-C12-001)', () => {
    const got = OPERATIONS.filter((o) => o.privileged).map((o) => o.n).sort((a, b) => a - b);
    for (const n of [32, 33, 48, 53, 55, 67, 79, 84, 86, 93]) expect(got, `#${n}`).toContain(n);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------- §6 test presence (07 §8 item 1: "§6.1-6.5 tests present and green")
describe('T-26 07-SECURITY §6 test ids are present in the suites (the green run is the other test files)', () => {
  const roots = ['services/api/src/modules/inventory', 'services/worker/src/jobs/inventory', 'tests/db', 'tests/lint'].map((r) => `${ROOT}${r}`);
  const files = roots.flatMap((r) => walk(r)).filter((f) => /\.(test|spec)\.[cm]?[tj]s$|\.helpers\.ts$|\.sql$|\.sh$/.test(f) && !/gate\.static\.test\.ts$/.test(f));
  const corpus = files.map((f) => readFileSync(f, 'utf8')).join('\n');
  const IDS = ['P-T1', 'P-T2', 'P-T3', 'P-T4', 'P-T5', 'P-T6', 'P-B1', 'P-B2', 'P-B3', 'P-B4', 'P-B5', 'P-B6', 'P-B7', 'P-B8', 'PE-1', 'PE-2', 'PE-3', 'PE-4', 'PE-5', 'IT-1', 'IT-1a', 'IT-2', 'IT-3', 'IT-4', 'LT-1', 'LT-2',
    'D-EVT', 'neutraliseFormula', 'inventory.cost.read'];
  for (const id of IDS) it(`${id} is named by at least one test`, () => expect(new RegExp(`(?<![\\w-])${id.replace(/[.]/g, '\\.')}(?![\\w])`).test(corpus), `${id} appears in no test file`).toBe(true));
});
