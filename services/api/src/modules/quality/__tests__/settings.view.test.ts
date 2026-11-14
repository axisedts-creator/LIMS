// C9 T-20 — `quality.v_pub_qc_summary` verification, static part (AC-15.1; 03-IC §6.7; 05-SCHEMA §6/§8; REQ-SEC-031). The behavioural part is the pgTAP suite db/tests/views/C9-T20.v_pub_qc_summary.test.sql.
// The quality DDL is merged by the C0 Wave-2 contract wave (06-IMPLEMENTATION-PLAN header), NOT by C9. So this file (a) always checks the DDL in 05-SCHEMA §8 against the 03-IC §6.7 row
// (the published columns are a contract: names, order, count) and (b) when a db/migrations/*.sql file defines the view, checks THAT definition the same way. No database needed.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../../core/module.js';

const COLUMNS = ['tenant_id', 'instrument_id', 'analyte_id', 'business_date', 'runs', 'accepted_runs', 'rejected_runs', 'warnings', 'last_in_control_run_at'];
const read = (...p: string[]) => readFileSync(join(REPO_ROOT, ...p), 'utf8');
const stripComments = (s: string) => s.replace(/--[^\n]*/g, '');

/** Text of `CREATE [OR REPLACE] VIEW quality.v_pub_qc_summary ... ;` (first statement end after it), comments removed. */
function viewDdl(sql: string): string | undefined {
  const t = stripComments(sql); const m = /CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+quality\.v_pub_qc_summary\b/i.exec(t); if (!m) return undefined;
  const end = t.indexOf(';', m.index); return t.slice(m.index, end < 0 ? undefined : end);
}
/** Output column names of the LAST top-level SELECT of the statement (alias after AS, else the last identifier). */
function outputColumns(ddl: string): string[] {
  let depth = 0, last = -1; const re = /[()]|\bSELECT\b/gi; let m: RegExpExecArray | null;
  while ((m = re.exec(ddl))) { if (m[0] === '(') depth++; else if (m[0] === ')') depth--; else if (depth === 0) last = m.index + m[0].length; }
  expect(last, 'a top-level SELECT').toBeGreaterThan(-1);
  const rest = ddl.slice(last); depth = 0; let from = -1; const re2 = /[()]|\bFROM\b/gi;
  while ((m = re2.exec(rest))) { if (m[0] === '(') depth++; else if (m[0] === ')') depth--; else if (depth === 0) { from = m.index; break; } }
  expect(from, 'a top-level FROM').toBeGreaterThan(-1);
  const list = rest.slice(0, from); const items: string[] = []; let d = 0, cur = '';
  for (const ch of list) { if (ch === '(') d++; if (ch === ')') d--; if (ch === ',' && d === 0) { items.push(cur); cur = ''; } else cur += ch; }
  items.push(cur);
  return items.map((it) => { const x = it.trim().replace(/\s+/g, ' '); const a = /\bAS\s+("?)([a-z_][a-z0-9_]*)\1$/i.exec(x); if (a) return a[2]!; const id = /([a-z_][a-z0-9_]*)$/i.exec(x); return id ? id[1]! : x; });
}

describe('03-IC §6.7 row for quality.v_pub_qc_summary', () => {
  const row = read('spec', 'program', '03-INTERFACE-CATALOG.md').split('\n').find((l) => l.startsWith('| `quality.v_pub_qc_summary`'))!;
  it('lists exactly the nine columns, in this order; consumer C8', () => {
    expect(row, 'the catalog row').toBeTruthy(); const cells = row.split('|').map((c) => c.trim());
    expect(cells[2]!.split(',').map((c) => c.trim())).toEqual(COLUMNS); expect(cells[4]).toBe('C8');
  });
});

describe('05-SCHEMA §8 DDL of the view (what C0 merges)', () => {
  const ddl = viewDdl(read('spec', 'chunks', 'C9-quality-engine', '05-SCHEMA.md'))!;
  it('exists, is security_invoker = true (REQ-SEC-031) and its output columns are exactly the §6.7 list', () => {
    expect(ddl).toBeTruthy(); expect(ddl).toMatch(/WITH\s*\(\s*security_invoker\s*=\s*true\s*\)/i); expect(outputColumns(ddl)).toEqual(COLUMNS);
  });
  it('business_date is the Asia/Kathmandu local date; only evaluated/closed runs count; accepted_runs = accepted + accepted_warning; warnings = accepted_warning; rejected_runs = rejected', () => {
    expect(ddl).toMatch(/AT TIME ZONE 'Asia\/Kathmandu'/); expect(ddl).toMatch(/status IN \('evaluated',\s*'closed'\)/i);
    expect(ddl).toMatch(/outcome IN \('accepted',\s*'accepted_warning'\)/i); expect(ddl).toMatch(/outcome = 'rejected'/i); expect(ddl).toMatch(/outcome = 'accepted_warning'/i);
  });
});

describe('the migration that defines the view (when one exists in db/migrations)', () => {
  const dir = join(REPO_ROOT, 'db', 'migrations');
  const defs = readdirSync(dir).filter((f) => f.endsWith('.sql')).map((f) => ({ f, ddl: viewDdl(readFileSync(join(dir, f), 'utf8')) })).filter((x) => x.ddl);
  it('defines the view at most once, with security_invoker = true and exactly the §6.7 columns in order; grants SELECT to lims_app only', () => {
    // ponytail: until C0's quality DDL migration lands, defs is empty and only the spec checks above run (reported in .orchestra/notes/C9.T-20-tests.md).
    expect(defs.length).toBeLessThanOrEqual(1);
    for (const d of defs) {
      expect(d.ddl, d.f).toMatch(/WITH\s*\(\s*security_invoker\s*=\s*true\s*\)/i); expect(outputColumns(d.ddl!), d.f).toEqual(COLUMNS);
      const sql = stripComments(readFileSync(join(dir, d.f), 'utf8'));
      expect(sql, d.f).toMatch(/GRANT\s+SELECT\s+ON\s+quality\.v_pub_qc_summary\s+TO\s+lims_app/i); expect(sql, d.f).not.toMatch(/GRANT\s+(?!SELECT)[A-Z, ]+\s+ON\s+quality\.v_pub_qc_summary/i);
    }
  });
});
