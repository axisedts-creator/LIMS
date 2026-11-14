// C7 API-T07 — CI check: code drivers <-> instruments.g_drivers rows (status, cap_*). CR-C7-013 / 02-TRD §6.1 / AC-21.3.
// Written by the TESTER role under LD-56 (2026-11-07): __tests__/ paths are tester-owned, the writer/debugger cannot create them.
// Reads every *.sql in migrationsDir (name order): INSERT INTO instruments.g_drivers (...) VALUES (...),(...) and later
// UPDATE instruments.g_drivers SET ... WHERE code = '<c>'. Fails closed: no rows at all while drivers exist is a problem per driver.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export interface DriverLike {
  readonly code: string;
  readonly status: string;
  readonly capabilities: { readonly hostQuery?: boolean; readonly worklistDownload?: boolean; readonly qc?: boolean; readonly attachments?: boolean; readonly calibration?: boolean };
}
export interface CheckResult { ok: boolean; problems: string[] }

const CAPS = [['hostQuery', 'cap_host_query'], ['worklistDownload', 'cap_worklist_download'], ['qc', 'cap_qc'], ['attachments', 'cap_attachments'], ['calibration', 'cap_calibration']] as const;
type Lit = string | boolean | number | null;
type Row = Record<string, Lit>;

/** Splits SQL into statements on ';' outside quotes, comments and $tag$ bodies; comments are dropped. */
function statements(sql: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < sql.length;) {
    const c = sql[i] as string;
    if (c === '-' && sql[i + 1] === '-') { while (i < sql.length && sql[i] !== '\n') i++; continue; }
    if (c === '/' && sql[i + 1] === '*') { const e = sql.indexOf('*/', i + 2); i = e < 0 ? sql.length : e + 2; cur += ' '; continue; }
    if (c === "'") {
      let j = i + 1;
      for (; j < sql.length; j++) { if (sql[j] === "'") { if (sql[j + 1] === "'") j++; else break; } }
      cur += sql.slice(i, j + 1); i = j + 1; continue;
    }
    if (c === '$') {
      const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i, i + 64))?.[0];
      if (tag) { const e = sql.indexOf(tag, i + tag.length); const end = e < 0 ? sql.length : e + tag.length; cur += sql.slice(i, end); i = end; continue; }
    }
    if (c === ';') { out.push(cur.trim()); cur = ''; i++; continue; }
    cur += c; i++;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function literal(raw: string): Lit {
  const s = raw.trim();
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) return s.slice(1, -1).replace(/''/g, "'");
  if (/^null$/i.test(s)) return null;
  if (/^true$/i.test(s)) return true;
  if (/^false$/i.test(s)) return false;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}

/** Splits on commas outside quotes and parentheses. */
function splitTop(s: string): string[] {
  const parts: string[] = [];
  let depth = 0; let q = false; let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i] as string;
    if (q) { cur += c; if (c === "'") { if (s[i + 1] === "'") { cur += "'"; i++; } else q = false; } continue; }
    if (c === "'") { q = true; cur += c; } else if (c === '(') { depth++; cur += c; } else if (c === ')') { depth--; cur += c; } else if (c === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += c;
  }
  parts.push(cur);
  return parts;
}

/** Returns the inner text of each top-level (...) tuple in a VALUES list; stops at the first other token (e.g. ON CONFLICT). */
function tuples(s: string): string[] {
  const out: string[] = [];
  let depth = 0; let q = false; let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i] as string;
    if (q) { if (c === "'") { if (s[i + 1] === "'") i++; else q = false; } continue; }
    if (c === "'") q = true;
    else if (c === '(') { if (depth === 0) start = i + 1; depth++; }
    else if (c === ')') { depth--; if (depth === 0) out.push(s.slice(start, i)); }
    else if (depth === 0 && !/[\s,]/.test(c)) break;
  }
  return out;
}

export function readRows(migrationsDir: string): Map<string, Row> {   // exported for H80-T05 row assertions
  const rows = new Map<string, Row>();
  const files = readdirSync(migrationsDir).filter((f) => f.toLowerCase().endsWith('.sql')).sort();
  for (const f of files) {
    for (const st of statements(readFileSync(join(migrationsDir, f), 'utf8'))) {
      const ins = /^INSERT\s+INTO\s+instruments\.g_drivers\s*\(([^)]*)\)\s*VALUES\s*([\s\S]*)$/i.exec(st);
      if (ins) {
        const cols = (ins[1] as string).split(',').map((c) => c.trim().toLowerCase());
        for (const t of tuples(ins[2] as string)) {
          const vals = splitTop(t).map(literal);
          const row: Row = { is_active: true, cap_host_query: false, cap_worklist_download: false, cap_qc: false, cap_attachments: false, cap_calibration: false };
          cols.forEach((c, i) => { row[c] = vals[i] ?? null; });
          if (typeof row['code'] === 'string') rows.set(row['code'], row);
        }
        continue;
      }
      const upd = /^UPDATE\s+instruments\.g_drivers\s+SET\s+([\s\S]*?)\s+WHERE\s+code\s*=\s*'([^']*)'$/i.exec(st);
      if (upd) {
        const row = rows.get(upd[2] as string);
        if (!row) continue;
        for (const a of splitTop(upd[1] as string)) {
          const m = /^\s*([A-Za-z_0-9]+)\s*=\s*([\s\S]*?)\s*$/.exec(a);
          if (m) row[(m[1] as string).toLowerCase()] = literal(m[2] as string);
        }
      }
    }
  }
  return rows;
}

export function checkDriverRegistry(input: { drivers: readonly DriverLike[]; migrationsDir: string }): CheckResult {
  const problems: string[] = [];
  const rows = readRows(input.migrationsDir);
  const byCode = new Map(input.drivers.map((d) => [d.code, d]));
  if (rows.size === 0 && input.drivers.length > 0) problems.push(`no instruments.g_drivers rows found in ${input.migrationsDir}`);
  for (const d of input.drivers) {
    const row = rows.get(d.code);
    if (!row) { problems.push(`${d.code}: implementation has no instruments.g_drivers row`); continue; }
    if (row['status'] !== d.status) problems.push(`${d.code}: status differs (code=${d.status}, row=${String(row['status'])})`);
    for (const [cap, col] of CAPS) {
      const code = d.capabilities[cap] === true;
      if (row[col] !== code) problems.push(`${d.code}: ${col} differs (code=${code}, row=${String(row[col])})`);
    }
  }
  for (const [code, row] of rows) if (row['is_active'] !== false && !byCode.has(code)) problems.push(`${code}: active g_drivers row has no code implementation`);
  return { ok: problems.length === 0, problems };
}

async function main(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const { listDrivers } = await import('../../drivers/registry.js');
  const r = checkDriverRegistry({ drivers: listDrivers(), migrationsDir: process.argv[2] ?? resolve(here, '../../../../../../../db/migrations') });
  for (const p of r.problems) console.error(p);
  console.log(r.ok ? 'driver-registry-check: ok' : `driver-registry-check: ${r.problems.length} problem(s)`);
  process.exit(r.ok ? 0 : 1);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void main();
