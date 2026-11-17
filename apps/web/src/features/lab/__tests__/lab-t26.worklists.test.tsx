// @vitest-environment jsdom
// C5 T-26 — worklist, pending and worksheet-print screens with MSW (PRD AC-07.1-07.5; 03-APP-FLOW §3.4-3.6; 04-UI-UX §3.4, §3.5, §3.15 and the IdText rule (08 A13 D-14); 07-SECURITY S-14).
// Real HTTP goes to LIMS_ORIGIN_API (MSW); `onUnhandledRequest: 'error'` => any call outside the handlers below fails the test (e.g. the print view must not re-read the live worklist: snapshot).
// ASSUMED module/prop contract (the spec fixes folders + the screens; names are the writer's to match or dispute):
//   apps/web/src/features/lab/components/worklists/WorklistPage.tsx   export WorklistPage({ departmentId, permissions })   client component; `permissions: readonly string[]` ("Create worksheet" only with lab.worksheet.manage)
//   apps/web/src/features/lab/components/pending/PendingPage.tsx      export PendingPage({ permissions? })
//   apps/web/src/features/lab/components/worksheets/WorksheetPrintPage.tsx  export WorksheetPrintPage({ worksheetId })   print region data-testid="print-region", @media print CSS in a <style> inside the page
//   Calls: GET /v1/lab/worklist-items (#18), GET /v1/lab/pending-items (#19), POST /v1/lab/worksheets (#20, with an Idempotency-Key header), GET /v1/lab/worksheets/{id} (#22), GET /v1/instruments/instruments (C7 E23, via the BFF -> same origin here).
//   The instrument names come from C7 only (never from lab.yaml); on 403 the instrument filter is hidden and an instrument id is shown as IdText (first 8 chars).
// SPEC GAP (notes file): WorksheetDto rows carry only {order_test_id, position, barcode, test_code}; the print view test pins what that DTO can show (#, barcode, test, blank Result / Remarks, footer) and does not invent where reg no / patient / priority come from.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { ReactNode } from 'react';
import { ToastProvider } from '@lims/ui/components/Toast';

const nav = { push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() };
vi.mock('next/navigation', () => ({
  useRouter: () => nav,
  usePathname: () => '/lab/worklists/x',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: [], displayName: 'Synthetic Lab', tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => '/lab/worklists/x',
}));

const ORIGIN = 'http://api.test';
process.env.LIMS_ORIGIN_API = ORIGIN;
const U = (n: number) => `01a1a98a-ac40-7000-8000-${String(n).padStart(12, '0')}`;
const DEPT = '0d1d1d1d-ac40-7000-8000-0000000000d1'; // distinct 8-char prefix: ruling C5.T-26 (print header shows dept + instrument IdText)
const INSTR = U(0x1a), INSTR2 = U(0x1b), WS = U(0xb1);
const problem = (code: string, status: number) => HttpResponse.json({ type: `urn:lims:error:${code}`, title: code, status, code, request_id: 'req-synthetic-26' }, { status });

const item = (n: number, o: Record<string, unknown> = {}) => ({
  order_test_id: U(0x100 + n), order_id: U(0x200 + n), specimen_id: U(0x300 + n), barcode: `E26000001${String(n).padStart(2, '0')}`, registration_no: `R26110500${String(n).padStart(2, '0')}`,
  patient_display: { full_name: `Synthetic Patient ${n}`, age_sex: '34Y/F', patient_code: `PC${n}` }, test_id: U(0x400), test_code: 'CBC', priority: 'routine', status: 'in_process',
  received_at: '2026-11-05T04:15:00.000Z', result_counts: { total: 3, resulted: 1, verified: 0 }, ...o,
});
const pend = (n: number, o: Record<string, unknown> = {}) => ({
  order_test_id: U(0x500 + n), order_id: U(0x600 + n), registration_no: `R26110500${String(n).padStart(2, '0')}`, patient_display: { full_name: `Synthetic Patient ${n}`, age_sex: '34Y/F', patient_code: `PC${n}` },
  test_code: 'CBC', item_status: 'in_process', priority: 'routine', centre_id: U(0xa1), age_seconds: 1800, age_anchor: 'received', over_target: false, ...o,
});
const sheet = (n: number, o: Record<string, unknown> = {}) => ({
  id: WS, title: 'Morning haematology', centre_id: U(0xa1), processing_centre_id: U(0xa2), department_id: DEPT, instrument_id: INSTR, created_at: '2026-11-05T04:15:00.000Z',
  rows: Array.from({ length: n }, (_, i) => ({ order_test_id: U(0x700 + i), position: i + 1, barcode: `E26000002${String(i).padStart(2, '0')}`, test_code: i % 2 ? 'GLU' : 'CBC' })), ...o,
});

const summary = (n: number, o: Record<string, unknown> = {}) => ({ // WorksheetSummary (lab.yaml): WorksheetDto without rows + row_count
  id: U(0xb00 + n), title: 'Morning haematology', centre_id: U(0xa1), processing_centre_id: U(0xa2), department_id: DEPT, created_at: '2026-11-05T04:15:00.000Z', row_count: 30, ...o,
});

interface Call { op: string; url: URL; headers: Headers; body?: any }
const calls: Call[] = [];
const rec = async (op: string, r: Request) => { calls.push({ op, url: new URL(r.url), headers: r.headers, body: r.method === 'GET' ? undefined : await r.clone().json().catch(() => undefined) }); };
const ops = (op: string) => calls.filter((c) => c.op === op);
let worklistReply: () => Response, pendingReply: () => Response, sheetReply: () => Response, createReply: () => Response, instrumentsReply: () => Response, sheetsReply: (u: URL) => Response;

const api = setupServer(
  http.get(`${ORIGIN}/v1/lab/worklist-items`, async ({ request }) => { await rec('worklist', request); return worklistReply(); }),
  http.get(`${ORIGIN}/v1/lab/pending-items`, async ({ request }) => { await rec('pending', request); return pendingReply(); }),
  http.get(`${ORIGIN}/v1/lab/worksheets`, async ({ request }) => { await rec('listSheets', request); return sheetsReply(new URL(request.url)); }),
  http.post(`${ORIGIN}/v1/lab/worksheets`, async ({ request }) => { await rec('create', request); return createReply(); }),
  http.get(`${ORIGIN}/v1/lab/worksheets/:id`, async ({ request }) => { await rec('getSheet', request); return sheetReply(); }),
  http.get(`${ORIGIN}/v1/instruments/instruments`, async ({ request }) => { await rec('instruments', request); return instrumentsReply(); }),
);
const page = (data: unknown[]) => HttpResponse.json({ data, page: { limit: 50 } });
beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => {
  worklistReply = () => page([item(1, { priority: 'urgent' }), item(2), item(3, { status: 'resulted' })]);
  pendingReply = () => page([pend(1), pend(2, { item_status: 'awaiting_receipt', age_anchor: 'registered', age_seconds: 5400, over_target: true, tat_target_seconds: 3600 })]);
  sheetReply = () => HttpResponse.json(sheet(30));
  createReply = () => HttpResponse.json(sheet(2), { status: 201 });
  sheetsReply = () => HttpResponse.json({ data: [summary(1), summary(2, { title: 'Evening biochemistry', row_count: 0 })], page: { limit: 50 } });
  instrumentsReply = () => HttpResponse.json({ data: [{ id: INSTR, display_name: 'Synthetic Analyser A' }, { id: INSTR2, display_name: 'Synthetic Analyser B' }], page: { limit: 50 } });
  Object.values(nav).forEach((f) => f.mockReset());
});
afterEach(() => { cleanup(); api.resetHandlers(); calls.length = 0; document.head.querySelectorAll('style').forEach((s) => s.remove()); });
afterAll(() => api.close());

const load = async (dir: string, name: string) => (await import(/* @vite-ignore */ `../components/${dir}/${name}`)) as Record<string, (p: any) => ReactNode>; // variable path: a missing module fails each test, not the file
const openWorklist = async (permissions: readonly string[] = ['lab.worklist.read', 'lab.worksheet.manage']) => {
  const { WorklistPage } = await load('worklists', 'WorklistPage');
  return render(<ToastProvider><WorklistPage departmentId={DEPT} permissions={permissions} /></ToastProvider>);
};
const openPending = async () => { const { PendingPage } = await load('pending', 'PendingPage'); return render(<ToastProvider><PendingPage permissions={['lab.worklist.read']} /></ToastProvider>); };
const openSheet = async () => { const { WorksheetPrintPage } = await load('worksheets', 'WorksheetPrintPage'); return render(<ToastProvider><WorksheetPrintPage worksheetId={WS} /></ToastProvider>); };
const openSheets = async () => { const { WorksheetListPage } = await load('worksheets', 'WorksheetListPage'); return render(<ToastProvider><WorksheetListPage permissions={['lab.worklist.read']} /></ToastProvider>); };
const rowsOf = () => screen.getAllByRole('row').slice(1);

describe('AC-07.1 — worklist of one department, urgent first with "★ Urgent" text', () => {
  it('asks #18 for the department only (default sort / status: no overrides) and lists the rows in the order the API gave them; barcode, reg no, patient, test shown', async () => {
    await openWorklist();
    await screen.findByText('E2600000101');
    expect(ops('worklist')).toHaveLength(1);
    expect(ops('worklist')[0]!.url.searchParams.get('department_id')).toBe(DEPT);
    expect(ops('worklist')[0]!.url.searchParams.get('sort')).toBeNull();                    // server default priority_received
    expect(ops('worklist')[0]!.headers.get('authorization')).toBe('Bearer jwt-synthetic');
    const rows = rowsOf();
    expect(rows).toHaveLength(3);
    expect(rows[0]!.textContent).toContain('E2600000101');
    expect(rows[0]!.textContent).toContain('R2611050001');
    expect(rows[0]!.textContent).toContain('Synthetic Patient 1');
    expect(rows[0]!.textContent).toContain('CBC');
  });

  it('an urgent row shows "★" AND the visible text "Urgent" (not icon alone, not sr-only only); routine rows show neither', async () => {
    await openWorklist();
    await screen.findByText('E2600000101');
    const [urgent, routine] = rowsOf();
    expect(urgent!.textContent).toMatch(/★/);
    const word = within(urgent!).getByText(/Urgent/);
    expect(word.closest('.sr-only, .visually-hidden, [class*="sr-only"]')).toBeNull();
    expect(routine!.textContent).not.toMatch(/★|Urgent/);
  });

  it('columns state their anchor: "Age since received" and "TAT target" (04-UI-UX §3.4 / glossary TAT rule); statuses as text; Received time shown', async () => {
    await openWorklist();
    await screen.findByText('E2600000101');
    for (const h of [/Age since received/, /TAT target/, /Barcode/, /Reg no/, /Patient/, /Test/, /Status/, /Received/]) expect(screen.getAllByRole('columnheader').some((c) => h.test(c.textContent ?? ''))).toBe(true);
    expect(rowsOf()[2]!.textContent).toMatch(/Resulted/i);
    expect(rowsOf()[0]!.textContent).toMatch(/In process/i);
  });

  it('empty: "No pending tests for this department."', async () => {
    worklistReply = () => page([]);
    await openWorklist();
    expect(await screen.findByText('No pending tests for this department.')).toBeTruthy();
  });

  it('the priority filter goes to #18 as a query value (priority=urgent)', async () => {
    await openWorklist();
    await screen.findByText('E2600000101');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: /priority/i }), 'urgent');
    await waitFor(() => expect(ops('worklist').at(-1)!.url.searchParams.get('priority')).toBe('urgent'));
  });

  it('attack: a patient name / test code with markup is rendered as text (S-14), no injected element', async () => {
    worklistReply = () => page([item(1, { patient_display: { full_name: '<img src=x onerror=alert(1)>', age_sex: '1Y/F', patient_code: 'P' } })]);
    await openWorklist();
    await waitFor(() => expect(within(document.body).getAllByText(/onerror/).length).toBeGreaterThan(0));
    expect(document.querySelector('img[src="x"]')).toBeNull();
  });

  it('no axe violations (worklist with rows)', async () => {
    await openWorklist();
    await screen.findByText('E2600000101');
    const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } });
    expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
  });
});

describe('AC-07.5 — no access / failure states', () => {
  it('403 from #18: "You don\'t have access to this screen." without Retry and no row data', async () => {
    worklistReply = () => problem('auth.forbidden', 403);
    await openWorklist();
    expect(await screen.findByText("You don't have access to this screen.")).toBeTruthy();
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
    expect(screen.queryAllByRole('row')).toHaveLength(0);
  });
  it('500 from #18: ErrorState "Something went wrong" with the request_id and Retry', async () => {
    worklistReply = () => problem('common.internal', 500);
    await openWorklist();
    expect(await screen.findByText('Something went wrong')).toBeTruthy();
    expect(screen.getByText(/req-synthetic-26/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy();
  });
  it('403 from #19 on the pending page: same "no access" text, no rows', async () => {
    pendingReply = () => problem('auth.forbidden', 403);
    await openPending();
    expect(await screen.findByText("You don't have access to this screen.")).toBeTruthy();
  });
});

describe('AC-07.2 / 08 A13 D-14 — instrument filter: names from C7 E23 via the BFF, IdText on 403 (filter hidden)', () => {
  it('lists the C7 display names; choosing one sends instrument_id (a UUID the user never types)', async () => {
    await openWorklist();
    const sel = await screen.findByRole('combobox', { name: /instrument/i });
    expect(ops('instruments')).toHaveLength(1);
    expect(within(sel).getByRole('option', { name: 'Synthetic Analyser A' })).toBeTruthy();
    await userEvent.selectOptions(sel, 'Synthetic Analyser A');
    await waitFor(() => expect(ops('worklist').at(-1)!.url.searchParams.get('instrument_id')).toBe(INSTR));
    expect(screen.queryByRole('textbox', { name: /instrument/i })).toBeNull();            // free UUID not offered
  });
  it('C7 answers 403: the instrument filter is hidden (no select, no free-text), the list still loads and the worklist makes no instrument_id call', async () => {
    instrumentsReply = () => problem('auth.forbidden', 403);
    await openWorklist();
    await screen.findByText('E2600000101');
    await waitFor(() => expect(ops('instruments')).toHaveLength(1));
    expect(screen.queryByRole('combobox', { name: /instrument/i })).toBeNull();
    expect(screen.queryByRole('textbox', { name: /instrument/i })).toBeNull();
    expect(ops('worklist').every((c) => c.url.searchParams.get('instrument_id') === null)).toBe(true);
  });
});

describe('AC-07.4 — select rows, "Create worksheet" (needs lab.worksheet.manage)', () => {
  it('without lab.worksheet.manage there is no "Create worksheet" action', async () => {
    await openWorklist(['lab.worklist.read']);
    await screen.findByText('E2600000101');
    expect(screen.queryByRole('button', { name: /create worksheet/i })).toBeNull();
  });
  it('with nothing selected the action is disabled; selecting 2 rows enables it; the dialog needs a title (max 80), then POSTs title + the selected order_test_ids with an Idempotency-Key and opens the worksheet', async () => {
    await openWorklist();
    await screen.findByText('E2600000101');
    const btn = screen.getByRole('button', { name: /create worksheet/i }) as HTMLButtonElement;
    expect(btn.disabled || btn.getAttribute('aria-disabled') === 'true').toBe(true);
    const boxes = screen.getAllByRole('checkbox').filter((b) => b.closest('tr')) as HTMLInputElement[];
    await userEvent.click(boxes[0]!); await userEvent.click(boxes[2]!);
    expect(btn.disabled).toBe(false);
    await userEvent.click(btn);
    const dlg = await screen.findByRole('dialog');
    const title = within(dlg).getByRole('textbox', { name: /title/i }) as HTMLInputElement;
    expect(Number(title.getAttribute('maxlength'))).toBe(80);
    await userEvent.click(within(dlg).getByRole('button', { name: /^(create|create worksheet|save)$/i }));
    expect(ops('create')).toHaveLength(0);                                                // title is required
    await userEvent.type(title, 'Morning haematology');
    await userEvent.click(within(dlg).getByRole('button', { name: /^(create|create worksheet|save)$/i }));
    await waitFor(() => expect(ops('create')).toHaveLength(1));
    const c = ops('create')[0]!;
    expect(c.body.title).toBe('Morning haematology');
    expect(c.body.order_test_ids).toEqual([U(0x101), U(0x103)]);
    expect(c.body.department_id === undefined || c.body.department_id === DEPT).toBe(true);
    expect(c.headers.get('idempotency-key')).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(Object.keys(c.body).every((k) => ['title', 'centre_id', 'department_id', 'instrument_id', 'order_test_ids'].includes(k))).toBe(true);
    await waitFor(() => expect(nav.push).toHaveBeenCalledWith(`/lab/worksheets/${WS}`));
  });
  it('403 on create (centre not in scope): the dialog stays open with "You don\'t have access to this screen." / forbidden text, nothing navigated', async () => {
    createReply = () => problem('auth.forbidden', 403);
    await openWorklist();
    await screen.findByText('E2600000101');
    await userEvent.click((screen.getAllByRole('checkbox').filter((b) => b.closest('tr')))[0]!);
    await userEvent.click(screen.getByRole('button', { name: /create worksheet/i }));
    const dlg = await screen.findByRole('dialog');
    await userEvent.type(within(dlg).getByRole('textbox', { name: /title/i }), 'X');
    await userEvent.click(within(dlg).getByRole('button', { name: /^(create|create worksheet|save)$/i }));
    await waitFor(() => expect(ops('create')).toHaveLength(1));
    expect(await screen.findByText(/don't have access|not allowed|forbidden/i)).toBeTruthy();
    expect(nav.push).not.toHaveBeenCalled();
  });
});

describe('AC-07.3 — pending list: anchors are always named, awaiting rows included, over-target badge as text', () => {
  it('asks #19, shows awaiting_receipt rows as "Awaiting receipt", "Over target" as a text badge only on the over-target row, "—" for a missing TAT target', async () => {
    await openPending();
    await screen.findByText('R2611050001');
    expect(ops('pending')).toHaveLength(1);
    const [r1, r2] = rowsOf();
    expect(r2!.textContent).toMatch(/Awaiting receipt/);
    expect(r2!.textContent).toMatch(/Over target/);
    expect(r1!.textContent).not.toMatch(/Over target/);
    expect(r1!.textContent).toMatch(/—/);
    expect(r2!.textContent).toMatch(/01:00|1 ?h/);                                       // the 3600 s target, as hh:mm or "1 h"
  });
  it('the age is never shown without its start point: a list with awaiting and in-process rows names BOTH "Age since registered" and "Age since received"', async () => {
    await openPending();
    await screen.findByText('R2611050001');
    const text = document.body.textContent ?? '';
    expect(text).toMatch(/Age since registered/);
    expect(text).toMatch(/Age since received/);
  });
  it('a list with only received rows never claims "Age since registered"', async () => {
    pendingReply = () => page([pend(1), pend(2, { item_status: 'resulted' })]);
    await openPending();
    await screen.findByText('R2611050001');
    expect(document.body.textContent).toMatch(/Age since received/);
    expect(document.body.textContent).not.toMatch(/Age since registered/);
  });
  it('"Over target only" sends over_target=true; empty state "Nothing pending."', async () => {
    await openPending();
    await screen.findByText('R2611050001');
    pendingReply = () => page([]);
    await userEvent.click(screen.getByRole('checkbox', { name: /over target only/i }));
    await waitFor(() => expect(ops('pending').at(-1)!.url.searchParams.get('over_target')).toBe('true'));
    expect(await screen.findByText('Nothing pending.')).toBeTruthy();
  });
  it('no axe violations (pending list)', async () => {
    await openPending();
    await screen.findByText('R2611050001');
    const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } });
    expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
  });
});

// Review item 1 (T-26 review): nav row "Worksheets | /lab/worksheets | lab.worklist.read" (04-UI-UX §1) calls #21 listWorksheets.
// ASSUMED (spec silent): export WorksheetListPage({ permissions? }) in components/worksheets/WorksheetListPage.tsx; empty text "No worksheets."; paging control = a button named /next|more/i that re-asks #21 with cursor=next_cursor.
describe('AC-07.4 — worksheets list (#21): title, created at, row count, link to the worksheet', () => {
  it('asks #21 once with the bearer token and lists title, created at and row_count; each title links to /lab/worksheets/{id}', async () => {
    await openSheets();
    await screen.findByText('Evening biochemistry');
    expect(ops('listSheets')).toHaveLength(1);
    expect(ops('listSheets')[0]!.headers.get('authorization')).toBe('Bearer jwt-synthetic');
    const rows = rowsOf();
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain('Morning haematology');
    expect(rows[0]!.textContent).toMatch(/\b30\b/);
    expect(rows[0]!.textContent).toMatch(/2026|05|Nov/);                                 // created_at rendered, not dropped
    expect(rows[1]!.textContent).toMatch(/\b0\b/);
    expect(within(rows[0]!).getByRole('link', { name: /Morning haematology/ }).getAttribute('href')).toBe(`/lab/worksheets/${U(0xb01)}`);
    const heads = screen.getAllByRole('columnheader').map((h) => h.textContent ?? '');
    for (const h of [/Title/, /Created/, /Rows|Row count|Tests/]) expect(heads.some((t) => h.test(t))).toBe(true);
  });
  it('shows no raw centre / department UUIDs (D-14: ids only as IdText)', async () => {
    await openSheets();
    await screen.findByText('Evening biochemistry');
    for (const id of [U(0xa1), U(0xa2), DEPT]) expect(document.body.textContent).not.toContain(id);
  });
  it('empty: "No worksheets." and no data rows', async () => {
    sheetsReply = () => page([]);
    await openSheets();
    expect(await screen.findByText(/No worksheets/i)).toBeTruthy();
    expect(screen.queryAllByRole('row').length).toBeLessThanOrEqual(1);                   // header row at most
  });
  it('403 from #21: "You don\'t have access to this screen." without Retry and no row data', async () => {
    sheetsReply = () => problem('auth.forbidden', 403);
    await openSheets();
    expect(await screen.findByText("You don't have access to this screen.")).toBeTruthy();
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
    expect(screen.queryAllByRole('row')).toHaveLength(0);
  });
  it('500 from #21: ErrorState "Something went wrong" with the request_id and Retry', async () => {
    sheetsReply = () => problem('common.internal', 500);
    await openSheets();
    expect(await screen.findByText('Something went wrong')).toBeTruthy();
    expect(screen.getByText(/req-synthetic-26/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy();
  });
  it('paging: next_cursor shows a next/more control that re-asks #21 with cursor=<next_cursor> and shows the next rows', async () => {
    sheetsReply = (u) => u.searchParams.get('cursor') === 'CUR2'
      ? HttpResponse.json({ data: [summary(3, { title: 'Night serology' })], page: { limit: 50 } })
      : HttpResponse.json({ data: [summary(1)], page: { limit: 1, next_cursor: 'CUR2' } });
    await openSheets();
    await screen.findByText('Morning haematology');
    await userEvent.click(screen.getByRole('button', { name: /next|more/i }));
    await waitFor(() => expect(ops('listSheets').at(-1)!.url.searchParams.get('cursor')).toBe('CUR2'));
    expect(await screen.findByText('Night serology')).toBeTruthy();
  });
  it('attack: a title with markup is rendered as text (S-14), no injected element', async () => {
    sheetsReply = () => page([summary(1, { title: '<img src=x onerror=alert(1)>' })]);
    await openSheets();
    await waitFor(() => expect(within(document.body).getAllByText(/onerror/).length).toBeGreaterThan(0));
    expect(document.querySelector('img[src="x"]')).toBeNull();
  });
  it('no axe violations (worksheets list)', async () => {
    await openSheets();
    await screen.findByText('Evening biochemistry');
    const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } });
    expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
  });
});

describe('AC-07.4 / §3.15 — worksheet print view: a snapshot, rendered from #22 only', () => {
  it('shows the title, 30 numbered rows with barcode + test code and BLANK "Result" / "Remarks" cells; reads #22 once and nothing from the live worklist (MSW would fail on #18)', async () => {
    await openSheet();
    expect(await screen.findByText('Morning haematology')).toBeTruthy();
    expect(ops('getSheet')).toHaveLength(1);
    expect(ops('getSheet')[0]!.url.pathname).toBe(`/v1/lab/worksheets/${WS}`);
    const rows = rowsOf();
    expect(rows).toHaveLength(30);
    expect(rows[0]!.textContent).toContain('E2600000200');
    expect(rows[29]!.textContent).toContain('E2600000229');
    expect(rows[0]!.textContent).toContain('CBC');
    expect(rows[1]!.textContent).toContain('GLU');
    const heads = screen.getAllByRole('columnheader').map((h) => h.textContent ?? '');
    expect(heads.some((h) => /^#$|No\.?$/i.test(h.trim()))).toBe(true);
    expect(heads.some((h) => /Result/.test(h))).toBe(true);
    expect(heads.some((h) => /Remarks/.test(h))).toBe(true);
    const resultIdx = heads.findIndex((h) => /^Result$/.test(h.trim())), remarksIdx = heads.findIndex((h) => /^Remarks$/.test(h.trim()));
    for (const r of rows) {
      const cells = within(r).getAllByRole('cell');
      expect((cells[resultIdx]?.textContent ?? '').trim()).toBe('');
      expect((cells[remarksIdx]?.textContent ?? '').trim()).toBe('');
    }
    expect(ops('worklist')).toHaveLength(0);
  });
  it('footer marks it as a snapshot: "Printed {datetime} — snapshot; check the worklist for current status."; header shows the row count', async () => {
    await openSheet();
    await screen.findByText('Morning haematology');
    expect(document.body.textContent).toMatch(/Printed .+ — snapshot; check the worklist for current status\./);
    expect(document.body.textContent).toMatch(/\b30\b/);
  });
  it('print CSS: A4 portrait in an @media print block; the print region exists', async () => {
    await openSheet();
    await screen.findByText('Morning haematology');
    const css = [...document.querySelectorAll('style')].map((s) => s.textContent ?? '').join('\n') + [...document.querySelectorAll('[data-testid="print-region"]')].map((r) => r.innerHTML).join('\n');
    expect(document.querySelector('[data-testid="print-region"]')).not.toBeNull();
    expect(css).toMatch(/@media print/);
    expect(css).toMatch(/@page[^}]*(A4|210mm)/i);
  });
  it('instrument: the C7 display name when readable; IdText (first 8 chars of the id, never a raw UUID, never a guessed name) on 403', async () => {
    await openSheet();
    expect(await screen.findByText(/Synthetic Analyser A/)).toBeTruthy();
    cleanup(); calls.length = 0;
    instrumentsReply = () => problem('auth.forbidden', 403);
    await openSheet();
    await screen.findByText('Morning haematology');
    await waitFor(() => expect(ops('instruments')).toHaveLength(1));
    expect(screen.queryByText(/Synthetic Analyser/)).toBeNull();
    const id = screen.getByText(new RegExp(INSTR.slice(0, 8)));
    expect(id.textContent).not.toContain(INSTR);
    expect(id.closest('[title]')?.getAttribute('title') ?? id.getAttribute('title')).toBe(INSTR);
  });
  it('04-UI-UX §3.15: header shows the department as IdText (first 8 chars, full id in title), never the raw UUID as text', async () => {
    await openSheet();
    await screen.findByText('Morning haematology');
    expect(document.body.textContent).toMatch(/Department:/);
    const id = screen.getByText(new RegExp(DEPT.slice(0, 8)));
    expect(id.textContent).not.toContain(DEPT);
    expect(id.closest('[title]')?.getAttribute('title') ?? id.getAttribute('title')).toBe(DEPT);
    expect(document.body.textContent).not.toContain(DEPT);
  });
  it('404: "This item doesn\'t exist or isn\'t visible to you." (another centre / tenant looks the same); 403: no-access text; no row data either way', async () => {
    sheetReply = () => problem('common.not_found', 404);
    await openSheet();
    expect(await screen.findByText("This item doesn't exist or isn't visible to you.")).toBeTruthy();
    cleanup();
    sheetReply = () => problem('auth.forbidden', 403);
    await openSheet();
    expect(await screen.findByText("You don't have access to this screen.")).toBeTruthy();
    expect(screen.queryAllByRole('row')).toHaveLength(0);
  });
  it('attack: a title / test code with markup is rendered as text (S-14)', async () => {
    sheetReply = () => HttpResponse.json(sheet(1, { title: '<img src=x onerror=alert(1)>' }));
    await openSheet();
    await waitFor(() => expect(within(document.body).getAllByText(/onerror/).length).toBeGreaterThan(0));
    expect(document.querySelector('img[src="x"]')).toBeNull();
  });
  it('no axe violations (print view)', async () => {
    await openSheet();
    await screen.findByText('Morning haematology');
    const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } });
    expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
  });
});
