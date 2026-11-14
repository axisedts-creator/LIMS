// T10 static guards on the six handlers + service/self.service.ts (+ repository/self.repo.ts when the writer splits the SQL out).
// 02-TRD s5.2 (own records only), 07-SECURITY AU-T20 / AU-T22 / s5 logging rules, AC-A6.3 (no network call), 02-CONVENTIONS P-42 (commitOnError right after the failure write, no other write).
// Expected now: fail (handlers/getMe.ts ... removeOwnMfaFactor.ts and service/self.service.ts do not exist).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../../../core/module.js';

const MOD = join(REPO_ROOT, 'services', 'api', 'src', 'modules', 'identity');
const OPS = ['getMe', 'changeOwnPassword', 'listOwnSessions', 'revokeOwnSession', 'listOwnMfaFactors', 'removeOwnMfaFactor'] as const;
const HANDLERS = OPS.map((o) => join(MOD, 'handlers', `${o}.ts`));
const SERVICE = join(MOD, 'service', 'self.service.ts'), REPO = join(MOD, 'repository', 'self.repo.ts');
const FILES = [...HANDLERS, SERVICE];
const src = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8') : '');
const all = () => FILES.map(src).join('\n') + '\n' + src(REPO);
const rel = (f: string) => f.slice(MOD.length + 1).replace(/\\/g, '/');

describe('files exist', () => { it.each(FILES.map((f) => [rel(f), f]))('%s', (_n, f) => { expect(existsSync(f as string), f as string).toBe(true); }); });

describe.each(FILES.map((f) => [rel(f), f]))('%s', (_n, f) => {
  const s = () => src(f as string);
  it('no console.*, no X-Forwarded-For / x-real-ip read, no network client, no hard-coded URL (AC-A6.3: no call leaves Nepal)', () => {
    if (!existsSync(f as string)) return expect(existsSync(f as string)).toBe(true);
    expect(s()).not.toMatch(/console\.(log|info|warn|error|debug)/); expect(s()).not.toMatch(/x-forwarded-for|x-real-ip|\bforwarded\b/i);
    expect(s()).not.toMatch(/\bfetch\s*\(|\bXMLHttpRequest\b|from ['"](node:)?https?['"]|from ['"](axios|got|undici|node-fetch)['"]/); expect(s()).not.toMatch(/https?:\/\/[a-z0-9.-]+/i);
  });
  it('no password / token / hash is interpolated into a log call or an Error message', () => {
    if (!existsSync(f as string)) return expect(existsSync(f as string)).toBe(true);
    expect(s()).not.toMatch(/(log|logger)\??\.(info|warn|error|debug)\([^)]*(password|Password|token|Token|hash)/);
    expect(s()).not.toMatch(/new (Lims)?Error\([^)]*\$\{[^}]*(password|Password|token|hash)/);
  });
});

describe('layering and tenancy', () => {
  it.each(HANDLERS.map((f) => [rel(f), f]))('%s: a thin handler - no SQL, no ctx.db / identityAuthTx / requestTx / withTenantScope (tenant context: the service works on ctx.tx)', (_n, f) => {
    if (!existsSync(f as string)) return expect(existsSync(f as string)).toBe(true); const s = src(f as string);
    expect(s).not.toMatch(/\b(SELECT\s.+\sFROM|INSERT\s+INTO|UPDATE\s+\w+[\w.]*\s+SET|DELETE\s+FROM)\b/i); expect(s).not.toMatch(/identityAuthTx|requestTx|withTenantScope|\.db\b/);
  });
  it('the service / repo never open another transaction or use identityAuthTx: own records go through the request tx under RLS (05-SCHEMA s5.2 __own / __own_user policies)', () => {
    expect(existsSync(SERVICE)).toBe(true); expect(src(SERVICE) + src(REPO)).not.toMatch(/identityAuthTx|bindTenant|withTenantScope|BEGIN\b|\.connect\(/);
  });
  it('every SQL statement touching identity.sessions / identity.mfa_factors names the caller (user_id) AND the tenant (tenant_id) explicitly (defence in depth next to RLS)', () => {
    const text = src(SERVICE) + '\n' + src(REPO); const stmts = [...text.matchAll(/(?:SELECT|UPDATE)\b[^`'"]*?\bidentity\.(?:sessions|mfa_factors)\b[^`'"]*/gis)].map((m) => m[0]);
    if (!existsSync(SERVICE)) return expect(existsSync(SERVICE)).toBe(true);
    expect(stmts.length).toBeGreaterThan(0); for (const q of stmts) { expect(q, q).toMatch(/\buser_id\s*=/i); expect(q, q).toMatch(/\btenant_id\s*=/i); }
  });
  it('the service never reads the tenant / user / current session from the INPUT: no input.tenantId / input.userId / input.membershipId', () => {
    expect(existsSync(SERVICE)).toBe(true); expect(src(SERVICE)).not.toMatch(/input\??\.(tenantId|userId|membershipId|actorId)\b/);
  });
  it('the handlers never take a tenant / user from the request: no bindTenant, no req.body|params|query|headers read of tenant_id / user_id / membership_id', () => {
    for (const f of HANDLERS) expect(existsSync(f), f).toBe(true);
    for (const f of HANDLERS) expect(src(f)).not.toMatch(/(body|params|query|headers)\??\.?\[?['"]?(tenant_id|user_id|membership_id|session_id_current)\b/);
  });
});

describe('P-42 / AU-T22 and the self-action guards, as code', () => {
  it('changeOwnPassword (service) calls ctx.commitOnError() and throws auth.login_failed (ordering and survival are proven behaviourally in self.service.test.ts)', () => {
    const s = src(SERVICE); expect(s).toMatch(/commitOnError\s*\(/); expect(s).toContain('auth.login_failed');
  });
  it('commitOnError() appears ONLY on the failed-current-password path: not in revokeOwnSession / removeOwnMfaFactor (their 409 / 404 paths must roll back)', () => {
    if (!existsSync(SERVICE)) return expect(existsSync(SERVICE)).toBe(true); expect((src(SERVICE).match(/commitOnError\s*\(/g) ?? []).length).toBe(1);
  });
  it('the guards use the spec codes verbatim: identity.self_action_forbidden, common.not_found, auth.login_failed, auth.password_policy_violation / auth.password_breached (via domain/password-policy)', () => {
    const s = all(); for (const code of ['identity.self_action_forbidden', 'common.not_found', 'auth.login_failed']) expect(s, code).toContain(code);
    expect(s).toMatch(/evaluatePassword|checkPasswordPolicy/); expect(s).toMatch(/password_change/); expect(s).toMatch(/self_revoke/);
  });
  it('sessions are revoked through the repo with reason password_change / self_revoke only (values of sessions__revoke_reason__ck), never an invented reason', () => {
    const reasons = [...all().matchAll(/reason:\s*'([a-z_]+)'/g)].map((m) => m[1]!); const allowed = new Set(['logout', 'admin_revoke', 'self_revoke', 'password_change', 'role_change', 'lock', 'deactivate', 'tenant_suspended', 'mfa_failed', 'mfa_reset', 'refresh_failed', 'superseded', 'token_reuse', 'self', 'admin_reset', 're_enrol']);
    expect(reasons.length).toBeGreaterThanOrEqual(2); for (const r of reasons) expect(allowed.has(r), r).toBe(true);
  });
});
