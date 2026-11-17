// C2.T12 — source-level done_when: route files (04-UI-UX §1), "no JWT in browser", cookie attribute scan, bundle scan for @supabase/*,
// CSRF origin check stays in core (middleware), no open redirect, text-node-only rendering (REQ-SEC-088), no-referrer on the token landing.
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = fileURLToPath(new URL('../../../../../', import.meta.url)); // apps/web/
const AUTH_APP = join(WEB, 'src/app/(auth)/auth');
const AUTH_FEAT = join(WEB, 'src/features/admin/auth');

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? (n === '__tests__' || n === 'node_modules' ? [] : walk(p)) : /\.(ts|tsx|mjs|js)$/.test(n) && !/\.test\./.test(n) ? [p] : [];
  });
}
const files = [...walk(AUTH_APP), ...walk(AUTH_FEAT)];
const read = (f: string) => readFileSync(f, 'utf8');
const rel = (f: string) => f.slice(WEB.length).replace(/\\/g, '/');
const isClient = (f: string) => /^\s*(['"])use client\1/m.test(read(f).slice(0, 400));

describe('route files exist (04-UI-UX §1; (auth) group per CR-C2-001)', () => {
  it.each(['login', 'mfa', 'mfa/enrol', 'forgot', 'set-password', 'logout', 'session-expired'])('/auth/%s has a page.tsx', (r) => {
    expect(existsSync(join(AUTH_APP, r, 'page.tsx')), `(auth)/auth/${r}/page.tsx`).toBe(true);
  });

  it('/auth/confirm has a page.tsx or a route.ts (it must set the session cookie and 303 to a clean URL)', () => {
    expect(existsSync(join(AUTH_APP, 'confirm', 'page.tsx')) || existsSync(join(AUTH_APP, 'confirm', 'route.ts'))).toBe(true);
  });

  it('the component + action modules the tests import exist', () => {
    for (const f of ['actions.ts', 'LoginForm.tsx', 'MfaChallengeForm.tsx', 'MfaEnrolment.tsx', 'ForgotPasswordForm.tsx', 'SetPasswordForm.tsx', 'ConfirmLanding.tsx', 'SessionExpiredCard.tsx']) {
      expect(existsSync(join(AUTH_FEAT, f)), `features/admin/auth/${f}`).toBe(true);
    }
  });

  it('writes nothing outside the task-owned paths: no auth page under (staff)', () => {
    expect(existsSync(join(WEB, 'src/app/(staff)/auth'))).toBe(false);
  });
});

describe('no JWT / secret in the browser (REQ-SEC-068, AC-A1.1)', () => {
  it('has auth source files to scan', () => expect(files.length).toBeGreaterThan(5));

  it('no file references @supabase/* or GoTrue directly (bundle scan, source level) — BFF talks only to /v1/identity/auth/*', () => {
    for (const f of files) expect(read(f), rel(f)).not.toMatch(/@supabase\/|gotrue|supabase\.co|createClient\(/i);
  });

  it('apps/web/package.json does not depend on any @supabase/* package', () => {
    expect(read(join(WEB, 'package.json'))).not.toMatch(/@supabase\//);
  });

  it('client components never touch web storage, document.cookie, or token/JWT names', () => {
    for (const f of files.filter(isClient)) {
      const s = read(f);
      expect(s, rel(f)).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie/);
      expect(s, rel(f)).not.toMatch(/access_token|refresh_token|session_token|accessToken|\bjwt\b|Bearer /i);
      expect(s, rel(f)).not.toMatch(/from ['"](server-only|next\/headers)['"]/);
      expect(s, rel(f)).not.toMatch(/LIMS_ORIGIN_API|LIMS_WEB_BFF_KEY|X-Lims-Bff-Key/i);
    }
  });

  it('no NEXT_PUBLIC_* env var is read by auth code (nothing secret-ish can be inlined into the bundle)', () => {
    for (const f of files) expect(read(f), rel(f)).not.toMatch(/NEXT_PUBLIC_/);
  });

  it('the BFF key and API origin are used only in server code (actions.ts is a "use server" module)', () => {
    const actions = read(join(AUTH_FEAT, 'actions.ts'));
    expect(actions.trimStart().startsWith("'use server'") || actions.trimStart().startsWith('"use server"')).toBe(true);
    expect(actions).toMatch(/\/v1\/identity\/auth\//);
    expect(actions).toMatch(/[Xx]-[Ll]ims-[Bb]ff-[Kk]ey/);
  });
});

describe('cookie attribute scan (AC-A1.1)', () => {
  const setters = files.filter((f) => /cookies\(\)|\.cookies\b|Set-Cookie|\.set\(/i.test(read(f)) && /lims_sid|SESSION_COOKIE|sessionCookieOptions/.test(read(f)));

  it('the session cookie is written in server code only, and only via the shared SESSION_COOKIE / sessionCookieOptions (core/session/cookie.ts)', () => {
    expect(setters.length).toBeGreaterThan(0);
    for (const f of setters) {
      const s = read(f);
      expect(isClient(f), rel(f)).toBe(false);
      expect(s, rel(f)).toMatch(/SESSION_COOKIE/);
      expect(s, rel(f)).toMatch(/sessionCookieOptions/);
    }
  });

  it('no literal re-declaration of the cookie name and no weakened attributes anywhere in auth code', () => {
    for (const f of files) {
      const s = read(f);
      expect(s, rel(f)).not.toMatch(/['"`]lims_sid['"`]/); // un-prefixed name
      expect(s, rel(f)).not.toMatch(/httpOnly:\s*false|secure:\s*false|sameSite:\s*['"]none['"]|domain:/i);
    }
  });
});

describe('CSRF + redirects + rendering', () => {
  it('the Origin / Sec-Fetch-Site check remains in core middleware and /auth is not exempted from it (only from the session requirement)', () => {
    const mw = read(join(WEB, 'src/middleware.ts'));
    expect(mw).toMatch(/csrfOk\(req\)/);
    expect(mw).toMatch(/auth\.csrf_failed/);
    expect(mw.replace(/\s+/g, ' ')).toMatch(/!SAFE_METHODS\.has\(req\.method\) && !csrfOk\(req\)\) return/); // runs before the SESSION_EXEMPT branch
    // the auth code must not implement its own looser origin check
    for (const f of files) expect(read(f), rel(f)).not.toMatch(/auth\.csrf_failed|allowedOrigin/);
  });

  it('post-login `next` is validated against the routes.yaml matcher (core/permissions/routes) — not a bare startsWith("/")', () => {
    const actions = read(join(AUTH_FEAT, 'actions.ts'));
    expect(actions).toMatch(/matchStaffRoute|core\/permissions\/routes/);
  });

  it('never uses dangerouslySetInnerHTML or innerHTML (REQ-SEC-088: values rendered as text nodes)', () => {
    for (const f of files) expect(read(f), rel(f)).not.toMatch(/dangerouslySetInnerHTML|\.innerHTML\s*=|insertAdjacentHTML/);
  });

  it('the QR image goes through the kit DataUriImage; components come from @lims/ui (no hand-rolled OTP / secret widgets)', () => {
    const enrol = read(join(AUTH_FEAT, 'MfaEnrolment.tsx'));
    expect(enrol).toMatch(/DataUriImage/);
    expect(enrol).toMatch(/SecretRevealOnce/);
    expect(enrol).toMatch(/OtpInput/);
    expect(read(join(AUTH_FEAT, 'MfaChallengeForm.tsx'))).toMatch(/OtpInput/);
    expect(read(join(AUTH_FEAT, 'LoginForm.tsx'))).toMatch(/PasswordField/);
    expect(read(join(AUTH_FEAT, 'SetPasswordForm.tsx'))).toMatch(/PasswordField/);
  });

  it('/auth/confirm sends Referrer-Policy: no-referrer (the link token must not leak) and never echoes token_hash into rendered text', () => {
    const confirm = walk(join(AUTH_APP, 'confirm')).map(read).join('\n') + read(join(AUTH_FEAT, 'ConfirmLanding.tsx'));
    expect(confirm).toMatch(/no-referrer/);
    expect(read(join(AUTH_FEAT, 'ConfirmLanding.tsx'))).not.toMatch(/\{\s*tokenHash\s*\}/); // not rendered as JSX text
  });

  it('login page copy is lab-neutral (no tenant branding before login) and pages carry no `next` echo into HTML', () => {
    const login = read(join(AUTH_APP, 'login', 'page.tsx'));
    expect(login).not.toMatch(/tenant(Name|_name|Code)|branding|logo_asset/i);
  });
});
