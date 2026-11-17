// C5.T-11 — page wiring for `/lab/collect` and `/lab/receive` (server components; node env, MSW). Synthetic data only.
// ASSUMED contract (dispute to rename): app/(staff)/lab/collect/page.tsx default async Page() → <CollectDispatch permissions=…/>;
//   app/(staff)/lab/receive/page.tsx default async Page() → <ReceiveScreen centres rejectionReasons recollectionDefault permissions/>, loading
//   centres from GET /v1/identity/centres (active only), reasons from GET /v1/lab/coded-sets/rejection_reasons (#53, active only), recollection_default from GET /v1/lab/settings (#47).
//   A failing settings/identity read must not crash the screen: recollectionDefault falls back to false; centres to [].
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { ReactElement } from 'react';
import { CENTRES, CENTRE_A, CENTRE_B, LAB, ORIGIN, calls, problem, rec, uuid } from './lab-t11.fixtures';

vi.mock('server-only', () => ({}));
const session = vi.hoisted(() => ({ permissions: [] as string[] }));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: session.permissions, displayName: 'Synthetic Tech', tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => '/lab/receive',
}));
vi.mock('next/navigation', () => ({ redirect: vi.fn(), notFound: () => { throw new Error('NEXT_NOT_FOUND'); } }));
process.env.LIMS_ORIGIN_API = ORIGIN;

const settings = (o: Record<string, unknown> = {}) => ({ version: 1, label_width_mm: 50, label_height_mm: 25, label_copies_default: 1, label_renderer: 'html_svg', host_query_requires_received: true, ingest_auto_receive: false, critical_notification_blocks_approval: true, recollection_default: true, delta_check_enabled: false, history_days: 365, ...o });
const api = setupServer(
  http.get(`${ORIGIN}/v1/identity/centres`, async ({ request }) => { await rec(request); return HttpResponse.json({ data: [...CENTRES.map((c) => ({ centre_id: c.id, name: c.name, is_active: true })), { centre_id: uuid(2, 9), name: 'Retired Lab', is_active: false }] }); }),
  http.get(`${LAB}/coded-sets/rejection_reasons`, async ({ request }) => { await rec(request); return HttpResponse.json({ data: [{ code: 'haemolysed', display: 'Haemolysed', sort_order: 1, is_active: true, source: 'global' }, { code: 'old_reason', display: 'Old reason', sort_order: 2, is_active: false, source: 'tenant' }] }); }),
  http.get(`${LAB}/settings`, async ({ request }) => { await rec(request); return HttpResponse.json(settings()); }),
);
beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
afterEach(() => { api.resetHandlers(); calls.length = 0; });
afterAll(() => api.close());

const render = async (mod: () => Promise<{ default: (p: any) => Promise<ReactElement> | ReactElement }>) => (await (await mod()).default({ searchParams: Promise.resolve({}) })) as ReactElement;

describe('/lab/collect page', () => {
  it('renders <CollectDispatch> with the session permissions and makes no API call (screen data comes from scans)', async () => {
    session.permissions = ['lab.specimen.collect', 'lab.specimen.read'];
    const el = await render(() => import('@/app/(staff)/lab/collect/page'));
    const { CollectDispatch } = await import('../components/CollectDispatch');
    expect(el.type).toBe(CollectDispatch);
    expect((el.props as { permissions: string[] }).permissions).toEqual(['lab.specimen.collect', 'lab.specimen.read']);
    expect(calls).toHaveLength(0);
  });
});

describe('/lab/receive page', () => {
  it('renders <ReceiveScreen> with active centres, active rejection reasons, recollection_default from settings and the session permissions', async () => {
    session.permissions = ['lab.specimen.receive', 'lab.specimen.reject', 'lab.specimen.read', 'lab.worklist.read'];
    const el = await render(() => import('@/app/(staff)/lab/receive/page'));
    const { ReceiveScreen } = await import('../components/ReceiveScreen');
    expect(el.type).toBe(ReceiveScreen);
    const p = el.props as { centres: { id: string; name: string }[]; rejectionReasons: { code: string; display: string }[]; recollectionDefault: boolean; permissions: string[] };
    expect(p.centres.map(({ id, name }) => ({ id, name }))).toEqual(CENTRES);
    expect(p.centres.map((c) => c.id)).toEqual([CENTRE_A, CENTRE_B]);
    expect(p.rejectionReasons.map(({ code, display }) => ({ code, display }))).toEqual([{ code: 'haemolysed', display: 'Haemolysed' }]);
    expect(p.recollectionDefault).toBe(true);
    expect(p.permissions).toEqual(session.permissions);
    for (const c of calls) expect(c.url.search).toBe(''); // no filters/ids in URLs
  });

  it('settings read refused (403) → the screen still renders with recollectionDefault=false (no crash, no stale default)', async () => {
    session.permissions = ['lab.specimen.receive', 'lab.specimen.read'];
    api.use(http.get(`${LAB}/settings`, async ({ request }) => { await rec(request); return problem(403, 'auth.forbidden', 'Forbidden'); }));
    const el = await render(() => import('@/app/(staff)/lab/receive/page'));
    expect((el.props as { recollectionDefault: boolean }).recollectionDefault).toBe(false);
  });

  it('identity centres read refused → centres is an empty list (the screen shows its own required-location message), not an exception', async () => {
    session.permissions = ['lab.specimen.receive', 'lab.specimen.read'];
    api.use(http.get(`${ORIGIN}/v1/identity/centres`, async ({ request }) => { await rec(request); return problem(403, 'auth.forbidden', 'Forbidden'); }));
    const el = await render(() => import('@/app/(staff)/lab/receive/page'));
    expect((el.props as { centres: unknown[] }).centres).toEqual([]);
  });
});
