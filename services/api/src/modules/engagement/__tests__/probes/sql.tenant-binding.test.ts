// C16.T-SEC1 — SQL tenant-binding scan (07-SECURITY §6.1 "no B data, no side effect in B", §6.2 table probes, REQ-SEC-024; 02-TRD §9.1 handler pattern).
// RLS is the backstop; the services must ALSO bind tenant_id in every statement they send. Static scan of every SQL string in the engagement module (non-test):
//   SELECT / UPDATE / DELETE on engagement.<table> must mention tenant_id; INSERT must list tenant_id in its column list.
// Global tables (g_cs_*) and DEFINER function calls (app.engagement_*) carry their own tenant resolution and are excluded by construction.
// Exceptions are listed in EXEMPT with the spec reason; an unlisted statement fails the test.
import { describe, expect, it } from 'vitest';
import { read, sourceFiles, ENGAGEMENT_DIR } from './support.js';
import { relative } from 'node:path';

const LITERAL = /`(?:[^`\\]|\\.)*`|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g;
const TOUCHES = /\b(SELECT|UPDATE|INSERT\s+INTO|DELETE\s+FROM)\b[\s\S]*?\bengagement\.([a-z_]+)/i;
const GLOBAL_TABLE = /^g_cs_/;
// file-relative path -> reason. Empty unless the spec names a tenant-less statement.
const EXEMPT: Record<string, string> = {};

/** `WHERE ${where}` / `${t.where}` statements get their predicate from a builder: accept only when that file's builders bind `tenant_id = $n` themselves. ponytail: file-level, not flow-level. */
const dynamicWhereBound = (s: Hit): boolean => /WHERE\s+\$\{/i.test(s.sql) && /tenant_id\s*=\s*\$/.test(read(`${ENGAGEMENT_DIR}/${s.file}`));

interface Hit { file: string; table: string; verb: string; sql: string }
function statements(): Hit[] {
  const out: Hit[] = [];
  for (const f of sourceFiles()) {
    for (const m of read(f).matchAll(LITERAL)) {
      const sql = m[0].slice(1, -1);
      if (!/^\s*(SELECT|UPDATE|INSERT|DELETE|WITH)\b/i.test(sql)) continue;
      const t = TOUCHES.exec(sql);
      if (!t) continue;
      out.push({ file: relative(ENGAGEMENT_DIR, f).replace(/\\/g, '/'), table: t[2]!, verb: t[1]!.toUpperCase().replace(/\s+/g, ' '), sql });
    }
  }
  return out;
}

describe('every engagement SQL statement binds the tenant (service-level isolation, independent of RLS)', () => {
  const all = statements();

  it('the scan finds the module\'s statements (guards against a regex that silently matches nothing)', () => {
    expect(all.length).toBeGreaterThan(150);
    expect(new Set(all.map((s) => s.table)).size).toBeGreaterThanOrEqual(25);
  });

  it('SELECT / UPDATE / DELETE: tenant_id appears in the statement', () => {
    const bad = all.filter((s) => s.verb !== 'INSERT INTO' && !GLOBAL_TABLE.test(s.table) && !/\btenant_id\b/i.test(s.sql) && !dynamicWhereBound(s) && !EXEMPT[s.file]).map((s) => `${s.file}: ${s.verb} ${s.table}: ${s.sql.replace(/\s+/g, ' ').slice(0, 110)}`);
    expect(bad).toEqual([]);
  });

  it('INSERT: tenant_id is in the column list (a B tenant_id cannot be defaulted in; RLS WITH CHECK rejects a foreign one)', () => {
    const bad = all.filter((s) => s.verb === 'INSERT INTO' && !GLOBAL_TABLE.test(s.table) && !/\(\s*[^)]*\btenant_id\b[^)]*\)/i.test(s.sql) && !EXEMPT[s.file]).map((s) => `${s.file}: INSERT ${s.table}: ${s.sql.replace(/\s+/g, ' ').slice(0, 110)}`);
    expect(bad).toEqual([]);
  });

  it('no module code writes engagement tables outside its own repository / service layer folders (handlers stay thin, 02-TRD §9.1)', () => {
    const bad = all.filter((s) => s.file.startsWith('handlers/')).map((s) => `${s.file}: ${s.sql.slice(0, 80)}`);
    expect(bad).toEqual([]);
  });

  it('DELETE statements target only the tables with a DELETE grant to lims_app (05-SCHEMA §1: 4 read models + otp_challenges, link_codes, notifications, number_counters)', () => {
    const allowed = new Set(['patient_orders', 'patient_order_specimens', 'patient_reports', 'smart_summaries', 'otp_challenges', 'link_codes', 'notifications', 'number_counters']);
    const bad = all.filter((s) => s.verb === 'DELETE FROM' && !allowed.has(s.table)).map((s) => `${s.file}: DELETE ${s.table}`);
    expect(bad).toEqual([]);
  });
});
