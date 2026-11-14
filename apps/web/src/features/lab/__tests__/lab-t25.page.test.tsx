// C5.T-25 — page wiring for `/lab/qc` (server component; node env, MSW). 04-UI-UX §1 nav row `QC results /lab/qc lab.qc.capture`, §3.12 (centre = Select of the user's centres, instrument = Select of the C7 list, 08 A13 D-14).
// ASSUMED contract: app/(staff)/lab/qc/page.tsx default async Page() → <QcResultsPage permissions centres instruments/> (components/qc/QcResultsPage.tsx, see lab-t25.qc.test.tsx),
//   permissions = session permissions; centres = GET /v1/identity/centres (active only, { id, name } as the receive / status-board pages); instruments = GET /v1/instruments/instruments mapped to { id, name: display_name }.
//   Without `lab.qc.capture` the page calls notFound(). A failing centres or instruments read → [] for that prop (neither crashes the page). The list itself is read by the client component, so the page makes no QC read.
//   Sibling folders error.tsx / loading.tsx exist like every other lab route.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { ReactElement } from 'react';
import { CENTRES, ORIGIN, calls, problem, rec, uuid } from './lab-t11.fixtures';

vi.mock('server-only', () => ({}));
const session = vi.hoisted(() => ({ permissions: ['lab.qc.capture'] as string[] }));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: session.permissions, displayName: 'Synthetic Technologist', tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => '/lab/qc',
}));
vi.mock('next/navigation', () => ({ redirect: vi.fn(), notFound: () => { throw new Error('NEXT_NOT_FOUND'); } }));
process.env.LIMS_ORIGIN_API = ORIGIN;

const INSTR = [{ id: uuid(6, 1), display_name: 'Synthetic Analyser 1', instrument_code: 'SYN-A1', centre_id: CENTRES[0]!.id, state: 'live' }, { id: uuid(6, 2), display_name: 'Synthetic Analyser 2', instrument_code: 'SYN-A2', centre_id: CENTRES[1]!.id, state: 'live' }];
let centresReply: () => Response, instrumentsReply: () => Response;
const api = setupServer(
  http.get(`${ORIGIN}/v1/identity/centres`, async ({ request }) => { await rec(request); return centresReply(); }),
  http.get(`${ORIGIN}/v1/instruments/instruments`, async ({ request }) => { await rec(request); return instrumentsReply(); }),
);
beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
afterEach(() => { api.resetHandlers(); calls.length = 0; session.permissions = ['lab.qc.capture']; });
afterAll(() => api.close());
const ok = () => {
  centresReply = () => HttpResponse.json({ data: [...CENTRES.map((c) => ({ centre_id: c.id, name: c.name, is_active: true })), { centre_id: uuid(2, 9), name: 'Retired Lab', is_active: false }] });
  instrumentsReply = () => HttpResponse.json({ data: INSTR, page: { limit: 50 } });
};

const render = async () => (await (await import('@/app/(staff)/lab/qc/page')).default()) as ReactElement;
const dir = fileURLToPath(new URL('../../../app/(staff)/lab/qc/', import.meta.url));

describe('/lab/qc page', () => {
  it('renders <QcResultsPage> with the session permissions, the user\'s ACTIVE centres and the instruments as { id, name }; makes no QC read itself', async () => {
    ok();
    const el = await render();
    const { QcResultsPage } = await import('../components/qc/QcResultsPage');
    expect(el.type).toBe(QcResultsPage);
    const p = el.props as { permissions: string[]; centres: Array<{ id: string; name: string }>; instruments: Array<{ id: string; name: string }> };
    expect(p.permissions).toEqual(['lab.qc.capture']);
    expect(p.centres.map((c) => c.id)).toEqual(CENTRES.map((c) => c.id));
    expect(p.centres.map((c) => c.name)).not.toContain('Retired Lab');
    expect(p.instruments).toEqual(INSTR.map((i) => ({ id: i.id, name: i.display_name })));
    expect(calls.some((c) => /\/v1\/lab\//.test(c.url.pathname))).toBe(false);
  });

  it('a session without lab.qc.capture gets notFound() and makes no read (the nav hides the route; a direct URL must not render it)', async () => {
    ok();
    session.permissions = ['lab.worklist.read', 'lab.result.read'];
    await expect(render()).rejects.toThrow('NEXT_NOT_FOUND');
    expect(calls).toHaveLength(0);
  });

  it('a refused centres read gives centres [] and a refused instruments read gives instruments [] — the page still renders', async () => {
    centresReply = () => problem(403, 'auth.forbidden', 'Forbidden');
    instrumentsReply = () => problem(403, 'auth.forbidden', 'Forbidden');
    const el = await render();
    expect((el.props as { centres: unknown[] }).centres).toEqual([]);
    expect((el.props as { instruments: unknown[] }).instruments).toEqual([]);
  });

  it('the route folder carries page.tsx, error.tsx and loading.tsx like its siblings', () => {
    for (const f of ['page.tsx', 'error.tsx', 'loading.tsx']) expect(existsSync(`${dir}${f}`), f).toBe(true);
  });
});
