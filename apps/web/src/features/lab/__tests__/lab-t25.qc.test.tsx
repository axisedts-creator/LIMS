// @vitest-environment jsdom
// C5 T-25 — QC results screen `/lab/qc` (04-UI-UX §1 nav row `lab.qc.capture`, §3.12; 02-TRD §5.7 rows 43-44; PRD AC-19.2, AC-19.3 "no UI text implies QC acceptance, rejection or enforcement").
// Real HTTP goes to LIMS_ORIGIN_API (MSW); `onUnhandledRequest: 'error'` => any call outside the handlers below fails the test.
// ASSUMED module/prop contract (the spec fixes the screen, not the names; the writer matches them or disputes):
//   apps/web/src/features/lab/components/qc/QcResultsPage.tsx   export QcResultsPage({ permissions, centres, instruments })   client component
//     centres: { id, name }[] (the user's active centres), instruments: { id, name }[] (C7 list, D-14), permissions: readonly string[]. It loads GET /v1/lab/qc-results itself (bearer token, cursor paging).
//   Header (role heading): "QC results (captured — rules arrive with the QC module)". Table columns: Time, Instrument, Analyte, Control, Lot, Level, Value, Unit, Source (cell text "Instrument" / "Manual").
//     Instrument cell = the instrument's name (from `instruments`), analyte cell = IdText (first 8 chars of the id). Empty state: "No QC results captured." "Load more" while page.next_cursor is set.
//   Button "Add QC result" (only with `lab.qc.capture`) opens a role="dialog" with labelled fields: "Centre" (select over `centres`), "Instrument" (select over `instruments`), "Analyte ID", "Control ID" (maxLength 64),
//     "Control lot" (64), "Control level" (16), "Value", "Unit", "Result time" (datetime-local); submit "Save QC result" -> POST /v1/lab/qc-results with Idempotency-Key and EXACTLY
//     { centre_id, instrument_id, analyte_id, control_id_raw, [control_lot_raw], [control_level], value_numeric (the typed text), [unit_code], instrument_result_time (ISO UTC, ends in Z) }; blank optionals are omitted.
//     Client validation (required fields, decimal value) blocks the POST and shows role="alert" text. A problem+json answer shows its title in role="alert" and keeps the dialog open.
//     On success the dialog closes and the list is reloaded (GET again). The submit button is disabled while the request is in flight (one POST per click burst).
//   No colour / pass-fail / acceptance wording anywhere (AC-19.3).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { ReactNode } from 'react';
import { ToastProvider } from '@lims/ui/components/Toast';

const nav = { push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() };
vi.mock('next/navigation', () => ({
  useRouter: () => nav,
  usePathname: () => '/lab/qc',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: [], displayName: 'Synthetic Technologist', tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => '/lab/qc',
}));

const ORIGIN = 'http://api.test';
process.env.LIMS_ORIGIN_API = ORIGIN;
const U = (n: number) => `01a1a98a-ac40-7000-8000-${String(n).padStart(12, '0')}`;
const C1 = U(0x201), C2 = U(0x202), I1 = U(0x301), I2 = U(0x302), AN = U(0x4a1);
const CENTRES = [{ id: C1, name: 'Synthetic Central Lab' }, { id: C2, name: 'Synthetic Satellite Lab' }];
const INSTRUMENTS = [{ id: I1, name: 'Synthetic Analyser 1' }, { id: I2, name: 'Synthetic Analyser 2' }];
const CAPTURE = ['lab.qc.capture'];
const problem = (status: number, code: string, title: string) => HttpResponse.json({ type: `urn:lims:error:${code}`, title, status, code, request_id: 'req-synthetic-25' }, { status });

const row = (n: number, o: Record<string, unknown> = {}) => ({ id: U(0x500 + n), centre_id: C1, instrument_id: I1, analyte_id: AN, control_id_raw: `CTRL-${n}`, control_lot_raw: `LOT-${n}`, control_level: 'L1',
  value_numeric: '5.4', unit_code: 'mmol_l', instrument_result_time: '2026-11-05T04:15:00.000Z', source: 'instrument', received_at: '2026-11-05T04:16:00.000Z', ...o });

interface Call { method: string; url: URL; headers: Headers; body?: any }
const calls: Call[] = [];
const rec = async (r: Request) => { calls.push({ method: r.method, url: new URL(r.url), headers: r.headers, body: r.method === 'GET' ? undefined : await r.clone().json().catch(() => undefined) }); };
const gets = () => calls.filter((c) => c.method === 'GET');
const posts = () => calls.filter((c) => c.method === 'POST');
let listReply: (url: URL) => Response, postReply: () => Promise<Response> | Response;

const api = setupServer(
  http.get(`${ORIGIN}/v1/lab/qc-results`, async ({ request }) => { await rec(request); return listReply(new URL(request.url)); }),
  http.post(`${ORIGIN}/v1/lab/qc-results`, async ({ request }) => { await rec(request); return postReply(); }),
);
beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => {
  listReply = () => HttpResponse.json({ data: [row(1), row(2, { source: 'manual', instrument_id: I2, control_lot_raw: undefined, control_level: undefined, unit_code: undefined, value_numeric: '12' })], page: { limit: 50 } });
  postReply = () => HttpResponse.json(row(9, { source: 'manual', control_id_raw: 'CTRL-NEW', value_numeric: '5.40' }), { status: 201 });
  Object.values(nav).forEach((f) => f.mockReset());
});
afterEach(() => { cleanup(); api.resetHandlers(); calls.length = 0; });
afterAll(() => api.close());

const load = async () => (await import(/* @vite-ignore */ '../components/qc/QcResultsPage')) as Record<string, (p: any) => ReactNode>; // variable-ish path: a missing module fails each test, not the file
const open = async (permissions: readonly string[] = CAPTURE, over: Record<string, unknown> = {}) => {
  const { QcResultsPage } = await load();
  return render(<ToastProvider><QcResultsPage permissions={permissions} centres={CENTRES} instruments={INSTRUMENTS} {...over} /></ToastProvider>);
};
const rowsOf = () => screen.getAllByRole('row').slice(1);
const fill = async (user: ReturnType<typeof userEvent.setup>, dlg: HTMLElement, label: RegExp, value: string) => { const el = within(dlg).getByLabelText(label); await user.clear(el); if (value) await user.type(el, value); return el as HTMLInputElement; };
const openDialog = async () => {
  const user = userEvent.setup();
  await screen.findByRole('table');
  await user.click(screen.getByRole('button', { name: /add qc result/i }));
  return { user, dlg: await screen.findByRole('dialog') };
};
async function fillValid(user: ReturnType<typeof userEvent.setup>, dlg: HTMLElement, over: { value?: string; lot?: string; level?: string; unit?: string; control?: string } = {}) {
  await user.selectOptions(within(dlg).getByLabelText(/^centre/i), 'Synthetic Satellite Lab');
  await user.selectOptions(within(dlg).getByLabelText(/^instrument/i), 'Synthetic Analyser 2');
  await fill(user, dlg, /analyte id/i, AN);
  await fill(user, dlg, /control id/i, over.control ?? 'CTRL-NEW');
  if (over.lot !== undefined) await fill(user, dlg, /control lot/i, over.lot);
  if (over.level !== undefined) await fill(user, dlg, /control level/i, over.level);
  await fill(user, dlg, /^value/i, over.value ?? '5.40');
  if (over.unit !== undefined) await fill(user, dlg, /^unit/i, over.unit);
  fireEvent.change(within(dlg).getByLabelText(/result time/i), { target: { value: '2026-11-05T09:30' } });
}

describe('QC results list — #43 (04-UI-UX §3.12)', () => {
  it('shows the exact header, the nine columns and one row per result with Instrument / Manual source; loads GET /v1/lab/qc-results with the bearer token', async () => {
    await open();
    expect(await screen.findByRole('heading', { name: 'QC results (captured — rules arrive with the QC module)' })).toBeTruthy();
    const heads = screen.getAllByRole('columnheader').map((h) => h.textContent?.trim());
    expect(heads).toEqual(['Time', 'Instrument', 'Analyte', 'Control', 'Lot', 'Level', 'Value', 'Unit', 'Source']);
    const rows = rowsOf();
    expect(rows).toHaveLength(2);
    for (const t of ['Synthetic Analyser 1', 'CTRL-1', 'LOT-1', 'L1', '5.4', 'mmol_l', 'Instrument', AN.slice(0, 8)]) expect(within(rows[0]!).getByText(t), t).toBeTruthy();
    for (const t of ['Synthetic Analyser 2', 'CTRL-2', '12', 'Manual']) expect(within(rows[1]!).getByText(t), t).toBeTruthy();
    expect(gets()[0]!.headers.get('authorization')).toBe('Bearer jwt-synthetic');
    expect(gets()[0]!.url.pathname).toBe('/v1/lab/qc-results');
  });

  it('empty list: "No QC results captured."', async () => {
    listReply = () => HttpResponse.json({ data: [], page: { limit: 50 } });
    await open();
    expect(await screen.findByText('No QC results captured.')).toBeTruthy();
  });

  it('AC-19.3: no acceptance / rejection / pass-fail / enforcement wording and no status colours, with rows shown and with the add dialog open', async () => {
    await open();
    const { dlg } = await openDialog();
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/\b(pass(ed)?|fail(ed|ure)?|accept(ed|ance)?|reject(ed)?|in control|out of control|violation|westgard|enforc\w*|approved|warning|error limit)\b/i);
    expect(text).toMatch(/rules arrive with the QC module/);
    const html = document.body.innerHTML;
    expect(html, 'no semantic colour classes on QC rows').not.toMatch(/(danger|success|warning|text-(red|green|yellow)|bg-(red|green|yellow))/i);
    expect(within(dlg).getByRole('button', { name: /save qc result/i })).toBeTruthy();
  });

  it('paging: "Load more" requests the next cursor, appends the rows and disappears with the last page', async () => {
    listReply = (url) => url.searchParams.get('cursor')
      ? HttpResponse.json({ data: [row(3)], page: { limit: 50 } })
      : HttpResponse.json({ data: [row(1), row(2)], page: { limit: 50, next_cursor: 'CUR2' } });
    await open();
    const user = userEvent.setup();
    await screen.findByRole('table');
    await user.click(await screen.findByRole('button', { name: /load more/i }));
    await waitFor(() => expect(rowsOf()).toHaveLength(3));
    expect(gets().at(-1)!.url.searchParams.get('cursor')).toBe('CUR2');
    expect(screen.queryByRole('button', { name: /load more/i })).toBeNull();
  });

  it('a failing list shows its problem title in an alert and does not crash', async () => {
    listReply = () => problem(500, 'common.internal', 'Something went wrong');
    await open();
    expect((await screen.findByRole('alert')).textContent).toMatch(/something went wrong/i);
  });

  it('without lab.qc.capture there is no "Add QC result" control', async () => {
    await open(['lab.worklist.read']);
    await screen.findByRole('table');
    expect(screen.queryByRole('button', { name: /add qc result/i })).toBeNull();
  });

  it('has no axe violations (list + add dialog)', async () => {
    await open();
    await openDialog();
    const res = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } });
    expect(res.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });
});

describe('Add QC result — #44 (AC-19.2)', () => {
  it('the centre select offers exactly the user\'s centres and the instrument select the C7 list; length limits mirror the API (64 / 64 / 16)', async () => {
    await open();
    const { dlg } = await openDialog();
    const names = (el: HTMLElement) => within(el).getAllByRole('option').map((o) => o.textContent?.trim()).filter((t) => t && !/^(select|choose|—|-)/i.test(t));
    expect(names(within(dlg).getByLabelText(/^centre/i))).toEqual(['Synthetic Central Lab', 'Synthetic Satellite Lab']);
    expect(names(within(dlg).getByLabelText(/^instrument/i))).toEqual(['Synthetic Analyser 1', 'Synthetic Analyser 2']);
    expect((within(dlg).getByLabelText(/control id/i) as HTMLInputElement).maxLength).toBe(64);
    expect((within(dlg).getByLabelText(/control lot/i) as HTMLInputElement).maxLength).toBe(64);
    expect((within(dlg).getByLabelText(/control level/i) as HTMLInputElement).maxLength).toBe(16);
  });

  it('submits POST /v1/lab/qc-results with an Idempotency-Key and exactly the API fields; optionals omitted; value sent as typed; time as ISO UTC; then closes and reloads the list', async () => {
    await open();
    const { user, dlg } = await openDialog();
    await fillValid(user, dlg);
    const getsBefore = gets().length;
    await user.click(within(dlg).getByRole('button', { name: /save qc result/i }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    const p = posts()[0]!;
    expect(p.headers.get('authorization')).toBe('Bearer jwt-synthetic');
    expect(p.headers.get('idempotency-key') ?? '').not.toBe('');
    expect(Object.keys(p.body).sort()).toEqual(['analyte_id', 'centre_id', 'control_id_raw', 'instrument_id', 'instrument_result_time', 'value_numeric']);
    expect(p.body).toMatchObject({ centre_id: C2, instrument_id: I2, analyte_id: AN, control_id_raw: 'CTRL-NEW', value_numeric: '5.40' });
    expect(p.body.instrument_result_time).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/);
    expect(Number.isNaN(Date.parse(p.body.instrument_result_time))).toBe(false);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(gets().length).toBeGreaterThan(getsBefore));
  });

  it('lot, level and unit are sent when filled', async () => {
    await open();
    const { user, dlg } = await openDialog();
    await fillValid(user, dlg, { lot: 'LOT-77', level: 'L2', unit: 'mmol_l' });
    await user.click(within(dlg).getByRole('button', { name: /save qc result/i }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]!.body).toMatchObject({ control_lot_raw: 'LOT-77', control_level: 'L2', unit_code: 'mmol_l' });
  });

  it('required fields: an empty form sends nothing and shows alerts', async () => {
    await open();
    const { user, dlg } = await openDialog();
    await user.click(within(dlg).getByRole('button', { name: /save qc result/i }));
    expect((await within(dlg).findAllByRole('alert')).length).toBeGreaterThan(0);
    expect(posts()).toHaveLength(0);
  });

  it.each(['abc', '5,4', '1e3', '--1', ' '])('a non-decimal value "%s" sends nothing and shows an alert', async (v) => {
    await open();
    const { user, dlg } = await openDialog();
    await fillValid(user, dlg, { value: v });
    await user.click(within(dlg).getByRole('button', { name: /save qc result/i }));
    expect((await within(dlg).findAllByRole('alert')).length).toBeGreaterThan(0);
    expect(posts()).toHaveLength(0);
  });

  it('a double click sends ONE request (the button is disabled while it is in flight)', async () => {
    postReply = async () => { await new Promise((r) => setTimeout(r, 150)); return HttpResponse.json(row(9, { source: 'manual' }), { status: 201 }); };
    await open();
    const { user, dlg } = await openDialog();
    await fillValid(user, dlg);
    const btn = within(dlg).getByRole('button', { name: /save qc result/i });
    await user.dblClick(btn);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(posts()).toHaveLength(1);
  });

  it('a 403 problem shows its title in an alert, keeps the dialog open and the typed values', async () => {
    postReply = () => problem(403, 'auth.forbidden', 'Not allowed to capture for this centre');
    await open();
    const { user, dlg } = await openDialog();
    await fillValid(user, dlg);
    await user.click(within(dlg).getByRole('button', { name: /save qc result/i }));
    expect((await within(dlg).findByRole('alert')).textContent).toMatch(/not allowed to capture for this centre/i);
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect((within(dlg).getByLabelText(/control id/i) as HTMLInputElement).value).toBe('CTRL-NEW');
  });

  it('a 400 validation problem is shown, nothing is retried automatically', async () => {
    postReply = () => problem(400, 'common.validation_failed', 'Validation failed');
    await open();
    const { user, dlg } = await openDialog();
    await fillValid(user, dlg);
    await user.click(within(dlg).getByRole('button', { name: /save qc result/i }));
    expect((await within(dlg).findByRole('alert')).textContent).toMatch(/validation failed/i);
    expect(posts()).toHaveLength(1);
  });
});
