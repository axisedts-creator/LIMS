// @vitest-environment jsdom
// C5.T-20 — Result entry grid `/lab/orders/{order_id}/results` (04-UI-UX §3.6 + §3.7; PRD AC-08.1, AC-08.4, AC-09.2, AC-09.3, AC-10.1, AC-11.1, AC-11.2;
// 07-SECURITY S-14 (comment/library text is plain text), P-02/S-22 (history keyed by ids only). done_when: every shortcut of the §3.6 keyboard table works WITHOUT the mouse.
// LD-25 (2026-11-07, A33-2 downtime mode; T-20 part): the grid has a "Downtime back-entry" toggle; back-entry needs `occurred_at` (<= now, >= now - downtime_backentry_max_hours, default 72)
// and `downtime_ref` (<= 32 chars); result writes carry `entry_mode:'downtime_backentry'`; history shows "Entered after downtime" with the original time. Tests for each limit. Synthetic data only.
//
// ASSUMED module/prop contract (spec fixes behaviour + folder `components/grid/`; dispute a name through the ruling flow, never by editing this file):
//   apps/web/src/features/lab/components/grid/ResultGrid.tsx   export function ResultGrid(props)  — named export, 'use client'; built on UI kit EditableGrid (role=grid) + TimeSeriesChart.
//   props: {
//     data: OrderResultsResponse              the `listOrderResults` body: { order:{order_id,registration_no,...}, items:[{order_item_id, test:{test_id,test_code}, results: ResultDto[]}] }
//     analytes: Record<analyte_id, { name: string; decimals?: number; value_type: 'numeric'|'ordinal'|'text' }>   catalog facts the ResultDto does not carry (analyte name, decimals)
//     permissions: string[]                   session permissions (lab.result.enter|verify|approve|amend|read)
//     patientId: string                       needed by getAnalyteTrend (#26 path); the ResultDto/LabOrderDto has no patient id — SPEC GAP, see notes
//     returnReasons: {code,display}[]         coded set return_reasons     amendmentReasons: {code,display}[]   coded set amendment_reasons (the grid must drop the 3 module-only codes itself)
//     downtimeMaxHours?: number               tenant setting downtime_backentry_max_hours (default 72)
//     worklist?: { prevOrderId?: string; nextOrderId?: string }   Alt+P / Alt+N target `/lab/orders/{id}/results` via next/navigation router.push
//   }
//   DOM contract: <table role=grid> with columnheaders incl. "Analyte" and "Value"; a row's FIRST gridcell holds "<name> <code>" (the code as its own word); the Value gridcell of an editable row is the
//   editing target: focus it, TYPE a printable character to start editing (an <input> appears), Enter commits AND moves focus to the Value cell of the next editable row (calculated/locked rows are skipped),
//   Shift+Enter / ArrowUp previous, ArrowDown next, Tab / Shift+Tab next/previous cell in the row, Esc cancels the edit (value reverted). Each row has one textbox whose accessible name matches /comment/i
//   (the T-18 CommentCell). All shortcuts are handled at page level (keydown on document) so they also work while focus is in a dialog/panel/input.
//   Writes go through server actions → BFF (MSW observes): POST /v1/lab/results/bulk-enter {entries:[{result_id,version,value_numeric|value_text|ordinal_code,comment_codes?,comment_text?}], entry_mode?, occurred_at?, downtime_ref?}
//   with `Idempotency-Key`; bulk-verify / bulk-approve {items:[{id,version,acknowledged_flags?}]}; POST /v1/lab/results/{id}/return {reason_code,comment?}; POST /v1/lab/results/{id}/amend
//   {value_numeric|value_text|ordinal_code, amendment_reason_code, amendment_reason_text?, comment_codes?, comment_text?} with `Idempotency-Key`; GET /v1/lab/results/{id}/history?limit=5;
//   GET /v1/lab/patients/{patient_id}/analytes/{analyte_id}/trend?limit=50; GET /v1/catalog/comment-codes?code_prefix=.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { ReactNode } from 'react';
import { ToastProvider } from '@lims/ui/components/Toast';
import { ResultGrid } from '../components/grid/ResultGrid';

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/lab/orders/x/results',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: [], displayName: 'Synthetic Tech', tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => '/lab/orders/x/results',
}));
const ORIGIN = 'http://api.test';
process.env.LIMS_ORIGIN_API = ORIGIN;

const id = (n: number) => `01a1a98a-ac40-7000-8000-${String(n).padStart(12, '0')}`;
const PATIENT = id(7777);
const ORDER = id(8888);
const ENTER = ['lab.result.read', 'lab.result.enter'];
const ALL = ['lab.result.read', 'lab.result.enter', 'lab.result.verify', 'lab.result.approve', 'lab.result.amend'];

// analyte n → result id(n), analyte id(100+n); CBC item id(10): HB(1) WBC(2) PLT(3); lipid item id(20): TC(4) HDL(5) TG(6) LDL(7, calculated)
const A = [
  { n: 1, code: 'HB', name: 'Hemoglobin', decimals: 1, item: 10 },
  { n: 2, code: 'WBC', name: 'Leukocytes', decimals: 1, item: 10 },
  { n: 3, code: 'PLT', name: 'Platelets', decimals: 0, item: 10 },
  { n: 4, code: 'TC', name: 'Total cholesterol', decimals: 2, item: 20 },
  { n: 5, code: 'HDL', name: 'High density chol.', decimals: 2, item: 20 },
  { n: 6, code: 'TG', name: 'Triglycerides', decimals: 2, item: 20 },
  { n: 7, code: 'LDL', name: 'Low density chol.', decimals: 2, item: 20 },
];
type Over = Record<string, unknown>;
const res = (n: number, o: Over = {}) => ({
  id: id(n), version: 1, order_id: ORDER, order_item_id: id(A[n - 1]!.item), specimen_id: id(3000 + n), test_id: id(A[n - 1]!.item + 4000), analyte_id: id(100 + n),
  analyte_code: A[n - 1]!.code, status: 'pending', origin: 'manual', unit_code: 'g_dl', range_unavailable_age_unknown: false, critical: { is_critical: false },
  on_hold: false, qc_review_required: false, unit_mismatch: false, current_version_no: 0, delta: { status: 'none' }, instrument_flags: [], ...o,
});
const build = (over: Record<number, Over> = {}) => ({
  order: { order_id: ORDER, registration_no: 'REG0042', specimens: [], order_tests: [] },
  items: [
    { order_item_id: id(10), test: { test_id: id(4010), test_code: 'CBC' }, results: [1, 2, 3].map((n) => res(n, over[n])) },
    { order_item_id: id(20), test: { test_id: id(4020), test_code: 'LIPID' }, results: [4, 5, 6, 7].map((n) => res(n, n === 7 ? { origin: 'calculated', calc: { status: 'waiting_for_inputs', reason: 'missing_input:HDL' }, ...over[n] } : over[n])) },
  ],
});
const analytes = Object.fromEntries(A.map((a) => [id(100 + a.n), { name: a.name, decimals: a.decimals, value_type: 'numeric' as const }]));
const RETURN_REASONS = [{ code: 'recheck', display: 'Recheck value' }, { code: 'wrong_specimen', display: 'Wrong specimen' }];
const AMEND_REASONS = [
  { code: 'transcription_error', display: 'Transcription error' }, { code: 'instrument_recalibration', display: 'Instrument recalibration' },
  { code: 'module_phase_progression', display: 'Module phase progression' }, { code: 'module_preliminary_update', display: 'Module preliminary update' }, { code: 'supplementary_report', display: 'Supplementary report' },
];

const calls: { method: string; url: URL; headers: Headers; body?: any }[] = [];
const rec = async (r: Request) => { calls.push({ method: r.method, url: new URL(r.url), headers: r.headers, body: r.method === 'GET' ? undefined : await r.clone().json().catch(() => undefined) }); };
const problem = (status: number, code: string) => HttpResponse.json({ type: 'about:blank', title: code, status, code }, { status, headers: { 'content-type': 'application/problem+json' } });
const base = (n: number) => res(n);
let enterReply: (b: any) => Response | Promise<Response> = (b) => HttpResponse.json({
  results: b.entries.map((e: any) => ({ result_id: e.result_id, outcome: 'ok', result: { ...base(Number(e.result_id.slice(-12))), id: e.result_id, version: e.version + 1, status: 'resulted', value_numeric: e.value_numeric, flag: 'N', current_version_no: 1 } })),
  recomputed: [],
});
let verifyReply: (b: any) => Response | Promise<Response> = (b) => HttpResponse.json({ results: b.items.map((i: any) => ({ id: i.id, outcome: 'ok' })) });
let approveReply: (b: any) => Response | Promise<Response> = (b) => HttpResponse.json({ results: b.items.map((i: any) => ({ id: i.id, outcome: 'ok' })) });
let historyReply: (rid: string) => Response = () => HttpResponse.json({ data: [] });
let trendReply: () => Response = () => HttpResponse.json({ points: [] });
let returnReply: () => Response = () => HttpResponse.json(res(1, { status: 'resulted', version: 3 }));
let amendReply: () => Response = () => HttpResponse.json(res(1, { status: 'approved', version: 4, current_version_no: 2 }));
const CODES: Record<string, { text: string; version: number }> = { HYPO: { text: 'Result is consistent with hypothyroidism.', version: 3 } };

const api = setupServer(
  http.post(`${ORIGIN}/v1/lab/results/bulk-enter`, async ({ request }) => { await rec(request); return enterReply(await request.clone().json()); }),
  http.post(`${ORIGIN}/v1/lab/results/bulk-verify`, async ({ request }) => { await rec(request); return verifyReply(await request.clone().json()); }),
  http.post(`${ORIGIN}/v1/lab/results/bulk-approve`, async ({ request }) => { await rec(request); return approveReply(await request.clone().json()); }),
  http.post(`${ORIGIN}/v1/lab/results/:rid/return`, async ({ request }) => { await rec(request); return returnReply(); }),
  http.post(`${ORIGIN}/v1/lab/results/:rid/amend`, async ({ request }) => { await rec(request); return amendReply(); }),
  http.get(`${ORIGIN}/v1/lab/results/:rid/history`, async ({ request, params }) => { await rec(request); return historyReply(String(params['rid'])); }),
  http.get(`${ORIGIN}/v1/lab/patients/:pid/analytes/:aid/trend`, async ({ request }) => { await rec(request); return trendReply(); }),
  http.get(`${ORIGIN}/v1/catalog/comment-codes`, async ({ request }) => {
    await rec(request);
    const p = new URL(request.url).searchParams.get('code_prefix') ?? '';
    return HttpResponse.json({ data: Object.entries(CODES).filter(([c]) => c.startsWith(p)).map(([code, v], i) => ({ id: id(900 + i), code, text: v.text, version: v.version, is_active: true })), page: { has_more: false } });
  }),
);
const reset = () => {
  enterReply = (b) => HttpResponse.json({
    results: b.entries.map((e: any) => ({ result_id: e.result_id, outcome: 'ok', result: { ...base(Number(e.result_id.slice(-12))), id: e.result_id, version: e.version + 1, status: 'resulted', value_numeric: e.value_numeric, flag: 'N', current_version_no: 1 } })),
    recomputed: [],
  });
  verifyReply = (b) => HttpResponse.json({ results: b.items.map((i: any) => ({ id: i.id, outcome: 'ok' })) });
  approveReply = (b) => HttpResponse.json({ results: b.items.map((i: any) => ({ id: i.id, outcome: 'ok' })) });
  historyReply = () => HttpResponse.json({ data: [] });
  trendReply = () => HttpResponse.json({ points: [] });
  returnReply = () => HttpResponse.json(res(1, { status: 'resulted', version: 3 }));
  amendReply = () => HttpResponse.json(res(1, { status: 'approved', version: 4, current_version_no: 2 }));
};
beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
afterEach(() => { cleanup(); api.resetHandlers(); calls.length = 0; push.mockReset(); reset(); });
afterAll(() => api.close());

type GridProps = Partial<React.ComponentProps<typeof ResultGrid>>;
const show = (o: { over?: Record<number, Over>; props?: GridProps } = {}) =>
  render(
    <ToastProvider>
      <ResultGrid
        {...({ data: build(o.over), analytes, permissions: ENTER, patientId: PATIENT, returnReasons: RETURN_REASONS, amendmentReasons: AMEND_REASONS, ...o.props } as React.ComponentProps<typeof ResultGrid>)}
      />
    </ToastProvider>,
  );
const user = () => userEvent.setup();
const rowOf = (code: string) => {
  const r = screen.getAllByRole('row').find((x) => new RegExp(`\\b${code}\\b`).test(x.querySelector('[role=gridcell]')?.textContent ?? ''));
  if (!r) throw new Error(`no grid row for ${code}`);
  return r;
};
const valueIdx = () => within(screen.getByRole('grid')).getAllByRole('columnheader').findIndex((h) => /^value$/i.test(h.textContent?.trim() ?? ''));
const valueCell = (code: string) => within(rowOf(code)).getAllByRole('gridcell')[valueIdx()] as HTMLElement;
const focusValue = (code: string) => { valueCell(code).focus(); expect(document.activeElement).toBe(valueCell(code)); };
const focusRow = (el: Element | null) => (el?.closest('[role=row]')?.querySelector('[role=gridcell]')?.textContent ?? '');
const activeIsValueOf = (code: string) => {
  const a = document.activeElement as HTMLElement | null;
  const cell = a?.closest('[role=gridcell]');
  expect(new RegExp(`\\b${code}\\b`).test(focusRow(a)), `focus is in the row of ${code}, got "${focusRow(a)}"`).toBe(true);
  expect(cell && Array.from(cell.parentElement!.children).indexOf(cell)).toBe(valueIdx());
};
const enterValue = async (u: ReturnType<typeof user>, code: string, text: string) => { focusValue(code); await u.keyboard(`${text}{Enter}`); };
const enters = () => calls.filter((c) => c.url.pathname.endsWith('/bulk-enter'));
const verifies = () => calls.filter((c) => c.url.pathname.endsWith('/bulk-verify'));
const approves = () => calls.filter((c) => c.url.pathname.endsWith('/bulk-approve'));
const dialogs = () => screen.queryAllByRole('dialog');
const noAxe = async () => {
  const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } });
  expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
};
/** local "YYYY-MM-DDTHH:mm" for a datetime-local control, `hoursAgo` hours before now */
const localAgo = (hoursAgo: number) => {
  const d = new Date(Date.now() - hoursAgo * 3_600_000), p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

// ───────────────────────────────────────── AC-08.1 keyboard entry
describe('C5.T-20 AC-08.1 — keyboard-first entry, one bulkEnterResults per Ctrl+S', () => {
  it('type 13.4 in Hb + Enter → focus on the Value cell of the next row; Ctrl+S sends ONE bulk-enter with only the edited rows, with versions and an Idempotency-Key', async () => {
    show();
    const u = user();
    await enterValue(u, 'HB', '13.4');
    activeIsValueOf('WBC');
    await u.keyboard('7.2{Enter}');
    activeIsValueOf('PLT');
    expect(enters()).toHaveLength(0); // nothing is sent before Ctrl+S
    await u.keyboard('{Control>}s{/Control}');
    await waitFor(() => expect(enters()).toHaveLength(1));
    const c = enters()[0]!;
    expect(c.body.entries).toEqual([{ result_id: id(1), version: 1, value_numeric: '13.4' }, { result_id: id(2), version: 1, value_numeric: '7.2' }]);
    expect(c.headers.get('idempotency-key')).toMatch(/^[A-Za-z0-9_-]{8,}$/);
    expect(c.headers.get('authorization')).toBe('Bearer jwt-synthetic'); // BFF→API hop carries the JWT (02-CONVENTIONS:798); browser-side absence is covered in c5-t20.static.test.ts
    expect(c.body.entry_mode ?? 'live').toBe('live');
    expect(c.body.occurred_at).toBeUndefined();
  });

  it('an ordinal analyte (from the page-built `analytes` map) saves `ordinal_code`, not value_numeric (review item 1)', async () => {
    show({ props: { analytes: { ...analytes, [id(101)]: { name: 'Culture growth', value_type: 'ordinal' as const } } } });
    const u = user();
    await enterValue(u, 'HB', 'POS');
    expect(within(rowOf('HB')).queryByText(/Enter a number/)).toBeNull();
    await u.keyboard('{Control>}s{/Control}');
    await waitFor(() => expect(enters()).toHaveLength(1));
    expect(enters()[0]!.body.entries).toEqual([{ result_id: id(1), version: 1, ordinal_code: 'POS' }]);
  });

  it('after a successful save the rows show Resulted and are no longer "edited": a second Ctrl+S sends nothing; the new row version is used by the next edit', async () => {
    show();
    const u = user();
    await enterValue(u, 'HB', '13.4');
    await u.keyboard('{Control>}s{/Control}');
    await waitFor(() => expect(within(rowOf('HB')).getByText(/Resulted/)).toBeTruthy());
    await u.keyboard('{Control>}s{/Control}');
    expect(enters()).toHaveLength(1);
    await enterValue(u, 'HB', '13.9');
    await u.keyboard('{Control>}s{/Control}');
    await waitFor(() => expect(enters()).toHaveLength(2));
    expect(enters()[1]!.body.entries).toEqual([{ result_id: id(1), version: 2, value_numeric: '13.9' }]);
  });

  it('Shift+Enter, ArrowUp / ArrowDown move between rows in the same column; calculated (LDL) and locked rows are skipped by Enter', async () => {
    show({ over: { 5: { status: 'approved', version: 2, value_numeric: '1.30', current_version_no: 1 } } });
    const u = user();
    focusValue('WBC');
    await u.keyboard('{ArrowDown}');
    activeIsValueOf('PLT');
    await u.keyboard('{ArrowUp}');
    activeIsValueOf('WBC');
    await enterValue(u, 'WBC', '7.1');
    activeIsValueOf('PLT');
    await u.keyboard('{Shift>}{Enter}{/Shift}'); // Shift+Enter on a non-editing cell = previous row
    activeIsValueOf('WBC');
    await enterValue(u, 'TC', '4.10');
    activeIsValueOf('TG'); // HDL is approved (read-only) → skipped
    await enterValue(u, 'TG', '1.20');
    expect(rowOf('LDL')).toBeTruthy();
    expect(within(rowOf('LDL')).queryByText(/Waiting for: HDL/)).toBeTruthy();
    expect(document.activeElement).not.toBe(valueCell('LDL')); // calculated row never takes the edit focus
  });

  it('Tab / Shift+Tab move to the next / previous cell of the same row (Value → …→ Value)', async () => {
    show();
    const u = user();
    focusValue('HB');
    const before = document.activeElement as HTMLElement;
    await u.tab();
    const after = document.activeElement as HTMLElement;
    expect(after).not.toBe(before);
    expect(after.closest('[role=row]')).toBe(before.closest('[role=row]'));
    await u.tab({ shift: true });
    expect(document.activeElement).toBe(before);
  });

  it('Esc cancels the current cell edit: the old value comes back and nothing is saved', async () => {
    show();
    const u = user();
    focusValue('HB');
    await u.keyboard('99');
    expect(within(rowOf('HB')).getByRole('textbox', { name: /value/i })).toBeTruthy();
    await u.keyboard('{Escape}');
    expect(within(rowOf('HB')).queryByRole('textbox', { name: /value/i })).toBeNull();
    expect(valueCell('HB').textContent).not.toContain('99');
    await u.keyboard('{Control>}s{/Control}');
    expect(enters()).toHaveLength(0);
  });

  it('a value with more decimals than the analyte allows is flagged inline ("Enter a number with up to 1 decimals." via aria-describedby) and is not sent (client side of AC-08.3)', async () => {
    show();
    const u = user();
    await enterValue(u, 'HB', '13.45');
    await enterValue(u, 'WBC', '7.2');
    expect(within(rowOf('HB')).getByText('Enter a number with up to 1 decimals.')).toBeTruthy();
    expect(valueCell('HB').getAttribute('aria-invalid')).toBe('true');
    await u.keyboard('{Control>}s{/Control}');
    await waitFor(() => expect(enters().length).toBeLessThanOrEqual(1));
    for (const c of enters()) expect(c.body.entries.map((e: any) => e.result_id)).not.toContain(id(1));
  });

  it('double Ctrl+S while the first request is in flight sends one request (no double submit)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const orig = enterReply;
    enterReply = async (b) => { await gate; return orig(b); };
    show();
    const u = user();
    await enterValue(u, 'HB', '13.4');
    await u.keyboard('{Control>}s{/Control}{Control>}s{/Control}');
    release();
    await waitFor(() => expect(within(rowOf('HB')).getByText(/Resulted/)).toBeTruthy());
    expect(enters()).toHaveLength(1);
  });

  it('the grid is built on the UI kit EditableGrid (role=grid, aria-colcount) and passes axe', async () => {
    show();
    const g = screen.getByRole('grid');
    expect(g.getAttribute('aria-colcount')).toBeTruthy();
    expect(g.closest('.lims-egrid')).toBeTruthy();
    await noAxe();
  });
});

// ───────────────────────────────────────── AC-08.4 stale version, merge of per-row outcomes
describe('C5.T-20 AC-08.4 — per-row outcomes', () => {
  it('stale If-Match version → that row says "Changed by someone else — reload this row", keeps the typed value; the other row is saved', async () => {
    enterReply = (b) => HttpResponse.json({
      results: b.entries.map((e: any) => (e.result_id === id(2)
        ? { result_id: e.result_id, outcome: 'error', code: 'common.version_conflict' }
        : { result_id: e.result_id, outcome: 'ok', result: { ...res(1), version: 2, status: 'resulted', value_numeric: e.value_numeric, flag: 'N', current_version_no: 1 } })),
      recomputed: [],
    });
    show();
    const u = user();
    await enterValue(u, 'HB', '13.4');
    await enterValue(u, 'WBC', '7.2');
    await u.keyboard('{Control>}s{/Control}');
    await waitFor(() => expect(within(rowOf('WBC')).getByText('Changed by someone else — reload this row')).toBeTruthy());
    expect(within(rowOf('HB')).getByText(/Resulted/)).toBeTruthy();
    expect(within(rowOf('WBC')).queryByText(/Resulted/)).toBeNull();
    expect(valueCell('WBC').textContent).toContain('7.2');
    expect(document.body.textContent).not.toMatch(/common\.version_conflict/); // raw code never rendered
  });

  it('lab.result_value_invalid on one row → readable inline message for that row only; lab.result_locked → "Approved results can only be changed by amendment."', async () => {
    enterReply = (b) => HttpResponse.json({
      results: b.entries.map((e: any) => ({ result_id: e.result_id, outcome: 'error', code: e.result_id === id(1) ? 'lab.result_value_invalid' : 'lab.result_locked' })),
      recomputed: [],
    });
    show();
    const u = user();
    await enterValue(u, 'HB', '13.4');
    await enterValue(u, 'WBC', '7.2');
    await u.keyboard('{Control>}s{/Control}');
    await waitFor(() => expect(within(rowOf('WBC')).getByText('Approved results can only be changed by amendment.')).toBeTruthy());
    expect(within(rowOf('HB')).getByText('Enter a number with up to 1 decimals.')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/lab\.result_(value_invalid|locked)/);
  });

  it('`recomputed` rows from the response are merged into the grid (calculated LDL appears without a reload)', async () => {
    enterReply = (b) => HttpResponse.json({
      results: b.entries.map((e: any) => ({ result_id: e.result_id, outcome: 'ok', result: { ...res(Number(e.result_id.slice(-12))), version: 2, status: 'resulted', value_numeric: e.value_numeric, flag: 'N' } })),
      recomputed: [res(7, { version: 2, status: 'resulted', origin: 'calculated', value_numeric: '2.70', calc: { status: 'computed' } })],
    });
    show();
    const u = user();
    await enterValue(u, 'TC', '5.00');
    await u.keyboard('{Control>}s{/Control}');
    await waitFor(() => expect(within(rowOf('LDL')).getByText(/2\.70/)).toBeTruthy());
    expect(within(rowOf('LDL')).queryByText(/Waiting for/)).toBeNull();
  });

  it('whole-request failure (5xx) keeps every typed value, shows a readable error and allows a retry', async () => {
    enterReply = () => problem(500, 'common.internal');
    show();
    const u = user();
    await enterValue(u, 'HB', '13.4');
    await u.keyboard('{Control>}s{/Control}');
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(valueCell('HB').textContent).toContain('13.4');
    expect(document.body.textContent).not.toMatch(/common\.internal/);
    reset();
    await u.keyboard('{Control>}s{/Control}');
    await waitFor(() => expect(within(rowOf('HB')).getByText(/Resulted/)).toBeTruthy());
  });
});

// ───────────────────────────────────────── AC-09.2 / AC-09.3 calculated rows
describe('C5.T-20 AC-09.2 / AC-09.3 — calculated rows', () => {
  it('TG over 400 → LDL stays pending and says "Not calculated: tg_over_400"', () => {
    show({ over: { 7: { calc: { status: 'not_computable', reason: 'tg_over_400' } } } });
    expect(within(rowOf('LDL')).getByText('Not calculated: tg_over_400')).toBeTruthy();
    expect(within(rowOf('LDL')).getByText(/Pending/)).toBeTruthy();
  });

  it('missing input → "Waiting for: HDL" (never a 0), the row carries the "Calculated" tag, the value cell is read-only and cannot be typed into', async () => {
    show();
    const row = rowOf('LDL');
    expect(within(row).getByText('Waiting for: HDL')).toBeTruthy();
    expect(within(row).getByText('Calculated')).toBeTruthy();
    expect(valueCell('LDL').textContent).not.toMatch(/\b0(\.0+)?\b/);
    expect(valueCell('LDL').getAttribute('aria-readonly')).toBe('true');
    valueCell('LDL').focus();
    const u = user();
    await u.keyboard('5.5');
    expect(within(row).queryByRole('textbox', { name: /value/i })).toBeNull();
    await u.keyboard('{Control>}s{/Control}');
    expect(enters()).toHaveLength(0);
  });

  it('a computed value shows its provenance (expression + inputs) as text in a tooltip-reachable element', () => {
    show({ over: { 7: { status: 'resulted', value_numeric: '2.70', calc: { status: 'computed', provenance: JSON.stringify({ expression: 'TC - HDL - TG/2.2', inputs: { TC: '5.00', HDL: '1.20', TG: '2.20' } }) } } } });
    const row = rowOf('LDL');
    expect(within(row).getByText(/2\.70/)).toBeTruthy();
    expect(row.innerHTML).toContain('TC - HDL - TG/2.2'); // present in the DOM for the Tooltip (not only on hover)
  });
});

// ───────────────────────────────────────── AC-10.1 short codes in the grid
describe('C5.T-20 AC-10.1 — comment short codes inside the grid', () => {
  it('":HYPO " in the Hb comment is replaced by the library text (C3 comment-codes lookup via the BFF); Ctrl+S sends comment_codes + comment_text', async () => {
    show();
    const u = user();
    const box = within(rowOf('HB')).getByRole('textbox', { name: /comment/i }) as HTMLTextAreaElement;
    box.focus();
    await u.keyboard(':HYPO ');
    await waitFor(() => expect(box.value).toContain(CODES['HYPO']!.text));
    expect(calls.find((c) => c.url.pathname === '/v1/catalog/comment-codes')!.url.searchParams.get('code_prefix')).toBe('HYPO');
    await enterValue(u, 'HB', '13.4');
    await u.keyboard('{Control>}s{/Control}');
    await waitFor(() => expect(enters()).toHaveLength(1));
    const e = enters()[0]!.body.entries[0];
    expect(e).toMatchObject({ result_id: id(1), version: 1, value_numeric: '13.4', comment_codes: ['HYPO'] });
    expect(e.comment_text).toContain(CODES['HYPO']!.text);
  });

  it('library text is plain text (S-14): markup in it is not interpreted; an unknown code shows the inline hint "Unknown code NOPE" and is not recorded', async () => {
    CODES['XSS'] = { text: '<img src=x onerror=alert(1)>', version: 1 };
    try {
      show();
      const u = user();
      const box = within(rowOf('HB')).getByRole('textbox', { name: /comment/i }) as HTMLTextAreaElement;
      box.focus();
      await u.keyboard(':XSS ');
      await waitFor(() => expect(box.value).toContain('<img src=x'));
      expect(document.querySelector('img[src="x"]')).toBeNull();
      await u.keyboard(':NOPE ');
      await waitFor(() => expect(screen.getByText('Unknown code NOPE')).toBeTruthy());
    } finally { delete CODES['XSS']; }
  });
});

// ───────────────────────────────────────── AC-11.1 / 11.3 history panel
const HIST = [
  { result_id: id(901), approved_at: '2026-11-08T05:00:00.000Z', value: '13.0', unit_code: 'g_dl', flag: 'N', version_no: 1 },
  { result_id: id(902), approved_at: '2026-10-08T05:00:00.000Z', value: '11.2', unit_code: 'g_dl', flag: 'L', version_no: 1 },
  { result_id: id(903), approved_at: '2026-09-08T05:00:00.000Z', value: '12.6', unit_code: 'g_dl', flag: 'N', version_no: 2 },
];
describe('C5.T-20 AC-11.1 — history side panel (F2)', () => {
  it('F2 on the Hb row opens the panel: GET /results/{id}/history?limit=5, values newest first with date, unit and flag text; F2 again closes it', async () => {
    historyReply = () => HttpResponse.json({ data: HIST });
    show();
    const u = user();
    focusValue('HB');
    await u.keyboard('{F2}');
    await waitFor(() => expect(screen.getByText('13.0')).toBeTruthy());
    const call = calls.find((c) => c.url.pathname === `/v1/lab/results/${id(1)}/history`)!;
    expect(call.url.searchParams.get('limit')).toBe('5');
    const panel = (screen.getByText('13.0').closest('[role=dialog],[role=complementary],aside') ?? document.body) as HTMLElement;
    const text = panel.textContent ?? '';
    expect(text.indexOf('13.0')).toBeLessThan(text.indexOf('11.2'));
    expect(text.indexOf('11.2')).toBeLessThan(text.indexOf('12.6'));
    expect(within(panel).getAllByText(/g_dl/).length).toBeGreaterThanOrEqual(3);
    expect(within(panel).getByText('Low')).toBeTruthy(); // flag as text, not colour only
    expect(within(panel).getByText(/2026/)).toBeTruthy();
    await u.keyboard('{F2}');
    await waitFor(() => expect(screen.queryByText('11.2')).toBeNull());
  });

  it('shows at most 5 rows even if the server sends more, and asks the API with ids only (no patient name/registration number in the URL)', async () => {
    historyReply = () => HttpResponse.json({ data: Array.from({ length: 8 }, (_, i) => ({ ...HIST[0]!, result_id: id(910 + i), value: `1${i}.0`, approved_at: `2026-0${8 - i}-01T05:00:00.000Z` })) });
    show();
    focusValue('HB');
    await user().keyboard('{F2}');
    await waitFor(() => expect(screen.getByText('10.0')).toBeTruthy());
    expect(screen.queryByText('15.0')).toBeNull(); // 6th row not shown
    const u = calls.find((c) => c.url.pathname.endsWith('/history'))!.url;
    expect(u.href).not.toMatch(/REG0042|Synthetic|patient/i);
  });

  it('empty history → "No previous results for this patient."; F2 on a different analyte asks for THAT result id', async () => {
    show();
    const u = user();
    focusValue('WBC');
    await u.keyboard('{F2}');
    await waitFor(() => expect(screen.getByText('No previous results for this patient.')).toBeTruthy());
    expect(calls.some((c) => c.url.pathname === `/v1/lab/results/${id(2)}/history`)).toBe(true);
    expect(calls.some((c) => c.url.pathname === `/v1/lab/results/${id(1)}/history`)).toBe(false);
  });
});

// ───────────────────────────────────────── AC-11.2 trend (F3)
const pt = (n: number, v: string, unit = 'g_dl') => ({ result_id: id(950 + n), at: `2026-0${n}-10T05:00:00.000Z`, value: v, unit_code: unit, flag: 'N' });
describe('C5.T-20 AC-11.2 — trend dialog (F3)', () => {
  it('F3 opens a dialog with TimeSeriesChart: only same-unit points plotted, reference band as text, other-unit points listed under "Not plotted (different unit)"; request carries limit=50 and ids only', async () => {
    trendReply = () => HttpResponse.json({ points: [pt(1, '12.1'), pt(2, '13.0'), pt(3, '14.2'), pt(4, '99', 'g_l')], reference_band: { low: '13.0', high: '17.0', unit_code: 'g_dl' } });
    show();
    const u = user();
    focusValue('HB');
    await u.keyboard('{F3}');
    const dlg = await screen.findByRole('dialog', { name: /trend/i });
    const call = calls.find((c) => c.url.pathname === `/v1/lab/patients/${PATIENT}/analytes/${id(101)}/trend`)!;
    expect(call.url.searchParams.get('limit')).toBe('50');
    const fig = dlg.querySelector('figure.lims-chart') as HTMLElement;
    expect(fig, 'TimeSeriesChart (UI kit) is used').toBeTruthy();
    expect(fig.querySelectorAll('svg circle')).toHaveLength(3); // the 99 g_l point is NOT on the g_dl axis
    expect(fig.textContent).toMatch(/Reference range: 13\.0 – 17\.0/);
    expect(fig.textContent).not.toContain('99');
    expect(within(dlg).getByText(/Not plotted \(different unit\)/)).toBeTruthy();
    const other = within(dlg).getByText('99').closest('table, ul, section, div') as HTMLElement;
    expect(other.textContent).toContain('g_l');
    expect(within(dlg).getByRole('button', { name: /show as table/i })).toBeTruthy(); // accessible data-table toggle
  });

  it('fewer than 2 points → "Not enough history to draw a trend (needs 2 results)."; Esc closes the dialog and focus returns to the grid cell', async () => {
    trendReply = () => HttpResponse.json({ points: [pt(1, '12.1')] });
    show();
    const u = user();
    focusValue('HB');
    await u.keyboard('{F3}');
    const dlg = await screen.findByRole('dialog', { name: /trend/i });
    expect(within(dlg).getByText('Not enough history to draw a trend (needs 2 results).')).toBeTruthy();
    expect(dlg.querySelector('svg circle')).toBeNull();
    await u.keyboard('{Escape}');
    await waitFor(() => expect(dialogs()).toHaveLength(0));
    expect(document.activeElement).toBe(valueCell('HB'));
  });
});

// ───────────────────────────────────────── footer, permissions, locked states
describe('C5.T-20 footer actions by permission, locked cells', () => {
  it('lab.result.enter only → Save is shown; Save & verify / Approve / Return / Amend are not', () => {
    show({ props: { permissions: ENTER } });
    expect(screen.getByRole('button', { name: /^save$/i })).toBeTruthy();
    for (const n of [/save (&|and) verify/i, /^approve/i, /^return/i, /^amend/i]) expect(screen.queryByRole('button', { name: n })).toBeNull();
  });

  it('read-only session: no Save, value cells do not enter edit mode, Ctrl+S sends nothing', async () => {
    show({ props: { permissions: ['lab.result.read'] } });
    expect(screen.queryByRole('button', { name: /^save/i })).toBeNull();
    focusValue('HB');
    const u = user();
    await u.keyboard('13.4');
    expect(within(rowOf('HB')).queryByRole('textbox', { name: /value/i })).toBeNull();
    await u.keyboard('{Control>}s{/Control}');
    expect(enters()).toHaveLength(0);
  });

  it('verified / approved / cancelled rows are not editable (return / amend first) and show their status text', () => {
    show({ props: { permissions: ALL }, over: { 1: { status: 'verified', value_numeric: '13.4', version: 2 }, 2: { status: 'approved', value_numeric: '7.2', version: 3, current_version_no: 2 }, 3: { status: 'cancelled' } } });
    expect(within(rowOf('HB')).getByText(/Verified/)).toBeTruthy();
    expect(within(rowOf('WBC')).getByText(/Approved v2/)).toBeTruthy();
    expect(within(rowOf('PLT')).getByText(/Cancelled/)).toBeTruthy();
    for (const c of ['HB', 'WBC', 'PLT']) expect(valueCell(c).getAttribute('aria-readonly')).toBe('true');
  });

  it('flag, range, Δ and status text: "High", snapshot range, "Δ +1.2 vs 4.0 (3 d ago)" for delta fail, "No previous" otherwise, "Age unknown — …" warning, "On QC hold"', () => {
    show({ over: {
      1: { status: 'resulted', value_numeric: '18.0', flag: 'H', version: 2, reference_range_snapshot: { low: '13.0', high: '17.0', unit_code: 'g_dl' }, delta: { status: 'fail', prev_value: '4.0', abs: '1.2', prev_at: new Date(Date.now() - 3 * 86_400_000).toISOString() } },
      2: { status: 'resulted', value_numeric: '7.0', version: 2, range_unavailable_age_unknown: true, on_hold: true },
    } });
    const hb = rowOf('HB');
    expect(within(hb).getByText('High')).toBeTruthy();
    expect(within(hb).getByText(/13\.0 – 17\.0/)).toBeTruthy();
    expect(within(hb).getByText(/Δ \+1\.2 vs 4\.0 \(3 d ago\)/)).toBeTruthy();
    expect(within(rowOf('PLT')).getByText('No previous')).toBeTruthy();
    expect(within(rowOf('WBC')).getByText('Age unknown — reference range and critical check not applied')).toBeTruthy();
    expect(within(rowOf('WBC')).getByText(/On QC hold/)).toBeTruthy();
  });

  it('S-14: analyte names and comment text from the server are rendered as text, never as markup', () => {
    const o = build({ 1: { comment_text: '<img src=x onerror=alert(1)>' } });
    const hostile = { ...analytes, [id(101)]: { name: '<b>Hemo</b>', decimals: 1, value_type: 'numeric' as const } };
    show({ props: { data: o, analytes: hostile } });
    expect(document.querySelector('img[src="x"]')).toBeNull();
    expect(document.querySelector('b')).toBeNull();
  });
});

// ───────────────────────────────────────── Ctrl+Enter, Alt+A, Alt+R, Alt+M, Alt+N/P, ?
describe('C5.T-20 shortcuts without a mouse', () => {
  it('Ctrl+Enter: saves, then verifies ONLY the rows of the focused test (Hb/WBC/PLT, not the lipid rows) with their new versions', async () => {
    show({ props: { permissions: ALL }, over: { 3: { status: 'resulted', value_numeric: '250', version: 5, flag: 'N', current_version_no: 1 } } });
    const u = user();
    await enterValue(u, 'HB', '13.4');
    focusValue('HB');
    await u.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() => expect(verifies()).toHaveLength(1));
    expect(enters()).toHaveLength(1); // save happened first
    expect(calls.findIndex((c) => c.url.pathname.endsWith('/bulk-enter'))).toBeLessThan(calls.findIndex((c) => c.url.pathname.endsWith('/bulk-verify')));
    const ids = verifies()[0]!.body.items.map((i: any) => i.id).sort();
    expect(ids).toEqual([id(1), id(3)].sort()); // HB (just saved) + PLT (already resulted); WBC still pending, lipid rows not in this test
    expect(verifies()[0]!.body.items.find((i: any) => i.id === id(1)).version).toBe(2);
    expect(verifies()[0]!.headers.get('idempotency-key')).toBeTruthy();
  });

  it('Ctrl+Enter with a flagged row (delta fail) opens the verify prompt; Verify stays disabled until each box is ticked, then sends acknowledged_flags', async () => {
    show({ props: { permissions: ALL }, over: { 1: { status: 'resulted', value_numeric: '9.0', version: 2, delta: { status: 'fail', prev_value: '4.0', abs: '5.0' }, current_version_no: 1 } } });
    const u = user();
    focusValue('HB');
    await u.keyboard('{Control>}{Enter}{/Control}');
    const dlg = await screen.findByRole('dialog');
    const verify = within(dlg).getByRole('button', { name: /^verify/i }) as HTMLButtonElement;
    expect(verify.disabled).toBe(true);
    await u.click(within(dlg).getByRole('checkbox', { name: /I have reviewed the delta/i }));
    expect(verify.disabled).toBe(false);
    await u.click(verify);
    await waitFor(() => expect(verifies()).toHaveLength(1));
    expect(verifies()[0]!.body.items).toEqual([{ id: id(1), version: 2, acknowledged_flags: ['delta'] }]);
  });

  it('Alt+R on a verified result opens the return dialog; reason is required; success posts {reason_code, comment}, shows "Returned for correction." and closes', async () => {
    show({ props: { permissions: ALL }, over: { 1: { status: 'verified', value_numeric: '13.4', version: 3, current_version_no: 1 } } });
    const u = user();
    focusValue('HB');
    await u.keyboard('{Alt>}r{/Alt}');
    const dlg = await screen.findByRole('dialog', { name: /return/i });
    await u.click(within(dlg).getByRole('button', { name: /^return$/i }));
    expect(calls.filter((c) => c.url.pathname.endsWith('/return'))).toHaveLength(0); // no reason → nothing sent
    await u.click(within(dlg).getByRole('button', { name: /reason/i }));
    await u.click(await screen.findByRole('option', { name: 'Recheck value' }));
    await u.type(within(dlg).getByRole('textbox', { name: /comment/i }), 'Repeat on analyser 2');
    await u.click(within(dlg).getByRole('button', { name: /^return$/i }));
    await waitFor(() => expect(calls.filter((c) => c.url.pathname === `/v1/lab/results/${id(1)}/return`)).toHaveLength(1));
    expect(calls.find((c) => c.url.pathname.endsWith('/return'))!.body).toEqual({ reason_code: 'recheck', comment: 'Repeat on analyser 2' });
    await waitFor(() => expect(screen.getByText('Returned for correction.')).toBeTruthy());
    expect(dialogs()).toHaveLength(0);
  });

  it('Alt+R on a row that is not verified, or without lab.result.verify, does nothing', async () => {
    show({ props: { permissions: ALL } });
    const u = user();
    focusValue('HB');
    await u.keyboard('{Alt>}r{/Alt}');
    expect(dialogs()).toHaveLength(0);
    cleanup();
    show({ props: { permissions: ENTER }, over: { 1: { status: 'verified', value_numeric: '13.4', version: 3 } } });
    focusValue('HB');
    await user().keyboard('{Alt>}r{/Alt}');
    expect(dialogs()).toHaveLength(0);
  });

  it('Alt+M on an approved result opens the amend dialog with the §3.6 copy; module-only reasons are not offered; same value or missing reason sends nothing; success posts the amendment and says "Amended to version 3."', async () => {
    show({ props: { permissions: ALL }, over: { 1: { status: 'approved', value_numeric: '13.4', version: 4, current_version_no: 2 } } });
    const u = user();
    focusValue('HB');
    await u.keyboard('{Alt>}m{/Alt}');
    const dlg = await screen.findByRole('dialog');
    expect(within(dlg).getByText(/Amend Hemoglobin \(current v2: 13\.4\)/)).toBeTruthy();
    expect(within(dlg).getByText('This creates version 3. The released report will be superseded.')).toBeTruthy();
    await u.click(within(dlg).getByRole('button', { name: /reason/i }));
    const opts = (await screen.findAllByRole('option')).map((o) => o.textContent);
    expect(opts).toEqual(['Transcription error', 'Instrument recalibration']); // module_phase_progression / module_preliminary_update / supplementary_report dropped (D-61, R1)
    await u.click(screen.getByRole('option', { name: 'Transcription error' }));
    const val = within(dlg).getByRole('textbox', { name: /new value/i });
    await u.clear(val); await u.type(val, '13.4'); // same as current → must differ
    await u.click(within(dlg).getByRole('button', { name: /^amend$/i }));
    expect(calls.filter((c) => c.url.pathname.endsWith('/amend'))).toHaveLength(0);
    await u.clear(val); await u.type(val, '14.1');
    await u.type(within(dlg).getByRole('textbox', { name: /detail/i }), 'Keying slip');
    await u.click(within(dlg).getByRole('button', { name: /^amend$/i }));
    await waitFor(() => expect(calls.filter((c) => c.url.pathname === `/v1/lab/results/${id(1)}/amend`)).toHaveLength(1));
    const c = calls.find((x) => x.url.pathname.endsWith('/amend'))!;
    expect(c.body).toEqual({ value_numeric: '14.1', amendment_reason_code: 'transcription_error', amendment_reason_text: 'Keying slip' });
    expect(c.headers.get('idempotency-key')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('Amended to version 3.')).toBeTruthy());
  });

  it('amend errors are readable: lab.amend_requires_pathologist is shown as text, never as the raw code', async () => {
    amendReply = () => problem(403, 'lab.amend_requires_pathologist');
    show({ props: { permissions: ALL }, over: { 1: { status: 'approved', value_numeric: '13.4', version: 4, current_version_no: 2 } } });
    const u = user();
    focusValue('HB');
    await u.keyboard('{Alt>}m{/Alt}');
    const dlg = await screen.findByRole('dialog');
    await u.click(within(dlg).getByRole('button', { name: /reason/i }));
    await u.click(await screen.findByRole('option', { name: 'Transcription error' }));
    await u.type(within(dlg).getByRole('textbox', { name: /new value/i }), '14.1');
    await u.click(within(dlg).getByRole('button', { name: /^amend$/i }));
    await waitFor(() => expect(within(dlg).getByRole('alert')).toBeTruthy());
    expect(document.body.textContent).not.toMatch(/lab\.amend_requires_pathologist/);
    expect(dialogs()).toHaveLength(1); // stays open for another try
  });

  it('Alt+M without lab.result.amend, or on a non-approved row, does nothing', async () => {
    show({ props: { permissions: ENTER }, over: { 1: { status: 'approved', value_numeric: '13.4', version: 4, current_version_no: 2 } } });
    focusValue('HB');
    await user().keyboard('{Alt>}m{/Alt}');
    expect(dialogs()).toHaveLength(0);
  });

  it('Alt+A approves the selected verified rows (Space selects): POST bulk-approve {items:[{id,version}]}; aal1 → 403 auth.mfa_required → "Verify now" prompt, no raw code', async () => {
    approveReply = () => problem(403, 'auth.mfa_required');
    show({ props: { permissions: ALL }, over: { 1: { status: 'verified', value_numeric: '13.4', version: 3, current_version_no: 1 } } });
    const u = user();
    focusValue('HB');
    await u.keyboard(' ');
    await u.keyboard('{Alt>}a{/Alt}');
    await waitFor(() => expect(approves()).toHaveLength(1));
    expect(approves()[0]!.body).toEqual({ items: [{ id: id(1), version: 3 }] });
    expect(approves()[0]!.headers.get('idempotency-key')).toBeTruthy();
    const banner = await screen.findByRole('alert');
    expect(within(banner).getByRole('button', { name: /verify now/i })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/auth\.mfa_required/);
  });

  it('Alt+A with nothing selected, or without lab.result.approve, sends nothing', async () => {
    show({ props: { permissions: ALL }, over: { 1: { status: 'verified', value_numeric: '13.4', version: 3 } } });
    focusValue('HB');
    await user().keyboard('{Alt>}a{/Alt}');
    cleanup();
    show({ props: { permissions: ENTER }, over: { 1: { status: 'verified', value_numeric: '13.4', version: 3 } } });
    focusValue('HB');
    const u = user();
    await u.keyboard(' ');
    await u.keyboard('{Alt>}a{/Alt}');
    expect(approves()).toHaveLength(0);
  });

  it('Alt+N / Alt+P go to the next / previous order of the worklist context; nothing happens without a neighbour', async () => {
    show({ props: { worklist: { nextOrderId: id(8890), prevOrderId: id(8886) } } });
    const u = user();
    focusValue('HB');
    await u.keyboard('{Alt>}n{/Alt}');
    expect(push).toHaveBeenLastCalledWith(`/lab/orders/${id(8890)}/results`);
    await u.keyboard('{Alt>}p{/Alt}');
    expect(push).toHaveBeenLastCalledWith(`/lab/orders/${id(8886)}/results`);
    cleanup(); push.mockReset();
    show({ props: { worklist: {} } });
    focusValue('HB');
    await user().keyboard('{Alt>}n{/Alt}{Alt>}p{/Alt}');
    expect(push).not.toHaveBeenCalled();
  });

  it('"?" opens KeyboardShortcutsDialog listing every shortcut of the §3.6 table; Esc closes it', async () => {
    show({ props: { permissions: ALL } });
    const u = user();
    focusValue('HB');
    await u.keyboard('?');
    const dlg = await screen.findByRole('dialog', { name: /keyboard shortcuts/i });
    const t = dlg.textContent ?? '';
    for (const k of ['Enter', 'Shift+Enter', 'Tab', 'Shift+Tab', 'Ctrl+S', 'Ctrl+Enter', 'F2', 'F3', 'Ctrl+Space', 'Alt+A', 'Alt+R', 'Alt+M', 'Alt+N', 'Alt+P', 'Esc']) expect(t, k).toContain(k);
    await u.keyboard('{Escape}');
    await waitFor(() => expect(dialogs()).toHaveLength(0));
  });
});

// ───────────────────────────────────────── unsaved guard
describe('C5.T-20 unsaved-changes guard', () => {
  it('with edits: beforeunload is prevented; Alt+N asks "You have unsaved results. Leave without saving?" and only navigates after confirming; Stay keeps the edits', async () => {
    show({ props: { worklist: { nextOrderId: id(8890) } } });
    const u = user();
    await enterValue(u, 'HB', '13.4');
    const ev = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    focusValue('HB');
    await u.keyboard('{Alt>}n{/Alt}');
    const dlg = await screen.findByRole('dialog');
    expect(within(dlg).getByText('You have unsaved results. Leave without saving?')).toBeTruthy();
    expect(push).not.toHaveBeenCalled();
    await u.click(within(dlg).getByRole('button', { name: /stay|cancel/i }));
    expect(push).not.toHaveBeenCalled();
    expect(valueCell('HB').textContent).toContain('13.4');
    await u.keyboard('{Alt>}n{/Alt}');
    await u.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /leave/i }));
    expect(push).toHaveBeenCalledWith(`/lab/orders/${id(8890)}/results`);
  });

  it('no edits → no prompt on Alt+N and beforeunload is not prevented; after a successful save the page is clean again', async () => {
    show({ props: { worklist: { nextOrderId: id(8890) } } });
    const clean = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);
    const u = user();
    await enterValue(u, 'HB', '13.4');
    await u.keyboard('{Control>}s{/Control}');
    await waitFor(() => expect(within(rowOf('HB')).getByText(/Resulted/)).toBeTruthy());
    const after = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
    focusValue('WBC');
    await u.keyboard('{Alt>}n{/Alt}');
    expect(dialogs()).toHaveLength(0);
    expect(push).toHaveBeenCalledWith(`/lab/orders/${id(8890)}/results`);
  });
});

// ───────────────────────────────────────── LD-25 downtime back-entry (T-20 part)
describe('C5.T-20 LD-25 — "Downtime back-entry" toggle on the result grid', () => {
  const toggle = () => (screen.queryByRole('switch', { name: /downtime back-entry/i }) ?? screen.getByRole('checkbox', { name: /downtime back-entry/i })) as HTMLInputElement;
  const fields = () => ({ at: screen.getByLabelText(/original time/i) as HTMLInputElement, ref: screen.getByLabelText(/paper form serial|downtime ref/i) as HTMLInputElement });
  const prime = async (at: string, ref: string) => {
    const u = user();
    await u.click(toggle());
    fireEvent.change(fields().at, { target: { value: at } });
    fireEvent.change(fields().ref, { target: { value: ref } });
    await enterValue(u, 'HB', '13.4');
    await u.keyboard('{Control>}s{/Control}');
    return u;
  };

  it('off by default: no time / serial fields; the toggle is reachable by keyboard (Tab order) and turning it on reveals both fields', async () => {
    show();
    expect(screen.queryByLabelText(/original time/i)).toBeNull();
    await user().click(toggle());
    expect(fields().at).toBeTruthy();
    expect(fields().ref.getAttribute('maxlength')).toBe('32');
  });

  it('valid back-entry (1 h ago, serial "PF-0001") → bulk-enter carries entry_mode downtime_backentry, occurred_at (ISO, ≈ the typed time) and downtime_ref', async () => {
    show();
    await prime(localAgo(1), 'PF-0001');
    await waitFor(() => expect(enters()).toHaveLength(1));
    const b = enters()[0]!.body;
    expect(b.entry_mode).toBe('downtime_backentry');
    expect(b.downtime_ref).toBe('PF-0001');
    expect(Math.abs(Date.parse(b.occurred_at) - (Date.now() - 3_600_000))).toBeLessThan(180_000);
    expect(b.entries).toEqual([{ result_id: id(1), version: 1, value_numeric: '13.4' }]);
  });

  it('limits: no time, future time, older than the tenant limit (default 72 h; 24 h when downtimeMaxHours=24) and a serial > 32 chars each block the save with a readable message and send nothing', async () => {
    show();
    await prime('', 'PF-0001');
    expect(enters()).toHaveLength(0);
    expect(screen.getAllByText(/original time/i).length).toBeGreaterThan(1); // validation text next to the label
    cleanup();
    show();
    await prime(localAgo(-3), 'PF-0001'); // 3 h in the future
    expect(enters()).toHaveLength(0);
    cleanup();
    show();
    await prime(localAgo(73), 'PF-0001');
    expect(enters()).toHaveLength(0);
    cleanup();
    show({ props: { downtimeMaxHours: 24 } });
    await prime(localAgo(25), 'PF-0001');
    expect(enters()).toHaveLength(0);
    cleanup();
    show({ props: { downtimeMaxHours: 24 } });
    await prime(localAgo(23), 'PF-0001');
    await waitFor(() => expect(enters()).toHaveLength(1)); // inside the tenant limit
    cleanup();
    calls.length = 0;
    show();
    const v = user();
    await v.click(toggle());
    fireEvent.change(fields().at, { target: { value: localAgo(1) } });
    fireEvent.change(fields().ref, { target: { value: 'X'.repeat(33) } });
    await enterValue(v, 'HB', '13.4');
    await v.keyboard('{Control>}s{/Control}');
    expect(enters()).toHaveLength(0);
  });

  it('missing serial blocks the save (downtime_ref is required for back-entry)', async () => {
    show();
    await prime(localAgo(1), '');
    expect(enters()).toHaveLength(0);
  });

  it('a result entered after downtime shows "Entered after downtime" with the original time in the row; a live result does not', () => {
    show({ over: { 1: { status: 'resulted', value_numeric: '13.4', version: 2, entry_mode: 'downtime_backentry', occurred_at: '2026-11-09T03:15:00.000Z', downtime_ref: 'PF-0001' } } });
    expect(within(rowOf('HB')).getByText(/Entered after downtime/)).toBeTruthy();
    expect(within(rowOf('HB')).getByText(/2026/)).toBeTruthy();
    expect(within(rowOf('WBC')).queryByText(/Entered after downtime/)).toBeNull();
  });
});
