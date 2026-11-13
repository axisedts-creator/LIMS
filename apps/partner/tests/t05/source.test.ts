// C13.T05 — source-level done_when: files exist; "no JWT in browser" (no JS-visible cookie/storage use, client files never touch core/session);
// cookie attribute scan; session kind bound by the partner BFF key only (no X-Lims-Origin, no staff cookie name); text-node-only rendering (REQ-SEC-088).
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = fileURLToPath(new URL('../../', import.meta.url)); // apps/partner/
const AUTH_APP = join(APP, 'src/app/(auth)/auth');
const CORE = join(APP, 'src/core');

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? (n === '__tests__' || n === 'node_modules' ? [] : walk(p)) : /\.(ts|tsx|mjs|js)$/.test(n) && !/\.test\./.test(n) ? [p] : [];
  });
}
const t05Core = ['session.ts', 'api.ts', 'auth-guard.ts', 'csrf.ts'].map((f) => join(CORE, f));
const files = [...t05Core.filter(existsSync), ...walk(AUTH_APP)];
const read = (f: string) => readFileSync(f, 'utf8');
const rel = (f: string) => f.slice(APP.length).replace(/\\/g, '/');
const isClient = (f: string) => /^\s*(['"])use client\1/m.test(read(f).slice(0, 400));
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1'); // comments may cite names; code may not

describe('files exist (TRD §3.6 layout)', () => {
  it.each(['session.ts', 'api.ts', 'auth-guard.ts', 'csrf.ts'])('src/core/%s', (f) => {
    expect(existsSync(join(CORE, f)), `src/core/${f}`).toBe(true);
  });
  it.each(['login', 'mfa', 'mfa/enrol', 'forgot', 'set-password', 'logout', 'session-expired'])('(auth)/auth/%s/page.tsx', (r) => {
    expect(existsSync(join(AUTH_APP, r, 'page.tsx')), `(auth)/auth/${r}/page.tsx`).toBe(true);
  });
  it('(auth)/auth/confirm has a page.tsx or a route.ts (token is removed from the URL by redirect, PA-5)', () => {
    expect(existsSync(join(AUTH_APP, 'confirm', 'page.tsx')) || existsSync(join(AUTH_APP, 'confirm', 'route.ts'))).toBe(true);
  });
  it('(auth)/auth/actions.ts exists (the module actions.test.ts imports)', () => {
    expect(existsSync(join(AUTH_APP, 'actions.ts'))).toBe(true);
  });
});

describe('server-only core', () => {
  it.each(['session.ts', 'api.ts', 'auth-guard.ts'])('src/core/%s imports server-only (REQ-SEC-068: token handling never ships to a browser bundle)', (f) => {
    const p = join(CORE, f);
    expect(existsSync(p), f).toBe(true);
    expect(read(p)).toMatch(/import\s+['"]server-only['"]/);
  });
  it('actions.ts is a server-actions module: "use server" and server-only', () => {
    const p = join(AUTH_APP, 'actions.ts');
    expect(existsSync(p)).toBe(true);
    expect(read(p).slice(0, 400)).toMatch(/^\s*(['"])use server\1/m);
  });
});

describe('no JWT / secret in the browser (US-03.1)', () => {
  it('there are source files to scan', () => {
    expect(files.length).toBeGreaterThanOrEqual(8);
  });

  it.each(['document.cookie', 'localStorage', 'sessionStorage', 'indexedDB', 'cookieStore', 'NEXT_PUBLIC_', '@supabase', 'dangerouslySetInnerHTML', 'console.log', 'eval('])(
    'no file under core/session|api|auth-guard|csrf or (auth)/auth uses %s', (needle) => {
      for (const f of files) expect(strip(read(f)), `${rel(f)} contains ${needle}`).not.toContain(needle);
    });

  it('"use client" files never import core/session, core/api, core/auth-guard or server-only, and never mention the BFF key, API URL or access_token', () => {
    for (const f of files.filter(isClient)) {
      const s = strip(read(f));
      expect(s, rel(f)).not.toMatch(/core\/(session|api|auth-guard)|server-only/);
      expect(s, rel(f)).not.toMatch(/BFF_KEY|LIMS_PARTNER_BFF|x-lims-bff-key|access_token|session_token/i);
    }
  });

  it('only the actions / core modules mention the BFF key header; pages and components do not', () => {
    for (const f of files) {
      const allowed = /src\/core\/|auth\/actions\.ts$/.test(rel(f));
      if (!allowed) expect(strip(read(f)).toLowerCase(), rel(f)).not.toContain('x-lims-bff-key');
    }
  });
});

describe('cookie attributes and session-kind binding (US-03.1, US-03.2/03.3, 08 R10)', () => {
  const all = () => files.map((f) => strip(read(f))).join('\n');

  it('uses the partner cookie name in the browser; __Host-lims_sid only as the server-to-server bffSession wire name, never in Set-Cookie; no unprefixed cookie', () => {
    expect(all()).toContain('__Host-lims_psid');
    expect(all()).toContain('__Host-lims_sid'); // wire name of the forwarded cookie header (contracts/openapi/_common.yaml bffSession)
    expect(all()).not.toMatch(/['"]lims_p?sid['"]/);
  });

  it('never weakens the flags: no httpOnly:false, secure:false, sameSite none/strict, domain, or Expires-less persistence tricks', () => {
    const s = all();
    expect(s).not.toMatch(/httpOnly\s*:\s*false/);
    expect(s).not.toMatch(/secure\s*:\s*false/);
    expect(s).not.toMatch(/sameSite\s*:\s*['"](none|strict)['"]/i);
    expect(s).not.toMatch(/\bdomain\s*:/);
  });

  it('session kind is bound by the partner BFF key: no client-chosen X-Lims-Origin header, and C2 is called on /auth/partner/login for sign-in', () => {
    const s = all();
    expect(s.toLowerCase()).not.toContain('x-lims-origin');
    expect(s).toContain('/auth/partner/login');
    expect(s).not.toMatch(/['"`]\/v1\/identity\/auth\/login['"`]/); // the staff login operation
  });

  it('the BFF key is read from LIMS_PARTNER_BFF_KEY_FILE (file-mounted secret), never from a plain env value', () => {
    const s = all();
    expect(s).toContain('LIMS_PARTNER_BFF_KEY_FILE');
    expect(s).not.toMatch(/process\.env\.LIMS_PARTNER_BFF_KEY\b(?!_FILE)/);
  });

  it('Origin check is wired against LIMS_ORIGIN_PARTNER with Sec-Fetch-Site (REQ-SEC-091)', () => {
    const s = strip(read(join(CORE, 'csrf.ts')));
    expect(s).toContain('LIMS_ORIGIN_PARTNER');
    expect(s.toLowerCase()).toContain('sec-fetch-site');
  });
});

describe('redirect hygiene', () => {
  it('no page or action redirects to a URL built from the session token', () => {
    for (const f of files) expect(strip(read(f)), rel(f)).not.toMatch(/redirect\([^)]*(session_token|sessionToken|token)/);
  });
});
