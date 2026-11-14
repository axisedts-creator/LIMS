// C6-T03 — "Repositories for all tables" + SQL hygiene (06-PLAN row C6-T03; 02-TRD §3.2 repository/*.repo.ts; 07-SECURITY REQ-SEC-011..016/024, 02-CV §5.13).
// Static (reads the repository sources + the C0 DDL): live CRUD-under-RLS and per-table probes are db/tests/isolation/reporting.<table>.test.sql (generated, exist) and T0B-10.C6.
// Assumed layout: services/api/src/modules/reporting/repository/*.ts (one or more files; names per TRD §3.2, `*.repo.ts`), SQL in string / template literals.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../../core/module.js';

const migDir = join(REPO_ROOT, 'db/migrations');
const ddl = readdirSync(migDir).filter((f) => /_reporting__.*\.sql$/.test(f)).map((f) => readFileSync(join(migDir, f), 'utf8')).join('\n');
const TABLES = [...new Set([...ddl.matchAll(/CREATE\s+TABLE\s+reporting\.(\w+)/gi)].map((m) => m[1]!))].sort();
const repoDir = join(import.meta.dirname, '..', 'repository');
const files = existsSync(repoDir) ? readdirSync(repoDir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts')) : [];
const src = new Map(files.map((f) => [f, readFileSync(join(repoDir, f), 'utf8')]));
const all = [...src.values()].join('\n');
/** string/template literals that look like SQL (verb + a reporting table). */
function sqlLiterals(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/`((?:[^`\\]|\\.)*)`|'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"/g)) {
    const s = m[1] ?? m[2] ?? m[3] ?? '';
    if (/\b(select|insert\s+into|update|delete\s+from)\b/i.test(s) && /\breporting\./i.test(s)) out.push(s);
  }
  return out;
}

describe('repository/ exists and covers every reporting table', () => {
  it('the DDL has the tables (guards an empty parametrisation)', () => expect(TABLES.length).toBeGreaterThanOrEqual(25));
  it('repository/ has non-test source files', () => expect(files.length).toBeGreaterThan(0));
  it.each(TABLES)('reporting.%s is accessed by a repository module', (t) => {
    expect(new RegExp(`reporting\\.${t}\\b`).test(all)).toBe(true);
  });
  it('services and handlers contain no inline SQL for the tables owned by repositories (single access path)', () => {
    for (const dir of ['service', 'handlers']) {
      const d = join(import.meta.dirname, '..', dir);
      if (!existsSync(d)) continue;
      for (const f of readdirSync(d).filter((x) => x.endsWith('.ts'))) {
        const t = readFileSync(join(d, f), 'utf8');
        expect({ file: `${dir}/${f}`, sql: sqlLiterals(t).length }).toEqual({ file: `${dir}/${f}`, sql: 0 });
      }
    }
  });
});

describe('every SQL statement in repository/ (REQ-SEC-024, REQ-SEC-026, 02-CV §5.13)', () => {
  const stmts = sqlLiterals(all);
  it('there are statements to check', () => expect(stmts.length).toBeGreaterThan(10));
  it('no value is interpolated into SQL (no ${...} inside a SQL template literal) — parameters only', () => {
    const interp = stmts.filter((s) => /\$\{/.test(s));
    expect(interp).toEqual([]);
  });
  it('every statement on a tenant table names tenant_id explicitly (in addition to RLS); global g_* tables and DEFINER calls are exempt', () => {
    const offenders = stmts.filter((s) => {
      const tables = [...s.matchAll(/\breporting\.(\w+)/gi)].map((m) => m[1]!.toLowerCase());
      const tenantTables = tables.filter((t) => !t.startsWith('g_') && !t.startsWith('v_pub_') && !t.startsWith('reporting_'));
      return tenantTables.length > 0 && !/\btenant_id\b/i.test(s);
    });
    expect(offenders.map((s) => s.replace(/\s+/g, ' ').slice(0, 120))).toEqual([]);
  });
  it('no DELETE against a table lims_app cannot delete from (05-SCHEMA §6.3: SELECT/INSERT/UPDATE only on the settings tables)', () => {
    const del = stmts.filter((s) => /\bdelete\s+from\s+reporting\.(settings|staff_assignments|centre_contacts|referrer_preferences)\b/i.test(s));
    expect(del).toEqual([]);
  });
  it('repositories read other modules only through ports / published views: no direct core./frontdesk./billing./lab./catalog./identity. table access', () => {
    const foreign = all.match(/\b(?:from|join|into|update)\s+(?:core|frontdesk|billing|lab|catalog|identity|partners|payments)\.\w+/gi) ?? [];
    expect(foreign).toEqual([]);
  });
  it('repositories do not import services or handlers (layering: handler -> service -> repository)', () => {
    expect(/from\s+['"]\.\.\/(service|handlers)\//.test(all)).toBe(false);
  });
});
