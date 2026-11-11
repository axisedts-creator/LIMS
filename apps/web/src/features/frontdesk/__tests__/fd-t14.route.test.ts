// FD-T14 review item 1 — the Preview link on the order page (/frontdesk/trf-attachments/{id}/content) must be served by a web route
// that streams F21a through the BFF (US-FD-09.4; 04-UI-UX §4 "preview (F21a)"). The browser never sees a Storage URL.
// ASSUMED path (mirrors billing/exports/[export_id]/content/route.ts): apps/web/src/app/(staff)/frontdesk/trf-attachments/[attachment_id]/content/route.ts exporting GET(req, {params: Promise<{attachment_id}>}).
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { ORIGIN, U } from './fd-t14.fixtures';

vi.mock('server-only', () => ({}));
let token: string | null = 'jwt-synthetic';
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => token,
  getShellSession: async () => ({ actor: { permissions: [], displayName: 'Synthetic Reception', tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => '/frontdesk/trf-attachments',
}));
process.env.LIMS_ORIGIN_API = ORIGIN;

const ID = U(40);
const upstream: { url: URL; auth: string | null }[] = [];
const problem = (status: number, code: string) => HttpResponse.json({ type: 'about:blank', title: code, status, code }, { status, headers: { 'content-type': 'application/problem+json' } });
const api = setupServer();
beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
afterEach(() => { api.resetHandlers(); upstream.length = 0; token = 'jwt-synthetic'; });
afterAll(() => api.close());

const GET = async (id: string) => {
  const m = (await import(/* @vite-ignore */ '../../../app/(staff)/frontdesk/trf-attachments/[attachment_id]/content/route')) as { GET: (r: Request, c: { params: Promise<{ attachment_id: string }> }) => Promise<Response> };
  return m.GET(new Request(`http://localhost/frontdesk/trf-attachments/${id}/content`), { params: Promise.resolve({ attachment_id: id }) });
};
const serve = (res: () => Response) => api.use(http.get(`${ORIGIN}/v1/frontdesk/trf-attachments/:id/content`, ({ request }) => { upstream.push({ url: new URL(request.url), auth: request.headers.get('authorization') }); return res(); }));

describe('GET /frontdesk/trf-attachments/[attachment_id]/content (F21a proxy)', () => {
  it('clean file: streams the bytes with the session bearer, attachment disposition, nosniff, no-store', async () => {
    serve(() => new HttpResponse(new Uint8Array([0x25, 0x50, 0x44, 0x46]), { status: 200, headers: { 'content-type': 'application/pdf' } }));
    const r = await GET(ID);
    expect(r.status).toBe(200);
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(new Uint8Array([0x25, 0x50, 0x44, 0x46]));
    expect(r.headers.get('content-type')).toBe('application/pdf');
    expect(r.headers.get('content-disposition')).toMatch(/^attachment/i);
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('cache-control')).toMatch(/no-store/);
    expect(upstream).toHaveLength(1);
    expect(upstream[0]!.url.pathname).toBe(`/v1/frontdesk/trf-attachments/${ID}/content`);
    expect(upstream[0]!.auth).toBe('Bearer jwt-synthetic');
  });

  it('a non-UUID id is rejected without calling the API (no path injection)', async () => {
    serve(() => new HttpResponse(new Uint8Array([1]), { status: 200 }));
    for (const bad of ['not-a-uuid', '..%2F..%2Fadmin', `${ID}/../x`]) expect((await GET(bad)).status).toBe(400);
    expect(upstream).toHaveLength(0);
  });

  it('unknown attachment (404) → 404; quarantined (422 common.upload_quarantined) → non-200 and the file body is never returned', async () => {
    serve(() => problem(404, 'common.not_found'));
    expect((await GET(ID)).status).toBe(404);
    api.resetHandlers();
    serve(() => problem(422, 'common.upload_quarantined'));
    const r = await GET(ID);
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.headers.get('content-type') ?? '').not.toMatch(/pdf|image/);
  });

  it('no session token → non-200 and no upstream call', async () => {
    token = null;
    serve(() => new HttpResponse(new Uint8Array([1]), { status: 200 }));
    expect((await GET(ID)).status).toBeGreaterThanOrEqual(400);
    expect(upstream).toHaveLength(0);
  });
});
