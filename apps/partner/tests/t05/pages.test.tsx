// C13.T05 — partner auth pages PA-1/PA-2/PA-6 + session-ended banner (04-UI-UX §2, 03-APP-FLOW §6), rendered to static markup (no jsdom in this package).
// ACs: US-03.1 (no JWT / token in anything the browser receives), US-03.2 (server error shown in a generic banner above the form, never field-specific),
//      US-03.5 (/auth/login?reason=session shows "You were signed out because your session ended."), REQ-SEC-088 (no HTML injection from query params).
// ASSUMED: every page.tsx default-exports a (possibly async) component taking Next 16 props { searchParams: Promise<Record<string,string|string[]|undefined>> }.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { JWT, NEW_TOKEN, SID, installFetch, resetApi, restoreFetch, seen, setEnv } from './harness';

vi.mock('server-only', () => ({}));
vi.mock('next/headers', async () => (await import('./harness')).headersMock);
vi.mock('next/navigation', async () => ({
  ...(await import('./harness')).navigationMock,
  useRouter: () => ({ push() {}, replace() {}, refresh() {} }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/auth/login',
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children?: unknown }) => createElement('a', { href, ...rest }, children as never),
}));

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };
const pages = {
  login: () => import('../../src/app/(auth)/auth/login/page'),
  mfa: () => import('../../src/app/(auth)/auth/mfa/page'),
  'set-password': () => import('../../src/app/(auth)/auth/set-password/page'),
  'session-expired': () => import('../../src/app/(auth)/auth/session-expired/page'),
};
async function render(route: keyof typeof pages, q: Record<string, string> = {}): Promise<string> {
  const mod = (await pages[route]()) as unknown as { default: (p: Props) => unknown };
  const tree = await mod.default({ searchParams: Promise.resolve(q) });
  return renderToStaticMarkup(tree as never);
}
const attr = (html: string, name: string) => new RegExp(`${name}=`, 'i').test(html);
const has = (html: string, re: RegExp) => re.test(html);

beforeAll(() => { setEnv(); installFetch(); });
afterAll(() => restoreFetch());
beforeEach(() => resetApi());

describe('PA-1 /auth/login', () => {
  it('renders title "Sign in", email + password fields with the specified attributes, and the "Forgot password?" link', async () => {
    const html = await render('login');
    expect(html).toContain('Sign in');
    expect(has(html, /autocomplete="username"/i)).toBe(true);
    expect(has(html, /autocomplete="current-password"/i)).toBe(true);
    expect(has(html, /type="password"/i)).toBe(true);
    expect(has(html, /maxlength="254"/i)).toBe(true);
    expect(has(html, /maxlength="128"/i)).toBe(true);
    expect(has(html, /inputmode="email"|type="email"/i)).toBe(true);
    expect(html).toContain('Forgot password?');
    expect(html).toContain('href="/auth/forgot"');
    expect(attr(html, 'required')).toBe(true);
  });

  it('US-03.5: ?reason=session shows the info banner "You were signed out because your session ended."; no banner without it', async () => {
    expect(await render('login', { reason: 'session' })).toContain('You were signed out because your session ended.');
    expect(await render('login')).not.toContain('signed out');
  });

  it('REQ-SEC-088: an unknown or hostile `reason` is never reflected into the page', async () => {
    const html = await render('login', { reason: '<script>alert(1)</script>' });
    expect(html).not.toContain('<script');
    expect(html).not.toContain('alert(1)');
    expect(html).not.toContain('signed out');
  });

  it('an unsafe `next` (absolute / protocol-relative URL) never reaches the markup; a known partner route may', async () => {
    for (const next of ['https://evil.test/x', '//evil.test', 'javascript:alert(1)']) expect(await render('login', { next })).not.toContain('evil.test');
    expect(await render('login', { next: 'javascript:alert(1)' })).not.toContain('javascript:');
    expect(await render('login', { next: '/manifests' })).toContain('/manifests');
  });

  it('is a plain form: no token/JWT/session id in the HTML, no inline <script> with data, no call to the API while rendering', async () => {
    const html = await render('login', { reason: 'session' });
    for (const secret of [NEW_TOKEN, JWT, SID, 'eyJ']) expect(html).not.toContain(secret);
    expect(has(html, /<script/i)).toBe(false);
    expect(seen).toHaveLength(0);
  });
});

describe('PA-2 /auth/mfa', () => {
  it('shows the copy and a 6-digit one-time-code field (inputMode numeric, autoComplete one-time-code, pattern ^[0-9]{6}$, max 6)', async () => {
    const html = await render('mfa');
    expect(html).toContain('Enter the 6-digit code from your authenticator app.');
    expect(has(html, /autocomplete="one-time-code"/i)).toBe(true);
    expect(has(html, /inputmode="numeric"/i)).toBe(true);
    expect(has(html, /pattern="\^?\[0-9\]\{6\}\$?"/i)).toBe(true);
    expect(has(html, /maxlength="6"/i)).toBe(true);
  });
});

describe('PA-6 /auth/set-password', () => {
  it('two new-password fields (max 128) and the "Use at least 12 characters." hint', async () => {
    const html = await render('set-password');
    expect((html.match(/autocomplete="new-password"/gi) ?? []).length).toBe(2);
    expect((html.match(/maxlength="128"/gi) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(html).toContain('Use at least 12 characters.');
  });
});

describe('/auth/session-expired', () => {
  it('offers a way back to /auth/login', async () => {
    expect(await render('session-expired')).toContain('href="/auth/login"');
  });
});
