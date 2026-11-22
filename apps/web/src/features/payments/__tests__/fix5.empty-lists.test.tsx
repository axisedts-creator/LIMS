// @vitest-environment jsdom
// T0D-FIX-5 (LD-447 done_when 4): the payments screens show a proper empty state when the API answers an empty list, which is what the demo tenant gets once the
// handlers are wired. Review queue and refunds are pinned here (reconciliation and static QR are pinned by uilist2.payments.test.tsx, settings by fix5.settings-env).
// These two already pass today (guard against regression); the failing web tests of this task are in fix5.settings-env.test.tsx.
// Kit rules: one EmptyState (.lims-state, no danger tone), no red alert, the h1 equals the menu label, the table header row stays.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { http } from 'msw';
import { setupServer } from 'msw/node';
import { ToastProvider } from '@lims/ui/components/Toast';
import { expectEmptyState, expectHeader, expectTable, page, props } from '@/__tests__/uilist2.helpers';

const ORIGIN = 'http://api.test';
process.env['LIMS_ORIGIN_API'] = ORIGIN;
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/payments/review',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
  redirect: (to: string) => { throw new Error(`NEXT_REDIRECT ${to}`); },
}));
vi.mock('server-only', () => ({}));
// no merchant_config.read here: the refunds page then does not read P23 and the test needs no settings fixture
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: ['payments.reconciliation.read'], displayName: 'Synthetic Finance', membershipId: '01950c12-0000-7000-8000-000000000900', tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => '/payments/review',
}));

const api = setupServer();
beforeAll(() => api.listen({ onUnhandledFrame: 'error' }));
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

const serve = (list: () => Response, path: string) => api.use(
  http.get(`${ORIGIN}/v1/payments/${path}`, list),
  http.get(`${ORIGIN}/v1/payments/coded-sets/:set`, () => page([])),
  http.all(`${ORIGIN}/v1/*`, () => page([])),
);
async function show(file: string) {
  const mod = await import(/* @vite-ignore */ `../../../app/(staff)/payments/${file}.tsx`);
  const tree = await (mod.default as (p: never) => Promise<never>)(props).catch((e: unknown) => { throw new Error(`the page threw to the error page instead of keeping its title: ${String(e)}`); });
  return render(<ToastProvider>{tree}</ToastProvider>);
}

describe.each([
  ['/payments/review', 'review/page', 'intents', /no payments need review/i],
  ['/payments/refunds', 'refunds/page', 'refunds', /no refunds/i],
] as const)('%s', (P, file, api_path, title) => {
  it('empty list: the title, the table header row and ONE EmptyState; no alert, no danger tone', async () => {
    serve(() => page([]), api_path);
    const { container } = await show(file);
    await screen.findByText(title);
    expectHeader(container, P);
    expectTable(container, P, { min: 2 });
    expectEmptyState(container, P, { title, inTable: false });
    expect(container.querySelectorAll('[role="alert"]').length).toBe(0);
    expect(container.querySelectorAll('.lims-tone-danger').length).toBe(0);
  });
});
