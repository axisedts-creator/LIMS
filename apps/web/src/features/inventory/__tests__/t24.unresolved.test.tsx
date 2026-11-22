// @vitest-environment jsdom
// C12.T-24 — S15 Waiting consumption (04-UI-UX §3 S15). ACs: AC-12.9 (unresolved fact -> admin resolves to a store -> movements written with the original business date; the server does the posting, the UI calls #77),
// TRD #75 list, #77 resolve, #78 dismiss (reason group fact_dismiss). Gate: resolve/dismiss need inventory.master.manage; the page needs inventory.item.read.
// LD-140 (2026-11-13): kit components only, ONE primary button per page (S15 has none: row actions are secondary), every status shows tone + icon + word.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import type { ReactNode } from 'react';
import { ToastProvider } from '@lims/ui/components/Toast';
import { actionBar, detailPane } from '../../../__tests__/uiconsole1.helpers';
import { ID, IDEM_RE, ORIGIN, PERM_MANAGE, PERM_NONE, PERM_READ, api, fact, hit, hits, page, problem, resetHits, router, state } from './t24.harness';

vi.mock('next/navigation', async () => (await import('./t24.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./t24.harness')).sessionMock);

beforeAll(() => api.listen({ onUnhandledFrame: 'error' }));
beforeEach(() => { resetHits(); Object.values(router).forEach((f) => f.mockReset()); state.permissions = PERM_MANAGE; state.path = '/inventory/unresolved'; });
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

const mount = async (sp: Record<string, string | undefined> = {}) => {
  const mod = await import('../../../app/(staff)/inventory/unresolved/page');
  return render(<ToastProvider>{await (mod.default as unknown as (p: unknown) => Promise<ReactNode>)({ searchParams: Promise.resolve(sp) })}</ToastProvider>);
};
// T0D-UICONSOLE-1: the queue is the console list (a table); the row actions live in the sticky bar of the SELECTED record.
const rowOf = async (text: RegExp) => (await within(await screen.findByRole('grid')).findByText(text)).closest('tr') as HTMLElement;
const barOf = async (text: RegExp) => { await userEvent.click(await rowOf(text)); return actionBar(document.body) as HTMLElement; };
const resolves = () => hit('POST', /^\/v1\/inventory\/consumption-facts\/[^/]+\/resolve$/);
const dismisses = () => hit('POST', /^\/v1\/inventory\/consumption-facts\/[^/]+\/dismiss$/);

describe('S15 gating', () => {
  it('without inventory.item.read: permission-denied, no API call', async () => {
    state.permissions = PERM_NONE;
    await mount();
    expect(screen.getByTestId('permission-denied')).toBeTruthy();
    expect(hits.length).toBe(0);
  });
  it('read-only: the queue is visible but "Post to store…" and "Dismiss" are hidden', async () => {
    state.permissions = PERM_READ;
    await mount();
    await userEvent.click(await rowOf(/BIO-1|analyser 1/i));
    expect(screen.queryByRole('button', { name: /post to store/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^dismiss$/i })).toBeNull();
  });
});

describe('S15 queue (TRD #75)', () => {
  it('asks the API for status=unresolved only', async () => {
    await mount();
    await screen.findByRole('grid');
    expect(new URLSearchParams(hit('GET', /^\/v1\/inventory\/consumption-facts$/)[0]!.search).get('status')).toBe('unresolved');
  });
  it('header copy is verbatim', async () => {
    await mount();
    expect(await screen.findByText('These deductions could not be posted because no store is linked to the analyser and no default store is set.')).toBeTruthy();
  });
  it('columns Occurred, Kind, Analyser, Test, Reason; the reason is the TEXT "No store found"; ids are joined to names', async () => {
    await mount();
    const grid = await screen.findByRole('grid');
    const heads = within(grid).getAllByRole('columnheader').map((h) => h.textContent?.trim());
    for (const h of ['Occurred', 'Kind', 'Analyser', 'Test']) expect(heads, h).toContain(h);
    const r1 = grid.querySelectorAll('tbody tr')[0] as HTMLElement;
    expect(r1.textContent).toMatch(/BIO-1|analyser 1/i);
    expect(r1.textContent).toMatch(/GLU|glucose/i);
    await userEvent.click(r1); // the Reason (a TEXT chip) is a fact of the detail now, not a column
    expect(detailPane(document.body)!.textContent).toContain('Reason');
    expect(detailPane(document.body)!.textContent).toContain('No store found');
    expect(document.body.textContent).not.toContain(ID(950)); // never a raw id
  });
  it('a fact without an analyser (manual QC) shows a dash, not "undefined"', async () => {
    await mount();
    const grid = await screen.findByRole('grid');
    expect(grid.textContent).not.toMatch(/undefined|null/);
  });
  it('empty state: "Nothing waiting"', async () => {
    api.use(http.get(`${ORIGIN}/v1/inventory/consumption-facts`, () => page([])));
    await mount();
    expect(await screen.findByText('Nothing waiting')).toBeTruthy();
  });
  it('API failure -> alert with request id', async () => {
    api.use(http.get(`${ORIGIN}/v1/inventory/consumption-facts`, () => problem('common.internal', 500)));
    await mount();
    expect((await screen.findByRole('alert')).textContent).toContain('req-syn-0024');
  });
  it('cursor paging: "Load more" requests the next cursor and appends rows', async () => {
    let n = 0;
    api.use(http.get(`${ORIGIN}/v1/inventory/consumption-facts`, ({ request }) => {
      n += 1;
      return new URL(request.url).searchParams.get('cursor') ? page([fact(5, { test_id: ID(71) })]) : page([fact(1)], 'CUR2');
    }));
    await mount();
    await screen.findByRole('grid');
    await userEvent.click(await screen.findByRole('button', { name: /load more|next/i }));
    await waitFor(() => expect(n).toBe(2));
    expect(new URLSearchParams(hit('GET', /consumption-facts$/)[1]!.search).get('cursor')).toBe('CUR2');
  });
});

describe('S15 Post to store… (TRD #77; AC-12.9)', () => {
  it('Select store (from GET /stores) -> POST /consumption-facts/{id}/resolve {store_id} + Idempotency-Key; row leaves the queue; toast', async () => {
    api.use(http.post(`${ORIGIN}/v1/inventory/consumption-facts/:id/resolve`, () => HttpResponse.json(fact(1, { status: 'posted', store_id: ID(301) }))));
    await mount();
    await userEvent.click(within(await barOf(/BIO-1|analyser 1/i)).getByRole('button', { name: /post to store/i }));
    const dlg = (await screen.findByRole('dialog')) as HTMLElement;
    await userEvent.click(within(dlg).getByRole('button', { name: /^store/i }));
    await userEvent.click(await screen.findByRole('option', { name: /synthetic store 1/i }));
    await userEvent.click(within(dlg).getByRole('button', { name: /^(post|save|confirm)/i }));
    await waitFor(() => expect(resolves()).toHaveLength(1));
    expect(resolves()[0]!.path).toBe(`/v1/inventory/consumption-facts/${ID(851)}/resolve`);
    expect(resolves()[0]!.json).toEqual({ store_id: ID(301) });
    expect(resolves()[0]!.headers.get('idempotency-key')).toMatch(IDEM_RE);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(router.refresh.mock.calls.length + hit('GET', /consumption-facts$/).length).toBeGreaterThan(1); // the queue is re-read
  });
  it('without choosing a store nothing is sent', async () => {
    await mount();
    await userEvent.click(within(await barOf(/BIO-1|analyser 1/i)).getByRole('button', { name: /post to store/i }));
    const dlg = (await screen.findByRole('dialog')) as HTMLElement;
    await userEvent.click(within(dlg).getByRole('button', { name: /^(post|save|confirm)/i }));
    expect(resolves()).toHaveLength(0);
  });
  it.each([['auth.forbidden', 403], ['inventory.document_invalid_transition', 409]])('%s -> alert with request id; the dialog stays open', async (code, status) => {
    api.use(http.post(`${ORIGIN}/v1/inventory/consumption-facts/:id/resolve`, () => problem(code, status)));
    await mount();
    await userEvent.click(within(await barOf(/BIO-1|analyser 1/i)).getByRole('button', { name: /post to store/i }));
    const dlg = (await screen.findByRole('dialog')) as HTMLElement;
    await userEvent.click(within(dlg).getByRole('button', { name: /^store/i }));
    await userEvent.click(await screen.findByRole('option', { name: /synthetic store 1/i }));
    await userEvent.click(within(dlg).getByRole('button', { name: /^(post|save|confirm)/i }));
    expect((await within(dlg).findByRole('alert')).textContent).toContain('req-syn-0024');
  });
});

describe('S15 Dismiss (TRD #78)', () => {
  it('reasons come from /coded-sets/reasons?reason_group=fact_dismiss; submit POSTs /dismiss {reason_code} with Idempotency-Key', async () => {
    api.use(http.post(`${ORIGIN}/v1/inventory/consumption-facts/:id/dismiss`, () => HttpResponse.json(fact(1, { status: 'dismissed' }))));
    await mount();
    await userEvent.click(within(await barOf(/BIO-1|analyser 1/i)).getByRole('button', { name: /^dismiss$/i }));
    const dlg = (await screen.findByRole('dialog')) as HTMLElement;
    await userEvent.click(within(dlg).getByRole('button', { name: /^reason/i }));
    expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual(expect.arrayContaining(['Not consumed', 'Duplicate entry', 'Test instrument', 'Other']));
    await userEvent.click(screen.getByRole('option', { name: 'Duplicate entry' }));
    await userEvent.click(within(dlg).getByRole('button', { name: /^(dismiss|confirm|save)/i }));
    await waitFor(() => expect(dismisses()).toHaveLength(1));
    expect(dismisses()[0]!.json).toEqual({ reason_code: 'duplicate_entry' });
    expect(dismisses()[0]!.headers.get('idempotency-key')).toMatch(IDEM_RE);
    expect(new URLSearchParams(hit('GET', /coded-sets\/reasons$/)[0]!.search).get('reason_group')).toBe('fact_dismiss');
  });
  it('the reason is required (inventory.reason_required): nothing is sent without it', async () => {
    await mount();
    await userEvent.click(within(await barOf(/BIO-1|analyser 1/i)).getByRole('button', { name: /^dismiss$/i }));
    const dlg = (await screen.findByRole('dialog')) as HTMLElement;
    await userEvent.click(within(dlg).getByRole('button', { name: /^(dismiss|confirm|save)/i }));
    expect(dismisses()).toHaveLength(0);
  });
  it('server-side inventory.reason_required -> alert with request id', async () => {
    api.use(http.post(`${ORIGIN}/v1/inventory/consumption-facts/:id/dismiss`, () => problem('inventory.reason_required', 400)));
    await mount();
    await userEvent.click(within(await barOf(/BIO-1|analyser 1/i)).getByRole('button', { name: /^dismiss$/i }));
    const dlg = (await screen.findByRole('dialog')) as HTMLElement;
    await userEvent.click(within(dlg).getByRole('button', { name: /^reason/i }));
    await userEvent.click(await screen.findByRole('option', { name: 'Other' }));
    await userEvent.click(within(dlg).getByRole('button', { name: /^(dismiss|confirm|save)/i }));
    expect((await within(dlg).findByRole('alert')).textContent).toContain('req-syn-0024');
  });
});
