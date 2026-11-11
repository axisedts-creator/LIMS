// @vitest-environment jsdom
// C5.T-23 — Instrument exceptions screen: list `/lab/ingest-exceptions` and detail `/lab/ingest-exceptions/{exception_id}` (04-UI-UX §3.10; 03-APP-FLOW §1.3).
// ACs: AC-14.3 (an unmapped_code exception is visible on the list), AC-14.5 (assign / re-apply / discard from the detail), AC-04.5 as seen from the UI (an exception that was auto re-applied shows as resolved).
// 07-SECURITY: raw values only on the detail (P3), no value/barcode in URLs (REQ-SEC-028), XSS, double submit. Synthetic data only.
//
// ASSUMED module/prop contract (dispute through the writer/ruling flow if wrong). Under apps/web/src/features/lab/components/ (named exports, 'use client'):
//   IngestExceptionList({ items, permissions, status? })   items = IngestExceptionDto[] (`data` of GET /v1/lab/ingest-exceptions); status = the active status filter, default 'open'.
//     Rows: one <tr role=row> per exception: instrument (id text), reason as TEXT (04-UI-UX §3.10: unknown_barcode "Unknown barcode", unmapped_code "Code not mapped", specimen_rejected "Specimen rejected",
//       result_locked "Result approved", result_already_verified "Result already verified", specimen_not_received "Not yet received", analyte_not_ordered "Test not ordered", unit_mismatch "Unit mismatch"),
//       barcode, instrument code, status, created_at. Each row has a link (role=link) to `/lab/ingest-exceptions/{id}`. Empty list with status open: "No open instrument exceptions."
//     Filters: a Select named /reason/i and a Select named /status/i; changing one calls router.push with `reason=<code>` / `status=<value>` — and NOTHING patient-linked (no barcode / value) in the URL.
//     No action buttons on the list (read-only; actions live on the detail).
//   IngestExceptionDetail({ exception, permissions, discardReasons })   exception = IngestExceptionDetail DTO (raw_value, raw_flags, unit_raw), discardReasons = [{ code, display }].
//     Shows the reason text, barcode, code, raw value + unit + flags. reason result_locked adds the copy "This result is approved. To use the new value, a pathologist must amend it."
//     Actions only when status === 'open' AND permissions include `lab.result.enter`: buttons "Re-apply", "Assign", "Discard". Otherwise none (read-only).
//     Re-apply: POST /v1/lab/ingest-exceptions/{id}/reapply, body {} → shows the outcome (role=status): applied → /applied/i, unmatched|rejected_state → /still open/i; router.refresh().
//     Discard: opens a dialog (role=dialog) with a Select named /reason/i (options = discardReasons display) and a comment textarea named /comment/i with maxLength 300; the dialog's "Discard" button is disabled
//       until a reason is picked; POST .../discard { reason_code, comment? } (comment omitted when empty); router.refresh().
//     Assign: opens a dialog with a text input named /barcode/i + button "Find" → POST /v1/lab/specimens/lookup { barcode } → specimen { id, order_id, ... } → GET /v1/lab/orders/{order_id}/results →
//       { items: [{ order_item_id, test, results: ResultDto[] }] } → one radio (role=radio) per non-cancelled result, accessible name contains the analyte_code; a checkbox "Apply to a different analyte"
//       (unchecked by default). The dialog's "Assign" button is disabled until a result is picked; POST .../assign { result_id, override_analyte? } with an `Idempotency-Key` header (x-idempotency required);
//       override_analyte only when the checkbox is checked; response { exception, outcome, result? } → outcome shown as for re-apply; router.refresh().
//     A failed call shows role=alert with the problem title and never the "applied" status.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { ReactNode } from 'react';
import { ToastProvider } from '@lims/ui/components/Toast';
import { IngestExceptionList } from '../components/IngestExceptionList';
import { IngestExceptionDetail } from '../components/IngestExceptionDetail';

const push = vi.fn();
const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh, back: vi.fn() }),
  usePathname: () => '/lab/ingest-exceptions',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: [], displayName: 'Synthetic Tech', tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => '/lab/ingest-exceptions',
}));
const ORIGIN = 'http://api.test';
process.env.LIMS_ORIGIN_API = ORIGIN;

const id = (n: number) => `01a1a98a-ac40-7000-8000-${String(n).padStart(12, '0')}`;
const READ = ['lab.result.read'];
const ENTER = ['lab.result.read', 'lab.result.enter'];
const EXC = id(0x23), INSTR = id(0x99), ORDER = id(0x400), SPEC = id(0x500), R_HGB = id(0x601), R_WBC = id(0x602);
const REASONS = [{ code: 'DUPLICATE_RUN', display: 'Duplicate run' }, { code: 'TEST_SAMPLE', display: 'Test sample' }];

type Over = Record<string, unknown>;
const exc = (n: number, o: Over = {}) => ({
  id: n === 1 ? EXC : id(0x1000 + n), status: 'open', reason: 'unmapped_code', instrument_id: INSTR, result_key: `${INSTR}:SN000${n}:HGB:2026-06-15T04:55:00.000Z`, sample_barcode: `SN000${n}`,
  instrument_analyte_code: `HGB${n}`, created_at: '2026-06-15T04:56:30.000Z', ...o,
});
const detail = (o: Over = {}) => ({ ...exc(1), raw_value: '13.4', raw_flags: ['H'], unit_raw: 'g/dL', ...o });

const calls: { method: string; url: URL; headers: Headers; body?: any }[] = [];
const rec = async (r: Request) => { calls.push({ method: r.method, url: new URL(r.url), headers: r.headers, body: r.method === 'GET' ? undefined : await r.clone().json().catch(() => undefined) }); };
const problem = (status: number, code: string, title = code) => HttpResponse.json({ type: 'about:blank', title, status, code }, { status, headers: { 'content-type': 'application/problem+json' } });
const resultDto = (rid: string, code: string, status = 'pending') => ({ id: rid, version: 1, order_id: ORDER, order_item_id: id(0x700), specimen_id: SPEC, test_id: id(0x701), analyte_id: id(0x702), analyte_code: code, status, origin: 'manual' });
let reapplyReply: () => Response = () => HttpResponse.json({ exception: { ...exc(1), status: 'resolved', resolution: 'applied', resolved_at: '2026-06-15T05:00:00.000Z' }, outcome: 'applied' });
let discardReply: () => Response = () => HttpResponse.json({ ...exc(1), status: 'discarded', resolution: 'discarded', resolved_at: '2026-06-15T05:00:00.000Z' });
let assignReply: () => Response = () => HttpResponse.json({ exception: { ...exc(1), status: 'resolved', resolution: 'assigned', result_id: R_HGB, resolved_at: '2026-06-15T05:00:00.000Z' }, outcome: 'applied', result: resultDto(R_HGB, 'HGB', 'resulted') });
let reapplyDelay = 0;
const api = setupServer(
  http.post(`${ORIGIN}/v1/lab/ingest-exceptions/${EXC}/reapply`, async ({ request }) => { await rec(request); if (reapplyDelay) await new Promise((r) => setTimeout(r, reapplyDelay)); return reapplyReply(); }),
  http.post(`${ORIGIN}/v1/lab/ingest-exceptions/${EXC}/discard`, async ({ request }) => { await rec(request); return discardReply(); }),
  http.post(`${ORIGIN}/v1/lab/ingest-exceptions/${EXC}/assign`, async ({ request }) => { await rec(request); return assignReply(); }),
  http.post(`${ORIGIN}/v1/lab/specimens/lookup`, async ({ request }) => { await rec(request); return HttpResponse.json({ id: SPEC, version: 1, barcode: 'SN0001', order_id: ORDER, registration_no: 'REG0001', specimen_type_code: 'WB', status: 'received' }); }),
  http.get(`${ORIGIN}/v1/lab/orders/${ORDER}/results`, async ({ request }) => { await rec(request); return HttpResponse.json({ order: { id: ORDER }, items: [
    { order_item_id: id(0x700), test: { id: id(0x701), code: 'CBC', name: 'CBC' }, results: [resultDto(R_HGB, 'HGB'), resultDto(R_WBC, 'WBC'), resultDto(id(0x603), 'PLT', 'cancelled')] }] }); }),
);
beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  cleanup(); api.resetHandlers(); calls.length = 0; push.mockReset(); refresh.mockReset(); reapplyDelay = 0;
  reapplyReply = () => HttpResponse.json({ exception: { ...exc(1), status: 'resolved', resolution: 'applied', resolved_at: '2026-06-15T05:00:00.000Z' }, outcome: 'applied' });
  discardReply = () => HttpResponse.json({ ...exc(1), status: 'discarded', resolution: 'discarded', resolved_at: '2026-06-15T05:00:00.000Z' });
  assignReply = () => HttpResponse.json({ exception: { ...exc(1), status: 'resolved', resolution: 'assigned', result_id: R_HGB, resolved_at: '2026-06-15T05:00:00.000Z' }, outcome: 'applied', result: resultDto(R_HGB, 'HGB', 'resulted') });
});
afterAll(() => api.close());

const wrap = (ui: ReactNode) => render(<ToastProvider>{ui}</ToastProvider>);
const rowOf = (text: string) => { const r = screen.getAllByRole('row').find((x) => x.textContent?.includes(text)); if (!r) throw new Error(`no row for ${text}`); return r; };
const noAxeViolations = async () => {
  const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } });
  expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
};
const posts = (suffix: string) => calls.filter((c) => c.method === 'POST' && c.url.pathname.endsWith(suffix));
const detailUi = (o: { exception?: Over; permissions?: string[] } = {}) =>
  wrap(<IngestExceptionDetail exception={detail(o.exception) as never} permissions={o.permissions ?? ENTER} discardReasons={REASONS} />);

// ───────────────────────────────────────── list
describe('C5.T-23 list /lab/ingest-exceptions', () => {
  it('AC-14.3: an unmapped_code exception is listed with reason text, barcode, code, instrument and status; every row links to its detail', () => {
    wrap(<IngestExceptionList items={[exc(1), exc(2, { reason: 'unknown_barcode' })] as never} permissions={READ} />);
    const r1 = rowOf('SN0001');
    expect(within(r1).getByText('Code not mapped')).toBeTruthy();
    expect(within(r1).getByText(/HGB1/)).toBeTruthy();
    expect(within(r1).getByText(/open/i)).toBeTruthy();
    expect(within(r1).getByRole('link').getAttribute('href')).toBe(`/lab/ingest-exceptions/${EXC}`);
    expect(within(rowOf('SN0002')).getByText('Unknown barcode')).toBeTruthy();
  });

  it.each([
    ['unknown_barcode', 'Unknown barcode'], ['unmapped_code', 'Code not mapped'], ['specimen_rejected', 'Specimen rejected'], ['result_locked', 'Result approved'],
    ['result_already_verified', 'Result already verified'], ['specimen_not_received', 'Not yet received'], ['analyte_not_ordered', 'Test not ordered'], ['unit_mismatch', 'Unit mismatch'],
  ])('reason %s is shown as the text "%s", not the code', (reason, text) => {
    wrap(<IngestExceptionList items={[exc(1, { reason })] as never} permissions={READ} />);
    expect(within(rowOf('SN0001')).getByText(text)).toBeTruthy();
    expect(within(rowOf('SN0001')).queryByText(reason)).toBeNull();
  });

  it('empty open list → "No open instrument exceptions."', () => {
    wrap(<IngestExceptionList items={[]} permissions={READ} />);
    expect(screen.getByText('No open instrument exceptions.')).toBeTruthy();
  });

  it('the list is read-only: no Re-apply / Assign / Discard buttons and no value column (raw values only on the detail)', () => {
    wrap(<IngestExceptionList items={[exc(1)] as never} permissions={ENTER} />);
    expect(screen.queryByRole('button', { name: /re-apply|assign|discard/i })).toBeNull();
    expect(document.body.textContent).not.toContain('13.4');
  });

  it('filters: choosing a reason / status navigates with reason= / status=; the URL carries no barcode or value (REQ-SEC-028)', async () => {
    const user = userEvent.setup();
    wrap(<IngestExceptionList items={[exc(1)] as never} permissions={READ} />);
    await user.selectOptions(screen.getByRole('combobox', { name: /reason/i }), 'unmapped_code');
    expect(String(push.mock.calls.at(-1)![0])).toMatch(/reason=unmapped_code/);
    await user.selectOptions(screen.getByRole('combobox', { name: /status/i }), 'resolved');
    const target = String(push.mock.calls.at(-1)![0]);
    expect(target).toMatch(/status=resolved/);
    expect(target).not.toMatch(/SN0001|13\.4|HGB/);
  });

  it('XSS: a barcode / code that is markup stays text', () => {
    wrap(<IngestExceptionList items={[exc(1, { sample_barcode: '<img src=x onerror=alert(1)>' })] as never} permissions={READ} />);
    expect(document.querySelector('img[src="x"]')).toBeNull();
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeTruthy();
  });

  it('has no axe violations', async () => {
    wrap(<IngestExceptionList items={[exc(1), exc(2, { reason: 'result_locked' })] as never} permissions={READ} />);
    await noAxeViolations();
  });
});

// ───────────────────────────────────────── detail: display + permissions
describe('C5.T-23 detail — display and permissions', () => {
  it('shows the raw value, unit and flags (P3: detail only) and the reason text', () => {
    detailUi();
    expect(screen.getByText(/13\.4/)).toBeTruthy();
    expect(screen.getByText(/g\/dL/)).toBeTruthy();
    expect(screen.getByText(/\bH\b/)).toBeTruthy();
    expect(screen.getByText('Code not mapped')).toBeTruthy();
  });

  it('result_locked shows the exact pathologist copy', () => {
    detailUi({ exception: { reason: 'result_locked' } });
    expect(screen.getByText('This result is approved. To use the new value, a pathologist must amend it.')).toBeTruthy();
  });

  it('without lab.result.enter the screen is read-only: no action buttons', () => {
    detailUi({ permissions: READ });
    expect(screen.queryByRole('button', { name: /re-apply|assign|discard/i })).toBeNull();
  });

  it('a resolved or discarded exception has no action buttons even for a user with lab.result.enter (terminal states)', () => {
    for (const status of ['resolved', 'discarded']) {
      const { unmount } = detailUi({ exception: { status, resolution: status === 'resolved' ? 'applied' : 'discarded', resolved_at: '2026-06-15T05:00:00.000Z' } });
      expect(screen.queryByRole('button', { name: /re-apply|assign|discard/i }), status).toBeNull();
      unmount();
    }
  });

  it('XSS: a raw value that is markup stays text', () => {
    detailUi({ exception: { raw_value: '<script>alert(1)</script>' } });
    expect(document.querySelector('script')).toBeNull();
    expect(screen.getByText('<script>alert(1)</script>')).toBeTruthy();
  });

  it('has no axe violations (detail, and with the discard dialog open)', async () => {
    const user = userEvent.setup();
    detailUi();
    await noAxeViolations();
    await user.click(screen.getByRole('button', { name: /^discard$/i }));
    await screen.findByRole('dialog');
    await noAxeViolations();
  });
});

// ───────────────────────────────────────── detail: re-apply
describe('C5.T-23 detail — Re-apply (AC-14.5 "re-applies after the mapping is fixed")', () => {
  it('POSTs {} to /reapply, shows the applied outcome and refreshes the route', async () => {
    const user = userEvent.setup();
    detailUi();
    await user.click(screen.getByRole('button', { name: /re-apply/i }));
    await waitFor(() => expect(posts('/reapply')).toHaveLength(1));
    expect(posts('/reapply')[0]!.body).toEqual({});
    expect((await screen.findByRole('status')).textContent).toMatch(/applied/i);
    expect(refresh).toHaveBeenCalled();
  });

  it.each(['unmatched', 'rejected_state'])('outcome %s says the exception is still open (AC-14.3: not applied, stays in the queue)', async (outcome) => {
    reapplyReply = () => HttpResponse.json({ exception: exc(1), outcome });
    const user = userEvent.setup();
    detailUi();
    await user.click(screen.getByRole('button', { name: /re-apply/i }));
    expect((await screen.findByRole('status')).textContent).toMatch(/still open/i);
    expect(screen.queryByText(/^applied$/i)).toBeNull();
  });

  it('double click sends ONE request (the button is disabled while in flight)', async () => {
    reapplyDelay = 150;
    const user = userEvent.setup();
    detailUi();
    const b = screen.getByRole('button', { name: /re-apply/i });
    await user.dblClick(b);
    await screen.findByRole('status');
    expect(posts('/reapply')).toHaveLength(1);
  });

  it('a failed call shows an alert with the problem title and no applied status', async () => {
    reapplyReply = () => problem(404, 'common.not_found', 'Not found');
    const user = userEvent.setup();
    detailUi();
    await user.click(screen.getByRole('button', { name: /re-apply/i }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/not found/i);
    expect(screen.queryByRole('status')).toBeNull();
  });
});

// ───────────────────────────────────────── detail: discard
describe('C5.T-23 detail — Discard (AC-14.5 "When discarded with a reason, Then discarded")', () => {
  const open = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByRole('button', { name: /^discard$/i }));
    return screen.findByRole('dialog');
  };

  it('the dialog lists the discard reasons; Discard stays disabled until a reason is picked', async () => {
    const user = userEvent.setup();
    detailUi();
    const dlg = await open(user);
    const sel = within(dlg).getByRole('combobox', { name: /reason/i }) as HTMLSelectElement;
    expect([...sel.options].map((o) => o.textContent)).toEqual(expect.arrayContaining(['Duplicate run', 'Test sample']));
    expect((within(dlg).getByRole('button', { name: /^discard$/i }) as HTMLButtonElement).disabled).toBe(true);
    await user.selectOptions(sel, 'DUPLICATE_RUN');
    expect((within(dlg).getByRole('button', { name: /^discard$/i }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('POSTs { reason_code, comment } and refreshes; an empty comment is omitted', async () => {
    const user = userEvent.setup();
    detailUi();
    let dlg = await open(user);
    await user.selectOptions(within(dlg).getByRole('combobox', { name: /reason/i }), 'TEST_SAMPLE');
    await user.type(within(dlg).getByRole('textbox', { name: /comment/i }), 'Bench test run');
    await user.click(within(dlg).getByRole('button', { name: /^discard$/i }));
    await waitFor(() => expect(posts('/discard')).toHaveLength(1));
    expect(posts('/discard')[0]!.body).toEqual({ reason_code: 'TEST_SAMPLE', comment: 'Bench test run' });
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    cleanup(); calls.length = 0;
    detailUi();
    dlg = await open(userEvent.setup());
    await userEvent.setup().selectOptions(within(dlg).getByRole('combobox', { name: /reason/i }), 'DUPLICATE_RUN');
    await userEvent.setup().click(within(dlg).getByRole('button', { name: /^discard$/i }));
    await waitFor(() => expect(posts('/discard')).toHaveLength(1));
    expect(posts('/discard')[0]!.body).toEqual({ reason_code: 'DUPLICATE_RUN' });
  });

  it('the comment box is capped at 300 characters (contract maxLength 300)', async () => {
    const user = userEvent.setup();
    detailUi();
    const dlg = await open(user);
    expect(within(dlg).getByRole('textbox', { name: /comment/i }).getAttribute('maxlength')).toBe('300');
  });

  it('a failed discard (validation_failed) shows an alert and keeps the dialog open', async () => {
    discardReply = () => problem(400, 'common.validation_failed', 'Validation failed');
    const user = userEvent.setup();
    detailUi();
    const dlg = await open(user);
    await user.selectOptions(within(dlg).getByRole('combobox', { name: /reason/i }), 'DUPLICATE_RUN');
    await user.click(within(dlg).getByRole('button', { name: /^discard$/i }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/validation failed/i);
    expect(screen.queryByRole('dialog')).toBeTruthy();
  });
});

// ───────────────────────────────────────── detail: assign
describe('C5.T-23 detail — Assign (AC-14.5 "assigns it to a specimen/result")', () => {
  const openAssign = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(screen.getByRole('button', { name: /^assign$/i }));
    return screen.findByRole('dialog');
  };
  const find = async (user: ReturnType<typeof userEvent.setup>, dlg: HTMLElement, barcode = 'SN0001') => {
    await user.type(within(dlg).getByRole('textbox', { name: /barcode/i }), barcode);
    await user.click(within(dlg).getByRole('button', { name: /^find$/i }));
  };

  it('barcode → lookup → results of that order: one radio per non-cancelled result (cancelled PLT is not offered); Assign is disabled until one is picked', async () => {
    const user = userEvent.setup();
    detailUi();
    const dlg = await openAssign(user);
    await find(user, dlg);
    expect(await within(dlg).findByRole('radio', { name: /HGB/ })).toBeTruthy();
    expect(within(dlg).getByRole('radio', { name: /WBC/ })).toBeTruthy();
    expect(within(dlg).queryByRole('radio', { name: /PLT/ })).toBeNull();
    expect(calls.find((c) => c.url.pathname.endsWith('/specimens/lookup'))!.body).toEqual({ barcode: 'SN0001' });
    expect((within(dlg).getByRole('button', { name: /^assign$/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('POSTs { result_id } with an Idempotency-Key (no override_analyte unless checked), shows the applied outcome and refreshes', async () => {
    const user = userEvent.setup();
    detailUi();
    const dlg = await openAssign(user);
    await find(user, dlg);
    await user.click(await within(dlg).findByRole('radio', { name: /HGB/ }));
    expect((within(dlg).getByRole('checkbox', { name: /different analyte/i }) as HTMLInputElement).checked).toBe(false);
    await user.click(within(dlg).getByRole('button', { name: /^assign$/i }));
    await waitFor(() => expect(posts('/assign')).toHaveLength(1));
    const c = posts('/assign')[0]!;
    expect(c.body).toEqual({ result_id: R_HGB });
    expect(c.headers.get('idempotency-key')).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect((await screen.findByRole('status')).textContent).toMatch(/applied/i);
    expect(refresh).toHaveBeenCalled();
  });

  it('"Apply to a different analyte" checked → override_analyte: true is sent', async () => {
    const user = userEvent.setup();
    detailUi();
    const dlg = await openAssign(user);
    await find(user, dlg);
    await user.click(await within(dlg).findByRole('radio', { name: /WBC/ }));
    await user.click(within(dlg).getByRole('checkbox', { name: /different analyte/i }));
    await user.click(within(dlg).getByRole('button', { name: /^assign$/i }));
    await waitFor(() => expect(posts('/assign')).toHaveLength(1));
    expect(posts('/assign')[0]!.body).toEqual({ result_id: R_WBC, override_analyte: true });
  });

  it('an unknown barcode (404 from lookup) shows "No specimen with this barcode in your lab." and nothing can be assigned', async () => {
    api.use(http.post(`${ORIGIN}/v1/lab/specimens/lookup`, () => problem(404, 'common.not_found', 'Not found')));
    const user = userEvent.setup();
    detailUi();
    const dlg = await openAssign(user);
    await find(user, dlg, 'NOPE0001');
    expect(await within(dlg).findByText('No specimen with this barcode in your lab.')).toBeTruthy();
    expect(within(dlg).queryAllByRole('radio')).toHaveLength(0);
    expect(posts('/assign')).toHaveLength(0);
  });

  it('outcome rejected_state (approved target) is reported as still open, not as applied', async () => {
    assignReply = () => HttpResponse.json({ exception: exc(1), outcome: 'rejected_state' });
    const user = userEvent.setup();
    detailUi();
    const dlg = await openAssign(user);
    await find(user, dlg);
    await user.click(await within(dlg).findByRole('radio', { name: /HGB/ }));
    await user.click(within(dlg).getByRole('button', { name: /^assign$/i }));
    expect((await screen.findByRole('status')).textContent).toMatch(/still open/i);
  });

  it('a failed assign (analyte mismatch → validation_failed) shows an alert and no applied status', async () => {
    assignReply = () => problem(422, 'common.validation_failed', 'Validation failed');
    const user = userEvent.setup();
    detailUi();
    const dlg = await openAssign(user);
    await find(user, dlg);
    await user.click(await within(dlg).findByRole('radio', { name: /WBC/ }));
    await user.click(within(dlg).getByRole('button', { name: /^assign$/i }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/validation failed/i);
    expect(screen.queryByRole('status')).toBeNull();
  });
});
