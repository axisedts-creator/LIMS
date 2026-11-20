// @vitest-environment jsdom
// T0D-UNSLOP-1 (A) — LD-344 / LD-353 rule 6: the founder walked these routes as tenant admin and saw "Something went wrong" instead of a page.
// Rule pinned here: when the API answers 501 operation_pending (an operation on the pending list, no handler yet) the page does NOT throw to error.tsx;
// it renders the calm NotAvailable state that KEEPS the page title (h1 = the sidebar label, LD-340) and, for list screens, the header row of the table.
// MSW answers EVERY /v1/* call with 501 operation_pending; the session holds every permission of contracts/permissions.yaml (an admin superset), so a
// missing permission can not hide the cause. A 500 must stay an error (guard test at the end): only 501 operation_pending is calm.
// Causes that are NOT 501 (404, 403 of the admin pack, thrown render error, missing tenant setting) are for the writer to find per route and to list in
// notes/T0D-UNSLOP-1-errors.md; /inventory/bench (403 for admin) and /admin/me (rs-c2) are listed there, not tested here.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { ToastProvider } from '@lims/ui/components/Toast';
import { navEntries } from '@/core/nav/generated';
import { t } from '@/core/i18n/messages';

const ORIGIN = 'http://api.test';
process.env['LIMS_ORIGIN_API'] = ORIGIN;
const ROOT = join(import.meta.dirname, '..', '..', '..', '..', '..', '..');
const ALL_PERMISSIONS = [...new Set(readFileSync(join(ROOT, 'contracts', 'permissions.yaml'), 'utf8').match(/\b[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){2,3}\b/g) ?? [])];

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/x',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
  redirect: (to: string) => { throw new Error(`NEXT_REDIRECT ${to}`); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: ALL_PERMISSIONS, displayName: 'Synthetic Admin', membershipId: '01950c12-0000-7000-8000-000000000900', tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => '/x',
}));

let status = 501;
const api = setupServer(
  http.all(`${ORIGIN}/*`, () => {
    const code = status === 501 ? 'operation_pending' : 'common.internal';
    return HttpResponse.json({ type: `urn:lims:error:${code}`, title: code, status, code, request_id: '01950c12-0000-7000-8000-000000000001' }, { status });
  }),
);
beforeAll(() => api.listen({ onUnhandledFrame: 'error' }));
afterEach(() => { cleanup(); status = 501; });
afterAll(() => api.close());

/** [route, page module, table header row expected]. Routes are the ten of the founder review + /instruments/settings (no h1). */
const ROUTES: readonly (readonly [string, () => Promise<{ default: (p: never) => unknown }>, boolean])[] = [
  ['/inventory', () => import('@/app/(staff)/inventory/page'), false],
  ['/inventory/alerts', () => import('@/app/(staff)/inventory/alerts/page'), true],
  ['/catalog/tests', () => import('@/app/(staff)/catalog/tests/page'), true],
  ['/catalog/comment-codes', () => import('@/app/(staff)/catalog/comment-codes/page'), true],
  ['/frontdesk/settings', () => import('@/app/(staff)/frontdesk/settings/page'), false],
  ['/smartreport/summaries', () => import('@/app/(staff)/smartreport/summaries/page'), true],
  ['/instruments/agents', () => import('@/app/(staff)/instruments/agents/page'), true],
  ['/instruments/instruments', () => import('@/app/(staff)/instruments/instruments/page'), true],
  ['/engagement/queue', () => import('@/app/(staff)/engagement/queue/page'), false],
  ['/engagement/bookings', () => import('@/app/(staff)/engagement/bookings/page'), true],
  ['/instruments/settings', () => import('@/app/(staff)/instruments/settings/page'), false],
];
const props = { searchParams: Promise.resolve({}), params: Promise.resolve({}) } as never;
const labelOf = (path: string) => {
  const e = navEntries.find((n) => n.path === path);
  if (!e) throw new Error(`no sidebar entry for ${path}`);
  return t(e.label);
};

describe('routes whose API operation is pending render NotAvailable, not the error boundary', () => {
  for (const [path, load, table] of ROUTES) {
    it(`${path}: 501 operation_pending -> page title + Not available yet${table ? ' + table header row' : ''}`, async () => {
      const mod = await load();
      const tree = await (mod.default as (p: never) => Promise<never>)(props); // a throw here IS the founder's error screen
      render(<ToastProvider>{tree}</ToastProvider>);
      await screen.findByText(/not available yet/i, undefined, { timeout: 5000 });
      const h1 = screen.getAllByRole('heading', { level: 1 });
      expect(h1.map((h) => (h.textContent ?? '').trim()), `exactly one h1, the menu label of ${path}`).toEqual([labelOf(path)]);
      expect(screen.queryByRole('alert'), 'no red alert').toBeNull();
      expect(document.body.textContent).not.toMatch(/something went wrong/i);
      if (table) expect(screen.getAllByRole('columnheader').length, 'the header row of the table stays').toBeGreaterThanOrEqual(2);
    });
  }
});

describe('guard: only 501 operation_pending is calm', () => {
  for (const path of ['/inventory/alerts', '/catalog/tests']) {
    it(`${path}: a 500 is still an error (thrown to error.tsx or an ErrorState), never "Not available yet"`, async () => {
      status = 500;
      const mod = await ROUTES.find((r) => r[0] === path)![1]();
      let shown = '';
      try {
        render(<ToastProvider>{await (mod.default as (p: never) => Promise<never>)(props)}</ToastProvider>);
        await waitFor(() => expect(document.body.textContent ?? '').not.toBe(''));
        shown = document.body.textContent ?? '';
      } catch { /* thrown: error.tsx shows the reference */ }
      expect(shown).not.toMatch(/not available yet/i);
    });
  }
});
