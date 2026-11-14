// @vitest-environment jsdom
// C11.T-19 — route pages + page states (04-UI-UX §4.1, §4.2; 03-APP-FLOW §4.1/§4.2; AC-13.1; REQ-SEC-026/027, REQ-SEC-081).
// "all page states": populated · empty · loading · error · forbidden · not-found. Server components are awaited directly and their element rendered (MSW plays the API).
// ASSUMED: pages are async server components with no nested async children; 403 -> a no-access state (no data), 404/400 -> notFound(), other failures reject (error.tsx).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { ToastProvider } from '@lims/ui/components/Toast';
import { ID, ORIGIN, PERM_NONE, PERM_READ, PERM_WORK, api, detail, hit, hits, page, problem, resetHits, router, state, summary } from './t19.harness';

vi.mock('next/navigation', async () => (await import('./t19.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./t19.harness')).sessionMock);

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => { resetHits(); router.push.mockReset(); state.permissions = PERM_READ; });
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

const worklist = async (sp: Record<string, string | string[] | undefined> = {}) => {
  const mod = await import('../../../app/(staff)/anatomic/page');
  const el = await mod.default({ searchParams: Promise.resolve(sp) } as never);
  return render(<ToastProvider>{el}</ToastProvider>);
};
const casePage = async (case_id: string) => {
  const mod = await import('../../../app/(staff)/anatomic/cases/[case_id]/page');
  const el = await mod.default({ params: Promise.resolve({ case_id }) } as never);
  return render(<ToastProvider>{el}</ToastProvider>);
};
const listCalls = () => hit('GET', /^\/v1\/anatomic\/cases$/);

describe('worklist page /anatomic', () => {
  it('AC-13.1: default tab is "To accession" -> GET /v1/anatomic/cases?queue=to_accession, page size 50, server order (urgent first, oldest first)', async () => {
    api.use(http.get(`${ORIGIN}/v1/anatomic/cases`, () => page([summary(2, { priority: 'urgent' }), summary(1)])));
    await worklist();
    const [c, ...rest] = listCalls();
    expect(rest).toHaveLength(0);
    const q = new URLSearchParams(c!.search);
    expect(q.get('queue')).toBe('to_accession');
    expect(q.get('limit') ?? '50').toBe('50');
    expect(q.get('sort') ?? 'priority_received_at').toBe('priority_received_at');
    expect(q.has('centre_id')).toBe(false); // centre scoping is the server's job (AC-13.2); the UI never widens or invents it
    expect(screen.getAllByRole('link', { name: /^SP26-/ }).map((l) => l.textContent)).toEqual(['SP26-000002', 'SP26-000001']);
    expect(screen.getByRole('tab', { name: /^to accession/i }).getAttribute('aria-selected')).toBe('true');
  });

  it.each(['grossing', 'bench', 'reporting', 'awaiting_lab', 'signed_out', 'cancelled', 'all'])('?queue=%s is forwarded', async (queue) => {
    await worklist({ queue });
    expect(new URLSearchParams(listCalls()[0]!.search).get('queue')).toBe(queue);
  });

  it('unknown / array queue values fall back to to_accession (nothing user-controlled reaches the API)', async () => {
    await worklist({ queue: 'drop table cases' });
    cleanup(); // registry.ts rightly throws on a duplicate page shortcut
    await worklist({ queue: ['all', 'grossing'] });
    for (const c of listCalls()) expect(new URLSearchParams(c.search).get('queue')).toBe('to_accession');
  });

  it('forwards only whitelisted, well-formed filters (case_kind, centre_id, priority, assigned_pathologist, received_at_from/to, sort, cursor)', async () => {
    await worklist({
      queue: 'all', case_kind: 'histology,molecular', centre_id: `${ID(2)},${ID(9)}`, priority: 'urgent', assigned_pathologist: 'me',
      received_at_from: '2026-11-01T00:00:00.000Z', received_at_to: '2026-11-08T00:00:00.000Z', sort: '-received_at', cursor: 'abc_DEF-1',
      evil: '1', label: 'SP26-000001', tenant_id: ID(99),
    });
    const q = new URLSearchParams(listCalls()[0]!.search);
    expect(Object.fromEntries(q)).toMatchObject({ case_kind: 'histology,molecular', centre_id: `${ID(2)},${ID(9)}`, priority: 'urgent', assigned_pathologist: 'me', sort: '-received_at', cursor: 'abc_DEF-1' });
    for (const k of ['evil', 'label', 'tenant_id']) expect(q.has(k), k).toBe(false);
  });

  it.each([
    ['case_kind', 'histology;drop'], ['centre_id', 'not-a-uuid'], ['priority', 'critical'], ['assigned_pathologist', 'someone'],
    ['received_at_from', 'yesterday'], ['sort', 'password'], ['cursor', '../../etc'],
  ])('a malformed %s (%s) is dropped, not forwarded', async (key, value) => {
    await worklist({ queue: 'all', [key]: value });
    expect(new URLSearchParams(listCalls()[0]!.search).has(key)).toBe(false);
  });

  it('passes the opaque next_cursor to the screen (Next control appears)', async () => {
    api.use(http.get(`${ORIGIN}/v1/anatomic/cases`, () => page([summary(1)], 'cur_1')));
    await worklist();
    expect(screen.getByRole('button', { name: /next|more/i })).toBeTruthy();
  });

  it('empty queue renders the empty state, not an error', async () => {
    api.use(http.get(`${ORIGIN}/v1/anatomic/cases`, () => page([])));
    await worklist();
    expect(document.body.textContent).toContain('Nothing to accession');
  });

  it('403 from the API -> no-access state: no table, no tabs, no case data (REQ-SEC-081)', async () => {
    api.use(http.get(`${ORIGIN}/v1/anatomic/cases`, () => problem('auth.forbidden', 403)));
    await worklist();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
    expect(document.body.textContent).toMatch(/permission|access/i);
  });

  it.each([500, 503])('%i from the API rejects so error.tsx renders (no partial table)', async (status) => {
    api.use(http.get(`${ORIGIN}/v1/anatomic/cases`, () => problem('common.internal', status)));
    await expect(worklist()).rejects.toBeTruthy();
  });

  it('401 (no session token) never calls the API with an empty bearer', async () => {
    state.token = undefined;
    try { await worklist().catch(() => undefined); } finally { state.token = 'jwt-synthetic'; }
    for (const c of hits) expect(c.headers.get('authorization') ?? 'Bearer x').not.toMatch(/^Bearer\s*$|undefined/);
  });

  it('every request carries the bearer from the session (server side), never from the URL', async () => {
    await worklist();
    expect(listCalls()[0]!.headers.get('authorization')).toBe('Bearer jwt-synthetic');
  });
});

describe('case workspace page /anatomic/cases/{case_id}', () => {
  it('GET /v1/anatomic/cases/{uuid} and renders the workspace (title = accession)', async () => {
    api.use(http.get(`${ORIGIN}/v1/anatomic/cases/:id`, () => HttpResponse.json(detail({ accession_no: 'SP26-000555' }))));
    state.permissions = PERM_WORK;
    await casePage(ID(1));
    expect(hit('GET', new RegExp(`^/v1/anatomic/cases/${ID(1)}$`))).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1, name: /SP26-000555/ })).toBeTruthy();
  });

  it.each(['abc', '../../x', `${ID(1)}/../${ID(2)}`, '12345', ID(1).toUpperCase().replace(/-/g, '')])('malformed id %s -> notFound() and no API call (REQ-SEC-026/027)', async (id) => {
    await expect(casePage(id)).rejects.toThrow('NEXT_NOT_FOUND');
    expect(hits).toHaveLength(0);
  });

  it('404 from the API -> notFound() (a UUID of another tenant/centre looks the same as a missing one)', async () => {
    api.use(http.get(`${ORIGIN}/v1/anatomic/cases/:id`, () => problem('common.not_found', 404)));
    await expect(casePage(ID(1))).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('403 -> no-access state, no case data in the DOM', async () => {
    api.use(http.get(`${ORIGIN}/v1/anatomic/cases/:id`, () => problem('auth.forbidden', 403)));
    await casePage(ID(1));
    expect(document.body.textContent).not.toContain('Synthetic Patient');
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
  });

  it('500 rejects so error.tsx renders', async () => {
    api.use(http.get(`${ORIGIN}/v1/anatomic/cases/:id`, () => problem('common.internal', 500)));
    await expect(casePage(ID(1))).rejects.toBeTruthy();
  });

  it('loads gross text templates with the page (GET /text-templates?section=gross) — only for holders of anatomic.case.work', async () => {
    state.permissions = PERM_WORK;
    await casePage(ID(1));
    expect(hit('GET', /text-templates$/).map((h) => new URLSearchParams(h.search).get('section'))).toContain('gross');
    resetHits();
    cleanup();
    state.permissions = PERM_READ;
    await casePage(ID(1));
    expect(hit('GET', /text-templates$/)).toHaveLength(0);
  });

  it('a failing template list does not break the page (templates are a convenience)', async () => {
    api.use(http.get(`${ORIGIN}/v1/anatomic/text-templates`, () => problem('common.internal', 500)));
    state.permissions = PERM_WORK;
    await casePage(ID(1));
    expect(screen.getAllByRole('tab').length).toBeGreaterThan(0);
  });
});

describe('loading.tsx / error.tsx (page states)', () => {
  it('loading.tsx renders a LoadingSkeleton (busy region, no data)', async () => {
    const { default: Loading } = await import('../../../app/(staff)/anatomic/loading');
    render(<Loading />);
    expect(document.querySelector('[aria-busy="true"],[role="progressbar"],.lims-skeleton')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/Synthetic/);
  });

  it('error.tsx: "We couldn\'t load cases." + reference (digest), Retry calls reset(); never shows error.message', async () => {
    const { default: ErrorPage } = await import('../../../app/(staff)/anatomic/error');
    const reset = vi.fn();
    const err = Object.assign(new Error('secret stack detail'), { digest: 'REF-1234' });
    render(<ErrorPage error={err} reset={reset} />);
    expect(document.body.textContent).toContain("We couldn't load cases.");
    expect(document.body.textContent).toContain('REF-1234');
    expect(document.body.textContent).not.toContain('secret stack detail');
    await userEvent.click(screen.getByRole('button', { name: /^retry$/i }));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('PERM_NONE sanity: the permission fixtures differ (guards the 403 tests above)', () => {
    expect(PERM_NONE).toHaveLength(0);
    expect(PERM_WORK).toContain('anatomic.case.work');
    expect(PERM_READ).not.toContain('anatomic.case.work');
  });
});
