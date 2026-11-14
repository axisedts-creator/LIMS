// C2-T28 log PHI scan (02-TRD §13 "Never logged"; 07-SECURITY §5.1/§5.7; DoD §3.7). Planted synthetic e-mail / password / token / JWT / MFA code / otpauth.
//   A. real shared logger (what ctx.log is in production): planted values in denylisted keys and in free text never reach the output line (guards the C0 seam C2 relies on).
//   B. EVERY identity handler (manifest.handlers) run with the planted values in body, query, params and headers (authorization, cookie), ctx.log = the real logger on a capture stream,
//      console / stdout / stderr captured: nothing logged, and no thrown error (message, detail, errors, stack head) or response header, contains a planted value.
//      Handlers that refuse early (validation, auth, unwired ctx) pass vacuously; the sweep is meaningful for every handler that reaches a log call.
//   C. static: no identity log call names a forbidden field (email, phone, password, totp/code, token, otpauth, secret, qr, jwt) in its arguments.
// Run: pnpm --dir services/api exec vitest run src/modules/identity/__tests__/logscan.test.ts
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
// [CONV] same relative import as core/observability/logging.ts until @lims/shared-ts is a services/api dependency.
import { createLogger } from '../../../../../../packages/shared-ts/src/logger/index.js';
import { manifest } from '../index.js';

const EMAIL = 'planted.user.0042@example.test';
const PASSWORD = 'Pl4nted-Passw0rd!xyz';
const TOKEN = 'tok_PLANTED_9f3a7c1e5b2d';
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwbGFudGVkLXVzZXIifQ.cGxhbnRlZC1zaWduYXR1cmUtMDA0Mg';
const CODE = '482913';
const OTPAUTH = 'otpauth://totp/LIMS:planted?secret=JBSWY3DPEHPK3PXP';
const PLANTED = [EMAIL, PASSWORD, TOKEN, JWT, CODE, 'JBSWY3DPEHPK3PXP'];

const stream = () => { const lines: string[] = []; return { lines, write: (l: string) => { lines.push(l); } }; };
const mkLogger = (s: { write(l: string): void }) => createLogger({ service: 'api', env: 'dev', version: '0.0.0', level: 'debug', destination: s });
/** pino-style (fields, msg) as Fastify's request.log / ctx.log (same adapter as core/observability/logging.ts). */
function pinoStyle(l: ReturnType<typeof createLogger>): any {
  const at = (fn: (m: string, f?: Record<string, unknown>) => void) => (a?: unknown, b?: unknown) => (typeof a === 'string' ? fn(a) : fn(typeof b === 'string' ? b : '', (a instanceof Error ? { err: a } : a) as Record<string, unknown>));
  return { info: at(l.info), warn: at(l.warn), error: at(l.error), debug: at(l.debug), trace: at(l.debug), fatal: at(l.error), child: (b: object) => pinoStyle(l.child(b as never)) };
}

describe('A. the shared logger never emits planted secrets (denylisted keys + free text)', () => {
  it('keys email / password / token / session_token / refresh_token / token_hash / otpauth / secret / authorization / cookie / phone are redacted', () => {
    const s = stream(); const log = mkLogger(s);
    log.info('login', { email: EMAIL, password: PASSWORD, new_password: PASSWORD, token: TOKEN, session_token: TOKEN, refresh_token: TOKEN, token_hash: TOKEN, otpauth_uri: OTPAUTH, totp_secret: 'JBSWY3DPEHPK3PXP', authorization: `Bearer ${JWT}`, cookie: `sid=${TOKEN}`, phone: '9800000042', operation_id: 'loginStaff' });
    const out = s.lines.join('\n');
    for (const p of [EMAIL, PASSWORD, TOKEN, JWT, 'JBSWY3DPEHPK3PXP']) expect(out, p).not.toContain(p);
    expect(out).toContain('loginStaff');   // the allowed fields survive (the scan is not just dropping everything)
  });
  it('a JWT and a keyword-labelled token / password in free text and in an Error message are scrubbed', () => {
    const s = stream(); const log = mkLogger(s);
    log.warn(`bad token ${TOKEN} with jwt ${JWT} and password=${PASSWORD}`, { err: new Error(`gotrue said Bearer ${JWT} for password ${PASSWORD}`) });
    const out = s.lines.join('\n');
    for (const p of [JWT, PASSWORD]) expect(out, p).not.toContain(p);
  });
});

// ---- B. every handler ----
function walkValues(v: unknown, f: (s: string) => void): void { if (typeof v === 'string') f(v); else if (Array.isArray(v)) v.forEach((x) => walkValues(x, f)); else if (v && typeof v === 'object') Object.values(v).forEach((x) => walkValues(x, f)); }
const safeJson = (v: unknown) => { try { return JSON.stringify(v, (_k, x) => (x instanceof Error ? { n: x.name, m: x.message } : typeof x === 'bigint' ? String(x) : x)) ?? ''; } catch { return String(v); } };

const BODY = {
  email: EMAIL, login: EMAIL, username: EMAIL, invite_email: EMAIL, password: PASSWORD, current_password: PASSWORD, new_password: PASSWORD, confirm_password: PASSWORD,
  token: TOKEN, refresh_token: TOKEN, session_token: TOKEN, access_token: JWT, token_hash: TOKEN, code: CODE, otp: CODE, totp_code: CODE, otpauth_uri: OTPAUTH, secret: 'JBSWY3DPEHPK3PXP',
  display_name: 'Planted Name', reason: `reason ${EMAIL}`, note: `note ${TOKEN}`,
};
const REQ = () => ({
  params: { id: '0190a000-0000-7000-8000-0000000000f1', token: TOKEN },
  query: { email: EMAIL, token: TOKEN, code: CODE, q: EMAIL },
  headers: { authorization: `Bearer ${JWT}`, cookie: `session=${TOKEN}`, 'x-forwarded-for': '203.0.113.9', 'user-agent': 'planted-agent' },
  body: BODY,
});

let restore: (() => void) | undefined;
afterEach(() => { restore?.(); restore = undefined; });
function captureAll(): { lines: string[] } {
  const lines: string[] = [];
  const keep: Array<[any, string, any]> = [];
  for (const k of ['log', 'info', 'warn', 'error', 'debug'] as const) { const o = (console as any)[k]; keep.push([console, k, o]); (console as any)[k] = (...a: unknown[]) => { lines.push(a.map((x) => (typeof x === 'string' ? x : safeJson(x))).join(' ')); }; }
  const so = process.stdout.write.bind(process.stdout); const se = process.stderr.write.bind(process.stderr);
  (process.stdout as any).write = (c: unknown, ...r: unknown[]) => { lines.push(String(c)); return typeof r[r.length - 1] === 'function' ? (r[r.length - 1] as any)() : true; };
  (process.stderr as any).write = (c: unknown, ...r: unknown[]) => { lines.push(String(c)); return typeof r[r.length - 1] === 'function' ? (r[r.length - 1] as any)() : true; };
  restore = () => { for (const [t, k, o] of keep) t[k] = o; (process.stdout as any).write = so; (process.stderr as any).write = se; };
  return { lines };
}

/** Permissive ctx: every unknown member is a callable that resolves to a nested permissive value, so handlers reach as far as they can. log = real logger. */
function permissive(log: any): any {
  const mk = (): any => new Proxy(function () { /* callable */ } as any, {
    get: (_t, p) => (p === 'then' ? undefined : p === Symbol.toPrimitive ? () => '' : mk()),
    apply: () => Promise.resolve(mk()),
  });
  const base: any = { tenantId: '0190a000-0000-7000-8000-0000000000a1', requestId: '0190a000-0000-7000-8000-0000000000e1', actor: { type: 'staff', id: '0190a000-0000-7000-8000-000000000011' }, log, commitOnError: () => undefined, now: () => '2026-11-13T04:00:00.000Z' };
  return new Proxy(base, { get: (t, p) => (p in t ? t[p] : mk()) });
}

const OPS = Object.keys(manifest.handlers).sort();

describe('B. planted e-mail / password / token / MFA code through every identity handler', () => {
  it('the handler map is non-empty (sweep is not vacuous on the set)', () => { expect(OPS.length).toBeGreaterThan(50); });

  it.each(OPS)('%s logs and throws no planted value', async (op) => {
    const s = stream(); const cap = captureAll();
    const ctx = permissive(pinoStyle(mkLogger(s)));
    let surfaced = ''; let thrown = false;
    try {
      const r: any = await Promise.race([Promise.resolve(manifest.handlers[op]!(REQ() as never, ctx)), new Promise((ok) => setTimeout(() => ok({ timeout: true }), 4000))]);
      surfaced = safeJson({ headers: r?.headers, body: r?.body, status: r?.status });
    } catch (e: any) {
      thrown = true;
      surfaced = safeJson({ m: e?.message, d: e?.detail, e: e?.errors, s: String(e?.stack ?? '').split('\n')[0], code: e?.code });
    }
    restore?.(); restore = undefined;
    const logged = [...s.lines, ...cap.lines].join('\n');
    for (const p of PLANTED) {
      expect(logged, `${op}: log output contains planted "${p}"`).not.toContain(p);
      // a success response may legitimately echo an e-mail (inviteUser returns the invitee); it must never echo a secret
      if (p !== EMAIL) expect(surfaced, `${op}: error/response contains planted "${p}"`).not.toContain(p);
    }
    if (thrown) expect(surfaced, `${op}: thrown error carries the e-mail`).not.toContain(EMAIL);   // 07-SEC §5.7 (REQ-SEC-095): error detail never carries an e-mail
  });
});

describe('B. the sweep is not vacuous (self-check)', () => {
  it('the capture sees console + ctx.log writes, and the real logger scrubs them', () => {
    const s = stream(); const cap = captureAll();
    console.log('canary-one'); const ctx = permissive(pinoStyle(mkLogger(s))); ctx.log.info({ email: EMAIL, event: 'canary-two' }, 'canary-three');
    restore?.(); restore = undefined;
    expect(cap.lines.join('|')).toContain('canary-one');
    expect(s.lines.join('|')).toMatch(/canary-two.*canary-three|canary-three.*canary-two/);
    expect(s.lines.join('|')).not.toContain(EMAIL);
  });
  it('the planted request really carries every planted value', () => {
    const j = safeJson(REQ());
    for (const p of [EMAIL, PASSWORD, TOKEN, JWT, CODE, 'JBSWY3DPEHPK3PXP']) expect(j).toContain(p);
  });
});

// ---- C. static ----
const ROOT = fileURLToPath(new URL('../../../../../../', import.meta.url));
const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
const SRC = [...walk(join(ROOT, 'services/api/src/modules/identity')), ...walk(join(ROOT, 'services/worker/src/jobs/identity'))]
  .map((p) => p.replace(/\\/g, '/')).filter((p) => /\.ts$/.test(p) && !/(__tests__|\.test\.|\.helpers\.|\.fake\.)/.test(p));
const FORBIDDEN = /\b(email|e_mail|phone|mobile|password|passwd|totp|totp_code|otp|otpauth\w*|secret|jwt|token|token_hash|session_token|refresh_token|qr|qr_svg|access_token)\b/i;

describe('C. no identity log call names a forbidden field (02-TRD §13 "Never logged")', () => {
  it('there are identity log calls to scan (guards the regex)', () => {
    const n = SRC.reduce((a, f) => a + (readFileSync(f, 'utf8').match(/\blog\??\.(?:info|warn|error|debug)\??\.?\(/g) ?? []).length, 0);
    expect(n).toBeGreaterThan(5);
  });
  it('no log / ctx.log call argument list contains a forbidden word', () => {
    const bad: string[] = [];
    for (const f of SRC) {
      const t = readFileSync(f, 'utf8');
      for (const m of t.matchAll(/\blog\??\.(?:info|warn|error|debug)\??\.?\(([^;]*?)\)\s*(?:;|\)\s*;|,\s*$|$)/gm)) {
        const args = m[1]!.replace(/\berror_code\b/g, '');
        const hit = args.match(FORBIDDEN);
        if (hit) bad.push(`${f.replace(ROOT.replace(/\\/g, '/'), '')}: ${hit[0]} in ${m[0].slice(0, 120)}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
