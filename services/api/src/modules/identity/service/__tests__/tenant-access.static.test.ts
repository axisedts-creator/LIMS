// T17 static guards on the eight handlers + service/tenant-access.service.ts (+ repository/tenant-access.repo.ts when the writer splits the SQL out).
// 02-TRD s5 / s9 (access-log table) / s10 (sign-out job), 03-APP-FLOW SP3/SP4/SP10, 07-SECURITY P-1 / P-3 / P-6 / threat 6, 02-CONVENTIONS P-42 (no commit-on-error path here).
// Expected now: fail (handlers/listSessions.ts ... dismissAdminNotice.ts and service/tenant-access.service.ts do not exist).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../../../core/module.js';

const MOD = join(REPO_ROOT, 'services', 'api', 'src', 'modules', 'identity');
const OPS = ['listSessions', 'revokeSession', 'listTenantSupportSessions', 'approveSupportSession', 'denySupportSession', 'revokeSupportSession', 'listAdminNotices', 'dismissAdminNotice'] as const;
const HANDLERS = OPS.map((o) => join(MOD, 'handlers', `${o}.ts`));
const SERVICE = join(MOD, 'service', 'tenant-access.service.ts'), REPO = join(MOD, 'repository', 'tenant-access.repo.ts');
const FILES = [...HANDLERS, SERVICE];
const src = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8') : '');
const all = () => FILES.map(src).join('\n') + '\n' + src(REPO);
const rel = (f: string) => f.slice(MOD.length + 1).replace(/\\/g, '/');

describe('files exist', () => { it.each(FILES.map((f) => [rel(f), f]))('%s', (_n, f) => { expect(existsSync(f as string), f as string).toBe(true); }); });

describe.each(FILES.map((f) => [rel(f), f]))('%s', (_n, f) => {
  const s = () => src(f as string);
  it('no console.*, no X-Forwarded-For / x-real-ip read, no network client, no hard-coded URL', () => {
    if (!existsSync(f as string)) return expect(existsSync(f as string)).toBe(true);
    expect(s()).not.toMatch(/console\.(log|info|warn|error|debug)/); expect(s()).not.toMatch(/x-forwarded-for|x-real-ip|\bforwarded\b/i);
    expect(s()).not.toMatch(/\bfetch\s*\(|\bXMLHttpRequest\b|from ['"](node:)?https?['"]|from ['"](axios|got|undici|node-fetch)['"]/); expect(s()).not.toMatch(/https?:\/\/[a-z0-9.-]+/i);
  });
  it('no token / reason text / note is interpolated into a log call or an Error message', () => {
    if (!existsSync(f as string)) return expect(existsSync(f as string)).toBe(true);
    expect(s()).not.toMatch(/(log|logger)\??\.(info|warn|error|debug)\([^)]*(reasonText|reason_text|decisionNote|token|Token|hash)/);
    expect(s()).not.toMatch(/new (Lims)?Error\([^)]*\$\{[^}]*(reasonText|reason|note|token|hash)/);
  });
});

describe('layering and tenancy', () => {
  it.each(HANDLERS.map((f) => [rel(f), f]))('%s: a thin handler - no SQL, no ctx.db / identityAuthTx / requestTx / withTenantScope (tenant context: the service works on ctx.tx)', (_n, f) => {
    if (!existsSync(f as string)) return expect(existsSync(f as string)).toBe(true); const s = src(f as string);
    expect(s).not.toMatch(/\b(SELECT\s.+\sFROM|INSERT\s+INTO|UPDATE\s+\w+[\w.]*\s+SET|DELETE\s+FROM)\b/i); expect(s).not.toMatch(/identityAuthTx|requestTx|withTenantScope|\.db\b/);
  });
  it('the service / repo run on the request tx under the tenant\'s claims: no identityAuthTx, bindTenant, withTenantScope (platform-only, D-214), BEGIN or own connection', () => {
    expect(existsSync(SERVICE)).toBe(true); expect(src(SERVICE) + src(REPO)).not.toMatch(/identityAuthTx|bindTenant|withTenantScope|BEGIN\b|\.connect\(/);
  });
  it('every back-ticked SQL statement on identity.support_sessions / identity.admin_notices names the tenant explicitly (tenant_id = ...), next to RLS (the session statements are covered behaviourally: P-1 / P-3)', () => {
    if (!existsSync(SERVICE)) return expect(existsSync(SERVICE)).toBe(true);
    const text = src(SERVICE) + '\n' + src(REPO); const stmts = text.split('`').filter((_c, i) => i % 2 === 1).filter((c) => /\bidentity\.(?:support_sessions|admin_notices)\b/i.test(c) && /\b(SELECT|UPDATE|INSERT|DELETE)\b/i.test(c));
    expect(stmts.length).toBeGreaterThan(0); for (const q of stmts) expect(q, q).toMatch(/\btenant_id\s*=/i);
  });
  it('the service never reads tenant / caller / current session from the INPUT: no input.tenantId / userId / membershipId / actorId', () => {
    expect(existsSync(SERVICE)).toBe(true); expect(src(SERVICE)).not.toMatch(/input\??\.(tenantId|userId|membershipId|actorId)\b/);
  });
  it('the handlers never take a tenant / user from the request: no req.body|params|query|headers read of tenant_id / user_id / membership_id', () => {
    for (const f of HANDLERS) expect(existsSync(f), f).toBe(true);
    for (const f of HANDLERS) expect(src(f)).not.toMatch(/(body|params|query|headers)\??\.?\[?['"]?(tenant_id|user_id|membership_id|actor_id)\b/);
  });
  it('no commit-on-error path: nothing here survives a failed request (P-42 is for failed credentials only)', () => {
    expect(existsSync(SERVICE)).toBe(true); expect(all()).not.toMatch(/commitOnError/);
  });
});

describe('spec names used verbatim', () => {
  it('error codes: identity.self_action_forbidden, common.not_found, common.version_conflict, common.precondition_required, common.validation_failed, auth.forbidden', () => {
    const s = all(); for (const code of ['identity.self_action_forbidden', 'common.not_found', 'common.version_conflict', 'common.precondition_required', 'common.validation_failed', 'auth.forbidden']) expect(s, code).toContain(code);
  });
  it('access-log actions (02-TRD s9): session.revoke (entity session), support_session.approve / .deny / .revoke (entity support_session)', () => {
    const s = all(); for (const a of ['session.revoke', 'support_session.approve', 'support_session.deny', 'support_session.revoke']) expect(s, a).toContain(a);
    expect(s).toMatch(/entityType:\s*'session'/); expect(s).toMatch(/entityType:\s*'support_session'/);
  });
  it('the sign-out job and revoke reason: identity.gotrue_signout, admin_revoke, event session_revoked (values of sessions__revoke_reason__ck / auth_events)', () => {
    const s = all(); for (const t of ['identity.gotrue_signout', 'admin_revoke', 'session_revoked', 'revoked_by_tenant']) expect(s, t).toContain(t);
  });
  it('support end_reason / status values come from the DDL CHECK sets only', () => {
    const reasons = [...all().matchAll(/(?:endReason|end_reason)\s*[:=]\s*'([a-z_]+)'/g)].map((m) => m[1]!); const allowed = new Set(['ended_by_staff', 'expired', 'revoked_by_tenant', 'superseded', 'platform_logout', 'denied']);
    for (const r of reasons) expect(allowed.has(r), r).toBe(true);
    const statuses = [...all().matchAll(/status:\s*'([a-z_]+)'/g)].map((m) => m[1]!); const ok = new Set(['requested', 'approved', 'denied', 'active', 'ended', 'expired', 'revoked']);
    for (const st of statuses) expect(ok.has(st), st).toBe(true);
  });
});

describe('handler glue', () => {
  it('handlers/index.ts wires all eight operations to their handler files (no stub left)', () => {
    const idx = src(join(MOD, 'handlers', 'index.ts'));
    for (const op of OPS) expect(idx, op).toMatch(new RegExp(`from '\\./${op}\\.js'`));
  });
});
