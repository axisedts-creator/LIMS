// T25 static checks (02-TRD s5.10: "checked by PlatformAuthz, never by IdentityPort"; 05-SCHEMA s5.4 / s11 test 25; 07-SECURITY REQ-SEC-063, D-T19).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../../../core/module.js';

const ID = join(REPO_ROOT, 'services', 'api', 'src', 'modules', 'identity');
const read = (...p: string[]) => readFileSync(join(ID, ...p), 'utf8');
const strip = (s: string) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const OPS = ['listPlatformStaff', 'invitePlatformStaff', 'updatePlatformStaff', 'deactivatePlatformStaff', 'resetPlatformStaffMfa', 'listPlatformSessions', 'revokePlatformSession', 'listPlatformAuthEvents'];

describe('service/platform-staff.service.ts', () => {
  const src = strip(read('service', 'platform-staff.service.ts'));
  it('holds no SQL and imports no repository / pg (rows come only through the injected repo seam)', () => {
    expect(src).not.toMatch(/\b(SELECT|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/i);
    expect(src).not.toMatch(/from\s+['"][^'"]*repository\/[^'"]*['"]|from\s+['"]pg['"]/);
  });
  it('authorises with PlatformAuthz (never IdentityPort / tenant roles): platform.staff.manage and platform.tenant.read, nothing else', () => {
    expect(src).toContain('PlatformAuthz'); expect(src).not.toMatch(/IdentityPort|assertRole|assertPermission/);
    expect(src).toContain('platform.staff.manage'); expect(src).toContain('platform.tenant.read');
    for (const p of src.match(/platform\.[a-z_]+\.[a-z_]+/g) ?? []) expect(['platform.staff.manage', 'platform.tenant.read']).toContain(p);
  });
  it('is platform-context only: never reads a tenant from ctx and never calls bindTenant / withTenantScope', () => {
    expect(src).not.toMatch(/ctx\.tenantId|\.bindTenant\(|withTenantScope|identityAuthTx/);
  });
  it('uses the spec codes verbatim', () => {
    for (const c of ['identity.last_admin_protected', 'identity.self_action_forbidden', 'identity.user_exists', 'common.version_conflict', 'common.precondition_required', 'common.not_found']) expect(src).toContain(c);
    for (const t of ['platform_staff_invited', 'platform_staff_changed', 'platform_staff_deactivated', 'platform_mfa_reset', 'platform_session_revoked']) expect(src).toContain(t);
    for (const j of ['identity.send_invitation', 'identity.gotrue_signout', 'identity.remove_mfa_factors']) expect(src).toContain(j);
  });
  it('writes no audit_log / access_log row for NULL-tenant staff actions (08 A25 D-215: platform_events only)', () => {
    expect(src).not.toMatch(/audit\.access\(|insertAccessLog|audit_log/);
  });
});

describe('handlers', () => {
  it.each(OPS)('handlers/%s.ts exists and handlers/index.ts registers it', (op) => {
    expect(existsSync(join(ID, 'handlers', `${op}.ts`))).toBe(true);
    expect(read('handlers', 'index.ts')).toMatch(new RegExp(`import \\{[^}]*\\b${op}\\b[^}]*\\} from './${op}\\.js'`));
    expect(strip(read('handlers', 'index.ts'))).toMatch(new RegExp(`implemented[\\s\\S]*\\b${op}\\b`));
  });
  it('the default platform_events writer is wired in the handler glue, not in the service', () => {
    const glue = strip(read('handlers', 'platform-staff.http.ts')); expect(glue).toMatch(/platformEvents/); expect(glue).toMatch(/createPlatformStaffService/);
    expect(strip(read('service', 'platform-staff.service.ts'))).not.toMatch(/insertPlatformEvent|INSERT/);
  });
});

describe('repository/platform-staff.repo.ts (the only SQL of T25)', () => {
  const sql = read('repository', 'platform-staff.repo.ts');
  it('locks the active superadmin set FOR UPDATE and reads only active platform_superadmin rows', () => {
    expect(sql).toMatch(/identity\.platform_staff[\s\S]{0,300}role_code\s*=\s*'platform_superadmin'[\s\S]{0,200}is_active[\s\S]{0,200}FOR UPDATE/i);
  });
  it('staff updates are optimistic (version = $n) and bump version', () => {
    expect(sql).toMatch(/UPDATE\s+identity\.platform_staff[\s\S]{0,600}version\s*=\s*version\s*\+\s*1[\s\S]{0,300}AND\s+version\s*=\s*\$\d/i);
  });
  it('never selects secret session columns for the platform session list', () => {
    const list = sql.match(/FROM\s+identity\.sessions[\s\S]{0,800}/i)?.[0] ?? '';
    expect(list).toMatch(/kind\s*=\s*'platform'/); expect(sql).not.toMatch(/SELECT[^;]*\b(refresh_token_enc|access_token_enc|token_sha256|enc_key_id)\b/i);
  });
  it('the platform auth-event list has no tenant_id = $n predicate (tenant-less rows included) and never selects email_hmac', () => {
    const q = sql.match(/FROM\s+identity\.auth_events[\s\S]{0,900}/i)?.[0] ?? ''; expect(q).not.toMatch(/WHERE\s+tenant_id\s*=\s*\$1/i);
    expect(sql).not.toMatch(/SELECT[^;]*\bemail_hmac\b/i); expect(q).toMatch(/\(\$\d+::uuid IS NULL OR tenant_id = \$\d+\)/i);
  });
});
