// @vitest-environment jsdom
// C5 T-10 — label page behaviour with MSW (PRD AC-02.1, AC-02.2, AC-02.5; 03-APP-FLOW §3.1; 04-UI-UX §3.1; 08 A13 D-4). done_when: "print CSS sized from #14 response; inactive per-id error;
// page calls neither #15 nor #47; 409 then 200 retry path without key". Real HTTP goes to LIMS_ORIGIN_API (MSW); `onUnhandledRequest: 'error'` => any call outside the handlers below
// (getLabOrder #15 = GET /v1/lab/orders/{id}, getLabSettings #47 = GET /v1/lab/settings, anything else) fails the test.
// ASSUMED module/prop contract (spec fixes folders + names of server file / renderer only; dispute via writer if wrong):
//   apps/web/src/features/lab/components/labels/LabelPage.tsx   export const LabelPage({ orderId, waitSeconds, permissions }) — client component; `waitSeconds` is LIMS_LAB_LABEL_WAIT_SECONDS read by the
//     server page (default 15); `permissions: readonly string[]` (shows "Mark selected collected" only with lab.specimen.collect).
//   apps/web/src/features/lab/server/printSpecimenLabels.server.ts   exports requestOrderLabelPrint(orderId), printSpecimenLabels(body) via serverFetch -> /v1/lab/... (what the page calls, directly or as server actions).
//   Each physical label is data-testid="label" (see lab-t10.renderer.test.ts); the print region is data-testid="print-region"; the specimen list rows are role=listitem or row with the barcode text.
//   window.print is called ONCE per print action, after the labels are in the DOM.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { ReactNode } from 'react';
import { ToastProvider } from '@lims/ui/components/Toast';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/lab/orders/x/labels',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: [], displayName: 'Synthetic Lab', tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => '/lab/orders/x/labels',
}));

const ORIGIN = 'http://api.test';
process.env.LIMS_ORIGIN_API = ORIGIN;
const U = (n: number) => `01a1a98a-ac40-7000-8000-${String(n).padStart(12, '0')}`;
const ORDER = U(1), S1 = U(11), S2 = U(12), S3 = U(13);
const B1 = 'E2600000101', B2 = 'E2600000102', B3 = 'E2600000103';
const problem = (code: string, status: number, extra: object = {}) => HttpResponse.json({ type: `urn:lims:error:${code}`, title: code, status, code, request_id: 'req-synthetic-1', ...extra }, { status });

const label = (id: string, barcode: string, o: Record<string, unknown> = {}) => ({ specimen_id: id, barcode, patient_name: 'Synthetic Patient', age_sex: '43Y/F', registration_no: 'REG0001', specimen_type_code: 'WB', container_code: 'EDTA',
  test_codes: ['CBC'], more_tests: 0, urgent: false, copies: 2, ...o });
const labelsBody = (o: Record<string, unknown> = {}) => ({ labels: [label(S1, B1), label(S2, B2)], errors: [], size: { width_mm: 60, height_mm: 30 }, label_copies_default: 2, ...o });
const readyBody = (specimens = [{ specimen_id: S1, barcode: B1, outcome: 'ready' }, { specimen_id: S2, barcode: B2, outcome: 'ready' }]) => ({ order_id: ORDER, specimens, labels_route: 'staff.lab.order_labels' });

interface Call { op: string; url: URL; headers: Headers; body?: any }
const calls: Call[] = [];
const rec = async (op: string, r: Request) => { calls.push({ op, url: new URL(r.url), headers: r.headers, body: r.method === 'GET' ? undefined : await r.clone().json().catch(() => undefined) }); };
const ops = (op: string) => calls.filter((c) => c.op === op);
/** replies for #14a in order; the last one repeats. */
let readyReplies: Array<() => Response> = [];
let printReply: () => Response = () => HttpResponse.json(labelsBody());
let readyN = 0;
const forbidden: Call[] = [];

const api = setupServer(
  http.post(`${ORIGIN}/v1/lab/orders/:id/label-prints`, async ({ request }) => { await rec('ready', request); const f = readyReplies[Math.min(readyN++, readyReplies.length - 1)]!; return f(); }),
  http.post(`${ORIGIN}/v1/lab/specimens/labels`, async ({ request }) => { await rec('print', request); return printReply(); }),
  http.get(`${ORIGIN}/v1/lab/orders/:id`, async ({ request }) => { await rec('getLabOrder', request); forbidden.push(calls.at(-1)!); return HttpResponse.json({}); }),
  http.get(`${ORIGIN}/v1/lab/settings`, async ({ request }) => { await rec('getLabSettings', request); forbidden.push(calls.at(-1)!); return HttpResponse.json({}); }),
);
const printSpy = vi.fn();
let labelsAtPrint: number[] = [];

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => {
  readyN = 0;
  readyReplies = [() => HttpResponse.json(readyBody())];
  printReply = () => HttpResponse.json(labelsBody());
  labelsAtPrint = [];
  printSpy.mockReset().mockImplementation(() => { labelsAtPrint.push(document.querySelectorAll('[data-testid="label"]').length); });
  window.print = printSpy as unknown as typeof window.print;
});
afterEach(() => { cleanup(); api.resetHandlers(); calls.length = 0; forbidden.length = 0; document.head.querySelectorAll('style').forEach((s) => s.remove()); });
afterAll(() => api.close());

const modName = 'LabelPage'; // variable path: a missing module fails each test, not the whole file at collection
const mod = async () => (await import(/* @vite-ignore */ `../components/labels/${modName}`)) as { LabelPage: (p: { orderId: string; waitSeconds?: number; permissions?: readonly string[] }) => ReactNode };
const open = async (p: { waitSeconds?: number; permissions?: readonly string[] } = {}) => {
  const { LabelPage } = await mod();
  return render(<ToastProvider><LabelPage orderId={ORDER} waitSeconds={p.waitSeconds ?? 15} permissions={p.permissions ?? ['lab.specimen.label_print', 'lab.specimen.collect']} /></ToastProvider>);
};
const labelEls = () => [...document.querySelectorAll('[data-testid="label"]')];
const css = () => [...document.querySelectorAll('style')].map((s) => s.textContent ?? '').join('\n') + [...document.querySelectorAll('[data-testid="print-region"]')].map((r) => r.innerHTML).join('\n');

describe('AC-02.1 — specimens exist: readiness once, labels once, print dialog once, no further clicks', () => {
  it('calls #14a once (no body fields, no Idempotency-Key) then #14 once for the ready specimens with default copies, renders one label per copy, window.print() exactly once after render', async () => {
    await open();
    await waitFor(() => expect(printSpy).toHaveBeenCalledTimes(1));
    expect(ops('ready')).toHaveLength(1);
    expect(ops('ready')[0]!.url.pathname).toBe(`/v1/lab/orders/${ORDER}/label-prints`);
    expect(ops('ready')[0]!.body).toEqual({});
    expect(ops('ready')[0]!.headers.get('idempotency-key')).toBeNull();      // x-idempotency: none (08 A13 D-4)
    expect(ops('print')).toHaveLength(1);
    const b = ops('print')[0]!.body;
    expect(b.copies).toBeUndefined();                                          // absent = label_copies_default
    expect(b.order_id !== undefined ? b.order_id : [...b.specimen_ids].sort()).toEqual(b.order_id !== undefined ? ORDER : [S1, S2].sort());
    expect(b.order_id !== undefined && b.specimen_ids !== undefined).toBe(false); // exactly one of the two
    expect(labelEls()).toHaveLength(4);                                        // 2 specimens x copies 2
    expect(labelsAtPrint).toEqual([4]);                                        // print only after the labels are in the DOM
    expect(forbidden).toEqual([]);                                             // neither #15 getLabOrder nor #47 getLabSettings
    await new Promise((r) => setTimeout(r, 300));
    expect(printSpy).toHaveBeenCalledTimes(1);                                 // not re-printed by a later render / re-fetch
    expect(ops('print')).toHaveLength(1);
  });

  it('print CSS is sized from the #14 response (60x30 mm), not a constant', async () => {
    await open();
    await waitFor(() => expect(printSpy).toHaveBeenCalled());
    expect(css()).toMatch(/@page[^}]*size:\s*60mm\s+30mm/);
    expect(css()).not.toMatch(/size:\s*50mm\s+25mm/);
  });

  it('a different size (80x40) in the response changes the CSS', async () => {
    printReply = () => HttpResponse.json(labelsBody({ size: { width_mm: 80, height_mm: 40 } }));
    await open();
    await waitFor(() => expect(printSpy).toHaveBeenCalled());
    expect(css()).toMatch(/@page[^}]*size:\s*80mm\s+40mm/);
  });

  it('header shows registration no and patient; the specimen list shows each barcode', async () => {
    await open();
    await waitFor(() => expect(printSpy).toHaveBeenCalled());
    expect(screen.getAllByText(/REG0001/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Synthetic Patient/).length).toBeGreaterThan(0);
    for (const b of [B1, B2]) expect(screen.getAllByText(new RegExp(b)).length).toBeGreaterThan(0);
  });

  it('no axe violations (labels page, ready state)', async () => {
    await open();
    await waitFor(() => expect(printSpy).toHaveBeenCalled());
    const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } });
    expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
  });
});

describe('AC-02.2 — specimens not created yet: "Preparing labels…", poll #14a every 1 s, 409 -> 200 retry path without a key', () => {
  it('409 common.version_conflict twice then 200: shows "Preparing labels…" while waiting, #14 is NOT called until 200, prints once afterwards, no key on any #14a call', async () => {
    readyReplies = [() => problem('common.version_conflict', 409, { detail: 'specimens not created yet' }), () => problem('common.version_conflict', 409, { detail: 'specimens not created yet' }), () => HttpResponse.json(readyBody())];
    await open();
    expect(await screen.findByText(/Preparing labels…/)).toBeTruthy();
    expect(ops('print')).toHaveLength(0);
    expect(printSpy).not.toHaveBeenCalled();
    await waitFor(() => expect(printSpy).toHaveBeenCalledTimes(1), { timeout: 8000 });
    expect(ops('ready')).toHaveLength(3);
    const t = ops('ready').map((c) => c.headers);
    expect(t.every((h) => h.get('idempotency-key') === null && h.get('if-match') === null)).toBe(true);
    expect(ops('print')).toHaveLength(1);
    expect(screen.queryByText(/Preparing labels…/)).toBeNull();
    expect(forbidden).toEqual([]);
  });

  it('polls about every 1 s (not a tight loop): 2 attempts within ~1.5 s', async () => {
    readyReplies = [() => problem('common.version_conflict', 409)];
    await open({ waitSeconds: 15 });
    await screen.findByText(/Preparing labels…/);
    await new Promise((r) => setTimeout(r, 1500));
    expect(ops('ready').length).toBeGreaterThanOrEqual(2);
    expect(ops('ready').length).toBeLessThanOrEqual(3);
  });

  it('timeout after LIMS_LAB_LABEL_WAIT_SECONDS: "Labels are not ready yet. Try again in a moment." + Retry; no #14, no print; Retry polls again and a 200 then prints', async () => {
    readyReplies = [() => problem('common.version_conflict', 409)];
    await open({ waitSeconds: 2 });
    expect(await screen.findByText('Labels are not ready yet. Try again in a moment.', undefined, { timeout: 6000 })).toBeTruthy();
    expect(ops('print')).toHaveLength(0);
    expect(printSpy).not.toHaveBeenCalled();
    const before = ops('ready').length;
    expect(before).toBeGreaterThanOrEqual(2);
    expect(before).toBeLessThanOrEqual(4);
    await new Promise((r) => setTimeout(r, 1300));
    expect(ops('ready').length).toBe(before);                                  // stopped polling after the timeout
    readyReplies = [() => HttpResponse.json(readyBody())]; readyN = 0;
    await userEvent.click(screen.getByRole('button', { name: /retry/i }));
    await waitFor(() => expect(printSpy).toHaveBeenCalledTimes(1), { timeout: 6000 });
    expect(ops('print')).toHaveLength(1);
  }, 30000);
});

describe('AC-02.5 — inactive specimen: per-id lab.specimen_inactive, greyed, not rendered', () => {
  beforeEach(() => {
    readyReplies = [() => HttpResponse.json(readyBody([{ specimen_id: S1, barcode: B1, outcome: 'ready' }, { specimen_id: S3, barcode: B3, outcome: 'inactive' }]))];
    printReply = () => HttpResponse.json(labelsBody({ labels: [label(S1, B1)], errors: [{ id: S3, code: 'lab.specimen_inactive' }] }));
  });

  it('#14 is requested without the inactive specimen id (or answers it per-id), the inactive row reads "Not printable (… cancelled)", only the active specimen is rendered and printed', async () => {
    await open();
    await waitFor(() => expect(printSpy).toHaveBeenCalledTimes(1));
    const b = ops('print')[0]!.body;
    if (b.specimen_ids) expect(b.specimen_ids).not.toContain(S3);
    expect(screen.getAllByText(/Not printable \((order )?cancelled\)/i).length).toBeGreaterThan(0);
    expect(labelEls()).toHaveLength(2);                                        // S1 x 2 copies only
    expect(labelEls().every((l) => (l.textContent ?? '').includes(B1) && !(l.textContent ?? '').includes(B3))).toBe(true);
    expect(labelsAtPrint).toEqual([2]);
  });

  it('the inactive specimen cannot be selected for reprint (checkbox disabled or absent)', async () => {
    await open();
    await waitFor(() => expect(printSpy).toHaveBeenCalled());
    const boxes = screen.queryAllByRole('checkbox') as HTMLInputElement[];
    const dead = boxes.find((b) => (b.closest('li,tr,label,div')?.textContent ?? '').includes(B3));
    if (dead) expect(dead.disabled || dead.getAttribute('aria-disabled') === 'true').toBe(true);
  });
});

describe('reprint (03-APP-FLOW §3.1 step 3): select specimens + copies, "Print labels" -> #14 again, print again (counted again on the server, E16)', () => {
  it('unticking a specimen and choosing 3 copies sends only the ticked id with copies 3 and prints once more', async () => {
    await open();
    await waitFor(() => expect(printSpy).toHaveBeenCalledTimes(1));
    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    const s2 = boxes.find((b) => (b.closest('li,tr,label,div')?.textContent ?? '').includes(B2))!;
    await userEvent.click(s2);
    const sel = screen.getByRole('combobox', { name: /copies/i }) as HTMLSelectElement;
    await userEvent.selectOptions(sel, '3');
    printReply = () => HttpResponse.json(labelsBody({ labels: [label(S1, B1, { copies: 3 })] }));
    await userEvent.click(screen.getByRole('button', { name: /print labels/i }));
    await waitFor(() => expect(printSpy).toHaveBeenCalledTimes(2));
    expect(ops('print')).toHaveLength(2);
    const b = ops('print')[1]!.body;
    expect(b.specimen_ids).toEqual([S1]);
    expect(b.copies).toBe(3);
    expect(ops('ready')).toHaveLength(1);                                      // readiness is not repeated
    expect(labelEls()).toHaveLength(3);
    expect(forbidden).toEqual([]);
  });

  it('with nothing selected "Print labels" is disabled and sends nothing (≥1 selected, 04-UI-UX §3.1)', async () => {
    await open();
    await waitFor(() => expect(printSpy).toHaveBeenCalledTimes(1));
    for (const b of screen.getAllByRole('checkbox') as HTMLInputElement[]) if (b.checked && !b.disabled) await userEvent.click(b);
    const btn = screen.getByRole('button', { name: /print labels/i }) as HTMLButtonElement;
    expect(btn.disabled || btn.getAttribute('aria-disabled') === 'true').toBe(true);
    await userEvent.click(btn);
    expect(ops('print')).toHaveLength(1);
  });

  it('"Mark selected collected" only with lab.specimen.collect', async () => {
    await open({ permissions: ['lab.specimen.label_print'] });
    await waitFor(() => expect(printSpy).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: /mark selected collected/i })).toBeNull();
  });
});

describe('failure states (04-UI-UX §3 common)', () => {
  it('403 from #14a: "You don\'t have access to this screen." without Retry; nothing printed', async () => {
    readyReplies = [() => problem('auth.forbidden', 403)];
    await open();
    expect(await screen.findByText("You don't have access to this screen.")).toBeTruthy();
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
    expect(printSpy).not.toHaveBeenCalled();
  });

  it('404 from #14a: "This item doesn\'t exist or isn\'t visible to you." (no tenant leak)', async () => {
    readyReplies = [() => problem('common.not_found', 404)];
    await open();
    expect(await screen.findByText("This item doesn't exist or isn't visible to you.")).toBeTruthy();
    expect(printSpy).not.toHaveBeenCalled();
  });

  it('500 from #14: ErrorState "Something went wrong" with the request_id and Retry; no print dialog', async () => {
    printReply = () => problem('common.internal', 500);
    await open();
    expect(await screen.findByText('Something went wrong')).toBeTruthy();
    expect(screen.getByText(/req-synthetic-1/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy();
    expect(printSpy).not.toHaveBeenCalled();
  });

  it('attack: patient name with markup from the API is rendered as text (no injected element)', async () => {
    printReply = () => HttpResponse.json(labelsBody({ labels: [label(S1, B1, { patient_name: '<img src=x onerror=alert(1)>' })] }));
    await open();
    await waitFor(() => expect(printSpy).toHaveBeenCalled());
    expect(document.querySelector('img[src="x"]')).toBeNull();
    expect(within(document.body).getAllByText(/onerror/).length).toBeGreaterThan(0);
  });
});
