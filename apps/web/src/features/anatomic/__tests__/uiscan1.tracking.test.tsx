// @vitest-environment jsdom
// T0D-UISCAN-1 (2) anatomic block and slide tracking /anatomic/tracking — LD-353 template 3 SCAN (rules 5, 6, 8). Scan handling, calls and shortcuts do not change (t20.tracking stays the proof).
// done_when under test (Lookup tab): ScanPanel with the scan input in .lims-scan-input; the looked-up block or slide is the last scan result card (.lims-scan-result);
//   basket mode: the basket DataTable is the queue (.lims-scan-queue), header row and EmptyState shown also when empty; h1 = menu label; at most one FilterBar; Basket mode stays a switch.
// Not required here (judgement): the single-lookup view has no queue table; the Sent out tab is a list (header row always shown), not a scan screen.
// Harness: t20.harness (MSW plays the anatomic API; the page.tsx server component runs for real).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { ToastProvider } from '@lims/ui/components/Toast';
import { ID, ORIGIN, PERM_READ, PERM_WORK, api, block, movement, page, problem, resetHits, router, slide, state, t20Defaults, workedCase } from './t20.harness';
import { expectScanScreen, menuLabel, norm, queue, resultCard } from '../../lab/__tests__/uiscan1.helpers';

vi.mock('next/navigation', async () => (await import('./t20.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./t20.harness')).sessionMock);

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => { resetHits(); router.push.mockReset(); state.permissions = PERM_WORK; api.use(...t20Defaults, ...lookups()); });
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

const CASE = ID(1);
const A1 = 'SP26-000042-A1';
const A2 = 'SP26-000042-A2';
const caseWithMaterial = () => workedCase({
  blocks: [block(1, { location_status: 'stored', location_text: 'Synthetic cabinet 7', slide_count: 1 }), block(2)],
  slides: [slide(1, { location_status: 'in_lab' })],
});
function lookups() {
  return [
    http.post(`${ORIGIN}/v1/anatomic/cases/lookup`, async ({ request }) => {
      const { label } = (await request.clone().json()) as { label: string };
      if (label === A1) return HttpResponse.json({ object_kind: 'block', case_id: CASE, block_id: ID(201) });
      if (label === A2) return HttpResponse.json({ object_kind: 'block', case_id: CASE, block_id: ID(202) });
      return problem('common.not_found', 404);
    }),
    http.get(`${ORIGIN}/v1/anatomic/cases/:id`, () => HttpResponse.json(caseWithMaterial())),
    http.get(`${ORIGIN}/v1/anatomic/blocks/:id/movements`, () => page([movement(1, { movement: 'stored', location_text: 'Synthetic cabinet 7', at: '2026-11-10T11:00:00.000Z' })])),
  ];
}

const mount = async (sp: Record<string, string | undefined> = {}) => {
  const mod = await import('../../../app/(staff)/anatomic/tracking/page');
  const el = await mod.default({ searchParams: Promise.resolve(sp) } as never);
  return render(<ToastProvider>{el}</ToastProvider>);
};
const field = () => screen.getByRole('textbox', { name: /scan or type/i });
const scan = async (v: string) => { await userEvent.type(field(), `${v}{Enter}`); };
const text = (el: Element | null) => norm(el?.textContent);

describe('Lookup tab', () => {
  it('no scan yet: ScanPanel with the scan input first, h1 = menu label, Basket mode is a switch, no result card, no queue table (single lookup)', async () => {
    const { container } = await mount();
    expectScanScreen(container, { title: '/anatomic/tracking', queue: false });
    expect(screen.getByRole('switch', { name: /basket mode/i })).toBeTruthy();
    expect(resultCard(container)).toBeNull();
    expect(screen.getByRole('tab', { name: /^lookup$/i }).getAttribute('aria-selected')).toBe('true');
  });

  it('one scan: the result card holds the label, the case link and the current location; the panel order stays input, card', async () => {
    const { container } = await mount();
    await scan(A1);
    await waitFor(() => expect(resultCard(container)).toBeTruthy());
    const card = resultCard(container)!;
    await waitFor(() => expect(text(card)).toContain('Synthetic cabinet 7'));
    expect(text(card)).toContain(A1);
    expect(within(card).getByRole('link', { name: /SP26-000042$/ }).getAttribute('href')).toBe(`/anatomic/cases/${CASE}`);
    expectScanScreen(container, { title: '/anatomic/tracking', queue: false });
  });

  it('unknown label: the result card holds the not-found text, the title and the panel stay', async () => {
    const { container } = await mount();
    await scan('SP26-999999-A9');
    await waitFor(() => expect(text(resultCard(container))).toContain('No block or slide with this label.'));
    expectScanScreen(container, { title: '/anatomic/tracking', queue: false });
  });

  it('basket mode, empty: the basket is the queue; header Label / Type / Current location and "The basket is empty" are shown', async () => {
    const { container } = await mount();
    await userEvent.click(screen.getByRole('switch', { name: /basket mode/i }));
    expectScanScreen(container, { title: '/anatomic/tracking', headers: ['Label', 'Type', 'Current location'] });
    expect(text(queue(container))).toMatch(/The basket is empty/);
  });

  it('basket mode, two scans: both rows sit in the queue below the panel input, the header stays, Record movement stays the one primary button', async () => {
    const { container } = await mount();
    await userEvent.click(screen.getByRole('switch', { name: /basket mode/i }));
    await scan(A1);
    await waitFor(() => expect(within(queue(container)!).getByText(A1)).toBeTruthy());
    await scan(A2);
    await waitFor(() => expect(within(queue(container)!).getByText(A2)).toBeTruthy());
    expectScanScreen(container, { title: '/anatomic/tracking', headers: ['Label', 'Type', 'Current location'] });
    expect((screen.getByRole('button', { name: /record movement/i }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('a reader without anatomic.case.work: same ScanPanel, no Basket switch, no Record movement', async () => {
    state.permissions = PERM_READ;
    const { container } = await mount();
    expectScanScreen(container, { title: '/anatomic/tracking', queue: false });
    expect(screen.queryByRole('switch', { name: /basket mode/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /record movement/i })).toBeNull();
  });
});

describe('Sent out tab', () => {
  it('keeps the title and a table whose header row is shown also when nothing is sent out', async () => {
    api.use(http.get(`${ORIGIN}/v1/anatomic/blocks`, () => page([])));
    const { container } = await mount({ tab: 'sent_out' });
    expect([...container.querySelectorAll('h1')].map((h) => norm(h.textContent))).toEqual([menuLabel('/anatomic/tracking')]);
    for (const h of ['Label', 'Case', 'Sent to', 'Since', 'Reason']) expect(screen.getByRole('columnheader', { name: new RegExp(`^${h}`) }), h).toBeTruthy();
    expect(container.querySelector('.lims-table-scroll'), 'table in the kit scroll box').toBeTruthy();
  });
});
