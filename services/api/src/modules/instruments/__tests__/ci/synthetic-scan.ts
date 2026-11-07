// C7 API-T07 — CI check (AC-21.4): fixtures/testdata must be synthetic. Flags a non-empty patient NAME in an ASTM `P` record (P.6)
// or HL7 `PID` segment (PID.5) that is not in allowedNames. Written by the TESTER role under LD-56 (2026-11-07).
// Violations never echo the matched value (CI logs stay free of PHI). Missing root = not ok (fail closed). Symlinks are not followed.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface Violation { file: string; line?: number; reason: string }
export interface ScanResult { ok: boolean; violations: Violation[] }

// Record separators seen in raw files, session JSON (mnemonics, STX+frame digit, escaped \r \n) and CR/LF/CRLF text.
const SEP = /<CR>|<LF>|<VT>|<FS>|<ETX>|<STX>\d?|\\r|\\n/g;
const START = /(?:^|["\s])(PID|P)\|/g;

function value(rec: string, idx: number): string {
  const v = (rec.split('|')[idx] ?? '').split('"')[0] as string; // cut at a JSON string end
  return v.replace(/\\+$/, '').trim();
}

function scanText(text: string, file: string, allowed: ReadonlySet<string>, out: Violation[]): void {
  text.split(/\r\n|\r|\n/).forEach((physical, i) => {
    for (const rec of physical.replace(SEP, '\n').split('\n')) {
      START.lastIndex = 0;
      const m = START.exec(rec);
      if (!m) continue;
      const type = m[1] as string;
      const name = value(rec.slice(m.index + m[0].length - type.length - 1), 5);
      if (name !== '' && !allowed.has(name)) out.push({ file, line: i + 1, reason: type === 'P' ? 'ASTM P.6 patient name is not synthetic' : 'HL7 PID.5 patient name is not synthetic' });
    }
  });
}

function walk(path: string, out: Violation[], allowed: ReadonlySet<string>): void {
  const st = statSync(path);
  if (st.isFile()) { scanText(readFileSync(path, 'utf8'), path, allowed, out); return; }
  for (const e of readdirSync(path, { withFileTypes: true })) {
    if (e.isDirectory() || e.isFile()) walk(join(path, e.name), out, allowed);
  }
}

export function scanSyntheticData(roots: string[], opts: { allowedNames?: string[] } = {}): ScanResult {
  const violations: Violation[] = [];
  const allowed = new Set(opts.allowedNames ?? []);
  if (roots.length === 0) violations.push({ file: '', reason: 'no scan roots given' });
  for (const root of roots) {
    try { walk(root, violations, allowed); } catch { violations.push({ file: root, reason: 'scan root missing or unreadable' }); }
  }
  return { ok: violations.length === 0, violations };
}

function main(): void {
  const r = scanSyntheticData(process.argv.slice(2));
  for (const v of r.violations) console.error(`${v.file}${v.line ? `:${v.line}` : ''}: ${v.reason}`);
  console.log(r.ok ? 'synthetic-scan: ok' : `synthetic-scan: ${r.violations.length} violation(s)`);
  process.exit(r.ok ? 0 : 1);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
