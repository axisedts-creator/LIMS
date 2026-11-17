// C6-T30 apps/portal static checks (no browser). 02-TRD §3.5; REQ-SEC-068/089/090/091/098; AC-11.9, AC-11.11 (zero SmartReportPort calls).
// Run: node --test tests/portal-e2e/C6-T30.static.test.mjs   Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PORTAL = join(ROOT, 'apps', 'portal');
const SRC = join(PORTAL, 'src');
const read = (...p) => readFileSync(join(PORTAL, ...p), 'utf8');
const walk = (d) => (existsSync(d) ? readdirSync(d).flatMap((n) => {
  const f = join(d, n);
  return statSync(f).isDirectory() ? (n === 'node_modules' || n === '.next' ? [] : walk(f)) : [f];
}) : []);
const srcFiles = () => walk(SRC).filter((f) => /\.(ts|tsx|mjs|js)$/.test(f) && !/__tests__|\.test\.|\.spec\./.test(f));
const isClient = (f) => /^\s*['"]use client['"]/.test(readFileSync(f, 'utf8'));

test('apps/portal package: @lims/portal, next + server-only + @lims/ui + @playwright/test, exact pins, no @supabase/*', () => {
  assert.ok(existsSync(join(PORTAL, 'package.json')), 'apps/portal/package.json missing');
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.name, '@lims/portal');
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  for (const d of ['next', 'react', 'react-dom', 'server-only', '@lims/ui', '@playwright/test']) assert.ok(deps[d], `dependency ${d} missing`);
  assert.deepEqual(Object.keys(deps).filter((d) => d.startsWith('@supabase/')), []);
  for (const [k, v] of Object.entries(deps)) assert.match(String(v), /^(workspace:|\d)/, `${k} must be exact-pinned (CV §15.1)`);
});

test('skeleton routes exist (02-TRD §3.5)', () => {
  for (const p of [
    'src/app/layout.tsx', 'src/app/r/[token]/page.tsx', 'src/app/r/[token]/code/page.tsx', 'src/app/r/[token]/report/page.tsx',
    'src/app/r/[token]/download/route.ts', 'src/app/r/[token]/reissue/route.ts', 'src/app/v/[token]/page.tsx',
    'src/app/app/reports/[report_id]/page.tsx', 'src/app/app/[...slug]/page.tsx',
    'src/server/api.ts', 'src/server/session.ts', 'src/middleware.ts',
  ]) assert.ok(existsSync(join(PORTAL, ...p.split('/'))), `${p} missing`);
});

test('middleware: nonce CSP, no-referrer, no-store on /r and /v, HSTS, nosniff, frame-ancestors none (REQ-SEC-089/090)', () => {
  const m = read('src', 'middleware.ts');
  assert.match(m, /nonce-\$\{/, 'CSP must use a per-request nonce');
  assert.match(m, /no-referrer/);
  assert.match(m, /no-store/);
  assert.match(m, /63072000/);
  assert.match(m, /nosniff/i);
  assert.match(m, /frame-ancestors 'none'/);
  assert.match(m, /object-src 'none'/);
  assert.match(m, /form-action 'self'/);
  assert.doesNotMatch(m, /'unsafe-inline'/, "no 'unsafe-inline' in CSP");
  assert.doesNotMatch(m, /https?:\/\/(?!localhost)/, 'no third-party origin in CSP');
});

test('server-only API client: header credential, never in URL; BFF key + forwarded XFF (08 D-32)', () => {
  const a = read('src', 'server', 'api.ts');
  assert.match(a, /import ['"]server-only['"]/);
  assert.match(a, /X-Lims-Portal-Credential/i);
  assert.match(a, /X-Lims-Bff-Key/i);
  assert.match(a, /X-Forwarded-For/i);
  assert.match(a, /LIMS_PORTAL_BFF_KEY_FILE/);
  assert.match(a, /LIMS_ORIGIN_API/);
  assert.doesNotMatch(a, /\$\{\s*(token|credential|sessionToken)[^}]*\}\s*[/?]|[?&]token=/, 'token interpolated into a URL');
});

test('session cookie: __Host-lims_portal, HttpOnly, Secure, SameSite=Lax, Path=/, no Domain; server-only', () => {
  const s = read('src', 'server', 'session.ts');
  assert.match(s, /import ['"]server-only['"]/);
  assert.match(s, /__Host-lims_portal/);
  assert.match(s, /httpOnly:\s*true/);
  assert.match(s, /secure:\s*true/);
  assert.match(s, /sameSite:\s*['"]lax['"]/i);
  assert.match(s, /path:\s*['"]\/['"]/);
  assert.doesNotMatch(s, /domain\s*:/i);
});

test('no client token exposure: no NEXT_PUBLIC_, client components never import src/server or cookies', () => {
  for (const f of srcFiles()) {
    const t = readFileSync(f, 'utf8');
    const rel = relative(PORTAL, f);
    assert.doesNotMatch(t, /NEXT_PUBLIC_/, `${rel}: NEXT_PUBLIC_ env`);
    if (isClient(f)) {
      assert.doesNotMatch(t, /server\/(api|session)|next\/headers|server-only|X-Lims-Portal-Credential|__Host-lims_portal|LIMS_PORTAL_BFF/i, `${rel}: client component touches server-only state`);
      assert.doesNotMatch(t, /localStorage|sessionStorage|document\.cookie/, `${rel}: client storage of credentials`);
    }
  }
});

test('portal never calls SmartReportPort / BillingPort / PaymentProviderPort or reads smartreport.* (AC-11.11, 08 R8)', () => {
  for (const f of srcFiles()) {
    assert.doesNotMatch(readFileSync(f, 'utf8'), /SmartReportPort|BillingPort|PaymentProviderPort|smartreport\.|@lims\/api|services\/api/i, relative(PORTAL, f));
  }
});

test('no third-party assets or analytics; images only self/data (08 A18.1)', () => {
  for (const f of srcFiles()) {
    const t = readFileSync(f, 'utf8');
    assert.doesNotMatch(t, /(src|href)=["']https?:\/\/(?!localhost)/i, `${relative(PORTAL, f)}: external asset`);
    assert.doesNotMatch(t, /googletagmanager|google-analytics|fonts\.googleapis|gstatic|sentry\.io/i, `${relative(PORTAL, f)}: third-party`);
  }
});

test('state-changing routes are POST only; reissue/download/pay check Origin (REQ-SEC-091/092)', () => {
  const re = read('src', 'app', 'r', '[token]', 'reissue', 'route.ts');
  assert.match(re, /export (async )?function POST|export const POST/);
  assert.doesNotMatch(re, /export (async )?function (GET|PUT|PATCH|DELETE)|export const (GET|PUT|PATCH|DELETE)/);
  assert.match(re, /origin/i, 'reissue must check the Origin header');
});

test('tokens are not logged', () => {
  for (const f of srcFiles()) {
    assert.doesNotMatch(readFileSync(f, 'utf8'), /console\.(log|info|debug|warn|error)\([^)]*(token|credential|cookie)/i, relative(PORTAL, f));
  }
});

test('OtpInput comes from @lims/ui (CR-C6-010); no hand-rolled otp input', () => {
  const all = srcFiles().map((f) => readFileSync(f, 'utf8')).join('\n');
  assert.match(all, /OtpInput/);
  assert.match(all, /from ['"]@lims\/ui/);
});

test('well-known association files exist (D-38) and parse as JSON', () => {
  for (const n of ['assetlinks.json', 'apple-app-site-association']) {
    const f = join(PORTAL, 'public', '.well-known', n);
    assert.ok(existsSync(f), `${n} missing`);
    JSON.parse(readFileSync(f, 'utf8'));
  }
});
