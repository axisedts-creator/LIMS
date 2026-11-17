// T22 static checks on service/tenant.service.ts and the 12 handler files (02-TRD s5.10, 08 R10 item 4 / A25 D-213 / D-214, A3.4, A9.5, REQ-SEC-063).
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const mod = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const service = join(mod, 'service', 'tenant.service.ts');
const OPS = ['listTenants', 'provisionTenant', 'getTenant', 'updateTenant', 'activateTenant', 'suspendTenant', 'reactivateTenant', 'terminateTenant', 'getTenantSettingsAsPlatform',
  'updateTenantSettingsAsPlatform', 'setFeatureFlagAsPlatform', 'inviteTenantAdmin'];
const read = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
const sqlLines = (s: string) => s.split(/\r?\n/).filter((l) => /\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b/.test(l) && /(core|identity|audit|app)\./.test(l));

describe('tenant.service.ts', () => {
  const s = read(service);
  it('exists; any SQL it holds is not built by interpolation/concatenation; no process.env', () => {
    expect(existsSync(service)).toBe(true);
    for (const l of sqlLines(s)) { expect(l).not.toMatch(/\$\{/); expect(l).not.toMatch(/['"`]\s*\+\s*\w/); }
    expect(s).not.toMatch(/process\.env/);
  });
  it('authorises with PlatformAuthz.assertPlatform and both contract permissions; never IdentityPort.assertRole', () => {
    expect(s).toMatch(/assertPlatform\s*\(/); expect(s).not.toMatch(/assertRole\s*\(/); for (const p of ['platform.tenant.read', 'platform.tenant.manage']) expect(s).toContain(p);
  });
  it('D-214: uses ctx.db.withTenantScope, and every operation that does is on the core allowlist', () => {
    expect(s).toMatch(/withTenantScope\s*\(/);
    const allow = read(join(mod, '..', '..', 'core', 'db', 'allowlists.ts'));
    for (const op of ['provisionTenant', 'inviteTenantAdmin', 'activateTenant', 'suspendTenant', 'reactivateTenant', 'terminateTenant', 'updateTenantSettingsAsPlatform', 'setFeatureFlagAsPlatform']) expect(allow).toContain(`'${op}'`);
    for (const op of ['listTenants', 'getTenant', 'updateTenant', 'getTenantSettingsAsPlatform']) expect(allow).not.toContain(`'${op}'`);
  });
  it('D-213: idempotency is the core platform store\'s - the service never touches core.idempotency_keys itself', () => { expect(s).not.toMatch(/idempotency_keys/); });
  it('08 A3.4: memberships are deactivated through status only - no SQL sets is_active; deactivation_reason_code is the literal other', () => {
    for (const l of sqlLines(s)) if (/memberships/.test(l)) expect(l).not.toMatch(/\bis_active\s*=/);
    expect(s).toMatch(/['"]other['"]/);
  });
  it('08 A9.5: deactivated_by is never fed from a system actor', () => { expect(s).not.toMatch(/deactivated_by[^;\n]*(system|SYSTEM)/); });
  it('LD-26 / LD-29 decisions are cited in code comments', () => { expect(s).toMatch(/LD-26/); expect(s).toMatch(/LD-29/); });
  it('reason texts are never passed to a logger or the access-log detail', () => {
    expect(s).not.toMatch(/log\.(info|warn|error|debug)\([^)]*(reasonText|reason_text)/); expect(s).not.toMatch(/detail\s*:\s*\{[^}]*(reasonText|reason_text|confirmCode)/);
  });
  it('timezone is checked against the single v1 value Asia/Kathmandu (P-15)', () => { expect(s).toContain('Asia/Kathmandu'); });
});

describe.each(OPS)('handler %s', (op) => {
  const s = read(join(mod, 'handlers', `${op}.ts`));
  it('exists, holds no SQL, does not authorise on its own (the service does), no process.env, no longer the common.internal stub', () => {
    expect(existsSync(join(mod, 'handlers', `${op}.ts`))).toBe(true);
    expect(sqlLines(s)).toEqual([]); expect(s).not.toMatch(/assertRole\s*\(/); expect(s).not.toMatch(/process\.env/);
  });
});
