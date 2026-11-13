// C2-T29 security pack, static half (07-SECURITY §6, grep-style items; no DB, no network). Synthetic data only.
//   AU-T2c  C2 code contains no read of X-Forwarded-For (the per-IP key is ctx.clientIp).
//   AU-T9   the staff web bundle sources import no @supabase/* and hold no access_token string sink.
//   AU-T8   the staff session cookie is __Host- prefixed, HttpOnly, Secure, SameSite=Lax, Path=/, with no Domain.
//   AU-T18  the identity code never writes core.memberships.is_active (generated column).
//   D-T4    no module-local spreadsheet formula guard; CSV cells go through @lims/shared-ts/spreadsheet neutraliseFormula.
//   D-T12   no SQL naming core.dead_letters in identity code (single write path via ctx.core.deadLetters).
//   D-T19   no identity test disables RLS; no identity code uses BYPASSRLS, SET ROLE or ALTER ... DISABLE ROW LEVEL SECURITY.
//   §7      no secret literal (service key, token enc key, e-mail HMAC key) in identity code or in apps/web sources.
// Run: pnpm --dir services/api exec vitest run src/modules/identity/__tests__/security
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../../../../../', import.meta.url));
function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    if (n === 'node_modules' || n === '.next' || n === 'dist') continue;
    const p = join(dir, n); const s = statSync(p);
    if (s.isDirectory()) walk(p, out); else if (/\.(ts|tsx|sql|mjs|js)$/.test(n)) out.push(p);
  }
  return out;
}
const isTest = (p: string) => /(__tests__|\.test\.|\.spec\.|[/\\]tests[/\\])/.test(p);
const rel = (p: string) => relative(ROOT, p).split(sep).join('/');
const read = (p: string) => readFileSync(p, 'utf8');
/** source with comments removed, so prose that names a forbidden thing does not trip the scan */
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

const API_ID = walk(join(ROOT, 'services/api/src/modules/identity')).filter((p) => !isTest(p));
const WORKER_ID = walk(join(ROOT, 'services/worker/src/jobs/identity')).filter((p) => !isTest(p));
const ID_SRC = [...API_ID, ...WORKER_ID];
const WEB = walk(join(ROOT, 'apps/web/src')).filter((p) => !isTest(p));
const hits = (files: string[], re: RegExp) => files.filter((f) => re.test(code(f))).map(rel);

describe('the scan sees the code it claims to (self-check)', () => {
  it('finds identity api + worker + web sources', () => { expect(API_ID.length).toBeGreaterThan(80); expect(WORKER_ID.length).toBeGreaterThan(5); expect(WEB.length).toBeGreaterThan(100); });
  it('comment stripping keeps code and drops prose', () => {
    const src = '/* x-forwarded-for */ const a = 1; // x-forwarded-for\nconst h = req.headers["x-forwarded-for"];';
    const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
    expect(stripped.match(/x-forwarded-for/gi)).toHaveLength(1);
  });
});

describe('AU-T2c no X-Forwarded-For read in C2 code', () => {
  it('identity api + worker sources never name the header', () => { expect(hits(ID_SRC, /x-forwarded-for|x_forwarded_for|xForwardedFor/i)).toEqual([]); });
  it('...nor read a client address from a header or the socket (only ctx.clientIp)', () => {
    expect(hits(API_ID, /headers\s*(\[\s*['"`](x-real-ip|forwarded|true-client-ip|cf-connecting-ip)|\.\s*(forwarded))|req(uest)?\.(ip|socket\.remoteAddress)\b/i)).toEqual([]);
  });
});

describe('AU-T9 staff web bundle', () => {
  it('imports nothing from @supabase/*', () => { expect(hits(WEB, /from\s+['"]@supabase\/|require\(\s*['"]@supabase\/|import\(\s*['"]@supabase\//)).toEqual([]); });
  it('has no access_token / refresh_token string sink in client code (server actions and BFF store are the only holders)', () => {
    const client = WEB.filter((f) => /^['"]use client['"]/m.test(read(f)));
    expect(client.length).toBeGreaterThan(5);
    expect(hits(client, /access_token|refresh_token|accessToken|refreshToken/)).toEqual([]);
  });
  it('no web source stores a token in localStorage / sessionStorage', () => { expect(hits(WEB, /(localStorage|sessionStorage)\s*\.\s*setItem\([^)]*(token|jwt|session)/i)).toEqual([]); });
});

describe('AU-T8 session cookie attributes (staff BFF)', () => {
  const cookie = read(join(ROOT, 'apps/web/src/core/session/cookie.ts'));
  it('__Host- prefix, HttpOnly, Secure, SameSite=Lax, Path=/ and no Domain', () => {
    expect(cookie).toMatch(/__Host-/);
    expect(cookie).toMatch(/httpOnly\s*:\s*true|HttpOnly/);
    expect(cookie).toMatch(/secure\s*:\s*true|;\s*Secure/);
    expect(cookie).toMatch(/sameSite\s*:\s*['"]lax['"]|SameSite=Lax/i);
    expect(cookie).toMatch(/path\s*:\s*['"]\/['"]|Path=\//);
    expect(code(join(ROOT, 'apps/web/src/core/session/cookie.ts'))).not.toMatch(/\bdomain\s*:|;\s*Domain=/i);
  });
});

describe('AU-T18 / D-T4 / D-T12 single-path rules', () => {
  it('no identity SQL writes core.memberships.is_active', () => {
    // statement shapes naming core.memberships; other tables' is_active (roles, centres, factors, staff) are legitimate.
    expect(hits(API_ID, /(UPDATE\s+core\.memberships\b[^;`]*\bis_active\s*=|INSERT\s+INTO\s+core\.memberships\s*\([^)]*\bis_active\b)/i)).toEqual([]);
  });
  it('no module-local spreadsheet formula guard exists', () => {
    expect(hits(ID_SRC, /function\s+(neutrali[sz]e\w*|escapeFormula\w*|csvInjection\w*|sanitiseCell\w*|sanitizeCell\w*)|const\s+(neutrali[sz]e\w*|escapeFormula\w*)\s*=/)).toEqual([]);
  });
  it('the audit export writer uses neutraliseFormula from @lims/shared-ts/spreadsheet', () => {
    const w = ID_SRC.filter((f) => /export/i.test(f) && /build_audit_export|exports?\.(repo|service)|audit-export/i.test(f));
    expect(w.length).toBeGreaterThan(0);
    expect(w.some((f) => /neutraliseFormula/.test(code(f)))).toBe(true);
  });
  it('no identity SQL names core.dead_letters', () => { expect(hits(ID_SRC, /core\.dead_letters/)).toEqual([]); });
  it('C2 SQL files contain no GRANT on core.dead_letters', () => {
    const sql = walk(join(ROOT, 'db')).filter((p) => /identity/i.test(rel(p)) && p.endsWith('.sql') && !isTest(p));
    expect(sql.length, 'C2 SQL files found').toBeGreaterThan(0);
    expect(sql.filter((f) => /GRANT[^;]*core\.dead_letters/i.test(read(f))).map(rel)).toEqual([]);
  });
});

describe('D-T19 / §7 RLS and secrets', () => {
  it('identity code never uses BYPASSRLS, SET ROLE, SET SESSION AUTHORIZATION or DISABLE ROW LEVEL SECURITY', () => {
    expect(hits(ID_SRC, /BYPASSRLS|SET\s+(LOCAL\s+)?ROLE\b|SESSION\s+AUTHORIZATION|DISABLE\s+ROW\s+LEVEL\s+SECURITY|NO\s+FORCE\s+ROW\s+LEVEL/i)).toEqual([]);
  });
  it('no identity test disables RLS or stands in an RLS-less table', () => {
    const tests = [...walk(join(ROOT, 'services/api/src/modules/identity')), ...walk(join(ROOT, 'services/worker/src/jobs/identity')), ...walk(join(ROOT, 'db/tests/identity'))]
      .filter((p) => isTest(p) && !/__tests__[/\\]security[/\\]/.test(p));
    // statement shapes only: a test that ASSERTS the absence of the words (sessions.repo.test.ts) is fine.
    expect(tests.filter((f) => /ALTER\s+TABLE[^;`'"]*(DISABLE|NO\s+FORCE)\s+ROW\s+LEVEL|(CREATE|ALTER)\s+ROLE[^;`'"]*\bBYPASSRLS|SET\s+(LOCAL\s+)?row_security\s*(=|TO)\s*off/i.test(read(f))).map(rel)).toEqual([]);
  });
  it('no secret value is committed: service key / token enc keys / e-mail HMAC key are only ever read from env', () => {
    const assign = /LIMS_IDENTITY_(GOTRUE_SERVICE_KEY|TOKEN_ENC_KEYS|EMAIL_HMAC_KEY)\s*[:=]\s*['"`][^'"`\s$]{8,}['"`]/;
    expect(hits([...ID_SRC, ...WEB], assign)).toEqual([]);
    expect(hits(ID_SRC, /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\./)).toEqual([]);   // no hard-coded JWT
  });
  it('the web app never reads the GoTrue service key', () => { expect(hits(WEB, /LIMS_IDENTITY_GOTRUE_SERVICE_KEY|GOTRUE_SERVICE_KEY/)).toEqual([]); });
});
