// T21 static checks on platform/authz.ts, service/support.service.ts and the four handler files (02-TRD s5.10, 08 R10 item 4/D-214, REQ-SEC-063).
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const mod = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const service = join(mod, 'service', 'support.service.ts');
const OPS = ['openSupportSession', 'activateSupportSession', 'endSupportSession', 'listPlatformSupportSessions'];
const read = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
const sqlLines = (s: string) => s.split(/\r?\n/).filter((l) => /\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b/.test(l) && /(core|identity|audit|app)\./.test(l));

describe('support.service.ts', () => {
  const s = read(service);
  it('exists; any SQL it holds is not built by interpolation/concatenation; no process.env', () => {
    expect(existsSync(service)).toBe(true);
    for (const l of sqlLines(s)) { expect(l).not.toMatch(/\$\{/); expect(l).not.toMatch(/['"`]\s*\+\s*\w/); }
    expect(s).not.toMatch(/process\.env/);
  });
  it('authorises with PlatformAuthz.assertPlatform and the three contract permissions; never IdentityPort.assertRole', () => {
    expect(s).toMatch(/assertPlatform\s*\(/); expect(s).not.toMatch(/assertRole\s*\(/);
    for (const p of ['platform.support_session.open', 'platform.tenant.read']) expect(s).toContain(p);
  });
  it('writes into the target tenant only through ctx.db.withTenantScope (D-214); the four ops are on the core allowlist', () => {
    expect(s).toMatch(/withTenantScope\s*\(/);
    const allow = read(join(mod, '..', '..', 'core', 'db', 'allowlists.ts'));
    for (const op of ['openSupportSession', 'activateSupportSession', 'endSupportSession']) expect(allow).toContain(op);
  });
  it('the reason text is never passed to a logger or the access-log detail', () => {
    expect(s).not.toMatch(/log\.(info|warn|error|debug)\([^)]*(reasonText|reason_text)/);
    expect(s).not.toMatch(/detail\s*:\s*\{[^}]*(reasonText|reason_text|ticketRef|ticket_ref)/);
  });
});

describe.each(OPS)('handler %s', (op) => {
  const s = read(join(mod, 'handlers', `${op}.ts`));
  it('exists, holds no SQL, does not authorise on its own (the service does) and does not read a tenant from input into claims', () => {
    expect(existsSync(join(mod, 'handlers', `${op}.ts`))).toBe(true);
    expect(sqlLines(s)).toEqual([]); expect(s).not.toMatch(/assertRole\s*\(/); expect(s).not.toMatch(/process\.env/);
  });
});
