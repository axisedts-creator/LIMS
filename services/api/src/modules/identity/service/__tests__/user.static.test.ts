// T13 static checks on user.service.ts, repository/{invitations,assets}.repo.ts and the 15 handler files (REQ-SEC-040/044; 07-SECURITY P-2, D-T12 style greps).
// No DB needed: the default repo's SQL is not executed by any T13 test (no LIMS_TEST_DATABASE_URL harness here), so these greps are the only guard on its text.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const idDir = join(here, '..', '..');
const files = { service: join(idDir, 'service', 'user.service.ts'), invitations: join(idDir, 'repository', 'invitations.repo.ts'), assets: join(idDir, 'repository', 'assets.repo.ts') };
const OPS = ['listUsers', 'searchUsers', 'inviteUser', 'getUser', 'updateUser', 'setUserRoles', 'setUserCentreScope', 'lockUser', 'unlockUser', 'deactivateUser', 'reactivateUser', 'resendInvitation', 'resetUserMfa', 'revokeUserSessions', 'uploadUserSignature'];
const read = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
const all = () => Object.values(files).map(read).join('\n');
const STMT = /`[^`]*\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b[^`]*`|'[^'\n]*\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b[^'\n]*'|"[^"\n]*\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b[^"\n]*"/g;
const stmts = (s: string) => s.match(STMT) ?? [];
const TENANT_TABLES = /core\.(users|memberships|membership_roles|membership_centres|membership_branches|roles|collection_centres|branches)\b|identity\.(sessions|invitations|branding_assets|mfa_factors)\b/;

describe('files exist', () => {
  it.each(Object.entries(files))('%s', (_n, p) => { expect(existsSync(p)).toBe(true); });
});

describe('SQL text', () => {
  it('there is SQL at all, and none of it is built by interpolation (${...}) or concatenation', () => {
    const s = stmts(all()); expect(s.length).toBeGreaterThan(10);
    for (const x of s) { expect(x).not.toMatch(/\$\{/); expect(x).not.toMatch(/['"`]\s*\+\s*\w/); }
  });
  it('no template literal passed to a query function carries ${...} (statement text is constant)', () => {
    for (const m of all().matchAll(/\b(?:q|query|tx\.query|exec)\(\s*[^,]*?,\s*`([^`]*)`/g)) expect(m[1]).not.toMatch(/\$\{/);
  });
  it('every statement on a tenant table names tenant_id', () => {
    const t = stmts(all()).filter((x) => TENANT_TABLES.test(x)); expect(t.length).toBeGreaterThan(8);
    for (const x of t) expect(x).toMatch(/tenant_id/);
  });
  it('no SELECT * / RETURNING * (explicit column lists only; no accidental leak of e-mail, hmac or token columns)', () => {
    for (const x of stmts(all())) { expect(x).not.toMatch(/SELECT\s+\*/i); expect(x).not.toMatch(/RETURNING\s+\*/i); }
  });
  it('core.memberships: no write to the generated is_active column, no is_locked column anywhere (lock = locked_at IS NOT NULL, 08 A3.4 / A6.1)', () => {
    const m = stmts(all()).filter((x) => /core\.memberships/.test(x));
    for (const x of m) { expect(x).not.toMatch(/\bis_active\s*=/); expect(x).not.toMatch(/\bis_locked\b/); }
    expect(all()).toMatch(/locked_at\s+IS\s+(NOT\s+)?NULL/i);
  });
  it('the membership UPDATE is guarded by version (optimistic lock) and bumps it', () => {
    const u = stmts(all()).filter((x) => /UPDATE\s+core\.memberships/i.test(x)); expect(u.length).toBeGreaterThan(0);
    expect(u.some((x) => /version\s*=\s*version\s*\+\s*1/i.test(x) && /version\s*=\s*\$\d/i.test(x.replace(/version\s*=\s*version\s*\+\s*1/gi, '')))).toBe(true);
  });
  it('listUsers / getUser read last_login_at from core.memberships, never from core.users (08 A6.3)', () => {
    for (const x of stmts(all()).filter((y) => /last_login_at/.test(y))) { expect(x).toMatch(/core\.memberships/); expect(x).not.toMatch(/\bu\.last_login_at\b|core\.users\.last_login_at/); }
  });
  it('last-admin read locks the role rows first (FOR UPDATE) - the serialisation point of the race (T14 convention)', () => {
    expect(stmts(all()).some((x) => /core\.roles/.test(x) && /FOR\s+UPDATE/i.test(x))).toBe(true);
  });
  it('searchUsers escapes LIKE metacharacters (ESCAPE clause) and binds the pattern as a parameter', () => {
    const s = stmts(all()).filter((x) => /\b(I?LIKE)\b/i.test(x)); expect(s.length).toBeGreaterThan(0);
    for (const x of s) { expect(x).toMatch(/ESCAPE/i); expect(x).toMatch(/\$\d/); }
  });
  it('lists are bounded: every ordered membership read ends in LIMIT $n', () => {
    const l = stmts(all()).filter((x) => /FROM\s+core\.memberships/i.test(x) && /ORDER\s+BY/i.test(x)); expect(l.length).toBeGreaterThan(0); for (const x of l) expect(x).toMatch(/LIMIT\s+\$\d/i);
  });
  it('invitation rows are created pending with an expiry; the signature asset row is kind signature with a membership_id', () => {
    expect(read(files.invitations)).toMatch(/INSERT\s+INTO\s+identity\.invitations/i); expect(read(files.invitations)).toMatch(/pending/); expect(read(files.invitations)).toMatch(/expires_at/);
    expect(read(files.assets)).toMatch(/INSERT\s+INTO\s+identity\.branding_assets/i); expect(read(files.assets)).toMatch(/signature/); expect(read(files.assets)).toMatch(/membership_id/);
  });
  it('the e-mail HMAC is written with the user row (08 A25 D-217)', () => { expect(all()).toMatch(/email_hmac/); });
});

describe('service text', () => {
  it('uses the registered reason / task / action literals', () => {
    const s = read(files.service);
    for (const lit of ["'lock'", "'deactivate'", "'role_change'", "'mfa_reset'", "'admin_revoke'", 'identity.send_invitation', 'identity.gotrue_signout', 'identity.remove_mfa_factors', 'identity.rescan_upload', "'role.change'", "'session.revoke'", 'identity-assets']) expect(s).toContain(lit);
  });
  it('touches no env, no platform tables, no dead letters; logs no e-mail and uses no console', () => {
    const s = all(); expect(s).not.toMatch(/process\.env|platform_staff|core\.dead_letters|console\./); expect(s).not.toMatch(/log\??\.\w+\([^)]*email/i);
  });
  it('the phone check is the C0 pattern (no looser regex)', () => { expect(read(files.service)).toContain('^\\+[1-9][0-9]{7,14}$'); });
  it('the signature object key never uses the client file name', () => { expect(read(files.service)).toMatch(/signatures\/\$\{/); expect(read(files.service)).not.toMatch(/signatures\/[^`'"]*\$\{[^}]*(filename|originalname|file\.name)/i); });
});

describe('handler files', () => {
  const handlerDir = join(idDir, 'handlers');
  it.each(OPS)('handlers/%s.ts exists and is not the not-implemented stub', (op) => {
    const p = join(handlerDir, `${op}.ts`); expect(existsSync(p)).toBe(true); expect(read(p)).not.toMatch(/not implemented/);
  });
  it.each(OPS)('handlers/%s.ts takes tenant and actor from the context only (no body/query/params tenant read)', (op) => {
    const p = join(handlerDir, `${op}.ts`); if (!existsSync(p)) return expect(existsSync(p)).toBe(true);
    expect(read(p)).not.toMatch(/(body|query|params)\??\.(tenant_id|tenantId)|\[['"]tenant_id['"]\]/);
  });
});
