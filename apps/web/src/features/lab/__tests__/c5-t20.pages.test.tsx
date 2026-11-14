// C5.T-20 — page wiring for `/lab/orders/{order_id}/results` (server component; node env, MSW). Synthetic data only.
// ASSUMED contract: app/(staff)/lab/orders/[order_id]/results/page.tsx  default async Page({ params: Promise<{order_id}>, searchParams }) → <ResultGrid data permissions returnReasons amendmentReasons .../>
//   data = GET /v1/lab/orders/{order_id}/results (#listOrderResults, `lab.result.read`); only `department_id` (uuid) is forwarded from searchParams (04-UI-UX §3.4 "Enter = open order result grid filtered to the department").
//   returnReasons / amendmentReasons = GET /v1/lab/coded-sets/return_reasons | amendment_reasons (same BFF read as rejection_reasons), active only, sorted by sort_order.
//   order_id that is not a uuid → notFound() without calling the API; API 404 → notFound() (no existence oracle, P-01); 5xx throws (error.tsx), never an empty grid.
//   error.tsx + loading.tsx siblings like every other lab screen.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { ReactElement } from 'react';

const ORIGIN = 'http://api.test';
vi.mock('server-only', () => ({}));
const session = vi.hoisted(() => ({ permissions: [] as string[] }));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: session.permissions, displayName: 'Synthetic Tech', tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => '/lab/orders/x/results',
}));
vi.mock('next/navigation', () => ({ redirect: vi.fn(), notFound: () => { throw new Error('NEXT_NOT_FOUND'); } }));
process.env.LIMS_ORIGIN_API = ORIGIN;

const ORDER = '01a1a98a-ac40-7000-8000-000000008888';
const DEPT = '01a1a98a-ac40-7000-8000-000000000777';
const body = { order: { order_id: ORDER, registration_no: 'REG0042', specimens: [], order_tests: [] }, items: [{ order_item_id: ORDER, test: { test_id: ORDER, test_code: 'CBC' }, results: [] }] };
const seen: URL[] = [];
const analyteSeen: string[] = [];
// getAnalyte (catalog.yaml #getAnalyte, `catalog.test.read`) → AnalyteDetail; the page maps name + current_version.{result_type,decimals} to the grid's `analytes` prop (review item 1).
const AN_HB = ORDER.replace(/8888$/, '0101');
const AN_CULT = ORDER.replace(/8888$/, '0102');
const ANALYTE_DETAIL: Record<string, { name: string; result_type: string; decimals?: number }> = {
  [AN_HB]: { name: 'Hemoglobin', result_type: 'numeric', decimals: 1 },
  [AN_CULT]: { name: 'Culture growth', result_type: 'ordinal' },
};
let orderReply: () => Response = () => HttpResponse.json(body);
const api = setupServer(
  http.get(`${ORIGIN}/v1/lab/orders/:oid/results`, ({ request }) => { seen.push(new URL(request.url)); return orderReply(); }),
  http.get(`${ORIGIN}/v1/catalog/analytes/:aid`, ({ params }) => {
    const aid = String(params['aid']); analyteSeen.push(aid);
    const d = ANALYTE_DETAIL[aid];
    return d
      ? HttpResponse.json({ id: aid, code: 'X', name: d.name, version: 1, versions: [], current_version: { version_no: 1, result_type: d.result_type, ...(d.decimals !== undefined ? { decimals: d.decimals } : {}) } })
      : HttpResponse.json({ type: 'about:blank', title: 'x', status: 404, code: 'common.not_found' }, { status: 404 });
  }),
  http.get(`${ORIGIN}/v1/lab/coded-sets/return_reasons`, () => HttpResponse.json({ data: [{ code: 'b', display: 'Second', sort_order: 2 }, { code: 'a', display: 'First', sort_order: 1 }, { code: 'z', display: 'Retired', sort_order: 0, is_active: false }] })),
  http.get(`${ORIGIN}/v1/lab/coded-sets/amendment_reasons`, () => HttpResponse.json({ data: [{ code: 'transcription_error', display: 'Transcription error', sort_order: 1 }] })),
);
beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
afterEach(() => { api.resetHandlers(); seen.length = 0; analyteSeen.length = 0; orderReply = () => HttpResponse.json(body); });
afterAll(() => api.close());

type Page = (p: { params: Promise<{ order_id: string }>; searchParams: Promise<Record<string, string>> }) => Promise<ReactElement>;
const page = async (oid: string, sp: Record<string, string> = {}) =>
  (await ((await import('@/app/(staff)/lab/orders/[order_id]/results/page')).default as Page)({ params: Promise.resolve({ order_id: oid }), searchParams: Promise.resolve(sp) })) as ReactElement;

describe('/lab/orders/[order_id]/results page', () => {
  it('renders <ResultGrid> with the order results, session permissions and the active, sorted return/amendment reasons', async () => {
    session.permissions = ['lab.result.read', 'lab.result.enter'];
    const el = await page(ORDER);
    const { ResultGrid } = await import('../components/grid/ResultGrid');
    expect(el.type).toBe(ResultGrid);
    const p = el.props as { data: typeof body; permissions: string[]; returnReasons: { code: string }[]; amendmentReasons: { code: string }[] };
    expect(p.data.order.registration_no).toBe('REG0042');
    expect(p.permissions).toEqual(['lab.result.read', 'lab.result.enter']);
    expect(p.returnReasons.map((r) => r.code)).toEqual(['a', 'b']);
    expect(p.amendmentReasons.map((r) => r.code)).toEqual(['transcription_error']);
    expect(seen[0]!.pathname).toBe(`/v1/lab/orders/${ORDER}/results`);
  });

  it('passes `analytes` built from catalog getAnalyte, one call per distinct analyte_id: ordinal analyte → value_type "ordinal"; name and decimals carried over', async () => {
    session.permissions = ['lab.result.read', 'lab.result.enter'];
    const r = (rid: string, aid: string) => ({ id: rid, version: 1, order_id: ORDER, analyte_id: aid, status: 'pending' });
    orderReply = () => HttpResponse.json({ ...body, items: [{ ...body.items[0]!, results: [r(ORDER, AN_HB), r(DEPT, AN_CULT), r(ORDER.replace(/8888$/, '9999'), AN_HB)] }] });
    const el = await page(ORDER);
    const p = el.props as { analytes: Record<string, { name: string; decimals?: number; value_type: string }> };
    expect(p.analytes[AN_HB]).toMatchObject({ name: 'Hemoglobin', decimals: 1, value_type: 'numeric' });
    expect(p.analytes[AN_CULT]).toMatchObject({ name: 'Culture growth', value_type: 'ordinal' });
    expect([...analyteSeen].sort()).toEqual([AN_HB, AN_CULT].sort()); // AN_HB is shared by two rows → fetched once
  });

  it('forwards only a valid department_id; a stray patient/q param or a bad uuid never reaches the API', async () => {
    session.permissions = ['lab.result.read'];
    await page(ORDER, { department_id: DEPT, patient: 'Jane Doe', q: 'REG0042' });
    expect(Object.fromEntries(seen[0]!.searchParams)).toEqual({ department_id: DEPT });
    seen.length = 0;
    await page(ORDER, { department_id: 'nope' });
    expect(Object.fromEntries(seen[0]!.searchParams)).toEqual({});
  });

  it('a non-uuid order_id → notFound() and the API is never called', async () => {
    session.permissions = ['lab.result.read'];
    await expect(page('../../etc/passwd')).rejects.toThrow('NEXT_NOT_FOUND');
    expect(seen).toHaveLength(0);
  });

  it('API 404 → notFound() (a foreign-tenant order looks the same as a missing one)', async () => {
    session.permissions = ['lab.result.read'];
    orderReply = () => HttpResponse.json({ type: 'about:blank', title: 'x', status: 404, code: 'common.not_found' }, { status: 404 });
    await expect(page(ORDER)).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('a 5xx read throws (error.tsx), it does not render an empty grid', async () => {
    session.permissions = ['lab.result.read'];
    orderReply = () => HttpResponse.json({ type: 'about:blank', title: 'x', status: 500, code: 'common.internal' }, { status: 500 });
    const err = await page(ORDER).then(() => undefined, (e: unknown) => e);
    expect(err).toBeDefined();
    expect(String((err as Error)?.message)).not.toMatch(/Cannot find|Failed to (resolve|load)|NEXT_NOT_FOUND/);
    expect((err as { status?: number }).status).toBe(500);
  });

  it('route folder has page, error and loading', async () => {
    const { existsSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    for (const f of ['page.tsx', 'error.tsx', 'loading.tsx']) {
      expect(existsSync(fileURLToPath(new URL(`../../../app/(staff)/lab/orders/[order_id]/results/${f}`, import.meta.url))), f).toBe(true);
    }
  });
});
