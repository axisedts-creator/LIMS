// T14 static checks on role.service.ts and the six handler files (REQ-SEC-040/044; 07-SECURITY P-2, D-T12 style greps). No DB needed: the default repo's SQL is not
// executed by any test here (no LIMS_TEST_DATABASE_URL harness for T14), so these greps are the only guard on its text.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const svcPath = join(here, '..', 'role.service.ts');
const handlerDir = join(here, '..', '..', 'handlers');
const OPS = ['listPermissions', 'listRoles', 'createRole', 'getRole', 'updateRole', 'deactivateRole'];
const src = () => readFileSync(svcPath, 'utf8');
const sqlLines = (s: string) => s.split(/\r?\n/).filter((l) => /\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b/.test(l) && /(core|identity|audit)\./.test(l));

describe('role.service.ts text checks', () => {
  it('exists', () => { expect(existsSync(svcPath)).toBe(true); });
  it('no SQL string is built by interpolation (${...}) or concatenation', () => {
    const lines = sqlLines(src()); expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) { expect(l).not.toMatch(/\$\{/); expect(l).not.toMatch(/['"`]\s*\+\s*\w/); }
  });
  it('every statement on a tenant table names tenant_id', () => {
    const s = src();
    const stmts = s.match(/`[^`]*\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b[^`]*`|'[^'\n]*\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b[^'\n]*'/g) ?? [];
    const tenantStmts = stmts.filter((x) => /core\.(roles|role_permissions|membership_roles|memberships)|identity\.sessions/.test(x));
    expect(tenantStmts.length).toBeGreaterThan(0);
    for (const x of tenantStmts) expect(x).toMatch(/tenant_id/);
  });
  it('touches only the role/membership/session tables, never dead letters or platform staff, and reads no env', () => {
    const s = src();
    expect(s).not.toMatch(/core\.dead_letters|platform_staff|process\.env/);
  });
  it('session revoke reason is the literal role_change (sessions__revoke_reason__ck)', () => { expect(src()).toMatch(/['"]role_change['"]/); });
  it('fan-out uses the registered task id identity.gotrue_signout and the access-log action role.change', () => {
    expect(src()).toMatch(/identity\.gotrue_signout/); expect(src()).toMatch(/['"]role\.change['"]/);
  });
});

describe('handler files', () => {
  it.each(OPS)('handlers/%s.ts exists and is not the not-implemented stub', (op) => {
    const p = join(handlerDir, `${op}.ts`); expect(existsSync(p)).toBe(true);
    expect(readFileSync(p, 'utf8')).not.toMatch(/not implemented/);
  });
  it.each(OPS)('handlers/%s.ts takes tenant and actor from the context only (no body/query/params tenant read)', (op) => {
    const p = join(handlerDir, `${op}.ts`); if (!existsSync(p)) return expect(existsSync(p)).toBe(true);
    expect(readFileSync(p, 'utf8')).not.toMatch(/(body|query|params)\??\.(tenant_id|tenantId)|\[['"]tenant_id['"]\]/);
  });
});
