// @vitest-environment jsdom
// HC-T20 — W3 Tube handovers (04-UI-UX §2.3, §4; 01-PRD US-12-2, US-12-5 (UI side); TRD H13, H14, H15; 07-SECURITY REQ-SEC-017, 050/051, 098; 08 A19 D-125). MSW plays the API.
// LD-140: kit components only; every status shows tone, icon and word. "scan flow test (kit BarcodeInput), confirm/discrepancy" is the plan row's test.
// ASSUMED contract (spec fixes folders + kit components; dispute via the writer if wrong):
//   * components/HandoversView.tsx exports `HandoversView({ handovers, centres, centreId, status, permissions, nextCursor? })` — handovers = H13 rows (HandoverSummaryDto[]).
//       DataTable columns: Handed over at · From · Tubes · Status · Open (row button "Open"). StatusChip(generic) + an svg icon + word in the Status cell:
//       pending "Waiting" (warning), confirmed "Received" (success), discrepancy "Missing tubes" (danger). Empty: "No handovers waiting at this centre."
//       Status filter (default Waiting) and centre select navigate with router.replace('?status=…&centre_id=…'). "Open" opens the HandoverDrawer for that row.
//   * components/HandoverDrawer.tsx exports `HandoverDrawer({ handover, isOpen, onClose })` (handover = the summary row) — Drawer width=lg; loads H14 (GET /handovers/{id}) on open.
//       Header "Handover from {name} · {n} tubes"; BarcodeInput label "Scan tube" (autofocus); items DataTable (Barcode · Specimen type · Received checkbox); live "Received {x} of {n}";
//       footer Button "Confirm handover". All ticked -> H15 at once; else ConfirmDialog "Mark {n} tubes as missing?" / "Missing tubes are flagged for the dispatcher."
//   * every write goes through features/homecollection/server/actions.ts -> POST /handovers/{id}/confirm with Bearer, If-Match = detail.version, Idempotency-Key,
//       body { items: [{ specimen_id, received }] } (exactly the handover's items); success => toast "Handover confirmed.", router.refresh(), onClose().
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { API, CENTRE, CENTRES, HV1, HV2, HV3, HV_ITEMS, P_RECEIVE, U, axeClean, detail, kathmandu, noRawCodes, problem, recorder, rowOf, userEvent, wrap, type Call } from './hc-t20.helpers';

const refresh = vi.hoisted(() => vi.fn());
const replace = vi.hoisted(() => vi.fn());
const onClose = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace, refresh, back: vi.fn() }),
  usePathname: () => '/homecollection/handovers',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: ['homecollection.handover.receive'], displayName: 'Synthetic Centre Staff', tenantCode: 'syn', roles: [], membershipId: U(9) } }),
  getRequestPathname: async () => '/homecollection/handovers',
}));

const calls: Call[] = [];
const rec = recorder(calls);
type R = () => Response | Promise<Response>;
let getOne: R, confirm: R;
const reset = () => {
  getOne = () => HttpResponse.json(detail(1));
  confirm = () => HttpResponse.json(detail(1, { status: 'confirmed', version: 3 }));
};
reset();
const api = setupServer(
  http.get(`${API}/handovers/:id`, async ({ request }) => { await rec(request); return getOne(); }),
  http.post(`${API}/handovers/:id/confirm`, async ({ request }) => { await rec(request); return confirm(); }),
);
beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-14T04:00:00Z')); });
afterEach(() => { vi.useRealTimers(); cleanup(); api.resetHandlers(); calls.length = 0; refresh.mockReset(); replace.mockReset(); onClose.mockReset(); reset(); });
afterAll(() => api.close());

const posts = () => calls.filter((c) => c.method === 'POST' && c.url.pathname.endsWith('/confirm'));
const mod = async <T,>(name: string) => (await import(/* @vite-ignore */ `../components/${name}`)) as T;
const drawer = async (h: unknown = HV1) => {
  const { HandoverDrawer } = await mod<{ HandoverDrawer: (p: any) => any }>('HandoverDrawer');
  wrap(<HandoverDrawer handover={h as never} isOpen onClose={onClose} />);
  const d = await screen.findByRole('dialog');
  await within(d).findByText('HCT200001'); // items loaded (H14)
  return d;
};
const scanBox = (d: HTMLElement) => within(d).getByLabelText('Scan tube') as HTMLInputElement;
const scan = async (d: HTMLElement, code: string) => { await userEvent.type(scanBox(d), `${code}{Enter}`); };
const ticked = (d: HTMLElement, barcode: string) => (within(rowOf(d, barcode)).getByRole('checkbox') as HTMLInputElement).checked;
const confirmBtn = (d: HTMLElement) => within(d).getByRole('button', { name: /^confirm handover$/i });
const counter = (d: HTMLElement) => /Received\s+(\d+)\s+of\s+(\d+)/.exec(d.textContent ?? '')?.slice(1, 3).map(Number);

describe('drawer content (§2.3; D-125: every field comes from the handover items themselves)', () => {
  it('loads H14 with Bearer; header "Handover from {name} · {n} tubes"; items show barcode and specimen type; live count "Received 0 of 3"', async () => {
    const d = await drawer();
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.url.pathname).toBe(`/v1/homecollection/handovers/${HV1.id}`);
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer jwt-synthetic');
    expect(within(d).getByRole('heading', { name: 'Handover from Test Phlebo 01 · 3 tubes' })).toBeTruthy();
    for (const i of HV_ITEMS) { const r = rowOf(d, i.barcode); expect(r.textContent).toMatch(new RegExp(i.specimen_type_code.replace('_', '[ _]'), 'i')); }
    expect(counter(d)).toEqual([0, 3]);
  });
  it('the BarcodeInput is labelled "Scan tube", focused on open, and accepts manual entry (allowManual)', async () => {
    const d = await drawer();
    expect(document.activeElement).toBe(scanBox(d));
    await scan(d, 'hct200002'); // typed by hand, lower case: the kit upper-cases and (allowManual) accepts it
    expect(ticked(d, 'HCT200002')).toBe(true);
  });
  it('the receiving centre never sees visit data: no visit id, no link to /homecollection/visits, and no call except /handovers (REQ-SEC-017, D-125)', async () => {
    const d = await drawer();
    for (const i of HV_ITEMS) { expect(d.textContent).not.toContain(i.visit_id); expect(d.textContent).not.toContain(i.specimen_id); }
    expect(d.querySelector('a[href*="/homecollection/visits"], a[href*="/visits/"]')).toBeNull();
    expect(calls.every((c) => c.url.pathname.includes('/handovers/'))).toBe(true);
  });
  it('H14 failure (404 / 403) shows a plain sentence, never a problem code, and offers no Confirm', async () => {
    getOne = () => problem('common.not_found', 404);
    const { HandoverDrawer } = await mod<{ HandoverDrawer: (p: any) => any }>('HandoverDrawer');
    wrap(<HandoverDrawer handover={HV1 as never} isOpen onClose={onClose} />);
    await screen.findByRole('dialog');
    await waitFor(() => expect(document.body.textContent).toMatch(/not found|no longer|couldn.t|could not|unavailable/i));
    noRawCodes();
    expect(screen.queryByRole('button', { name: /^confirm handover$/i })).toBeNull();
  });
  it('a11y: no axe violations with the drawer open', async () => { await drawer(); await axeClean(); });
});

describe('scan flow (US-12-2, kit BarcodeInput)', () => {
  it('scanning a barcode in this handover ticks its Received box and moves the live count', async () => {
    const d = await drawer();
    await scan(d, 'HCT200001');
    expect(ticked(d, 'HCT200001')).toBe(true);
    expect(ticked(d, 'HCT200002')).toBe(false);
    expect(counter(d)).toEqual([1, 3]);
    await scan(d, 'HCT200003');
    expect(counter(d)).toEqual([2, 3]);
  });
  it('an unknown barcode shows "This tube is not in this handover." and changes nothing', async () => {
    const d = await drawer();
    await scan(d, 'ZZZ999999');
    expect(within(d).getByText('This tube is not in this handover.')).toBeTruthy();
    expect(counter(d)).toEqual([0, 3]);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });
  it('the error clears on the next good scan', async () => {
    const d = await drawer();
    await scan(d, 'ZZZ999999');
    await scan(d, 'HCT200002');
    expect(within(d).queryByText('This tube is not in this handover.')).toBeNull();
    expect(counter(d)).toEqual([1, 3]);
  });
  it('a duplicate scan of a tube already received is ignored (count stays; no error, no untick)', async () => {
    const d = await drawer();
    await scan(d, 'HCT200001');
    await scan(d, 'HCT200001');
    expect(ticked(d, 'HCT200001')).toBe(true);
    expect(counter(d)).toEqual([1, 3]);
    expect(within(d).queryByText('This tube is not in this handover.')).toBeNull();
  });
  it('staff can tick and untick the Received checkbox by hand (the count follows)', async () => {
    const d = await drawer();
    await userEvent.click(within(rowOf(d, 'HCT200002')).getByRole('checkbox'));
    expect(counter(d)).toEqual([1, 3]);
    await userEvent.click(within(rowOf(d, 'HCT200002')).getByRole('checkbox'));
    expect(counter(d)).toEqual([0, 3]);
  });
  it('never logs a barcode value (kit rule, REQ-SEC-098): no console output while scanning, confirming or failing', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => {}));
    const d = await drawer();
    await scan(d, 'HCT200001');
    await scan(d, 'ZZZ999999');
    expect(spies.flatMap((s) => s.mock.calls.flat()).join(' ')).not.toMatch(/HCT2000|ZZZ9999/);
  });
});

// review HC-T20: toast assertions are scoped to status/alert regions, not document.body
const liveText = () => [...screen.queryAllByRole('status'), ...screen.queryAllByRole('alert')].map((e) => e.textContent).join(' ');

describe('confirm — all received (US-12-2 → status confirmed)', () => {
  const scanAll = async (d: HTMLElement) => { for (const i of HV_ITEMS) await scan(d, i.barcode); };
  it('Confirm handover posts H15 once: exactly the 3 items, all received:true; If-Match = version, Idempotency-Key, Bearer; no "missing" question; toast, refresh, close', async () => {
    const d = await drawer();
    await scanAll(d);
    await userEvent.click(confirmBtn(d));
    await waitFor(() => expect(posts()).toHaveLength(1));
    const c = posts()[0]!;
    expect(c.url.pathname).toBe(`/v1/homecollection/handovers/${HV1.id}/confirm`);
    expect(c.headers.get('authorization')).toBe('Bearer jwt-synthetic');
    expect(c.headers.get('if-match')).toMatch(/2/);
    expect(c.headers.get('idempotency-key')).toMatch(/^[A-Za-z0-9_.:-]{8,200}$/);
    expect(c.body.items).toEqual(HV_ITEMS.map((i) => ({ specimen_id: i.specimen_id, received: true })));
    expect(Object.keys(c.body).sort()).toEqual(['items']);
    expect(screen.queryByText(/as missing/i)).toBeNull();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(refresh).toHaveBeenCalled();
    expect(liveText()).toContain('Handover confirmed.');
  });
  it('Ctrl+Enter confirms (04-UI-UX §2.3 keyboard)', async () => {
    const d = await drawer();
    await scanAll(d);
    await userEvent.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() => expect(posts()).toHaveLength(1));
  });
  it('a double click is single-flight: one POST', async () => {
    const d = await drawer();
    await scanAll(d);
    await userEvent.dblClick(confirmBtn(d));
    await new Promise((r) => setTimeout(r, 50));
    expect(posts()).toHaveLength(1);
  });
});

describe('confirm — some tubes missing (US-12-2 → status discrepancy)', () => {
  it('with 2 of 3 received, Confirm handover asks "Mark 1 tubes as missing?" with the dispatcher note and does NOT post yet', async () => {
    const d = await drawer();
    await scan(d, 'HCT200001'); await scan(d, 'HCT200003');
    await userEvent.click(confirmBtn(d));
    const dlg = (await screen.findAllByRole('dialog')).at(-1)!;
    expect(within(dlg).getByText(/Mark 1 tubes? as missing\?/)).toBeTruthy();
    expect(within(dlg).getByText('Missing tubes are flagged for the dispatcher.')).toBeTruthy();
    expect(posts()).toHaveLength(0);
  });
  it('confirming that question posts H15 with the 2 received:true and the 1 received:false; same Idempotency-Key rules; toast "Handover confirmed."', async () => {
    confirm = () => HttpResponse.json(detail(1, { status: 'discrepancy', version: 3 }));
    const d = await drawer();
    await scan(d, 'HCT200001'); await scan(d, 'HCT200003');
    await userEvent.click(confirmBtn(d));
    const dlg = (await screen.findAllByRole('dialog')).at(-1)!;
    await userEvent.click(within(dlg).getByRole('button', { name: /mark|confirm|missing/i }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    const c = posts()[0]!;
    expect(c.body.items).toEqual([
      { specimen_id: HV_ITEMS[0]!.specimen_id, received: true },
      { specimen_id: HV_ITEMS[1]!.specimen_id, received: false },
      { specimen_id: HV_ITEMS[2]!.specimen_id, received: true },
    ]);
    expect(c.headers.get('idempotency-key')).toBeTruthy();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(liveText()).toContain('Handover confirmed.');
  });
  it('Cancel on the question posts nothing and keeps the drawer (and the scanned ticks) as they were', async () => {
    const d = await drawer();
    await scan(d, 'HCT200001');
    await userEvent.click(confirmBtn(d));
    const dlg = (await screen.findAllByRole('dialog')).at(-1)!;
    await userEvent.click(within(dlg).getByRole('button', { name: /^cancel$/i }));
    expect(posts()).toHaveLength(0);
    expect(onClose).not.toHaveBeenCalled();
    expect(counter(d)).toEqual([1, 3]);
  });
  it('nothing scanned at all: the question says all 3 tubes are missing (no silent "confirmed")', async () => {
    const d = await drawer();
    await userEvent.click(confirmBtn(d));
    const dlg = (await screen.findAllByRole('dialog')).at(-1)!;
    expect(within(dlg).getByText(/Mark 3 tubes as missing\?/)).toBeTruthy();
    expect(posts()).toHaveLength(0);
  });
});

describe('failures on confirm (07-SECURITY AB: replay, stale state)', () => {
  const scanAll = async (d: HTMLElement) => { for (const i of HV_ITEMS) await scan(d, i.barcode); };
  it('a retry after a 5xx re-sends the SAME Idempotency-Key and the same body (replay, not a second confirmation)', async () => {
    confirm = () => problem('common.internal', 500);
    const d = await drawer();
    await scanAll(d);
    await userEvent.click(confirmBtn(d));
    await waitFor(() => expect(posts()).toHaveLength(1));
    noRawCodes();
    expect(onClose).not.toHaveBeenCalled();
    confirm = () => HttpResponse.json(detail(1, { status: 'confirmed', version: 3 }));
    await userEvent.click(confirmBtn(d));
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(posts()[1]!.headers.get('idempotency-key')).toBe(posts()[0]!.headers.get('idempotency-key'));
    expect(posts()[1]!.body).toEqual(posts()[0]!.body);
  });
  it('409 version_conflict (someone else already confirmed) -> plain sentence, no raw code, drawer stays, no toast "confirmed"', async () => {
    confirm = () => problem('common.version_conflict', 409);
    const d = await drawer();
    await scanAll(d);
    await userEvent.click(confirmBtn(d));
    await waitFor(() => expect(document.body.textContent).toMatch(/already|changed|reload|refresh/i));
    noRawCodes();
    expect(onClose).not.toHaveBeenCalled();
    expect(liveText()).not.toContain('Handover confirmed.');
  });
  it('403 / validation errors are plain sentences too', async () => {
    confirm = () => problem('auth.forbidden', 403);
    const d = await drawer();
    await scanAll(d);
    await userEvent.click(confirmBtn(d));
    await waitFor(() => expect(posts()).toHaveLength(1));
    await waitFor(() => expect(document.body.textContent).toMatch(/permission|not allowed|access/i));
    noRawCodes();
  });
});

describe('an already-handled handover is read-only', () => {
  it.each([['confirmed', 'received'], ['discrepancy', 'missing']])('status %s: items show their outcome, no scan box, no Confirm button, nothing to POST', async (status, word) => {
    getOne = () => HttpResponse.json(detail(2, {
      status, version: 3, received_by_display: 'Test Centre Staff 01', received_at: '2026-11-14T03:40:00.000Z',
      items: HV_ITEMS.map((i, k) => ({ ...i, outcome: status === 'discrepancy' && k === 1 ? 'missing' : 'received' })),
    }));
    const { HandoverDrawer } = await mod<{ HandoverDrawer: (p: any) => any }>('HandoverDrawer');
    wrap(<HandoverDrawer handover={(status === 'confirmed' ? HV2 : HV3) as never} isOpen onClose={onClose} />);
    const d = await screen.findByRole('dialog');
    await within(d).findByText('HCT200001');
    expect(within(d).queryByLabelText('Scan tube')).toBeNull();
    expect(within(d).queryByRole('button', { name: /^confirm handover$/i })).toBeNull();
    expect(d.textContent).toMatch(new RegExp(word, 'i'));
    expect(d.textContent).toContain('Test Centre Staff 01');
    expect(d.textContent).toContain(kathmandu('2026-11-14T03:40:00.000Z').slice(0, 10));
  });
});

// ------------------------------------------------------------------ list
const list = async (o: { handovers?: unknown[]; status?: string; centreId?: string; permissions?: string[] } = {}) => {
  const { HandoversView } = await mod<{ HandoversView: (p: any) => any }>('HandoversView');
  return wrap(<HandoversView handovers={(o.handovers ?? [HV1, HV2, HV3]) as never} centres={CENTRES} centreId={o.centreId ?? CENTRE} status={o.status ?? 'pending'} permissions={o.permissions ?? P_RECEIVE} />);
};

describe('list (§2.3)', () => {
  it('title "Tube handovers"; table columns Handed over at · From · Tubes · Status; one row per handover with the phlebotomist, tube count and Kathmandu time', async () => {
    await list();
    expect(screen.getByRole('heading', { level: 1, name: /tube handovers/i })).toBeTruthy();
    const grid = screen.getByRole('grid');
    for (const h of ['Handed over at', 'From', 'Tubes', 'Status']) expect(within(grid).getByRole('columnheader', { name: new RegExp(h, 'i') })).toBeTruthy();
    const r = rowOf(grid, 'Test Phlebo 01');
    expect(r.textContent).toContain('3');
    expect(r.textContent).toContain(kathmandu(HV1.handed_over_at as string).slice(0, 10));
  });
  it('status chips carry tone, icon and word: Waiting (warning), Received (success), Missing tubes (danger)', async () => {
    await list();
    const grid = screen.getByRole('grid');
    for (const [who, word, tone] of [['Test Phlebo 01', 'Waiting', 'warning'], ['Test Phlebo 02', 'Received', 'success']] as const) {
      const cell = within(rowOf(grid, who)).getByText(word).closest('[role="gridcell"], td') as HTMLElement;
      expect(cell.querySelector('svg'), `${word} icon`).toBeTruthy();
      expect(cell.innerHTML, `${word} tone`).toMatch(new RegExp(tone));
    }
    const miss = within(grid).getAllByText('Missing tubes')[0]!.closest('[role="gridcell"], td') as HTMLElement;
    expect(miss.querySelector('svg')).toBeTruthy();
    expect(miss.innerHTML).toMatch(/danger/);
  });
  it('default filter is Waiting; empty state "No handovers waiting at this centre."', async () => {
    await list({ handovers: [] });
    expect(document.body.textContent).toContain('No handovers waiting at this centre.');
    expect(document.body.textContent).toMatch(/waiting/i);
  });
  it('picking another status or centre navigates with the whitelisted query (router.replace)', async () => {
    await list();
    await userEvent.click(screen.getByRole('button', { name: /status/i }));
    await userEvent.click(await screen.findByRole('option', { name: /received/i }));
    await waitFor(() => expect(replace).toHaveBeenCalled());
    expect(String(replace.mock.calls.at(-1)![0])).toMatch(/status=confirmed/);
  });
  it('Open on a row opens the drawer for that handover (H14) with the scan box focused', async () => {
    await list();
    await userEvent.click(within(rowOf(screen.getByRole('grid'), 'Test Phlebo 01')).getByRole('button', { name: /open/i }));
    const d = await screen.findByRole('dialog');
    await within(d).findByText('HCT200001');
    expect(calls[0]!.url.pathname).toBe(`/v1/homecollection/handovers/${HV1.id}`);
    expect(document.activeElement).toBe(scanBox(d));
  });
  it('a11y + no raw codes', async () => { await list(); await axeClean(); noRawCodes(); });
});
