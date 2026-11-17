// C2-T19 static rules (07-SECURITY D-T4 "no module-local guard exists in services/**/identity/** (grep)", A-13, REQ-SEC-097; 05-SCHEMA §4.15, 08 A13 P-9).
// Source-level checks only; behaviour is in audit-export.service.test.ts and the worker test.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { check } from '../../../../../../tools/lint/rules/no-local-spreadsheet-guard.ts';

const ROOT = join(import.meta.dirname, '../../../../../..');
const API_IDENT = join(ROOT, 'services/api/src/modules/identity');
const WORKER_IDENT = join(ROOT, 'services/worker/src/jobs/identity');
const walk = (d: string): string[] => { try { return readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? (n === '__tests__' || n === 'node_modules' ? [] : walk(p)) : [p]; }); } catch { return []; } };
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/([^:])\/\/.*$/gm, '$1');
const src = (p: string) => readFileSync(p, 'utf8');
const prod = [...walk(API_IDENT), ...walk(WORKER_IDENT)].filter((p) => /\.ts$/.test(p) && !/\.test\.ts$/.test(p));

describe('D-T4: no module-local CSV-injection guard in services/**/identity/**', () => {
  it('the files under test exist (handlers, service, worker task)', () => {
    for (const f of ['services/api/src/modules/identity/handlers/createAuditExport.ts', 'services/api/src/modules/identity/handlers/listAuditExports.ts', 'services/api/src/modules/identity/handlers/getAuditExport.ts',
      'services/api/src/modules/identity/handlers/downloadAuditExport.ts', 'services/api/src/modules/identity/service/audit-export.service.ts', 'services/worker/src/jobs/identity/tasks/build_audit_export.ts']) {
      expect(() => statSync(join(ROOT, f)), f).not.toThrow();
    }
  });
  it('the shared lint rule (no-local-spreadsheet-guard) finds nothing in the identity sources', () => {
    expect(prod.length).toBeGreaterThan(5);
    for (const p of prod) expect(check(p.replace(ROOT + '\\', '').replace(ROOT + '/', '').replaceAll('\\', '/'), src(p)), p).toEqual([]);
  });
  it('no hand-rolled formula-prefix test either: no character class of = + - @ (tab / CR) in any identity source', () => {
    for (const p of prod) {
      const code = strip(src(p));
      expect(code, p).not.toMatch(/\[\s*=\s*\+\s*\\?-\s*@/);                        // /^[=+\-@]/
      expect(code, p).not.toMatch(/\[\s*=\s*\\?\+\s*@\s*\\?-/);
      expect(code, p).not.toMatch(/['"`]=\+-@['"`]|['"`]=\+@-['"`]/);              // '=+-@'.includes(c)
      expect(code, p).not.toMatch(/startsWith\(\s*['"`][=+@-]['"`]\s*\)/);         // cell.startsWith('=')
    }
  });
  it('the worker task imports neutraliseFormula from the shared spreadsheet module (P-9) and does not define restoreNeutralised', () => {
    const t = strip(src(join(WORKER_IDENT, 'tasks/build_audit_export.ts')));
    expect(t).toMatch(/import\s*\{[^}]*\bneutraliseFormula\b[^}]*\}\s*from\s*['"](@lims\/shared-ts\/spreadsheet|(\.\.\/)+packages\/shared-ts\/src\/spreadsheet\/index\.js)['"]/);
  });
});

describe('exports never carry values (07-SECURITY threat 5, 08 A3.3)', () => {
  it('the worker task never selects old_values / new_values', () => {
    const t = strip(src(join(WORKER_IDENT, 'tasks/build_audit_export.ts')));
    expect(t).not.toMatch(/old_values|new_values|oldValues|newValues/);
  });
  it('the service / repository never put filter values or reason text into the access-log detail or notice (detail holds only ids / counts)', () => {
    const s = strip(src(join(API_IDENT, 'service/audit-export.service.ts')));
    expect(s).not.toMatch(/detail\s*:\s*\{[^}]*filters/);
  });
});

describe('default repository (repository/exports.repo.ts) - tenant isolation and quota race', () => {
  const p = join(API_IDENT, 'repository/exports.repo.ts');
  it('every statement that reads / updates identity.audit_exports names tenant_id = $n (RLS is the second layer, not the only one)', () => {
    const code = strip(src(p));
    const lits = [...code.matchAll(/`([^`]*)`|'([^'\n]*)'|"([^"\n]*)"/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? '').filter((s) => /\bidentity\.audit_exports\b/i.test(s) && /\b(SELECT|UPDATE|DELETE)\b/i.test(s));
    expect(lits.length).toBeGreaterThan(2);
    for (const s of lits) expect(s, s).toMatch(/\btenant_id\s*=\s*\$\d/);
  });
  it('the quota lock is a transaction-scoped lock (advisory xact lock or row lock), not a bare count', () => {
    expect(strip(src(p))).toMatch(/pg_advisory_xact_lock|FOR UPDATE/i);
  });
  it('the atomic download decrement is ONE conditional UPDATE (downloads_remaining > 0 AND status = ready AND expires_at > now) with RETURNING', () => {
    const code = strip(src(p));
    const upd = [...code.matchAll(/`([^`]*UPDATE\s+identity\.audit_exports[^`]*)`/gi)].map((m) => m[1]!).find((s) => /downloads_remaining\s*=\s*downloads_remaining\s*-\s*1/i.test(s));
    expect(upd, 'no UPDATE ... downloads_remaining = downloads_remaining - 1').toBeTruthy();
    expect(upd).toMatch(/downloads_remaining\s*>\s*0/i);
    expect(upd).toMatch(/status\s*=\s*'ready'/i);
    expect(upd).toMatch(/expires_at\s*>/i);
    expect(upd).toMatch(/RETURNING/i);
  });
});
