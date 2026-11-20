// T0D-ELABMENU-1 (LD-340, founder 2026-11-17 20:37 NPT: "admin needs an analytical dashboard at the start"): GET / (apps/web/src/app/page.tsx, RS-08 / LD-224).
//   tenant staff holding the permission of analytics.dashboard -> the path of that entry, even when an earlier nav entry is also permitted;
//   otherwise the first permitted entry in nav order (unchanged); no permitted entry, any other kind, no session -> /auth/login; platform -> /platform (unchanged).
// Part 1 uses a fixture manifest where the dashboard is NOT first; part 2 uses the real generated manifest (run `pnpm --dir apps/web run build:nav` first).
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const redirects: string[] = [];
vi.mock('next/navigation', () => ({
  redirect: (url: string) => { redirects.push(url); throw new Error(`NEXT_REDIRECT:${url}`); },
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));

const session = vi.hoisted(() => ({ current: undefined as unknown }));
const manifest = vi.hoisted(() => ({ real: false }));
vi.mock('@/core/session/server', () => ({
  getShellSession: async () => session.current,
  getRequestPathname: async () => '/',
}));
vi.mock('@/core/nav/generated', async (orig) => {
  const real = await orig<typeof import('@/core/nav/generated')>();
  const fixture = [
    { id: 'frontdesk.worklist', module: 'frontdesk', group: 'front_desk', order: 10, path: '/frontdesk/worklist', permission: 'frontdesk.order.read', routeId: 'r1', label: 'x' },
    { id: 'lab.pending', module: 'lab', group: 'laboratory', order: 10, path: '/lab/pending', permission: 'lab.result.read', routeId: 'r2', label: 'x' },
    { id: 'analytics.dashboard', module: 'analytics', group: 'analytics', order: 10, path: '/analytics', permission: 'analytics.dashboard.read', routeId: 'r3', label: 'x' },
    { id: 'analytics.reports', module: 'analytics', group: 'analytics', order: 20, path: '/analytics/reports', permission: 'analytics.dashboard.read', routeId: 'r4', label: 'x' },
  ];
  return { ...real, get navEntries() { return manifest.real ? real.navEntries : fixture; } };
});

const sess = (kind: string, permissions: string[]) => ({
  sessionId: '0190a000-0000-7000-8000-000000000001', kind, aal: 'aal2',
  idleExpiresAt: '2026-11-17T07:00:00.000Z', absoluteExpiresAt: '2026-11-17T15:00:00.000Z',
  actor: { displayName: 'Ana Demo', tenantCode: 'lab_a', roles: [], permissions },
});

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

beforeEach(() => { session.current = undefined; redirects.length = 0; manifest.real = false; });

describe('GET / lands on the dashboard (fixture manifest, dashboard is third in nav order)', () => {
  it('actor with the dashboard permission and earlier entries -> the dashboard, not the first nav entry', async () => {
    session.current = sess('tenant_staff', ['frontdesk.order.read', 'lab.result.read', 'analytics.dashboard.read']);
    expect(await landing()).toBe('/analytics');
  });

  it('actor with only the dashboard permission -> the dashboard', async () => {
    session.current = sess('tenant_staff', ['analytics.dashboard.read']);
    expect(await landing()).toBe('/analytics');
  });

  it('actor without the dashboard permission -> the first permitted entry in nav order (unchanged)', async () => {
    session.current = sess('tenant_staff', ['lab.result.read', 'frontdesk.order.read']);
    expect(await landing()).toBe('/frontdesk/worklist');
    session.current = sess('tenant_staff', ['lab.result.read']);
    expect(await landing()).toBe('/lab/pending');
  });

  it('a permission that merely looks like the dashboard one does not count', async () => {
    for (const p of ['analytics.dashboard', 'analytics.dashboard.read ', 'ANALYTICS.DASHBOARD.READ', 'analytics.*', '*']) {
      session.current = sess('tenant_staff', [p, 'lab.result.read']);
      expect(await landing(), p).toBe('/lab/pending');
    }
  });

  it('empty permission set -> /auth/login (no 404, no loop)', async () => {
    session.current = sess('tenant_staff', []);
    expect(await landing()).toBe('/auth/login');
  });

  it('platform session -> /platform even when it holds the dashboard permission', async () => {
    session.current = sess('platform', ['analytics.dashboard.read']);
    expect(await landing()).toBe('/platform');
  });

  it('other kinds and no session never reach the dashboard -> /auth/login', async () => {
    session.current = sess('portal_patient', ['analytics.dashboard.read']);
    expect(await landing()).toBe('/auth/login');
    session.current = undefined;
    expect(await landing()).toBe('/auth/login');
  });

  it('only redirects to a same-origin absolute path, never to / itself', async () => {
    for (const s of [undefined, sess('platform', []), sess('tenant_staff', []), sess('tenant_staff', ['analytics.dashboard.read'])]) {
      session.current = s;
      const to = await landing();
      expect(to).not.toBe('/');
      expect(to).toMatch(/^\/[a-z]/);
      expect(to).not.toMatch(/^\/\//);
    }
  });
});

describe('GET / with the real manifest', () => {
  it('the dashboard entry exists and holds a permission the actor can have', async () => {
    const { navEntries } = await vi.importActual<typeof import('@/core/nav/generated')>('@/core/nav/generated');
    const d = navEntries.find((e) => e.id === 'analytics.dashboard');
    expect(d).toBeTruthy();
    expect(d!.permission).toBe('analytics.dashboard.read');
  });

  it('an actor holding every permission lands on the dashboard path', async () => {
    const { navEntries } = await vi.importActual<typeof import('@/core/nav/generated')>('@/core/nav/generated');
    manifest.real = true;
    session.current = sess('tenant_staff', [...new Set(navEntries.map((e) => e.permission))]);
    expect(await landing()).toBe(navEntries.find((e) => e.id === 'analytics.dashboard')!.path);
  });

  it('an actor without the dashboard permission lands on the first permitted entry in nav order', async () => {
    const { navEntries } = await vi.importActual<typeof import('@/core/nav/generated')>('@/core/nav/generated');
    manifest.real = true;
    const perms = [...new Set(navEntries.map((e) => e.permission))].filter((p) => p !== 'analytics.dashboard.read');
    session.current = sess('tenant_staff', perms);
    expect(await landing()).toBe(navEntries.find((e) => perms.includes(e.permission))!.path);
    expect(await landing()).not.toBe('/analytics');
  });
});
