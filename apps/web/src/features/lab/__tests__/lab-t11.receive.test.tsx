// @vitest-environment jsdom
// C5.T-11 — Receive screen `/lab/receive` (04-UI-UX §3.3, 03-APP-FLOW §3.3). done_when: keyboard-only flows pass; scanner simulation (fast keystrokes + Enter); UI kit defaults.
// ACs: AC-04.1 (scan + accept → receiveSpecimen with the chosen centre), AC-04.2 (unknown barcode), AC-04.3 (rejected/discarded → lab.specimen_not_receivable),
//      AC-04.4 (auto-accept: five scans → five receives in scan order, each row its own outcome), AC-05.1 (reject dialog → rejectSpecimen; new barcode shown), AC-03.2 (unverified-barcode warning).
// Security: REQ-SEC-028/098 (barcode only in POST bodies; storage holds the non-PHI centre id only).
// ASSUMED module/prop contract (spec fixes folders + copy + kit components only; raise a dispute to rename):
//   components/ReceiveScreen.tsx  export ReceiveScreen({ centres, rejectionReasons, recollectionDefault, permissions })
//        centres: {id, name}[] (centres in the actor's scope)   rejectionReasons: {code, display}[] (active `rejection_reasons`, coded set #53)   recollectionDefault: boolean (LabSettingsDto.recollection_default)
//        Top bar: Select labelled "Receiving location" (required; value remembered per workstation in localStorage — the centre id only) and Switch labelled "Auto-accept" (role=switch).
//        BarcodeInput (label contains "barcode"; kit defaults, useScanCapture enabled while no dialog is open) autofocused and re-focused after every action.
//        Card for the looked-up specimen: barcode, registration no, specimen type, test codes; Banner texts per 04-UI-UX §3.3; buttons "Accept", "Reject", (after accept) "Aliquot", "Open specimen".
//        Accept = Enter on the screen when the BarcodeInput is empty. Session log = table; one row per outcome (barcode · "Received" / "Rejected" / "Error: {title}"), newest first, last 50 kept in memory.
//        Reject dialog (role=dialog): title "Reject specimen {barcode}"; RadioGroup of reasons; TextArea "Comment" ≤500; Checkbox "Request recollection" (default = recollectionDefault); confirm "Reject".
//        While a dialog is open the screen passes `enabled: false` to useScanCapture; a scan then announces "Close the dialog before scanning" in an aria-live region.
//   server/actions.ts: lookup POST /specimens/lookup, receive POST /specimens/{id}/receive {processing_centre_id}, reject POST /specimens/{id}/reject.
// NOT tested (spec silent / needs layout or heavy fixtures): Aliquot dialog (T-08 covers the API; dialog is T-12+ scope in the plan row), "Open specimen" navigation target, single-key R/A/O shortcuts
//   (the BarcodeInput holds focus, so the key binding is unspecified), patient display on the card (SpecimenDto carries no patient field — spec gap, see notes), print-labels button after aliquots.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { delay, http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { ReactNode } from 'react';
import { ToastProvider } from '@lims/ui/components/Toast';
import { BC, CENTRES, CENTRE_A, CENTRE_B, LAB, ORIGIN, REASONS, REG, SP, calls, lookups, problem, rec, receives, rejects, specimen } from './lab-t11.fixtures';

const push = vi.fn();
const replace = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace, refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/lab/receive',
  useSearchParams: () => new URLSearchParams(''),
  notFound: () => { throw Object.assign(new Error('NEXT_NOT_FOUND'), { digest: 'NEXT_HTTP_ERROR_FALLBACK;404' }); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: ['lab.specimen.receive', 'lab.specimen.reject', 'lab.specimen.read'], displayName: 'Synthetic Tech', tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => '/lab/receive',
}));
process.env.LIMS_ORIGIN_API = ORIGIN;

const PERMS = ['lab.specimen.receive', 'lab.specimen.reject', 'lab.specimen.read'];
const NEW_BC = 'SYN0009999';
const db = new Map<string, Record<string, unknown>>(); // barcode → specimen DTO served by the lookup handler
const seed = (...list: Record<string, unknown>[]) => { db.clear(); for (const s of list) db.set(s.barcode as string, s); };

const api = setupServer(
  http.post(`${LAB}/specimens/lookup`, async ({ request }) => {
    await rec(request);
    const { barcode } = (await request.clone().json()) as { barcode?: string };
    const s = barcode ? db.get(barcode) : undefined;
    return s ? HttpResponse.json(s) : problem(404, 'common.not_found', 'Not found');
  }),
  http.post(`${LAB}/specimens/:id/receive`, async ({ request, params }) => {
    await rec(request);
    const s = [...db.values()].find((x) => x.id === params['id']);
    if (!s) return problem(404, 'common.not_found', 'Not found');
    if (['rejected', 'discarded'].includes(s.status as string)) return problem(409, 'lab.specimen_not_receivable', 'Specimen not receivable');
    const { processing_centre_id } = (await request.clone().json()) as { processing_centre_id: string };
    return HttpResponse.json({ ...s, version: (s.version as number) + 1, status: 'received', processing_centre_id, received_at: '2026-11-11T05:00:00.000Z' });
  }),
  http.post(`${LAB}/specimens/:id/reject`, async ({ request, params }) => {
    await rec(request);
    const s = [...db.values()].find((x) => x.id === params['id'])!;
    const b = (await request.clone().json()) as { recollection_required: boolean };
    return HttpResponse.json({
      specimen: { ...s, version: (s.version as number) + 1, status: b.recollection_required ? 'recollection_ordered' : 'rejected' },
      ...(b.recollection_required ? { recollection_specimen: specimen(99, { barcode: NEW_BC, replaces_specimen_id: s.id }) } : {}),
    });
  }),
);
beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
afterEach(() => { cleanup(); api.resetHandlers(); calls.length = 0; db.clear(); push.mockReset(); replace.mockReset(); localStorage.clear(); sessionStorage.clear(); });
afterAll(() => api.close());

const wrap = (ui: ReactNode) => render(<ToastProvider>{ui}</ToastProvider>);
const show = async (props: Record<string, unknown> = {}) => {
  const { ReceiveScreen } = await import('../components/ReceiveScreen');
  return wrap(<ReceiveScreen centres={CENTRES} rejectionReasons={REASONS} recollectionDefault={false} permissions={PERMS} {...(props as object)} />);
};
const text = (root: HTMLElement = document.body) => root.textContent ?? '';
const bodyHas = (s: string | RegExp) => (typeof s === 'string' ? text().includes(s) : s.test(text()));
const noAxeViolations = async () => {
  const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } });
  expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
};
const box = () => screen.getByLabelText(/barcode/i) as HTMLInputElement;
const kb = () => userEvent.setup({ delay: null });
const scan = async (value: string) => { await kb().type(box(), `${value}{Enter}`); };
/** Select a receiving location through the kit Select (button → option); works for native <select> too. */
const chooseCentre = async (name: string) => {
  const sel = screen.getByLabelText(/receiving location/i);
  if (sel.tagName === 'SELECT') { await userEvent.selectOptions(sel, name); return; }
  await userEvent.click(screen.getAllByRole('button', { name: /receiving location/i })[0] ?? sel);
  await userEvent.click(await screen.findByRole('option', { name: new RegExp(name) }));
};
const logRow = (bc: string) => screen.getByRole('row', { name: new RegExp(bc) });
const dialog = () => screen.getByRole('dialog');

describe('top bar + kit defaults', () => {
  it('shows the receiving-location Select (required), the Auto-accept switch (off) and an autofocused BarcodeInput; rendering calls nothing', async () => {
    await show();
    expect(screen.getByLabelText(/receiving location/i)).toBeTruthy();
    const sw = screen.getByRole('switch', { name: /auto-accept/i });
    expect(sw.getAttribute('aria-checked')).toBe('false');
    expect(document.activeElement).toBe(box());
    expect(calls).toHaveLength(0);
  });

  it('the chosen receiving location is remembered per workstation in localStorage — only the centre id, nothing else', async () => {
    const first = await show();
    await chooseCentre('Synthetic Satellite Lab');
    first.unmount();
    expect(JSON.stringify({ ...localStorage })).toContain(CENTRE_B);
    seed(specimen(1, { status: 'collected' }));
    await show();
    await scan(BC(1));
    await screen.findByText(BC(1));
    await kb().keyboard('{Enter}');
    await waitFor(() => expect(receives()).toHaveLength(1));
    expect(receives()[0]!.body).toEqual({ processing_centre_id: CENTRE_B }); // restored without choosing again
    const stored = JSON.stringify({ ...localStorage });
    expect(stored).not.toContain(BC(1));
    expect(stored).not.toContain(REG);
  });

  it('kit defaults: a value outside the barcode pattern → kit invalid message, nothing looked up', async () => {
    await show();
    await kb().type(box(), 'not a barcode!{Enter}');
    expect(await screen.findByText("This doesn't look like a sample barcode")).toBeTruthy();
    expect(lookups()).toHaveLength(0);
  });

  it('kit defaults: lower-case + padded scan is normalised; duplicate within 1,500 ms looked up once', async () => {
    seed(specimen(1, { status: 'collected' }));
    await show();
    await kb().type(box(), ` ${BC(1).toLowerCase()} {Enter}`);
    await kb().type(box(), `${BC(1)}{Enter}`);
    await waitFor(() => expect(lookups()).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 100));
    expect(lookups()).toHaveLength(1);
    expect(lookups()[0]!.body).toEqual({ barcode: BC(1) });
  });

  it('axe', async () => {
    await show();
    await noAxeViolations();
  });
});

describe('AC-04.1 — scan, card, accept', () => {
  it('scanner simulation (fast keystrokes + Enter) → ONE lookup POST {barcode}; card shows barcode, registration no, type and tests', async () => {
    seed(specimen(1, { status: 'collected', tests: [{ test_id: SP(70), test_code: 'HBA1C' }, { test_id: SP(71), test_code: 'LIPID' }] }));
    await show();
    await scan(BC(1));
    await waitFor(() => expect(lookups()).toHaveLength(1));
    const c = lookups()[0]!;
    expect(c.body).toEqual({ barcode: BC(1) });
    expect(c.url.search).toBe('');
    expect(c.headers.get('authorization')).toBe('Bearer jwt-synthetic');
    await screen.findByText(BC(1));
    for (const s of [REG, 'HBA1C', 'LIPID']) expect(bodyHas(s)).toBe(true);
    expect(bodyHas(/serum/i)).toBe(true);
    expect(receives()).toHaveLength(0); // not auto-accept: nothing received until Accept
  });

  it('document-level capture: a scan with focus outside any field (useScanCapture) is looked up', async () => {
    seed(specimen(1, { status: 'collected' }));
    await show();
    (document.activeElement as HTMLElement | null)?.blur();
    for (const ch of BC(1)) fireEvent.keyDown(document.body, { key: ch });
    fireEvent.keyDown(document.body, { key: 'Enter' });
    await waitFor(() => expect(lookups()).toHaveLength(1));
    expect(lookups()[0]!.body).toEqual({ barcode: BC(1) });
  });

  it.each([['collected'], ['in_transit']])('a %s specimen: Accept → receiveSpecimen {processing_centre_id = chosen centre}; log row "Received"; focus back on the BarcodeInput', async (status) => {
    seed(specimen(1, { status }));
    await show();
    await chooseCentre('Synthetic Central Lab');
    await scan(BC(1));
    await screen.findByText(BC(1));
    await userEvent.click(screen.getByRole('button', { name: /^accept/i }));
    await waitFor(() => expect(receives()).toHaveLength(1));
    const c = receives()[0]!;
    expect(c.url.pathname).toBe(`/v1/lab/specimens/${SP(1)}/receive`);
    expect(c.body).toEqual({ processing_centre_id: CENTRE_A });
    expect(c.url.search).toBe('');
    await waitFor(() => expect(text(logRow(BC(1)))).toMatch(/Received/));
    await waitFor(() => expect(document.activeElement).toBe(box()));
  });

  it('KEYBOARD ONLY: choose location with the keyboard, scan, Enter accepts — no pointer event', async () => {
    seed(specimen(1, { status: 'collected' }));
    await show();
    const k = kb();
    const sel = screen.getByLabelText(/receiving location/i);
    if (sel.tagName === 'SELECT') await k.selectOptions(sel, 'Synthetic Central Lab');
    else { (sel as HTMLElement).focus(); await k.keyboard('{Enter}'); await k.keyboard('{ArrowDown}{Enter}'); }
    box().focus();
    await k.type(box(), `${BC(1)}{Enter}`);
    await screen.findByText(BC(1));
    box().focus();
    await k.keyboard('{Enter}'); // Accept (Enter) — spec 04-UI-UX §3.3
    await waitFor(() => expect(receives()).toHaveLength(1));
    expect(receives()[0]!.body.processing_centre_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('without a receiving location Accept does nothing (location is required): no receive request', async () => {
    seed(specimen(1, { status: 'collected' }));
    await show();
    await scan(BC(1));
    await screen.findByText(BC(1));
    const accept = screen.getByRole('button', { name: /^accept/i });
    fireEvent.click(accept);
    await kb().keyboard('{Enter}');
    await new Promise((r) => setTimeout(r, 60));
    expect(receives()).toHaveLength(0);
  });

  it('double Enter while the receive is in flight sends ONE receive', async () => {
    seed(specimen(1, { status: 'collected' }));
    api.use(http.post(`${LAB}/specimens/:id/receive`, async ({ request }) => {
      await rec(request); await delay(120);
      return HttpResponse.json({ ...specimen(1), status: 'received' });
    }));
    await show();
    await chooseCentre('Synthetic Central Lab');
    await scan(BC(1));
    await screen.findByText(BC(1));
    await kb().keyboard('{Enter}{Enter}');
    await new Promise((r) => setTimeout(r, 250));
    expect(receives()).toHaveLength(1);
  });
});

describe('AC-04.2 / AC-04.3 — unknown, rejected, discarded', () => {
  it('AC-04.2 unknown barcode → "No specimen with this barcode in your lab."; nothing changes (no card, no log row, no receive)', async () => {
    seed();
    await show();
    await scan('SYN8888888');
    await waitFor(() => expect(lookups()).toHaveLength(1));
    expect(await screen.findByText('No specimen with this barcode in your lab.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^accept/i })).toBeNull();
    expect(screen.queryByRole('row', { name: /SYN8888888/ })).toBeNull();
    expect(receives()).toHaveLength(0);
  });

  it('AC-04.3 discarded specimen: Accept → 409 lab.specimen_not_receivable shown as its own log outcome "Error: Specimen not receivable"', async () => {
    seed(specimen(1, { status: 'discarded' }));
    await show();
    await chooseCentre('Synthetic Central Lab');
    await scan(BC(1));
    await screen.findByText(BC(1));
    await kb().keyboard('{Enter}');
    await waitFor(() => expect(text(logRow(BC(1)))).toContain('Error: Specimen not receivable'));
  });

  it('rejected specimen scanned → warning "Rejected on {date}: {reason}" is shown on the card', async () => {
    seed(specimen(1, { status: 'rejected', rejected_at: '2026-11-10T04:30:00.000Z', rejection_reason_code: 'haemolysed' }));
    await show();
    await scan(BC(1));
    await screen.findByText(BC(1));
    expect(bodyHas(/Rejected on/)).toBe(true);
    expect(bodyHas(/haemolysed/i)).toBe(true);
  });

  it('inactive specimen (order cancelled) → "Order cancelled — do not process" and Accept cannot be used', async () => {
    seed(specimen(1, { status: 'collected', is_active: false }));
    await show();
    await chooseCentre('Synthetic Central Lab');
    await scan(BC(1));
    await screen.findByText(BC(1));
    expect(bodyHas('Order cancelled — do not process')).toBe(true);
    const accept = screen.queryByRole('button', { name: /^accept/i });
    if (accept) { fireEvent.click(accept); }
    await kb().keyboard('{Enter}');
    await new Promise((r) => setTimeout(r, 60));
    expect(receives()).toHaveLength(0);
  });

  it('AC-03.2 unverified collection barcode (home collection) → warning "Collection barcode was not verified on the phlebotomy app"', async () => {
    seed(specimen(1, { status: 'in_transit', collection_barcode_unverified: true }));
    await show();
    await scan(BC(1));
    await screen.findByText(BC(1));
    expect(bodyHas('Collection barcode was not verified on the phlebotomy app')).toBe(true);
  });
});

describe('AC-04.4 — auto-accept: five scans in a row, five receives in scan order, own outcome per row', () => {
  it('toggle on → each scan receives immediately, in SCAN order even when lookups resolve out of order; one failure shows only on its own row', async () => {
    seed(...[1, 2, 3, 4, 5].map((n) => specimen(n, { status: 'collected' })), specimen(6, { status: 'collected' }));
    db.set(BC(3), specimen(3, { status: 'discarded' })); // third scan → 409 on its own row
    api.use(http.post(`${LAB}/specimens/lookup`, async ({ request }) => {
      await rec(request);
      const { barcode } = (await request.clone().json()) as { barcode: string };
      const n = Number(barcode.slice(-1));
      await delay((6 - n) * 25); // later scans answer FIRST
      const s = db.get(barcode);
      return s ? HttpResponse.json(s) : problem(404, 'common.not_found', 'Not found');
    }));
    await show();
    await chooseCentre('Synthetic Central Lab');
    await userEvent.click(screen.getByRole('switch', { name: /auto-accept/i }));
    const k = kb();
    for (let n = 1; n <= 5; n++) await k.type(box(), `${BC(n)}{Enter}`); // all five typed without awaiting any response
    await waitFor(() => expect(receives()).toHaveLength(5), { timeout: 5000 });
    expect(receives().map((c) => c.url.pathname)).toEqual([1, 2, 3, 4, 5].map((n) => `/v1/lab/specimens/${SP(n)}/receive`));
    for (const c of receives()) expect(c.body).toEqual({ processing_centre_id: CENTRE_A });
    for (const n of [1, 2, 4, 5]) await waitFor(() => expect(text(logRow(BC(n)))).toMatch(/Received/));
    await waitFor(() => expect(text(logRow(BC(3)))).toContain('Error: Specimen not receivable'));
    expect(text(logRow(BC(1)))).not.toMatch(/Error/);
  });

  it('auto-accept off by default: a scan alone never receives', async () => {
    seed(specimen(1, { status: 'collected' }));
    await show();
    await chooseCentre('Synthetic Central Lab');
    await scan(BC(1));
    await screen.findByText(BC(1));
    await new Promise((r) => setTimeout(r, 80));
    expect(receives()).toHaveLength(0);
  });

  it('the session log keeps the last 50 rows only (in memory: nothing persisted)', async () => {
    const all = Array.from({ length: 52 }, (_, i) => specimen(i + 1, { status: 'collected', barcode: `SYN${String(1000 + i + 1).padStart(7, '0')}`, id: SP(i + 1) }));
    seed(...all);
    await show();
    await chooseCentre('Synthetic Central Lab');
    await userEvent.click(screen.getByRole('switch', { name: /auto-accept/i }));
    const k = kb();
    for (const s of all) await k.type(box(), `${s.barcode as string}{Enter}`);
    await waitFor(() => expect(receives()).toHaveLength(52), { timeout: 20000 });
    await waitFor(() => expect(screen.queryByRole('row', { name: new RegExp(all[51]!.barcode as string) })).not.toBeNull(), { timeout: 5000 });
    expect(screen.queryByRole('row', { name: new RegExp(all[0]!.barcode as string) })).toBeNull(); // oldest dropped
    expect(screen.queryByRole('row', { name: new RegExp(all[1]!.barcode as string) })).toBeNull();
    expect(screen.getByRole('row', { name: new RegExp(all[2]!.barcode as string) })).toBeTruthy(); // 50th newest kept
    expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toContain('SYN000');
  }, 40000);
});

describe('AC-05.1 — reject dialog (UI side; the one-transaction semantics are T-08 API tests)', () => {
  const openReject = async (n = 1, o: Record<string, unknown> = {}) => {
    seed(specimen(n, { status: 'received', ...o }));
    await chooseCentre('Synthetic Central Lab');
    await scan(BC(n));
    await screen.findByText(BC(n));
    await userEvent.click(screen.getByRole('button', { name: /^reject/i }));
    return screen.findByRole('dialog');
  };

  it('dialog: title "Reject specimen {barcode}", reasons as radios, Comment textarea, "Request recollection" checkbox default = recollectionDefault', async () => {
    await show({ recollectionDefault: true });
    const d = await openReject();
    expect(within(d).getByText(`Reject specimen ${BC(1)}`)).toBeTruthy();
    expect(within(d).getAllByRole('radio')).toHaveLength(2);
    expect(within(d).getByRole('radio', { name: /haemolysed/i })).toBeTruthy();
    expect(within(d).getByLabelText(/comment/i).tagName).toBe('TEXTAREA');
    expect((within(d).getByRole('checkbox', { name: /request recollection/i }) as HTMLInputElement).checked).toBe(true);
  });

  it('recollectionDefault=false → checkbox starts unticked', async () => {
    await show({ recollectionDefault: false });
    const d = await openReject();
    expect((within(d).getByRole('checkbox', { name: /request recollection/i }) as HTMLInputElement).checked).toBe(false);
  });

  it('confirming without a reason sends nothing (reason is required — AC-05.2 on the screen side)', async () => {
    await show();
    const d = await openReject();
    await userEvent.click(within(d).getByRole('button', { name: /^reject$/i }));
    await new Promise((r) => setTimeout(r, 60));
    expect(rejects()).toHaveLength(0);
    expect(screen.queryByRole('dialog')).not.toBeNull(); // still open, user can fix
  });

  it('reason + recollection → rejectSpecimen {reason_code, recollection_required:true}; success text names the NEW barcode; log row "Rejected"; dialog closes; focus back on input', async () => {
    await show({ recollectionDefault: true });
    const d = await openReject();
    await userEvent.click(within(d).getByRole('radio', { name: /haemolysed/i }));
    await userEvent.type(within(d).getByLabelText(/comment/i), 'Visible haemolysis');
    await userEvent.click(within(d).getByRole('button', { name: /^reject$/i }));
    await waitFor(() => expect(rejects()).toHaveLength(1));
    const c = rejects()[0]!;
    expect(c.url.pathname).toBe(`/v1/lab/specimens/${SP(1)}/reject`);
    expect(c.body).toEqual({ reason_code: 'haemolysed', comment: 'Visible haemolysis', recollection_required: true });
    expect((c.headers.get('idempotency-key') ?? '').length).toBeGreaterThanOrEqual(8); // reject is Idempotency R (required)
    await waitFor(() => expect(bodyHas(`Specimen rejected. New barcode ${NEW_BC} created for recollection.`)).toBe(true));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(text(logRow(BC(1)))).toMatch(/Rejected/);
    await waitFor(() => expect(document.activeElement).toBe(box()));
  });

  it('reason without recollection → recollection_required:false and the plain text "Specimen rejected."', async () => {
    await show({ recollectionDefault: false });
    const d = await openReject();
    await userEvent.click(within(d).getByRole('radio', { name: /insufficient volume/i }));
    await userEvent.click(within(d).getByRole('button', { name: /^reject$/i }));
    await waitFor(() => expect(rejects()).toHaveLength(1));
    expect(rejects()[0]!.body).toEqual({ reason_code: 'insufficient_volume', recollection_required: false });
    await waitFor(() => expect(bodyHas('Specimen rejected.')).toBe(true));
    expect(bodyHas('New barcode')).toBe(false);
  });

  it('comment longer than 500 characters is not sent', async () => {
    await show();
    const d = await openReject();
    await userEvent.click(within(d).getByRole('radio', { name: /haemolysed/i }));
    fireEvent.change(within(d).getByLabelText(/comment/i), { target: { value: 'x'.repeat(501) } });
    await userEvent.click(within(d).getByRole('button', { name: /^reject$/i }));
    await new Promise((r) => setTimeout(r, 80));
    for (const c of rejects()) expect((c.body.comment as string | undefined ?? '').length).toBeLessThanOrEqual(500);
  });

  it('dialog open → scanner capture is off: a fast scan is not looked up and "Close the dialog before scanning" is announced (aria-live)', async () => {
    await show();
    await openReject();
    const before = lookups().length;
    (document.activeElement as HTMLElement | null)?.blur();
    for (const ch of BC(2)) fireEvent.keyDown(document.body, { key: ch });
    fireEvent.keyDown(document.body, { key: 'Enter' });
    await waitFor(() => expect(bodyHas('Close the dialog before scanning')).toBe(true));
    expect(lookups()).toHaveLength(before);
    const region = screen.getByText('Close the dialog before scanning').closest('[aria-live]');
    expect(region).not.toBeNull();
  });

  it('dialog traps focus and axe is clean', async () => {
    await show();
    const d = await openReject();
    expect(d.contains(document.activeElement)).toBe(true);
    await kb().tab({ shift: true });
    expect(d.contains(document.activeElement)).toBe(true);
    const r = await axe.run(d, { rules: { 'color-contrast': { enabled: false } } });
    expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
    expect(dialog()).toBeTruthy();
  });

  it('without lab.specimen.reject the Reject button is not offered', async () => {
    seed(specimen(1, { status: 'received' }));
    await show({ permissions: ['lab.specimen.receive', 'lab.specimen.read'] });
    await scan(BC(1));
    await screen.findByText(BC(1));
    expect(screen.queryByRole('button', { name: /^reject/i })).toBeNull();
  });
});

describe('SECURITY — barcode / registration no only in POST bodies (REQ-SEC-028, REQ-SEC-098, S-09)', () => {
  it('a full receive + reject journey: no pushed URL, query-free API URLs, web storage holds the centre id only', async () => {
    seed(specimen(1, { status: 'collected' }), specimen(2, { status: 'received' }));
    await show();
    const hist = window.history.length;
    await chooseCentre('Synthetic Central Lab');
    await scan(BC(1));
    await screen.findByText(BC(1));
    await kb().keyboard('{Enter}');
    await waitFor(() => expect(receives()).toHaveLength(1));
    await scan(BC(2));
    await screen.findByText(BC(2));
    await userEvent.click(screen.getByRole('button', { name: /^reject/i }));
    const d = await screen.findByRole('dialog');
    await userEvent.click(within(d).getByRole('radio', { name: /haemolysed/i }));
    await userEvent.click(within(d).getByRole('button', { name: /^reject$/i }));
    await waitFor(() => expect(rejects()).toHaveLength(1));
    const secrets = [BC(1), BC(2), REG];
    for (const u of [...push.mock.calls, ...replace.mock.calls].map((c) => String(c[0]))) for (const s of secrets) expect(u).not.toContain(s);
    expect(window.history.length).toBe(hist);
    for (const c of calls) { expect(c.url.search).toBe(''); for (const s of secrets) expect(c.url.href).not.toContain(s); }
    const stored = JSON.stringify({ l: { ...localStorage }, s: { ...sessionStorage } });
    for (const s of secrets) expect(stored).not.toContain(s);
    expect(JSON.stringify(receives()[0]!.body)).toBe(JSON.stringify({ processing_centre_id: CENTRE_A }));
  });

  it('a hostile scan value (markup) is rejected by the kit pattern and never sent', async () => {
    seed(specimen(1, { status: 'received' }));
    await show();
    await kb().type(box(), '<script>alert(1)</script>{Enter}');
    await new Promise((r) => setTimeout(r, 30));
    expect(lookups()).toHaveLength(0);
    expect(document.body.innerHTML).not.toMatch(/<script>alert/);
  });
});
