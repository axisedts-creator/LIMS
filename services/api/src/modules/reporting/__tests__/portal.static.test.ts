// C6-T20 static/structural checks (07-SECURITY 4, 8, 8f, 8g, 9, 14; 02-TRD §3.2 file layout, §6.6; CR-C6-001/002).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
vi.setConfig({ testTimeout: 30_000 });   // first import of the module manifest parses the OpenAPI spec
import { REPO_ROOT } from '../../../core/module.js';

const API = join(REPO_ROOT, 'services', 'api', 'src', 'modules', 'reporting');
const FILES = { resolver: join(API, 'auth', 'portal.resolver.ts'), service: join(API, 'service', 'portal.service.ts'), task: join(REPO_ROOT, 'services', 'worker', 'src', 'jobs', 'reporting', 'tasks', 'send_portal_otp.ts') };
const src = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
const code = (p: string) => src(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const HANDLERS = ['createPortalOtpChallenge', 'verifyPortalOtp', 'getPortalReport', 'downloadPortalReportPdf', 'requestPortalLinkReissue', 'endPortalSession'];

describe('owned files exist', () => {
  for (const [k, p] of Object.entries(FILES)) it(`${k}: ${p.slice(REPO_ROOT.length + 1).replaceAll('\\', '/')}`, () => { expect(existsSync(p)).toBe(true); });
  it('a portal handlers file exists under handlers/ and is wired into the manifest', () => {
    const idx = src(join(API, 'index.ts')); expect(idx).toMatch(/portal\.handlers|portalHandlers/); expect(existsSync(join(API, 'handlers', 'portal.handlers.ts'))).toBe(true);
  });
});

describe('manifest', () => {
  it('P1-P6 are implemented (not the 501 stub) and portalSession is the real resolver, not the fail-closed stub', async () => {
    const { manifest } = await import('../index.js');
    for (const op of HANDLERS) { expect(typeof manifest.handlers[op]).toBe('function'); const r = await manifest.handlers[op]!({ params: {}, query: {}, headers: {}, body: {} } as any, { operationId: op } as any).catch((e: any) => e); expect(r?.status, op).not.toBe(501); }
    expect(String((manifest.authResolvers as any).portalSession.resolve)).not.toMatch(/ok:\s*false/);
  });
});

describe('source hygiene', () => {
  const all = Object.values(FILES).concat(join(API, 'handlers', 'portal.handlers.ts'));
  it('no console / network / eval / Math.random / raw HTTP clients', () => {
    for (const p of all) { const c = code(p); expect(c, p).not.toMatch(/console\.|\bfetch\(|node:https?|\beval\(|new Function\(|Math\.random\(/); }
  });
  it('no core.* or foreign-module SQL; only reporting.* tables and the two app.* functions', () => {
    for (const p of all) for (const m of code(p).matchAll(/\b(?:from|into|update|join)\s+([a-z_]+)\.([a-z_]+)/gi)) expect(['reporting', 'app'], `${p}: ${m[0]}`).toContain(m[1]!.toLowerCase());
  });
  it('portal code never references BillingPort / PaymentProviderPort / SmartReportPort (08 R8 rule 3, A2.3)', () => {
    for (const p of [FILES.resolver, FILES.service, join(API, 'handlers', 'portal.handlers.ts')]) expect(code(p), p).not.toMatch(/BillingPort|PaymentProviderPort|SmartReportPort|BillingCommandPort/);
  });
  it('SQL is parameterised: no template-literal interpolation inside tx.query strings', () => {
    for (const p of all) for (const m of code(p).matchAll(/\.query\(\s*`([^`]*)`/g)) expect(m[1], p).not.toMatch(/\$\{/);
  });
  it('tokens/OTP only through the shared helpers: domain/tokens + domain/otp (CSPRNG, constant-time compare), no ad-hoc createHash of secrets in handlers', () => {
    expect(code(FILES.resolver)).toMatch(/hashToken|tokens\.js/); expect(code(FILES.service)).toMatch(/issueToken/); expect(code(FILES.service)).toMatch(/verifyOtp|otp\.js/);
    expect(code(FILES.task)).toMatch(/generateOtp|otpHmac/);
    for (const p of all) expect(code(p), p).not.toMatch(/randomBytes|randomInt|===\s*[a-z.]*code_hmac|code_hmac\s*===|\.equals\(\s*[a-z.]*hmac/i);
  });
  it('the DEFINER is called by its exact name with a bytea hash (CR-C6-002) and the resolver does not log credentials', () => {
    expect(code(FILES.resolver)).toMatch(/app\.reporting_resolve_portal_credential\(\$1,\s*\$2\)/); expect(code(FILES.resolver)).not.toMatch(/log\w*\.\w+\([^)]*(credential|token)/i);
  });
  it('error codes and names are copied from the spec', () => {
    const c = all.map(code).join('\n');
    for (const n of ['reporting.link_invalid', 'reporting.otp_required', 'auth.otp_invalid', 'auth.otp_attempts_exhausted', 'common.rate_limited', 'report.portal_download', 'reporting.send_portal_otp', 'reporting.reissue_portal_link', 'reporting.portal_otp']) expect(c, n).toContain(n);
  });
  it('tenant tables are always filtered by tenant_id in portal.service / task SQL', () => {
    for (const p of [FILES.service, FILES.task]) for (const m of code(p).matchAll(/\.query\(\s*`([^`]*)`/g)) if (/\breporting\.(portal_links|otp_challenges|portal_sessions|reports|report_versions|qr_tokens|settings)\b/i.test(m[1]!)) expect(m[1], p).toMatch(/tenant_id\s*=\s*\$\d/);
  });
});
