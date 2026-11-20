// AUDIT-SMALL-1 (LD-224, audit RS-08): GET / is a root route, apps/web/src/app/page.tsx (default export, async server component).
// It resolves the session the way the shell does (getShellSession) and redirects, with no copy and no styling:
//   - platform session                                   -> /platform  (even with an empty permission set)
//   - tenant_staff session                               -> the path of the FIRST nav entry (core/nav/generated navEntries order) whose permission the actor holds
//   - tenant_staff with no permission that any nav entry needs, any other kind, or no session -> /auth/login (the existing sign-in route)
// Seams mocked: next/navigation (redirect throws like Next), @/core/session/server (getShellSession), @/core/nav/generated (fixture nav).
// Expected now: apps/web/src/app/page.tsx does not exist, so every case fails to import it.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const redirects: string[] = [];
vi.mock('next/navigation', () => ({
  redirect: (url: string) => { redirects.push(url); throw new Error(`NEXT_REDIRECT:${url}`); },
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));

const session = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock('@/core/session/server', () => ({
  getShellSession: async () => session.current,
  getRequestPathname: async () => '/',
}));

// Fixture nav, already in nav order (group, order) as build-nav emits it. Names are synthetic.
vi.mock('@/core/nav/generated', () => ({
  navEntries: [
    { id: 'frontdesk.worklist', module: 'frontdesk', group: 'frontdesk', order: 10, path: '/frontdesk/worklist', permission: 'frontdesk.order.read', routeId: 'r1', label: 'x' },
    { id: 'lab.pending', module: 'lab', group: 'lab', order: 10, path: '/lab/pending', permission: 'lab.result.read', routeId: 'r2', label: 'x' },
    { id: 'billing.worklist', module: 'billing', group: 'billing', order: 10, path: '/billing/worklist', permission: 'billing.invoice.read', routeId: 'r3', label: 'x' },
  ],
  staffRoutes: [
    { id: 'r1', path: '/frontdesk/worklist', permission: 'frontdesk.order.read' },
    { id: 'r2', path: '/lab/pending', permission: 'lab.result.read' },
    { id: 'r3', path: '/billing/worklist', permission: 'billing.invoice.read' },
  ],
}));

const sess = (kind: string, permissions: string[]) => ({
  sessionId: '0190a000-0000-7000-8000-000000000001', kind, aal: 'aal2',
  idleExpiresAt: '2026-11-15T07:00:00.000Z', absoluteExpiresAt: '2026-11-15T15:00:00.000Z',
  actor: { displayName: 'Ana Demo', tenantCode: 'lab_a', roles: [], permissions },
});

/** Renders the root page and returns where it redirected (the page must redirect, never return markup). */
async function landing(): Promise<string> {
  const mod = await import('../page');
  redirects.length = 0;
  let returned: unknown;
  try { returned = await (mod.default as () => Promise<unknown>)(); } catch (e) {
    if (!String((e as Error).message).startsWith('NEXT_REDIRECT:')) throw e;
  }
  expect(returned, 'the root page must redirect, not render').toBeUndefined();
  expect(redirects, 'exactly one redirect').toHaveLength(1);
  return redirects[0]!;
}

beforeEach(() => { session.current = undefined; redirects.length = 0; });

describe('GET / redirects by session kind (RS-08)', () => {
  it('platform session -> /platform', async () => {
    session.current = sess('platform', ['platform.tenant.read']);
    expect(await landing()).toBe('/platform');
  });

  it('platform session with an empty permission set still -> /platform (the web never derives a permission set)', async () => {
    session.current = sess('platform', []);
    expect(await landing()).toBe('/platform');
  });

  it('platform session never lands on a staff page even when it holds a staff permission', async () => {
    session.current = sess('platform', ['lab.result.read']);
    expect(await landing()).toBe('/platform');
  });

  it('tenant staff with several permissions -> the first nav entry they may open, in NAV order (not permission order)', async () => {
    session.current = sess('tenant_staff', ['billing.invoice.read', 'lab.result.read']);
    expect(await landing()).toBe('/lab/pending');
  });

  it('tenant staff with one permission -> that module landing page', async () => {
    session.current = sess('tenant_staff', ['billing.invoice.read']);
    expect(await landing()).toBe('/billing/worklist');
  });

  it('tenant staff with the first nav permission -> the first nav entry', async () => {
    session.current = sess('tenant_staff', ['lab.result.read', 'frontdesk.order.read']);
    expect(await landing()).toBe('/frontdesk/worklist');
  });

  it('tenant staff with an EMPTY permission set -> sign-in route /auth/login (no 404, no loop to /)', async () => {
    session.current = sess('tenant_staff', []);
    expect(await landing()).toBe('/auth/login');
  });

  it('tenant staff whose permissions match no nav entry -> /auth/login', async () => {
    session.current = sess('tenant_staff', ['catalog.nothing.read']);
    expect(await landing()).toBe('/auth/login');
  });

  it('no session -> /auth/login (the route the middleware already uses)', async () => {
    session.current = undefined;
    expect(await landing()).toBe('/auth/login');
  });

  it('any other session kind (e.g. portal) -> /auth/login, never a staff or platform page', async () => {
    session.current = sess('portal_patient', ['lab.result.read', 'platform.tenant.read']);
    expect(await landing()).toBe('/auth/login');
  });

  it('never redirects to / itself (no redirect loop) and only to a same-origin absolute path', async () => {
    for (const s of [undefined, sess('platform', []), sess('tenant_staff', []), sess('tenant_staff', ['lab.result.read'])]) {
      session.current = s;
      const to = await landing();
      expect(to).not.toBe('/');
      expect(to).toMatch(/^\/[a-z]/);
      expect(to).not.toMatch(/^\/\//);
    }
  });
});
