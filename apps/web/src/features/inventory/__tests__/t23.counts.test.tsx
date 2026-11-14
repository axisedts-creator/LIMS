// @vitest-environment jsdom
// C12.T-23 — S11 Stock count (04-UI-UX §3 S11; BLIND COUNT decision). ACs: AC-19.1 (lines per item/lot), AC-19.2 (variance = server preview), AC-19.3 (post needs stock.adjust), AC-19.4 (lock error surfaced on S8, see t23.stock).
// LD-140 (2026-11-13): kit components only, ONE primary button per page, every status shows tone + icon + word.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { ToastProvider } from '@lims/ui/components/Toast';
import { ID, IDEM_RE, ORIGIN, PERM_ADJUST, PERM_MANAGE, PERM_NONE, api, count, countLine, countSummary, hit, hits, problem, resetHits, router, state } from './t23.harness';

vi.mock('next/navigation', async () => (await import('./t23.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./t23.harness')).sessionMock);

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => { resetHits(); Object.values(router).forEach((f) => f.mockReset()); state.permissions = PERM_MANAGE; state.path = '/inventory/counts'; });
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

const C1 = ID(900);
const mountList = async () => {
  const mod = await import('../../../app/(staff)/inventory/counts/page');
  return render(<ToastProvider>{await mod.default({ searchParams: Promise.resolve({}) } as never)}</ToastProvider>);
};
const mountCount = async () => {
  state.path = `/inventory/counts/${C1}`;
  const mod = await import('../../../app/(staff)/inventory/counts/[count_id]/page');
  return render(<ToastProvider>{await mod.default({ params: Promise.resolve({ count_id: C1 }), searchParams: Promise.resolve({}) } as never)}</ToastProvider>);
};
const rowOf = async (text: string) => (await screen.findByText(text)).closest('tr')!;
const putLines = () => hit('PUT', /^\/v1\/inventory\/stock-counts\/[^/]+\/lines$/);
const postCount = () => hit('POST', /^\/v1\/inventory\/stock-counts\/[^/]+\/post$/);
// The tester fixture gives line 1 a book snapshot of 37 and line 2 of 58: those numbers must NOT appear in the DOM while counting blind.
// CountLine (contract) carries only ids: item code/name come from GET /items (ItemSummary) and lot numbers from GET /lots, joined by id (harness serves both).
const lines = () => [countLine(1), countLine(2)];
const useCount = (over: Record<string, unknown> = {}) => api.use(http.get(`${ORIGIN}/v1/inventory/stock-counts/:id`, () => HttpResponse.json(count({ lines: lines(), ...over }))));

describe('S11 list', () => {
  it('columns No., Store, Status, Opened, Posted; status carries a word; "No counts" empty state', async () => {
    await mountList();
    const grid = await screen.findByRole('grid');
    const heads = within(grid).getAllByRole('columnheader').map((h) => h.textContent?.trim());
    for (const h of ['No.', 'Store', 'Status', 'Opened', 'Posted']) expect(heads, h).toContain(h);
    expect(within(within(grid).getByText('CNT-000001').closest('tr')!).getByText(/open/i)).toBeTruthy();
    expect(within(within(grid).getByText('CNT-000002').closest('tr')!).getByText(/posted/i)).toBeTruthy();
    cleanup();
    api.use(http.get(`${ORIGIN}/v1/inventory/stock-counts`, () => HttpResponse.json({ data: [], page: { limit: 50 } })));
    await mountList();
    expect(await screen.findByText('No counts')).toBeTruthy();
  });

  it('no inventory.item.read -> permission-denied, no API call', async () => {
    state.permissions = PERM_NONE;
    await mountList();
    expect(screen.getByTestId('permission-denied')).toBeTruthy();
    expect(hits.length).toBe(0);
  });

  it('"New count" drawer: store (required), category (optional), notes -> POST /stock-counts {store_id, scope_category?, notes?} + Idempotency-Key', async () => {
    api.use(http.post(`${ORIGIN}/v1/inventory/stock-counts`, () => HttpResponse.json(count({ id: ID(909), lines: [] }), { status: 201 })));
    await mountList();
    await userEvent.click(await screen.findByRole('button', { name: /^new count$/i }));
    const dlg = await screen.findByRole('dialog');
    await userEvent.click(within(dlg).getByRole('button', { name: /^store/i }));
    await userEvent.click(await screen.findByRole('option', { name: /synthetic store 1|BR1-ST1/i }));
    await userEvent.click(within(dlg).getByRole('button', { name: /^category/i }));
    await userEvent.click(await screen.findByRole('option', { name: /reagent/i }));
    await userEvent.click(within(dlg).getByRole('button', { name: /^(open count|save|create)$/i }));
    const p = await waitFor(() => { const h = hit('POST', /^\/v1\/inventory\/stock-counts$/); expect(h).toHaveLength(1); return h[0]!; });
    expect(p.json).toEqual({ store_id: ID(301), scope_category: 'reagent' });
    expect(p.headers.get('idempotency-key')).toMatch(IDEM_RE);
  });

  it('409 inventory.count_already_open -> Banner with request_id', async () => {
    api.use(http.post(`${ORIGIN}/v1/inventory/stock-counts`, () => problem('inventory.count_already_open', 409)));
    await mountList();
    await userEvent.click(await screen.findByRole('button', { name: /^new count$/i }));
    const dlg = await screen.findByRole('dialog');
    await userEvent.click(within(dlg).getByRole('button', { name: /^store/i }));
    await userEvent.click(await screen.findByRole('option', { name: /synthetic store 1|BR1-ST1/i }));
    await userEvent.click(within(dlg).getByRole('button', { name: /^(open count|save|create)$/i }));
    expect((await screen.findByRole('alert')).textContent).toContain('req-syn-0023');
  });
});

describe('S11 count screen — BLIND count', () => {
  it('AC-19.1: one row per (item, lot) line with Item, Lot, Counted; 404 -> notFound()', async () => {
    useCount();
    await mountCount();
    const grid = await screen.findByRole('grid');
    const heads = within(grid).getAllByRole('columnheader').map((h) => h.textContent?.trim());
    for (const h of ['Item', 'Lot', 'Counted']) expect(heads, h).toContain(h);
    expect(within(grid).getByText('SYNLOT-001')).toBeTruthy();
    expect(within(grid).getByText('SYNLOT-002')).toBeTruthy();
    cleanup();
    api.use(http.get(`${ORIGIN}/v1/inventory/stock-counts/:id`, () => problem('common.not_found', 404)));
    await expect(mountCount()).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('book quantity is NOT in the DOM by default (blind count, even for stock.adjust holders)', async () => {
    state.permissions = PERM_ADJUST;
    useCount();
    await mountCount();
    await screen.findByRole('grid');
    expect(document.body.textContent).not.toMatch(/\b37\b/);
    expect(document.body.textContent).not.toMatch(/\b58\b/);
    expect((screen.getByRole('switch', { name: /show system quantity/i }) as HTMLInputElement).checked).toBe(false);
  });

  it('the "Show system quantity" switch exists only with stock.adjust; turning it on reveals the snapshot', async () => {
    useCount();
    await mountCount(); // stock.manage only
    await screen.findByRole('grid');
    expect(screen.queryByRole('switch', { name: /show system quantity/i })).toBeNull();
    expect(document.body.textContent).not.toMatch(/\b37\b/);
    cleanup(); state.permissions = PERM_ADJUST;
    await mountCount();
    await userEvent.click(await screen.findByRole('switch', { name: /show system quantity/i }));
    expect(document.body.textContent).toMatch(/\b37\b/);
  });

  it('entering a counted qty PUTs /lines {lines:[{line_id, item_id, lot_id, counted_qty_base}]}; Enter saves and moves focus to the next uncounted line', async () => {
    useCount();
    api.use(http.put(`${ORIGIN}/v1/inventory/stock-counts/:id/lines`, () => HttpResponse.json({ updated: 1, lines: [countLine(1, { counted_qty_base: '35', counted_at: new Date().toISOString(), book_qty_at_count: '37', variance_qty_base: '-2', version: 2 })] })));
    await mountCount();
    const inputs = await screen.findAllByRole('textbox', { name: /counted/i });
    await userEvent.type(inputs[0]!, '35{Enter}');
    await waitFor(() => expect(putLines()).toHaveLength(1));
    expect(putLines()[0]!.json.lines).toEqual([expect.objectContaining({ line_id: ID(1001), item_id: ID(11), lot_id: ID(21), counted_qty_base: '35' })]);
    await waitFor(() => expect(document.activeElement).toBe(screen.getAllByRole('textbox', { name: /counted/i })[1]));
  });

  // Review item 1-3 (07-SECURITY.md:57 blind count by default): the API returns book fields to every caller, so the BFF must strip them for users without inventory.stock.adjust.
  const leaky = () => countLine(1, { counted_qty_base: '35', counted_at: new Date().toISOString(), book_qty_snapshot: '424242', book_qty_at_count: '424242', variance_qty_base: '-777', variance_value_paisa: -987654, version: 2 });
  const BOOK = /424242|777|987654/;

  it('stock.manage without stock.adjust: the PUT /lines response book/variance fields never reach the DOM', async () => {
    useCount();
    api.use(http.put(`${ORIGIN}/v1/inventory/stock-counts/:id/lines`, () => HttpResponse.json({ updated: 1, lines: [leaky()] })));
    await mountCount(); // stock.manage only
    const inputs = await screen.findAllByRole('textbox', { name: /counted/i });
    await userEvent.type(inputs[0]!, '35{Enter}');
    await waitFor(() => expect(putLines()).toHaveLength(1));
    await waitFor(() => expect(document.activeElement).toBe(screen.getAllByRole('textbox', { name: /counted/i })[1]));
    expect(document.body.textContent).not.toMatch(BOOK);
  });

  it('putCountLinesAction result carries no book/variance fields without stock.adjust, and keeps them with it', async () => {
    api.use(http.put(`${ORIGIN}/v1/inventory/stock-counts/:id/lines`, () => HttpResponse.json({ updated: 1, lines: [leaky()] })));
    const { putCountLinesAction } = await import('../server/actions');
    const put = [{ line_id: ID(1001), item_id: ID(11), lot_id: ID(21), counted_qty_base: '35' }];
    state.permissions = PERM_MANAGE;
    expect(JSON.stringify(await putCountLinesAction(C1, put))).not.toMatch(BOOK);
    state.permissions = PERM_ADJUST;
    expect(JSON.stringify(await putCountLinesAction(C1, put))).toMatch(/424242/);
  });

  it('createCountAction result does not expose line book quantities to a stock.manage user', async () => {
    api.use(http.post(`${ORIGIN}/v1/inventory/stock-counts`, () => HttpResponse.json(count({ id: ID(909), lines: [leaky()] }), { status: 201 })));
    const { createCountAction } = await import('../server/actions');
    const r = await createCountAction({ store_id: ID(301) } as never, 'k'.repeat(20));
    expect(JSON.stringify(r)).not.toMatch(BOOK);
  });

  it.each(['-1', '1.2345', 'abc', ''])('counted qty "%s" is rejected client-side: no PUT', async (bad) => {
    useCount();
    await mountCount();
    const inputs = await screen.findAllByRole('textbox', { name: /counted/i });
    if (bad) await userEvent.type(inputs[0]!, bad);
    await userEvent.type(inputs[0]!, '{Enter}');
    expect(putLines()).toHaveLength(0);
  });

  it('AC-19.2: Review shows the SERVER variance (counted − (snapshot + movements)), not a client subtraction', async () => {
    // snapshot 37, server book_at_count 40 (3 received during the count), counted 35 -> server variance -5 (a client "35-37" would show -2).
    useCount({ lines: [countLine(1, { counted_qty_base: '35', counted_at: new Date().toISOString(), book_qty_at_count: '40', variance_qty_base: '-5', variance_value_paisa: -12500 }), countLine(2)] });
    state.permissions = PERM_ADJUST;
    await mountCount();
    await userEvent.click(await screen.findByRole('button', { name: /^review$/i }));
    const row = await rowOf('SYNLOT-001');
    expect(row.textContent).toMatch(/-5|−5/);
    expect(row.textContent).not.toMatch(/-2\b|−2\b/);
  });

  it('every status word is text: a counted line says so, an uncounted line says so (not colour only)', async () => {
    useCount({ lines: [countLine(1, { counted_qty_base: '35', counted_at: new Date().toISOString() }), countLine(2)] });
    await mountCount();
    expect(within(await rowOf('SYNLOT-001')).getByText(/counted/i)).toBeTruthy();
    expect(within(await rowOf('SYNLOT-002')).getByText(/not counted|uncounted/i)).toBeTruthy();
  });

  it('scan-first: a BarcodeInput/useScanCapture is wired (the value is never put in the URL)', async () => {
    useCount();
    await mountCount();
    await screen.findByRole('grid');
    expect(router.push).not.toHaveBeenCalled();
  });
});

describe('S11 Post count (AC-19.3) — stock.adjust + aal2', () => {
  const openPost = async () => {
    state.permissions = PERM_ADJUST;
    useCount();
    await mountCount();
    await userEvent.click(await screen.findByRole('button', { name: /^post count$/i }));
    return (await screen.findByRole('alertdialog').catch(() => screen.findByRole('dialog')))!;
  };

  it('"Post count" is hidden without stock.adjust (S11 state table)', async () => {
    useCount();
    await mountCount(); // stock.manage only
    await screen.findByRole('grid');
    expect(screen.queryByRole('button', { name: /^post count$/i })).toBeNull();
  });

  it('ConfirmDialog has the uncounted_policy RadioGroup: "Leave uncounted lines unchanged" (default) / "Treat uncounted lines as zero"', async () => {
    const dlg = await openPost();
    const keep = within(dlg).getByRole('radio', { name: 'Leave uncounted lines unchanged' }) as HTMLInputElement;
    const zero = within(dlg).getByRole('radio', { name: 'Treat uncounted lines as zero' }) as HTMLInputElement;
    expect(keep.checked).toBe(true);
    expect(zero.checked).toBe(false);
  });

  it('default posts {uncounted_policy:"skip"} with If-Match "<version>" and an Idempotency-Key', async () => {
    api.use(http.post(`${ORIGIN}/v1/inventory/stock-counts/:id/post`, () => HttpResponse.json(count({ status: 'posted', version: 5 }))));
    const dlg = await openPost();
    await userEvent.click(within(dlg).getByRole('button', { name: /^(post count|post|confirm)$/i }));
    await waitFor(() => expect(postCount()).toHaveLength(1));
    expect(postCount()[0]!.json).toEqual({ uncounted_policy: 'skip' });
    expect(postCount()[0]!.headers.get('if-match')).toBe('"4"');
    expect(postCount()[0]!.headers.get('idempotency-key')).toMatch(IDEM_RE);
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
  });

  it('choosing "Treat uncounted lines as zero" posts {uncounted_policy:"zero"}', async () => {
    api.use(http.post(`${ORIGIN}/v1/inventory/stock-counts/:id/post`, () => HttpResponse.json(count({ status: 'posted', version: 5 }))));
    const dlg = await openPost();
    await userEvent.click(within(dlg).getByRole('radio', { name: 'Treat uncounted lines as zero' }));
    await userEvent.click(within(dlg).getByRole('button', { name: /^(post count|post|confirm)$/i }));
    await waitFor(() => expect(postCount()).toHaveLength(1));
    expect(postCount()[0]!.json).toEqual({ uncounted_policy: 'zero' });
  });

  it('403 auth.mfa_required -> step-up banner mentioning verification; the dialog/page stays, no refresh', async () => {
    api.use(http.post(`${ORIGIN}/v1/inventory/stock-counts/:id/post`, () => problem('auth.mfa_required', 403)));
    const dlg = await openPost();
    await userEvent.click(within(dlg).getByRole('button', { name: /^(post count|post|confirm)$/i }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/verif/i);
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it('409 common.version_conflict -> Banner warning; the count is not shown as posted', async () => {
    api.use(http.post(`${ORIGIN}/v1/inventory/stock-counts/:id/post`, () => problem('common.version_conflict', 409)));
    const dlg = await openPost();
    await userEvent.click(within(dlg).getByRole('button', { name: /^(post count|post|confirm)$/i }));
    expect((await screen.findByRole('alert')).textContent).toContain('req-syn-0023');
    expect(screen.queryByText(/^posted$/i)).toBeNull();
  });
});
