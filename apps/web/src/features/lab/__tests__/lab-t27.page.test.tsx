// C5.T-27 — page wiring for `/lab/status-board` (server component; node env, MSW). Synthetic data only. 04-UI-UX §3.11, 03-APP-FLOW §3.11 ("Date range (default today)"), 02-TRD §5.2 row 17.
// ASSUMED contract (dispute to rename): app/(staff)/lab/status-board/page.tsx default async Page({ searchParams }) → <StatusBoard centres initialRows initialRange permissions/> (components/StatusBoard.tsx, see lab-t27.board.test.tsx),
//   centres from GET /v1/identity/centres (active only, as the receive page), initialRows from GET /v1/lab/status-board?registered_at_from=…&registered_at_to=… (the range = "today": from ≤ now ≤ to, span ≤ 7 days,
//   both ISO UTC), permissions = session permissions. A failing centres read → centres [] ; a failing board read → initialRows [] (the screen then polls / shows its own error) — neither crashes the page.
//   No patient or order identifier in any URL (the board query carries only the range, centre_id, board_status, cursor, limit — REQ-SEC-098).
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { ReactElement } from 'react';
import { CENTRES, CENTRE_A, CENTRE_B, LAB, ORIGIN, calls, problem, rec, uuid } from './lab-t11.fixtures';

vi.mock('server-only', () => ({}));
const session = vi.hoisted(() => ({ permissions: ['lab.status_board.read'] as string[] }));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: session.permissions, displayName: 'Synthetic Front Desk', tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => '/lab/status-board',
}));
vi.mock('next/navigation', () => ({ redirect: vi.fn(), notFound: () => { throw new Error('NEXT_NOT_FOUND'); } }));
process.env.LIMS_ORIGIN_API = ORIGIN;

const ROW = { order_id: uuid(4, 7), registration_no: 'REG270007', patient_display: { full_name: 'Synthetic Patient 7', age_sex: '34Y/F', patient_code: 'P-SYN-7' }, centre_id: CENTRE_A,
  board_status: 'ready', rejected_specimens: 0, priority: 'routine' };
const api = setupServer(
  http.get(`${ORIGIN}/v1/identity/centres`, async ({ request }) => { await rec(request); return HttpResponse.json({ data: [...CENTRES.map((c) => ({ centre_id: c.id, name: c.name, is_active: true })), { centre_id: uuid(2, 9), name: 'Retired Lab', is_active: false }] }); }),
  http.get(`${LAB}/status-board`, async ({ request }) => { await rec(request); return HttpResponse.json({ data: [ROW], page: { limit: 50 } }); }),
);
beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
afterEach(() => { api.resetHandlers(); calls.length = 0; });
afterAll(() => api.close());

const render = async () => (await (await import('@/app/(staff)/lab/status-board/page')).default({ searchParams: Promise.resolve({}) })) as ReactElement;
const boardCalls = () => calls.filter((c) => c.url.pathname === '/v1/lab/status-board');

describe('/lab/status-board page', () => {
  it('renders <StatusBoard> with the loaded rows, active centres, the session permissions and a "today" range of at most 7 days', async () => {
    const el = await render();
    const { StatusBoard } = await import('../components/StatusBoard');
    expect(el.type).toBe(StatusBoard);
    const p = el.props as { centres: { id: string; name: string }[]; initialRows: unknown[]; initialRange: { from: string; to: string }; permissions: string[] };
    expect(p.initialRows).toEqual([ROW]);
    expect(p.centres.map((c) => c.id)).toEqual([CENTRE_A, CENTRE_B]);
    expect(p.permissions).toEqual(session.permissions);
    const from = Date.parse(p.initialRange.from), to = Date.parse(p.initialRange.to), now = Date.now();
    expect(Number.isNaN(from) || Number.isNaN(to)).toBe(false);
    expect(from).toBeLessThanOrEqual(now);
    expect(to).toBeGreaterThanOrEqual(now);
    expect(to - from).toBeLessThanOrEqual(7 * 24 * 3_600_000);
    expect(p.initialRange.from).toMatch(/Z$/);
    expect(p.initialRange.to).toMatch(/Z$/);
  });

  it('the board request carries the same range and nothing identifying (no patient, order or registration filter in the URL)', async () => {
    const el = await render();
    const range = (el.props as { initialRange: { from: string; to: string } }).initialRange;
    expect(boardCalls()).toHaveLength(1);
    const q = boardCalls()[0]!.url.searchParams;
    expect(q.get('registered_at_from')).toBe(range.from);
    expect(q.get('registered_at_to')).toBe(range.to);
    for (const k of q.keys()) expect(['registered_at_from', 'registered_at_to', 'centre_id', 'board_status', 'cursor', 'limit']).toContain(k);
    expect(boardCalls()[0]!.headers.get('authorization')).toBe('Bearer jwt-synthetic');
  });

  it('board read refused (403) → the page still renders the screen with no rows (no crash)', async () => {
    api.use(http.get(`${LAB}/status-board`, async ({ request }) => { await rec(request); return problem(403, 'auth.forbidden', 'Forbidden'); }));
    const el = await render();
    expect((el.props as { initialRows: unknown[] }).initialRows).toEqual([]);
  });

  it('identity centres read refused → centres is an empty list, not an exception', async () => {
    api.use(http.get(`${ORIGIN}/v1/identity/centres`, async ({ request }) => { await rec(request); return problem(403, 'auth.forbidden', 'Forbidden'); }));
    const el = await render();
    expect((el.props as { centres: unknown[] }).centres).toEqual([]);
    expect((el.props as { initialRows: unknown[] }).initialRows).toEqual([ROW]);
  });
});
