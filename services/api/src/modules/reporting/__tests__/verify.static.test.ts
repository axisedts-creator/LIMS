// C6-T22 static/structural checks (06-PLAN row C6-T22 files: modules/reporting/handlers, service/verify.service.ts; 07-SECURITY REQ-SEC-018, 9, 14; 02-TRD §3.2).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
vi.setConfig({ testTimeout: 30_000 });
import { REPO_ROOT } from '../../../core/module.js';

const API = join(REPO_ROOT, 'services', 'api', 'src', 'modules', 'reporting');
const F = { service: join(API, 'service', 'verify.service.ts'), handlers: join(API, 'handlers', 'verify.handlers.ts') };
const src = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
const code = (p: string) => src(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const OPS = ['verifyReportQr', 'revokeReportQrToken', 'listPortalLinks', 'revokePortalLink'];

describe('owned files exist and are wired', () => {
  for (const [k, p] of Object.entries(F)) it(`${k}: ${p.slice(REPO_ROOT.length + 1).replaceAll('\\', '/')}`, () => { expect(existsSync(p)).toBe(true); });
  it('index.ts wires the verify handlers into the manifest', () => { expect(src(join(API, 'index.ts'))).toMatch(/verify\.handlers|verifyHandlers/); });
  it('Q1, R14, R15, R16 are real handlers, not the 501 stub', async () => {
    const { manifest } = await import('../index.js');
    for (const op of OPS) { expect(typeof manifest.handlers[op]).toBe('function'); const r = await manifest.handlers[op]!({ params: {}, query: {}, headers: {}, body: {} } as any, { operationId: op } as any).catch((e: any) => e); expect(r?.status, op).not.toBe(501); }
  });
});

describe('source hygiene', () => {
  const files = Object.values(F);
  it('no console / network / eval / Math.random / raw HTTP clients', () => {
    for (const p of files) expect(src(p).length, p).toBeGreaterThan(0);
    for (const p of files) expect(code(p), p).not.toMatch(/console\.|\bfetch\(|node:https?|\beval\(|new Function\(|Math\.random\(/);
  });
  it('service and handlers contain no inline SQL (single access path = repository/, same rule as repository.static)', () => {
    for (const p of files) expect(src(p).length, p).toBeGreaterThan(0);
    for (const p of files) expect(code(p), p).not.toMatch(/\b(select\s[\s\S]{0,200}\sfrom|insert\s+into|update\s+\w+[\s\S]{0,80}\sset|delete\s+from)\b[\s\S]{0,200}\b(reporting|app)\./i);
  });
  it('the public lookup goes through the DEFINER only: app.reporting_verify_qr( appears in repository/, and no repository statement reads qr_tokens with a token predicate outside it', () => {
    const repo = readdirSync(join(API, 'repository')).filter((f) => f.endsWith('.ts')).map((f) => src(join(API, 'repository', f))).join('\n');
    expect(repo).toMatch(/app\.reporting_verify_qr\s*\(\s*\$1\s*\)/i);
    expect(repo).not.toMatch(/reporting\.qr_tokens[^`'"]*\btoken_sha256\s*=/i);          // no direct token_sha256 lookup under the app role (RLS lookup policy is the DEFINER's)
  });
  it('the handler/service hash with the shared token helper (domain/tokens.hashToken), never roll their own crypto, and never log the token', () => {
    const c = code(F.service) + code(F.handlers);
    expect(c).toMatch(/hashToken|domain\/tokens/); expect(c).not.toMatch(/createHash\(|from 'node:crypto'/);
    expect(c).not.toMatch(/log\.(info|warn|error)\([^)]*(token|qr_token|body)/i);
  });
  it('Q1 consumes the qr_verify tier keyed on the client IP (ctx.clientIp), and checks the 22-char base64url shape itself', () => {
    const c = code(F.service) + code(F.handlers);
    expect(c).toMatch(/qr_verify/); expect(c).toMatch(/['"`]i:/); expect(c).toMatch(/clientIp/); expect(c).toMatch(/\{22\}/);
  });
  it('the error for every failure is the single code reporting.verify_not_found (no other reporting.* verify error exists in the sources)', () => {
    const c = code(F.service) + code(F.handlers); expect(c).toMatch(/reporting\.verify_not_found/);
    expect([...c.matchAll(/LimsError\(\s*'(reporting\.[a-z_]+)'/g)].map((m) => m[1]).filter((x) => x !== 'reporting.verify_not_found')).toEqual([]);
  });
  it('R14/R16 write the access log with action report.token_revoke and entity types qr_token / portal_link', () => {
    const c = code(F.service) + code(F.handlers); expect(c).toMatch(/report\.token_revoke/); expect(c).toMatch(/qr_token/); expect(c).toMatch(/portal_link/);
  });
  it('reason codes are validated against the token_revoke_reasons coded set (reuse listCodes), not a hard-coded list', () => {
    const c = code(F.service); expect(c).toMatch(/token_revoke_reasons/); expect(c).toMatch(/listCodes/);
  });
});
