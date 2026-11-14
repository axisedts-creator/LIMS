// C11 T-04 static + fake-tx guards over anatomic/repository/*.repo.ts (02-TRD §3.2 listing; 05-SCHEMA §1/§7; REQ-SEC-024 explicit tenant_id in every query).
// Fails now: the repository files do not exist yet. No DB needed.
// Conventions the writer must follow (spec gives no signatures; same approach as billing BL-T03):
//   every exported function is `fn(tx, input)`; `tx` is the request Tx (never a pool, never BEGIN/COMMIT here); `input` is ONE object carrying the tenant
//   (`tenantId` for lookups, snake_case row with `tenant_id` for inserts); SQL is bound ($n), reads/writes `anatomic.*` only.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoDir = join(dirname(fileURLToPath(import.meta.url)), '..');
// 02-TRD §3.2 repository/ listing, verbatim.
const NAMES = ['cases', 'parts', 'gross', 'blocks', 'slides', 'stainOrders', 'movements', 'images', 'drafts', 'versions', 'submissions', 'addenda',
  'molecular', 'batches', 'counters', 'specimenLinks', 'config', 'templates', 'codedValues'];
const REQUIRED = NAMES.map((n) => `${n}.repo.ts`);
// 05-SCHEMA §7: class-A tables have no UPDATE grant (insert-only); no table has DELETE; g_cs_cancel_reasons is a global read-only seed.
const APPEND_ONLY = ['case_transitions', 'object_movements', 'report_versions', 'item_submissions'];
const GLOBAL = new Set(['g_cs_cancel_reasons']);
const OTHER_SCHEMAS = /\b(core|frontdesk|lab|billing|catalog|identity|reporting|instruments|analytics|quality|micro|inventory|partners|smartreport|payments|engagement|homecollection|audit|app)\.[a-z_]+/i;

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|(^|[^:'"`])\/\/[^\n]*/g, '$1');
const files = () => (existsSync(repoDir) ? readdirSync(repoDir).filter((f) => f.endsWith('.repo.ts')) : []);
const src = (f: string) => strip(readFileSync(join(repoDir, f), 'utf8'));
const sqlOf = (s: string) => [...s.matchAll(/`[^`]*`|'[^'\n]*'|"[^"\n]*"/g)].map((m) => m[0]).filter((l) => /\banatomic\./i.test(l) && /\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b/i.test(l));
const stmts = () => files().flatMap((f) => sqlOf(src(f)).map((q) => [f, q] as const));

describe('repository files exist (02-TRD §3.2)', () => {
  for (const f of REQUIRED) it(`${f} exists, exports a function taking tx first, and contains SQL`, () => {
    expect(files()).toContain(f);
    expect(src(f)).toMatch(/export\s+(async\s+)?function\s+\w+\s*\(\s*tx\b/);
    expect(sqlOf(src(f)).length, `${f} has no anatomic.* statement`).toBeGreaterThan(0);
  });
});

describe('REQ-SEC-024: explicit tenant_id in every query (RLS is the second wall, not the first)', () => {
  it('every statement over a tenant table filters or inserts tenant_id', () => {
    expect(stmts().length).toBeGreaterThan(0);
    for (const [f, q] of stmts()) {
      const tables = [...q.matchAll(/\banatomic\.([a-z_]+)/gi)].map((m) => m[1]!.toLowerCase()).filter((t) => !GLOBAL.has(t));
      if (tables.length === 0) continue; // only the global seed
      if (/\bINSERT\s+INTO\b/i.test(q)) {
        expect(q, `${f}: INSERT must list tenant_id\n${q}`).toMatch(/INSERT\s+INTO\s+anatomic\.\w+\s*\([^)]*\btenant_id\b/i);
      } else {
        const cmp = (q.match(/\btenant_id\s*=\s*(\$\d+|\w+\.tenant_id)/gi) ?? []).length;
        expect(cmp, `${f}: ${tables.length} tenant table(s) but ${cmp} tenant_id comparison(s)\n${q}`).toBeGreaterThanOrEqual(tables.length);
      }
    }
  });
  it('a tenant filter is a bound parameter, never a literal or an interpolated value', () => {
    expect(stmts().length).toBeGreaterThan(0);
    for (const [f, q] of stmts()) expect(q, f).not.toMatch(/tenant_id\s*=\s*['"\d]|tenant_id\s*=\s*\$\{/i);
  });
});

describe('SQL hygiene (05-SCHEMA §7 grants, 02-TRD §3.1 layer rules)', () => {
  it('no DELETE FROM anywhere (no anatomic table grants DELETE to lims_app)', () => {
    expect(files().length).toBeGreaterThan(0);
    for (const f of files()) expect(src(f), f).not.toMatch(/\bDELETE\s+FROM\b/i);
  });
  it('no TRUNCATE / DROP / ALTER / CREATE statements', () => {
    expect(files().length).toBeGreaterThan(0);
    for (const f of files()) expect(src(f), f).not.toMatch(/\b(TRUNCATE|DROP\s+(TABLE|TRIGGER|POLICY)|ALTER\s+(TABLE|FUNCTION|POLICY)|CREATE\s+(TABLE|TRIGGER|FUNCTION|POLICY))\b/i);
  });
  it.each(APPEND_ONLY)('nothing issues UPDATE anatomic.%s (class A: new rows only)', (t) => {
    expect(files().length).toBeGreaterThan(0);
    for (const f of files()) expect(src(f), f).not.toMatch(new RegExp(`\\bUPDATE\\s+anatomic\\.${t}\\b`, 'i'));
  });
  it('g_cs_cancel_reasons (global seed) is only ever read', () => {
    expect(files().length).toBeGreaterThan(0);
    for (const f of files()) expect(src(f), f).not.toMatch(/\b(INSERT\s+INTO|UPDATE)\s+anatomic\.g_cs_cancel_reasons\b/i);
  });
  it('statements touch the anatomic schema only (other schemas go through ctx.core / ports)', () => {
    expect(stmts().length).toBeGreaterThan(0);
    for (const [f, q] of stmts()) expect(q.replace(/\banatomic\.[a-z_]+/gi, ''), f).not.toMatch(OTHER_SCHEMAS);
  });
  it('the caller owns the transaction: no pool, pg import, BEGIN/COMMIT/ROLLBACK, or SET ROLE in a repo', () => {
    expect(files().length).toBeGreaterThan(0);
    for (const f of files()) {
      const s = src(f);
      expect(s, f).not.toMatch(/from\s+['"]pg['"]|\bnew\s+Pool\b|\bpool\.(query|connect)\b/);
      expect(s, f).not.toMatch(/['"`]\s*(BEGIN|COMMIT|ROLLBACK|SET\s+(LOCAL\s+)?ROLE|SET\s+LOCAL\s+request)/i);
    }
  });
  it('SQL text has no value interpolation (only UPPER_CASE constants such as ${COLS} are allowed)', () => {
    expect(stmts().length).toBeGreaterThan(0);
    for (const [f, q] of stmts()) for (const m of q.matchAll(/\$\{([^}]*)\}/g)) expect(m[1], `${f}: ${m[0]}`).toMatch(/^[A-Z][A-Z0-9_]*$/);
  });
});

describe('counters.repo allocation statement (02-TRD §4.2, AC-02.2)', () => {
  const s = () => src('counters.repo.ts');
  it('lazy row create is INSERT … ON CONFLICT (tenant_id, series_key, year_ad) DO NOTHING', () => {
    expect(s()).toMatch(/INSERT\s+INTO\s+anatomic\.accession_counters[\s\S]*ON\s+CONFLICT\s*\(\s*tenant_id\s*,\s*series_key\s*,\s*year_ad\s*\)\s*DO\s+NOTHING/i);
  });
  it('bump is ONE atomic UPDATE … last_value = last_value + 1 … RETURNING last_value (no read-modify-write)', () => {
    expect(s()).toMatch(/UPDATE\s+anatomic\.accession_counters\s+SET[\s\S]*\blast_value\s*=\s*last_value\s*\+\s*1\b[\s\S]*WHERE[\s\S]*tenant_id\s*=\s*\$\d[\s\S]*RETURNING[\s\S]*\blast_value\b/i);
    expect(s()).not.toMatch(/\blast_value\s*=\s*\$\d/i);
  });
});

// ---- fake-tx probe: call every exported function as fn(tx, input) where input answers tenantId/tenant_id with TENANT; every query it issues must carry TENANT ----
const TENANT = '01a1a98a-ac40-7000-8000-00000000a001', OTHER = '0190c411-0000-7000-8000-0000000000ff';
const input = () => new Proxy({}, {
  get: (_t, k) => (k === 'tenantId' || k === 'tenant_id' ? TENANT : k === 'limit' ? 10 : k === 'offset' ? 0 : typeof k === 'symbol' || k === 'then' ? undefined : OTHER),
  has: () => true,
});
describe('every exported repo function binds the tenant it is given (REQ-SEC-024, fake tx)', () => {
  for (const n of NAMES) it(`${n}.repo: all queries carry tenant_id and the tenant value; at least one function queried`, async () => {
    const loaders = import.meta.glob('../*.repo.ts') as Record<string, () => Promise<Record<string, unknown>>>;
    expect(loaders[`../${n}.repo.ts`], `${n}.repo.ts must exist`).toBeDefined();
    const mod: Record<string, unknown> = await loaders[`../${n}.repo.ts`]();
    const fns = Object.entries(mod).filter(([, v]) => typeof v === 'function') as Array<[string, (...a: unknown[]) => Promise<unknown>]>;
    expect(fns.length).toBeGreaterThan(0);
    let queried = 0;
    for (const [name, fn] of fns) {
      const calls: Array<{ text: string; values?: unknown[] }> = [];
      const tx = { async query(text: string, values?: unknown[]) { calls.push({ text, values }); return { rows: [] }; } };
      await Promise.resolve(fn(tx, input(), input(), input())).catch(() => undefined); // functions that choke on the probe input are skipped, not failed
      for (const c of calls) {
        queried++;
        if (!/\banatomic\.(?!g_cs_cancel_reasons\b)/i.test(c.text)) continue;
        expect(c.text, `${n}.${name}`).toMatch(/\btenant_id\b/i);
        expect(c.values ?? [], `${n}.${name} must pass the tenant as a bound value`).toContain(TENANT);
      }
    }
    expect(queried, `${n}.repo: no exported function issued a query for the probe input (OTHER=${OTHER})`).toBeGreaterThan(0);
  });
});
