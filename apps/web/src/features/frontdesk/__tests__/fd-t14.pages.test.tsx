// @vitest-environment jsdom
// FD-T14 — page-level states (03-APP-FLOW §4): success wiring, 404 → "Order not found"/notFound (also other-centre), error boundary, permission-denied copy.
// Pages are async server components (Next 16: params is a Promise) that read the BFF through features/frontdesk/server/*.server.ts and hand DTOs to the components
// (same shape as app/(staff)/billing/invoices/[invoice_id]/page.tsx). Session permissions come from getShellSession().actor.permissions.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { ReactNode } from 'react';
import { ToastProvider } from '@lims/ui/components/Toast';
import { ORIGIN, ORDER, PATIENT, RECEPTION, PERM, U, approval, billing, flag, flagResolutions, order, orderSummary, patient, patientOrders, patientSummary } from './fd-t14.fixtures';

const session = { perms: [] as string[] };
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/frontdesk/worklist',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: session.perms, displayName: 'Synthetic Reception', tenantCode: 'syn', roles: [], membershipId: U(90) } }),
  getRequestPathname: async () => '/frontdesk/worklist',
}));
process.env.LIMS_ORIGIN_API = ORIGIN;

const problem = (status: number, code: string) => HttpResponse.json({ type: 'about:blank', title: code, status, code }, { status, headers: { 'content-type': 'application/problem+json' } });
const coded = (set: string) => ({ data: [{ code: `${set}_a`, display: `${set} A`, sort_order: 1 }] });
const api = setupServer(
  http.get(`${ORIGIN}/v1/frontdesk/orders/:id`, ({ params }) => (params.id === ORDER ? HttpResponse.json(order()) : problem(404, 'common.not_found'))),
  http.get(`${ORIGIN}/v1/billing/orders/:id`, () => HttpResponse.json(billing())),
  http.get(`${ORIGIN}/v1/frontdesk/coded-sets/:set`, ({ params }) => HttpResponse.json(coded(String(params.set)))),
  http.get(`${ORIGIN}/v1/frontdesk/patients/possible-duplicates`, () => HttpResponse.json({ data: [{ patient: patientSummary(), candidates: [] }] })),
  http.get(`${ORIGIN}/v1/frontdesk/patients/:id/orders`, () => HttpResponse.json({ data: patientOrders })),
  http.get(`${ORIGIN}/v1/frontdesk/patients/:id`, ({ params }) => (params.id === PATIENT ? HttpResponse.json(patient()) : problem(404, 'common.not_found'))),
  http.get(`${ORIGIN}/v1/frontdesk/order-flags`, () => HttpResponse.json({ data: [flag()] })),
  http.get(`${ORIGIN}/v1/frontdesk/orders`, () => HttpResponse.json({ data: [orderSummary()] })),
  http.get(`${ORIGIN}/v1/frontdesk/discount-approvals`, () => HttpResponse.json({ data: [approval()] })),
  http.get(`${ORIGIN}/v1/catalog/*`, () => HttpResponse.json({ data: [] })),
  http.get(`${ORIGIN}/v1/frontdesk/trf-attachments/:id`, () => problem(404, 'common.not_found')),
);
beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
afterEach(() => { cleanup(); api.resetHandlers(); session.perms = []; });
afterAll(() => api.close());

const wrap = (ui: ReactNode) => render(<ToastProvider>{ui}</ToastProvider>);
const page = async (rel: string) => (await import(/* @vite-ignore */ `../../../app/(staff)/frontdesk/${rel}/page`)) as { default: (p: any) => Promise<ReactNode> };

describe('order page', () => {
  it('success: loads the order through the BFF and renders registration no + patient + billing tab', async () => {
    session.perms = RECEPTION;
    const { default: Page } = await page('orders/[order_id]');
    wrap(await Page({ params: Promise.resolve({ order_id: ORDER }) }));
    expect(screen.getAllByText('R-0001-000001').length).toBeGreaterThan(0);
    expect(screen.getByRole('tab', { name: 'Billing' })).toBeTruthy();
  });

  it('404 (unknown order OR another centre — same response) → notFound(); 400 (malformed id) → notFound()', async () => {
    session.perms = RECEPTION;
    const { default: Page } = await page('orders/[order_id]');
    await expect(Page({ params: Promise.resolve({ order_id: U(404) }) })).rejects.toThrow('NEXT_NOT_FOUND');
    api.use(http.get(`${ORIGIN}/v1/frontdesk/orders/:id`, () => problem(400, 'common.validation_failed')));
    await expect(Page({ params: Promise.resolve({ order_id: 'not-a-uuid' }) })).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('a 5xx is NOT turned into 404 — it propagates to error.tsx', async () => {
    session.perms = RECEPTION;
    api.use(http.get(`${ORIGIN}/v1/frontdesk/orders/:id`, () => problem(500, 'common.internal')));
    const { default: Page } = await page('orders/[order_id]');
    await expect(Page({ params: Promise.resolve({ order_id: ORDER }) })).rejects.not.toThrow('NEXT_NOT_FOUND');
  });

  it('user without billing.invoice.read: the billing endpoint is not needed and the Billing tab is absent', async () => {
    session.perms = [PERM.orderRead];
    api.use(http.get(`${ORIGIN}/v1/billing/orders/:id`, () => problem(403, 'auth.forbidden')));
    const { default: Page } = await page('orders/[order_id]');
    wrap(await Page({ params: Promise.resolve({ order_id: ORDER }) }));
    expect(screen.queryByRole('tab', { name: 'Billing' })).toBeNull();
  });

  it('not-found.tsx says "Order not found"', async () => {
    const nf = (await import(/* @vite-ignore */ '../../../app/(staff)/frontdesk/orders/[order_id]/not-found')) as { default: () => ReactNode };
    wrap(nf.default());
    expect(screen.getByText(/Order not found/)).toBeTruthy();
  });
});

describe('patient page', () => {
  it('success renders demographics + visits; unknown patient → notFound()', async () => {
    session.perms = RECEPTION;
    const { default: Page } = await page('patients/[patient_id]');
    wrap(await Page({ params: Promise.resolve({ patient_id: PATIENT }) }));
    expect(screen.getAllByText(/P-000001/).length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: 'R-0001-000001' })).toBeTruthy();
    cleanup();
    await expect(Page({ params: Promise.resolve({ patient_id: U(404) }) })).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('document title/metadata never contains the patient name or phone (REQ-SEC-098)', async () => {
    session.perms = RECEPTION;
    const m = (await import(/* @vite-ignore */ '../../../app/(staff)/frontdesk/patients/[patient_id]/page')) as { generateMetadata?: (p: any) => Promise<{ title?: unknown }> | { title?: unknown }; metadata?: { title?: unknown } };
    const meta = m.generateMetadata ? await m.generateMetadata({ params: Promise.resolve({ patient_id: PATIENT }) }) : m.metadata;
    expect(JSON.stringify(meta ?? {})).not.toMatch(/Demo Patient|9800000042|98xxxxxx42|demo\.a@/);
  });
});

describe('worklist page', () => {
  it('success: recollection flag joined to its order (registration no) from the BFF', async () => {
    session.perms = RECEPTION;
    const { default: Page } = await page('worklist');
    wrap(await Page({ searchParams: Promise.resolve({}) }));
    expect(screen.getByRole('link', { name: 'R-0001-000001' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Recollection needed' })).toBeTruthy();
  });

  it('banner-level error (03-APP-FLOW §4: Error = banner): a failing list endpoint does not blank the whole page', async () => {
    session.perms = RECEPTION;
    api.use(http.get(`${ORIGIN}/v1/frontdesk/order-flags`, () => problem(503, 'common.unavailable')));
    const { default: Page } = await page('worklist');
    let threw = false;
    try { wrap(await Page({ searchParams: Promise.resolve({}) })); } catch { threw = true; }
    // Either the page renders an inline banner (preferred) or throws to error.tsx; it must never render a stale/empty "Nothing pending".
    if (!threw) expect(screen.queryByText('Nothing pending')).toBeNull();
  });

  it('possible-duplicates is only fetched/shown with frontdesk.registration.create', async () => {
    session.perms = [PERM.orderRead, PERM.orderEdit];
    api.use(http.get(`${ORIGIN}/v1/frontdesk/patients/possible-duplicates`, () => problem(403, 'auth.forbidden')));
    const { default: Page } = await page('worklist');
    wrap(await Page({ searchParams: Promise.resolve({}) }));
    expect(screen.queryByRole('tab', { name: /possible duplicates/i })).toBeNull();
  });
});

describe('discount approvals page', () => {
  it('approver: inbox rows from the BFF', async () => {
    session.perms = [PERM.approve, PERM.orderRead];
    const { default: Page } = await page('discount-approvals');
    wrap(await Page({ searchParams: Promise.resolve({}) }));
    expect(screen.getByText('Synthetic Receptionist')).toBeTruthy();
  });

  it('non-approver: "Approvals require approver role and MFA", the list endpoint is not called', async () => {
    session.perms = RECEPTION;
    let listed = 0;
    api.use(http.get(`${ORIGIN}/v1/frontdesk/discount-approvals`, () => { listed += 1; return HttpResponse.json({ data: [approval()] }); }));
    const { default: Page } = await page('discount-approvals');
    wrap(await Page({ searchParams: Promise.resolve({}) }));
    expect(screen.getByText(/Approvals require approver role and MFA/)).toBeTruthy();
    expect(screen.queryByText('Synthetic Receptionist')).toBeNull();
    expect(listed).toBe(0);
  });

  it('API 403 auth.mfa_required on load → MFA banner (not an error boundary)', async () => {
    session.perms = [PERM.approve, PERM.orderRead];
    api.use(http.get(`${ORIGIN}/v1/frontdesk/discount-approvals`, () => problem(403, 'auth.mfa_required')));
    const { default: Page } = await page('discount-approvals');
    wrap(await Page({ searchParams: Promise.resolve({}) }));
    expect(screen.getByText(/Approving discounts requires MFA — complete MFA in your profile|Approvals require approver role and MFA/)).toBeTruthy();
  });
});

void flagResolutions;
