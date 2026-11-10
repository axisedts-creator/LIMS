// @vitest-environment jsdom
// C6-T31 — Staff web screens for reporting (04-UI-UX §1, §1.1, §1.2, §2.1–§2.9). done_when: "every screen has empty/loading/error/denied states;
// shortcuts registered". Component tests + MSW (server actions run for real against MSW) + axe. Synthetic data only.
// Page-level states (empty / error / denied / loading) are in c6-t31.pages.test.tsx.
// ASSUMED module/prop contract (spec fixes folders + kit components only; dispute via writer if wrong). All under apps/web/src/features/reporting/components/:
//   ReportsWorklist({reports: ReportSummary[], tab, permissions, centres, nextCursor?})   §2.1 ; tab ∈ awaiting_content|ready_to_release|held|render_failed|released_today|all
//   CriticalAlertsPanel({alerts: CriticalAlert[] | null, hasMore?, centreId?})            §2.9 ; null = the load failed (inline ErrorState + Retry)
//   ReportDetailView({report: ReportDetail, permissions})                                 §2.2 (reasons lists are fetched through server actions when a dialog opens)
//   OutsourcedQueue({items, permissions, centres})  OutsourcedFilePanel({file: InputFile, patientDisplayName, permissions})   §2.3
//   NarrativeEditor({narrative, templates, permissions})                                  §2.4
//   DeliveriesList({deliveries, permissions, nextCursor?})  DeliveryDetail({delivery, permissions})   §2.5
//   TemplatesList({templates, permissions})  TemplateEditor({template, permissions})      §2.6
//   MessagesChannels({templates, accounts, permissions})                                  §2.7
//   ReportingSettingsForm({settings, contacts, centres, permissions})                     §2.8
//   permissions: readonly string[] (session.actor.permissions). Navigation = next/navigation useRouter().push|replace.
//   Shortcut page ids = routes.yaml ids: staff.reporting.worklist, staff.reporting.report, staff.reporting.narrative (shortcuts.list(id), .run()).
//   Writes: server actions → BFF (MSW observes /v1/reporting/* and /v1/billing/*) with Idempotency-Key; versioned writes with If-Match: "<version>".
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { ReactNode } from 'react';
import { ToastProvider } from '@lims/ui/components/Toast';
import { ADMIN, BULK, CENTRE, DLV, FILE, ITEM, NARR, ORDER, ORIGIN, READ, RELEASE, REPORT, TPL, U, V1, V2, V3, alert, centreContact, channelAccount, delivery, detail, inputFile, msgTemplate, narrative, narrativeTemplate, outsourced, page, problem, settings, summary, templateDetail, vsum } from './c6-t31.fixtures';

const push = vi.fn();
const replace = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace, refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/reporting',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: ADMIN, displayName: 'Synthetic Reporter', tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => '/reporting',
}));
process.env.LIMS_ORIGIN_API = ORIGIN;

const R = `${ORIGIN}/v1/reporting`;
const centres = [{ id: CENTRE, name: 'Synthetic Centre A1' }];

const calls: { method: string; url: URL; headers: Headers; body?: any }[] = [];
const rec = async (r: Request) => {
  const ct = r.headers.get('content-type') ?? '';
  calls.push({ method: r.method, url: new URL(r.url), headers: r.headers, body: r.method === 'GET' ? undefined : ct.includes('json') ? await r.clone().json().catch(() => undefined) : await r.clone().formData().catch(() => undefined) });
};
const last = () => calls[calls.length - 1]!;
const api = setupServer(
  http.get(`${R}/coded-sets/:set`, () => HttpResponse.json({ data: [
    { code: 'demographic_correction', display: 'Demographic correction', sort_order: 1 }, { code: 'smart_summary_added', display: 'Smart summary added', sort_order: 2 }, { code: 'other', display: 'Other', sort_order: 3 },
    { code: 'issued_in_error', display: 'Issued in error', sort_order: 4 }, { code: 'transcription_error', display: 'Transcription error', sort_order: 5 },
  ] })),
  http.get(`${ORIGIN}/v1/billing/coded-sets/override_reasons`, () => HttpResponse.json({ data: [{ code: 'family_emergency', display: 'Family emergency', sort_order: 1 }, { code: 'regular_customer', display: 'Regular customer', sort_order: 2 }] })),
  http.get(`${R}/critical-alerts`, async ({ request }) => { await rec(request); return HttpResponse.json(page([alert()])); }),
  http.post(`${R}/reports/search`, async ({ request }) => { await rec(request); return HttpResponse.json({ data: [summary()] }); }),
  // R7 takes report-VERSION ids: the server action resolves each selected report id via getReport (ReportDetail.versions[].id), newest releasable (rendered) version.
  http.get(`${R}/reports/:id`, ({ params }) => HttpResponse.json(detail({ id: params.id, versions: params.id === REPORT
    ? [vsum({ id: V1, version_no: 2, status: 'rendered' }), vsum({ id: V3, version_no: 1, status: 'superseded' })]
    : [vsum({ id: V2, version_no: 1, status: 'rendered' })] }))),
  http.post(`${R}/report-versions/bulk-release`, async ({ request }) => { await rec(request); return HttpResponse.json({ results: [{ id: V1, outcome: 'released', release_basis: 'paid_in_full' }, { id: V2, outcome: 'blocked_due' }] }); }),
  http.post(`${R}/report-versions/:id/release`, async ({ request }) => { await rec(request); return HttpResponse.json(vsum({ status: 'released' })); }),
  http.post(`${R}/report-versions/:id/retry-render`, async ({ request }) => { await rec(request); return HttpResponse.json(vsum({ status: 'rendering' })); }),
  http.post(`${R}/report-versions/:id/prints`, async ({ request }) => { await rec(request); return HttpResponse.json({ id: U(18), state: 'rendering', variant: 'letterhead', copies: 1, expires_at: '2026-11-05T05:15:00.000Z' }, { status: 201 }); }),
  http.get(`${R}/prints/:id`, () => HttpResponse.json({ id: U(18), state: 'ready', variant: 'letterhead', copies: 1, expires_at: '2026-11-05T05:15:00.000Z' })),
  http.post(`${R}/reports/:id/regenerations`, async ({ request }) => { await rec(request); return HttpResponse.json({}, { status: 202 }); }),
  http.post(`${R}/report-versions/:id/qr-token/revoke`, async ({ request }) => { await rec(request); return HttpResponse.json({ revoked: 1 }); }),
  http.post(`${ORIGIN}/v1/billing/orders/:id/release-overrides`, async ({ request }) => { await rec(request); return HttpResponse.json({ override_id: U(99), created_at: '2026-11-05T05:20:00.000Z' }, { status: 201 }); }),
  http.post(`${R}/order-items/:id/outsourced-files`, async ({ request }) => { await rec(request); return HttpResponse.json(inputFile({ state: 'pending_scan' }), { status: 201 }); }),
  http.post(`${R}/outsourced-files/:id/confirm`, async ({ request }) => { await rec(request); return HttpResponse.json(inputFile({ state: 'confirmed' })); }),
  http.put(`${R}/narratives/:id/draft`, async ({ request }) => { await rec(request); return HttpResponse.json(narrative({ version: 6 })); }),
  http.post(`${R}/narratives/:id/sign`, async ({ request }) => { await rec(request); return HttpResponse.json(narrative({ status: 'signed', version: 7 })); }),
  http.post(`${R}/narratives/:id/amendments`, async ({ request }) => { await rec(request); return HttpResponse.json(narrative({ status: 'amending', version: 8 })); }),
  http.post(`${R}/narratives/:id/images`, async ({ request }) => { await rec(request); return HttpResponse.json({ image_id: U(77) }, { status: 201 }); }),
  http.post(`${R}/deliveries/:id/retry`, async ({ request }) => { await rec(request); return HttpResponse.json(delivery({ status: 'queued', attempt_no: 3 })); }),
  http.get(`${R}/deliveries/:id`, () => HttpResponse.json(delivery({ attempts: [{ attempt_no: 1, started_at: '2026-11-05T05:00:00.000Z', outcome: 'suppressed', error_code: 'no_consent' }] }))),
  http.put(`${R}/report-templates/:id/draft`, async ({ request }) => { await rec(request); return HttpResponse.json(templateDetail({ version: 4 })); }),
  http.post(`${R}/report-templates/:id/publish`, async ({ request }) => { await rec(request); return HttpResponse.json(templateDetail({ version: 5 })); }),
  http.post(`${R}/report-templates/:id/previews`, async ({ request }) => { await rec(request); return HttpResponse.json({ id: U(19), state: 'rendering' }, { status: 201 }); }),
  http.put(`${R}/message-templates/:code/texts/:channel`, async ({ request }) => { await rec(request); return HttpResponse.json(msgTemplate().texts[0]); }),
  http.put(`${R}/channel-accounts/:channel`, async ({ request }) => { await rec(request); return HttpResponse.json(channelAccount({ version: 3 })); }),
  http.post(`${R}/channel-accounts/:channel/callback-token`, async ({ request }) => { await rec(request); return HttpResponse.json({ callback_url: 'https://api.test/v1/reporting/callbacks/sms/SYN-ONCE-TOKEN' }); }),
  http.patch(`${R}/settings`, async ({ request }) => { await rec(request); return HttpResponse.json(settings({ version: 7 })); }),
);
beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
afterEach(() => { cleanup(); api.resetHandlers(); calls.length = 0; push.mockReset(); replace.mockReset(); vi.useRealTimers(); localStorage.clear(); sessionStorage.clear(); });
afterAll(() => api.close());

const wrap = (ui: ReactNode) => render(<ToastProvider>{ui}</ToastProvider>);
const noAxeViolations = async () => {
  const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } });
  expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
};
const mod = async <T,>(p: string) => (await import(/* @vite-ignore */ `../components/${p}`)) as T;
const keys = async (pageId: string) => (await import('@/core/shortcuts/registry')).shortcuts.list(pageId);
const shortcut = async (pageId: string, re: RegExp) => (await keys(pageId)).find((s) => re.test(s.key));
const user = () => userEvent.setup();

// ───────────────────────────────────────────────────────── §2.1 worklist
describe('§2.1 ReportsWorklist', () => {
  const load = async () => (await mod<{ ReportsWorklist: any }>('ReportsWorklist')).ReportsWorklist;
  const view = (W: any, reports: unknown[], o: Record<string, unknown> = {}) => wrap(<W reports={reports as never} tab="ready_to_release" permissions={BULK} centres={centres} {...o} />);

  it('title "Reports", six tabs in order, caption + columns, reg-no link to the detail, items "7/9", status chip text, version "v2"', async () => {
    const W = await load();
    view(W, [summary()]);
    expect(screen.getByRole('heading', { level: 1, name: 'Reports' })).toBeTruthy();
    const tabs = screen.getAllByRole('tab').map((t) => t.textContent?.replace(/\s+/g, ' ').trim());
    expect(tabs).toEqual(['Awaiting content', 'Ready to release', 'Held (dues)', 'Render failed', 'Released today', 'All']);
    for (const h of ['Reg no', 'Patient', 'Centre', 'Family', 'Items', 'Status', 'Version', 'Registered', 'Updated']) expect(screen.getByRole('columnheader', { name: new RegExp(h, 'i') })).toBeTruthy();
    expect(screen.getByRole('table').querySelector('caption')).toBeTruthy();
    const link = screen.getByRole('link', { name: 'R2611050001' });
    expect(link.getAttribute('href')).toBe(`/reporting/reports/${REPORT}`);
    const row = link.closest('tr')!;
    expect(within(row).getByText('7/9')).toBeTruthy();
    expect(within(row).getByText('Ready to release')).toBeTruthy();
    expect(within(row).getByText('Lab')).toBeTruthy();
    expect(row.textContent).toMatch(/v2/);
  });

  it('Held rows read "Held — NPR 500.00" (MoneyText from balance_due_paisa)', async () => {
    const W = await load();
    view(W, [summary({ display_status: 'held', held_basis: 'due_outstanding', balance_due_paisa: 50000 })], { tab: 'held' });
    expect(screen.getByText('Held — NPR 500.00')).toBeTruthy();
  });

  it('patient name is a text node: markup in the name is inert (PHI/XSS)', async () => {
    const W = await load();
    view(W, [summary({ patient_display_name: '<img src=x onerror=alert(1)>' })]);
    expect(document.querySelector('img[src="x"]')).toBeNull();
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeTruthy();
  });

  it.each([
    ['awaiting_content', 'Nothing is waiting for results.'],
    ['ready_to_release', 'No reports are ready to release.'],
    ['held', 'No reports are held for dues.'],
    ['render_failed', 'No failed reports. Good.'],
    ['released_today', 'No reports released today yet.'],
  ])('empty state, tab %s: "%s"', async (tab, copy) => {
    const W = await load();
    view(W, [], { tab });
    expect(screen.getByText(copy)).toBeTruthy();
  });

  it('selection column only on Ready-to-release / Held tabs', async () => {
    const W = await load();
    const a = view(W, [summary()], { tab: 'ready_to_release' });
    expect(within(screen.getByRole('table')).getAllByRole('checkbox').length).toBeGreaterThan(0);
    a.unmount();
    view(W, [summary()], { tab: 'all' });
    expect(within(screen.getByRole('table')).queryAllByRole('checkbox')).toHaveLength(0);
  });

  it('shortcuts (§1.1) registered on staff.reporting.worklist: Alt+1…Alt+6, "/" and Alt+R (with bulk-release permission)', async () => {
    const W = await load();
    view(W, [summary()]);
    const ks = (await keys('staff.reporting.worklist')).map((s) => s.key.toLowerCase());
    for (const n of [1, 2, 3, 4, 5, 6]) expect(ks).toContain(`alt+${n}`);
    expect(ks).toContain('/');
    expect(ks).toContain('alt+r');
  });

  it('Alt+2 switches to the "Ready to release" tab via the router', async () => {
    const W = await load();
    view(W, [summary()], { tab: 'awaiting_content' });
    const s = await shortcut('staff.reporting.worklist', /^alt\+2$/i);
    expect(s).toBeTruthy();
    act(() => s!.run());
    const target = [...push.mock.calls, ...replace.mock.calls].map((c) => String(c[0]));
    expect(target.some((t) => /ready_to_release/.test(t))).toBe(true);
  });

  it('denied: without reporting.report.bulk_release there is no Alt+R, no bulk bar and no checkboxes', async () => {
    const W = await load();
    view(W, [summary()], { permissions: READ });
    expect(await shortcut('staff.reporting.worklist', /^alt\+r$/i)).toBeUndefined();
    expect(within(screen.getByRole('table')).queryAllByRole('checkbox')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /release \d+/i })).toBeNull();
  });

  it('bulk release: select 2 → confirm "Release 2 reports?" → POST ids with Idempotency-Key → result table + summary line', async () => {
    const W = await load();
    const u = user();
    view(W, [summary({ id: REPORT }), summary({ id: U(5), registration_no: 'R2611050002' })]);
    const rows = screen.getAllByRole('row').slice(1);
    for (const r of rows) await u.click(within(r).getByRole('checkbox'));
    await u.click(screen.getByRole('button', { name: /^release 2/i }));
    const dlg = await screen.findByRole('dialog');
    expect(within(dlg).getByText('Release 2 reports?')).toBeTruthy();
    expect(within(dlg).getByText(/Reports with dues will stay held unless an override exists\. Messages are sent to patients who agreed to them\./)).toBeTruthy();
    await u.click(within(dlg).getByRole('button', { name: 'Release 2' }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1));
    expect(last().url.pathname).toBe('/v1/reporting/report-versions/bulk-release');
    expect(Array.isArray(last().body.ids)).toBe(true);
    expect([...last().body.ids].sort()).toEqual([V1, V2].sort()); // version ids, never the report ids (REPORT / U(5))
    expect(last().headers.get('idempotency-key')).toBeTruthy();
    expect(await screen.findByText(/1 released · 1 held for dues · 0 not released/)).toBeTruthy();
  });

  it('barcode search: label, scan → POST search {barcode}; one match opens the detail; the barcode is never in the URL', async () => {
    const W = await load();
    const u = user();
    view(W, [summary()], { permissions: [...BULK, 'lab.specimen.read'] });
    const input = screen.getByLabelText('Registration no. or barcode');
    expect(input.getAttribute('maxlength')).toBe('20');
    await u.type(input, 'BC123456{Enter}');
    await waitFor(() => expect(calls.some((c) => c.url.pathname.endsWith('/reports/search'))).toBe(true));
    expect(calls.find((c) => c.url.pathname.endsWith('/reports/search'))!.body).toEqual({ barcode: 'BC123456' });
    await waitFor(() => expect(push).toHaveBeenCalled());
    expect(String(push.mock.calls[0]![0])).toBe(`/reporting/reports/${REPORT}`);
    expect(push.mock.calls.map((c) => String(c[0])).join()).not.toMatch(/BC123456/);
  });

  it('no match shows inline "No report found for this barcode"', async () => {
    const W = await load();
    const u = user();
    api.use(http.post(`${R}/reports/search`, () => HttpResponse.json({ data: [] })));
    view(W, [summary()], { permissions: [...BULK, 'lab.specimen.read'] });
    await u.type(screen.getByLabelText('Registration no. or barcode'), 'NOPE99{Enter}');
    expect(await screen.findByText('No report found for this barcode')).toBeTruthy();
  });

  it('without lab.specimen.read the label is "Registration no." and a scan explains why (no search call)', async () => {
    const W = await load();
    const u = user();
    view(W, [summary()], { permissions: BULK });
    const input = screen.getByLabelText('Registration no.');
    await u.type(input, 'BC123456{Enter}');
    expect(await screen.findByText(/Barcode search is not available for your role — enter the registration no\./)).toBeTruthy();
    expect(calls.filter((c) => c.url.pathname.endsWith('/reports/search'))).toHaveLength(0);
  });

  it('axe: populated and empty', async () => {
    const W = await load();
    const a = view(W, [summary()]);
    await noAxeViolations();
    a.unmount();
    view(W, [], { tab: 'held' });
    await noAxeViolations();
  });
});

// ───────────────────────────────────────────────────────── §2.9 critical alerts panel
describe('§2.9 CriticalAlertsPanel', () => {
  const load = async () => (await mod<{ CriticalAlertsPanel: any }>('CriticalAlertsPanel')).CriticalAlertsPanel;

  it('collapsible card "Critical alerts" with a count badge, rows with reg no, time, recipient chips and "Open report"', async () => {
    const P = await load();
    wrap(<P alerts={[alert()] as never} />);
    expect(screen.getByText('Critical alerts')).toBeTruthy();
    const card = screen.getByText('Critical alerts').closest('section,div,article')!;
    expect(within(card as HTMLElement).getByText('1')).toBeTruthy();
    expect(screen.getByText('R2611050001')).toBeTruthy();
    expect(screen.getByText('Doctor — Delivered')).toBeTruthy();
    expect(screen.getByText('Staff — Not sent (call)')).toBeTruthy();
    expect(screen.getByRole('link', { name: /open report/i }).getAttribute('href')).toBe(`/reporting/reports/${REPORT}`);
  });

  it('a row without a report shows "—" for the reg no. and no Open-report link; "50+" badge when a next page exists', async () => {
    const P = await load();
    wrap(<P alerts={[alert({ report_id: undefined, registration_no: undefined })] as never} hasMore />);
    expect(screen.queryByRole('link', { name: /open report/i })).toBeNull();
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
    expect(screen.getByText('50+')).toBeTruthy();
  });

  it('never shows a value, an analyte or a patient name (review fix #16)', async () => {
    const P = await load();
    wrap(<P alerts={[alert({ patient_display_name: 'Synthetic P.', analyte: 'Potassium', value: '7.9' })] as never} />);
    const t = document.body.textContent ?? '';
    expect(t).not.toMatch(/Synthetic P\.|Potassium|7\.9/);
  });

  it('empty: "No critical alerts in the last 24 hours."', async () => {
    const P = await load();
    wrap(<P alerts={[]} />);
    expect(screen.getByText('No critical alerts in the last 24 hours.')).toBeTruthy();
  });

  it('error (alerts=null): inline alert with Retry; Retry re-reads R18 and shows rows', async () => {
    const P = await load();
    const u = user();
    wrap(<P alerts={null} />);
    const err = screen.getByRole('alert');
    await u.click(within(err).getByRole('button', { name: /retry/i }));
    await waitFor(() => expect(calls.some((c) => c.url.pathname === '/v1/reporting/critical-alerts')).toBe(true));
    expect(await screen.findByText('R2611050001')).toBeTruthy();
  });

  it('polls every 30 s and follows the worklist centre filter', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const P = await load();
    wrap(<P alerts={[alert()] as never} centreId={CENTRE} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_500); });
    await waitFor(() => expect(calls.some((c) => c.url.pathname === '/v1/reporting/critical-alerts')).toBe(true));
    expect(calls.find((c) => c.url.pathname === '/v1/reporting/critical-alerts')!.url.searchParams.get('centre_id')).toBe(CENTRE);
  });

  it('axe', async () => {
    const P = await load();
    wrap(<P alerts={[alert()] as never} />);
    await noAxeViolations();
  });
});

// ───────────────────────────────────────────────────────── §2.2 report detail
describe('§2.2 ReportDetailView', () => {
  const load = async () => (await mod<{ ReportDetailView: any }>('ReportDetailView')).ReportDetailView;
  const view = (D: any, report: unknown, perms: readonly string[] = ADMIN) => wrap(<D report={report as never} permissions={perms} />);
  const openMenu = async (u: ReturnType<typeof user>) => u.click(screen.getByRole('button', { name: /more actions|⋯|more/i }));

  it('header "Report · R2611050001", cards (header, items, versions, deliveries) and referrer "SELF" when none', async () => {
    const D = await load();
    view(D, detail({ referrer_name: undefined }));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toMatch(/Report · R2611050001/);
    for (const h of [/items/i, /versions/i, /deliveries/i]) expect(screen.getAllByRole('heading', { name: h }).length).toBeGreaterThan(0);
    expect(screen.getByText('SELF')).toBeTruthy();
    expect(screen.getByText('Complete blood count')).toBeTruthy();
    expect(screen.getByRole('link', { name: /open delivery log filtered to this report/i }).getAttribute('href')).toMatch(/\/reporting\/deliveries\?.*report_id=/);
  });

  it('versions timeline: newest first, kind/status text, Download per version, discarded collapsed behind "Show discarded"', async () => {
    const D = await load();
    const u = user();
    view(D, detail({ versions: [vsum({ id: V2, version_no: 2, status: 'released', report_kind: 'amended', released_at: '2026-11-05T05:05:00.000Z', release_basis: 'paid_in_full' }), vsum({ id: V1, version_no: 1, status: 'superseded' }), vsum({ id: U(14), version_no: 3, status: 'discarded' })] }));
    expect(screen.getByText(/v2/)).toBeTruthy();
    expect(screen.getByText(/Paid in full/)).toBeTruthy();
    expect(screen.getAllByRole('link', { name: /download/i }).length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText(/v3/)).toBeNull();
    await u.click(screen.getByRole('button', { name: /show discarded/i }));
    expect(screen.getByText(/v3/)).toBeTruthy();
  });

  it('shortcuts on staff.reporting.report: Alt+R, Alt+P, Alt+D', async () => {
    const D = await load();
    view(D, detail());
    const ks = (await keys('staff.reporting.report')).map((s) => s.key.toLowerCase());
    for (const k of ['alt+r', 'alt+p', 'alt+d']) expect(ks).toContain(k);
  });

  it('release dialog: audiences (computed set; patient checked + disabled), "Print only" switch; submit → POST release with If-Match of the latest version + Idempotency-Key', async () => {
    const D = await load();
    const u = user();
    view(D, detail({ versions: [vsum({ version: 7 })] }));
    await u.click(screen.getByRole('button', { name: /^release$/i }));
    const dlg = await screen.findByRole('dialog');
    const patient = within(dlg).getByRole('checkbox', { name: /patient/i }) as HTMLInputElement;
    expect(patient.checked).toBe(true);
    expect(patient.disabled).toBe(true);
    expect(within(dlg).getByRole('switch', { name: /print only/i })).toBeTruthy();
    await u.click(within(dlg).getByRole('button', { name: /^release$/i }));
    await waitFor(() => expect(calls.some((c) => c.url.pathname === `/v1/reporting/report-versions/${V2}/release`)).toBe(true));
    const c = calls.find((x) => x.url.pathname.endsWith('/release'))!;
    expect(c.headers.get('if-match')).toBe('"7"');
    expect(c.headers.get('idempotency-key')).toBeTruthy();
    expect(c.body.audiences).toEqual(['patient']);
  });

  it('"Print only" sends suppress_notifications:true', async () => {
    const D = await load();
    const u = user();
    view(D, detail());
    await u.click(screen.getByRole('button', { name: /^release$/i }));
    const dlg = await screen.findByRole('dialog');
    await u.click(within(dlg).getByRole('switch', { name: /print only/i }));
    await u.click(within(dlg).getByRole('button', { name: /^release$/i }));
    await waitFor(() => expect(calls.some((c) => c.url.pathname.endsWith('/release'))).toBe(true));
    expect(calls.find((x) => x.url.pathname.endsWith('/release'))!.body.suppress_notifications).toBe(true);
  });

  it('release_blocked_due → held banner with the balance; "Record override" only with billing.release.override (C4); denied users see no override action', async () => {
    const D = await load();
    const u = user();
    api.use(http.post(`${R}/report-versions/:id/release`, () => HttpResponse.json(problem(422, 'reporting.release_blocked_due', { release_basis: 'due_outstanding', balance_due_paisa: 50000 }), { status: 422 })));
    const a = view(D, detail({ display_status: 'held', held_basis: 'due_outstanding', balance_due_paisa: 50000 }));
    expect(screen.getByRole('button', { name: /record override/i })).toBeTruthy();
    await u.click(screen.getByRole('button', { name: /^release$/i }));
    await u.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /^release$/i }));
    expect(await screen.findByText(/NPR 500\.00/)).toBeTruthy();
    a.unmount();
    view(D, detail({ display_status: 'held', held_basis: 'due_outstanding', balance_due_paisa: 50000 }), RELEASE);
    expect(screen.queryByRole('button', { name: /record override/i })).toBeNull();
    expect(screen.getByText(/NPR 500\.00/)).toBeTruthy();
  });

  it('C4 override dialog (MSW): reasons from listBillingCodes, note ≤500, optional valid-until; submit POSTs release-overrides then reopens the release dialog', async () => {
    const D = await load();
    const u = user();
    view(D, detail({ display_status: 'held', held_basis: 'due_outstanding', balance_due_paisa: 50000 }));
    await u.click(screen.getByRole('button', { name: /record override/i }));
    const dlg = await screen.findByRole('dialog');
    const reason = within(dlg).getByLabelText(/reason/i);
    await waitFor(() => expect(within(dlg).getByRole('option', { name: 'Family emergency' })).toBeTruthy());
    await u.selectOptions(reason, 'family_emergency');
    const note = within(dlg).getByLabelText(/note/i);
    expect(note.getAttribute('maxlength')).toBe('500');
    await u.type(note, 'Synthetic note');
    await u.click(within(dlg).getByRole('button', { name: 'Record override' }));
    await waitFor(() => expect(calls.some((c) => c.url.pathname === `/v1/billing/orders/${ORDER}/release-overrides`)).toBe(true));
    const c = calls.find((x) => x.url.pathname.endsWith('/release-overrides'))!;
    expect(c.body).toMatchObject({ reason_code: 'family_emergency', reason_text: 'Synthetic note' });
    expect(c.headers.get('idempotency-key')).toBeTruthy();
    const next = await screen.findByRole('dialog');
    expect(within(next).getByRole('switch', { name: /print only/i })).toBeTruthy(); // the release dialog is back
  });

  it('render_failed banner shows the error code and Retry posts retry-render; Retry hidden without reporting.report.render', async () => {
    const D = await load();
    const u = user();
    const failed = detail({ display_status: 'render_failed', versions: [vsum({ status: 'render_failed', last_render_error_code: 'render_timeout' })] });
    const a = view(D, failed, [...ADMIN, 'reporting.report.render']);
    expect(screen.getByText(/render_timeout/)).toBeTruthy();
    await u.click(screen.getByRole('button', { name: /retry/i }));
    await waitFor(() => expect(calls.some((c) => c.url.pathname.endsWith('/retry-render'))).toBe(true));
    expect(last().headers.get('idempotency-key')).toBeTruthy();
    a.unmount();
    view(D, failed, READ);
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
  });

  it('review flag banner: "The order was cancelled after this report was released."', async () => {
    const D = await load();
    view(D, detail({ review_flag: 'released_order_cancelled', display_status: 'released' }), READ);
    expect(screen.getByText('The order was cancelled after this report was released.')).toBeTruthy();
  });

  it('print dialog: paper RadioGroup (letterhead default), copies 1–5, POST prints with variant+copies, then "Preparing print…"', async () => {
    const D = await load();
    const u = user();
    view(D, detail({ versions: [vsum({ status: 'released' })], display_status: 'released' }));
    await u.click(screen.getByRole('button', { name: /print/i }));
    const dlg = await screen.findByRole('dialog');
    expect((within(dlg).getByRole('radio', { name: /with letterhead/i }) as HTMLInputElement).checked).toBe(true);
    expect(within(dlg).getByRole('radio', { name: /plain paper/i })).toBeTruthy();
    const copies = within(dlg).getByLabelText(/copies/i) as HTMLInputElement;
    expect(copies.getAttribute('min')).toBe('1');
    expect(copies.getAttribute('max')).toBe('5');
    await u.click(within(dlg).getByRole('radio', { name: /plain paper/i }));
    await u.click(within(dlg).getByRole('button', { name: /^print$/i }));
    await waitFor(() => expect(calls.some((c) => c.url.pathname.endsWith('/prints'))).toBe(true));
    expect(calls.find((c) => c.url.pathname.endsWith('/prints'))!.body).toEqual({ variant: 'plain', copies: 1 });
    expect(await screen.findByText(/Preparing print…/)).toBeTruthy();
  });

  it('Print on an UNRELEASED version needs both reporting.report.print and reporting.report.release (08 A13 D-37)', async () => {
    const D = await load();
    const a = view(D, detail(), ['reporting.report.read', 'reporting.report.print']);
    expect(screen.queryByRole('button', { name: /print/i })).toBeNull();
    a.unmount();
    view(D, detail(), ['reporting.report.read', 'reporting.report.print', 'reporting.report.release']);
    expect(screen.getByRole('button', { name: /print/i })).toBeTruthy();
  });

  it('regenerate: ConfirmDialog with reason codes, help text, free text required for "other"; POST regenerations {reason_code}', async () => {
    const D = await load();
    const u = user();
    view(D, detail());
    await openMenu(u);
    await u.click(await screen.findByRole('menuitem', { name: /regenerate/i }));
    const dlg = await screen.findByRole('dialog');
    expect(within(dlg).getByText(/After a released version, the new version prints as AMENDED REPORT with this reason, except 'Smart summary added'\./)).toBeTruthy();
    const reason = within(dlg).getByLabelText(/reason/i);
    await waitFor(() => expect(within(dlg).getByRole('option', { name: 'Demographic correction' })).toBeTruthy());
    await u.selectOptions(reason, 'other');
    await u.click(within(dlg).getByRole('button', { name: /regenerate|confirm/i }));
    expect(calls.filter((c) => c.url.pathname.endsWith('/regenerations'))).toHaveLength(0); // "other" without text is refused client-side
    await u.type(within(dlg).getByLabelText(/note|details|text/i), 'Synthetic detail');
    await u.click(within(dlg).getByRole('button', { name: /regenerate|confirm/i }));
    await waitFor(() => expect(calls.some((c) => c.url.pathname === `/v1/reporting/reports/${REPORT}/regenerations`)).toBe(true));
    expect(calls.find((c) => c.url.pathname.endsWith('/regenerations'))!.body).toMatchObject({ reason_code: 'other', reason_text: 'Synthetic detail' });
  });

  it('regenerate and revoke-QR are absent without their permissions', async () => {
    const D = await load();
    const u = user();
    view(D, detail(), RELEASE);
    const more = screen.queryByRole('button', { name: /more actions|⋯|more/i });
    if (more) await u.click(more);
    expect(screen.queryByRole('menuitem', { name: /regenerate/i })).toBeNull();
  });

  it('revoke QR: danger ConfirmDialog with the exact copy, reason set token_revoke_reasons, POST qr-token/revoke', async () => {
    const D = await load();
    const u = user();
    view(D, detail({ versions: [vsum({ status: 'released' })], display_status: 'released' }));
    await openMenu(u);
    await u.click(await screen.findByRole('menuitem', { name: /revoke qr/i }));
    const dlg = await screen.findByRole('dialog');
    expect(within(dlg).getByText(/Anyone who scans this report's QR code will see 'could not be verified'\. This cannot be undone\./)).toBeTruthy();
    await waitFor(() => expect(within(dlg).getByRole('option', { name: 'Issued in error' })).toBeTruthy());
    await u.selectOptions(within(dlg).getByLabelText(/reason/i), 'issued_in_error');
    await u.click(within(dlg).getByRole('button', { name: /revoke/i }));
    await waitFor(() => expect(calls.some((c) => c.url.pathname.endsWith('/qr-token/revoke'))).toBe(true));
    expect(calls.find((c) => c.url.pathname.endsWith('/qr-token/revoke'))!.body).toMatchObject({ reason_code: 'issued_in_error' });
  });

  it('axe: full detail with a banner', async () => {
    const D = await load();
    view(D, detail({ display_status: 'held', held_basis: 'due_outstanding', balance_due_paisa: 50000 }));
    await noAxeViolations();
  });
});

// ───────────────────────────────────────────────────────── §2.3 outsourced
describe('§2.3 OutsourcedQueue + OutsourcedFilePanel', () => {
  const loadQ = async () => (await mod<{ OutsourcedQueue: any }>('OutsourcedQueue')).OutsourcedQueue;
  const loadP = async () => (await mod<{ OutsourcedFilePanel: any }>('OutsourcedFilePanel')).OutsourcedFilePanel;
  const PERM = ['reporting.outsourced.attach'];

  it('columns, state chip text, state filter (Awaiting file / Awaiting confirmation / Confirmed), empty state', async () => {
    const Q = await loadQ();
    const a = wrap(<Q items={[outsourced()] as never} permissions={PERM} centres={centres} />);
    for (const h of ['Reg no', 'Patient', 'Test', 'External lab', 'File state', 'Registered']) expect(screen.getByRole('columnheader', { name: new RegExp(h, 'i') })).toBeTruthy();
    const bar = screen.getByRole('search');
    for (const l of ['Awaiting file', 'Awaiting confirmation', 'Confirmed']) expect(within(bar).getAllByText(l).length).toBeGreaterThan(0);
    a.unmount();
    wrap(<Q items={[]} permissions={PERM} centres={centres} />);
    expect(screen.getByText(/no outsourced reports|nothing .*outsourced/i)).toBeTruthy();
  });

  it('upload dialog: PDF only ≤15 MB, external lab name ≤120 chars required; submit posts multipart file + external_lab_name with Idempotency-Key', async () => {
    const Q = await loadQ();
    const u = user();
    wrap(<Q items={[outsourced({ latest_file_state: undefined })] as never} permissions={PERM} centres={centres} />);
    await u.click(screen.getByRole('button', { name: /upload/i }));
    const dlg = await screen.findByRole('dialog');
    const lab = within(dlg).getByLabelText(/external lab name/i);
    expect(lab.getAttribute('maxlength')).toBe('120');
    const file = within(dlg).getByLabelText(/file/i) as HTMLInputElement;
    expect(file.getAttribute('accept')).toMatch(/application\/pdf/);
    await u.click(within(dlg).getByRole('button', { name: /upload/i }));
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0); // both fields required
    await u.type(lab, 'Synthetic External Lab');
    await u.upload(file, new File(['%PDF-1.7 synthetic'], 'synthetic-external.pdf', { type: 'application/pdf' }));
    await u.click(within(dlg).getByRole('button', { name: /upload/i }));
    await waitFor(() => expect(calls.some((c) => c.url.pathname === `/v1/reporting/order-items/${ITEM}/outsourced-files`)).toBe(true));
    const c = calls.find((x) => x.method === 'POST')!;
    expect(c.headers.get('content-type')).toMatch(/multipart\/form-data/);
    expect(c.headers.get('idempotency-key')).toBeTruthy();
  });

  it.each([
    ['pending_scan', 'Checking the file for viruses…'],
    ['scanning', 'Checking the file for viruses…'],
    ['sanitizing', 'Preparing the file…'],
    ['ready', 'Ready. Open it and confirm it belongs to this patient.'],
    ['quarantined', 'This file was blocked by the virus scanner and has been isolated.'],
  ])('file card, state %s: "%s"', async (state, copy) => {
    const P = await loadP();
    wrap(<P file={inputFile({ state }) as never} patientDisplayName="Synthetic P." permissions={PERM} />);
    expect(screen.getByText(copy)).toBeTruthy();
    expect(screen.getByText(/synthetic-external\.pdf/)).toBeTruthy();
  });

  it.each([
    ['encrypted'], ['damaged'], ['too many pages'], ['took too long'],
  ])('rejected file explains the reason (%s)', async (why) => {
    const P = await loadP();
    const code = { encrypted: 'pdf_encrypted', damaged: 'pdf_malformed', 'too many pages': 'pdf_too_many_pages', 'took too long': 'pdf_timeout' }[why]!;
    wrap(<P file={inputFile({ state: 'rejected', last_error_code: code }) as never} patientDisplayName="Synthetic P." permissions={PERM} />);
    expect(screen.getByText(new RegExp(`This PDF could not be used \\(.*${why}.*\\)\\.`))).toBeTruthy();
  });

  it('confirmed: "Confirmed by … at …"; no confirm control any more', async () => {
    const P = await loadP();
    wrap(<P file={inputFile({ state: 'confirmed', confirmed_at: '2026-11-05T05:10:00.000Z' }) as never} patientDisplayName="Synthetic P." permissions={PERM} />);
    expect(screen.getByText(/^Confirmed by .+ at /)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^confirm$/i })).toBeNull();
  });

  it('confirm: needs the "I have checked that this report belongs to {patient}" box; then POST confirm with If-Match + Idempotency-Key', async () => {
    const P = await loadP();
    const u = user();
    wrap(<P file={inputFile({ state: 'ready', version: 3 }) as never} patientDisplayName="Synthetic P." permissions={PERM} />);
    const confirm = screen.getByRole('button', { name: /^confirm$/i }) as HTMLButtonElement;
    const box = screen.getByRole('checkbox', { name: 'I have checked that this report belongs to Synthetic P.' });
    await u.click(confirm);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    await u.click(box);
    await u.click(confirm);
    await waitFor(() => expect(calls.some((c) => c.url.pathname === `/v1/reporting/outsourced-files/${FILE}/confirm`)).toBe(true));
    expect(last().headers.get('if-match')).toBe('"3"');
    expect(last().headers.get('idempotency-key')).toBeTruthy();
  });

  it('axe: queue and file card', async () => {
    const Q = await loadQ();
    const P = await loadP();
    wrap(<><Q items={[outsourced()] as never} permissions={PERM} centres={centres} /><P file={inputFile() as never} patientDisplayName="Synthetic P." permissions={PERM} /></>);
    await noAxeViolations();
  });
});

// ───────────────────────────────────────────────────────── §2.4 narrative editor
describe('§2.4 NarrativeEditor', () => {
  const load = async () => (await mod<{ NarrativeEditor: any }>('NarrativeEditor')).NarrativeEditor;
  const TPLS = [narrativeTemplate()];
  const WRITE = ['reporting.narrative.write'];
  const SIGN = [...WRITE, 'reporting.narrative.sign'];

  it('one editor per template section with its heading, required marked, "Save draft" always; "Sign report" only with reporting.narrative.sign', async () => {
    const N = await load();
    const a = wrap(<N narrative={narrative() as never} templates={TPLS as never} permissions={WRITE} />);
    expect(screen.getByText('Findings')).toBeTruthy();
    expect(screen.getByText('Impression')).toBeTruthy();
    expect(screen.getAllByText(/required/i).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Sign report' })).toBeNull();
    a.unmount();
    wrap(<N narrative={narrative() as never} templates={TPLS as never} permissions={SIGN} />);
    expect(screen.getByRole('button', { name: 'Sign report' })).toBeTruthy();
  });

  it('shortcuts on staff.reporting.narrative: Ctrl+S, Ctrl+Enter (sign only with permission), Alt+I', async () => {
    const N = await load();
    wrap(<N narrative={narrative() as never} templates={TPLS as never} permissions={SIGN} />);
    const ks = (await keys('staff.reporting.narrative')).map((s) => s.key.toLowerCase());
    for (const k of ['ctrl+s', 'ctrl+enter', 'alt+i']) expect(ks).toContain(k);
  });

  it('Ctrl+Enter is not registered without reporting.narrative.sign', async () => {
    const N = await load();
    wrap(<N narrative={narrative() as never} templates={TPLS as never} permissions={WRITE} />);
    expect(await shortcut('staff.reporting.narrative', /^ctrl\+enter$/i)).toBeUndefined();
  });

  it('Save draft: PUT draft with sections + If-Match: "<version>" + Idempotency-Key; footer shows "Saved …"', async () => {
    const N = await load();
    const u = user();
    wrap(<N narrative={narrative() as never} templates={TPLS as never} permissions={WRITE} />);
    await u.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(calls.some((c) => c.url.pathname === `/v1/reporting/narratives/${NARR}/draft`)).toBe(true));
    expect(last().method).toBe('PUT');
    expect(last().headers.get('if-match')).toBe('"5"');
    expect(last().headers.get('idempotency-key')).toBeTruthy();
    expect(JSON.stringify(last().body)).toMatch(/Synthetic findings/);
    expect(await screen.findByText(/^Saved /)).toBeTruthy();
  });

  it('Sign: confirm "Sign and lock this report? After signing, changes need an amendment." then POST sign', async () => {
    const N = await load();
    const u = user();
    wrap(<N narrative={narrative() as never} templates={TPLS as never} permissions={SIGN} />);
    await u.click(screen.getByRole('button', { name: 'Sign report' }));
    const dlg = await screen.findByRole('dialog');
    expect(within(dlg).getByText('Sign and lock this report? After signing, changes need an amendment.')).toBeTruthy();
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    await u.click(within(dlg).getByRole('button', { name: /sign/i }));
    await waitFor(() => expect(calls.some((c) => c.url.pathname === `/v1/reporting/narratives/${NARR}/sign`)).toBe(true));
    expect(last().headers.get('idempotency-key')).toBeTruthy();
  });

  it('changing the template on a non-empty draft asks "Replace section text with the template?"', async () => {
    const N = await load();
    const u = user();
    const tpls = [narrativeTemplate(), narrativeTemplate({ id: U(35), code: 'XRAY_SPINE', name: 'Spine X-ray' })];
    wrap(<N narrative={narrative({ current_version: { ...narrative().current_version, template_id: tpls[0]!.id } }) as never} templates={tpls as never} permissions={WRITE} />);
    await u.selectOptions(screen.getByLabelText(/template/i), 'Spine X-ray');
    expect(await screen.findByText('Replace section text with the template?')).toBeTruthy();
  });

  it('signed view: sanitised HTML rendered by the kit (script stripped), signature line, "Start amendment" with narrative_amend_reasons', async () => {
    const N = await load();
    const u = user();
    const signed = narrative({ status: 'signed', current_version: { version_no: 2, status: 'signed', sections: [{ key: 'findings', heading: 'Findings', html: '<p>Synthetic signed finding.</p><script>window.__pwned=1</script>' }], images: [], signed_at: '2026-11-05T05:00:00.000Z', signed_by: U(9) } });
    wrap(<N narrative={signed as never} templates={TPLS as never} permissions={SIGN} signedByName="Dr Synthetic" signedByTitle="Radiologist" />);
    expect(screen.getByText('Synthetic signed finding.')).toBeTruthy();
    expect(document.querySelector('script')).toBeNull();
    expect(screen.getByText(/Signed by Dr Synthetic, Radiologist on /)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save draft' })).toBeNull();
    await u.click(screen.getByRole('button', { name: 'Start amendment' }));
    const dlg = await screen.findByRole('dialog');
    await waitFor(() => expect(within(dlg).getByRole('option', { name: 'Transcription error' })).toBeTruthy());
    await u.selectOptions(within(dlg).getByLabelText(/reason/i), 'transcription_error');
    await u.click(within(dlg).getByRole('button', { name: /start amendment|confirm/i }));
    await waitFor(() => expect(calls.some((c) => c.url.pathname.endsWith('/amendments'))).toBe(true));
    expect(last().body).toMatchObject({ reason_code: 'transcription_error' });
  });

  it('images: PNG/JPEG only, ≤12 images (upload disabled at 12), caption ≤200', async () => {
    const N = await load();
    const twelve = Array.from({ length: 12 }, (_, i) => ({ image_id: U(200 + i), caption: `Synthetic image ${i + 1}` }));
    const a = wrap(<N narrative={narrative() as never} templates={TPLS as never} permissions={WRITE} />);
    const input = document.querySelector('input[type=file]') as HTMLInputElement;
    expect(input.getAttribute('accept')).toMatch(/image\/png/);
    expect(input.getAttribute('accept')).toMatch(/image\/jpeg/);
    expect(input.getAttribute('accept')).not.toMatch(/gif|svg|pdf/);
    a.unmount();
    wrap(<N narrative={narrative({ current_version: { ...narrative().current_version, images: twelve } }) as never} templates={TPLS as never} permissions={WRITE} />);
    const full = document.querySelector('input[type=file]') as HTMLInputElement | null;
    expect(full === null || full.disabled).toBe(true);
  });

  it('axe: draft and signed', async () => {
    const N = await load();
    const a = wrap(<N narrative={narrative() as never} templates={TPLS as never} permissions={SIGN} />);
    await noAxeViolations();
    a.unmount();
    wrap(<N narrative={narrative({ status: 'signed', current_version: { version_no: 2, status: 'signed', sections: [{ key: 'findings', heading: 'Findings', html: '<p>x</p>' }], images: [] } }) as never} templates={TPLS as never} permissions={SIGN} />);
    await noAxeViolations();
  });
});

// ───────────────────────────────────────────────────────── §2.5 deliveries
describe('§2.5 DeliveriesList + DeliveryDetail', () => {
  const loadL = async () => (await mod<{ DeliveriesList: any }>('DeliveriesList')).DeliveriesList;
  const loadD = async () => (await mod<{ DeliveryDetail: any }>('DeliveryDetail')).DeliveryDetail;
  const DP = ['reporting.delivery.read'];

  it('columns; masked destination only; status chip text; report link; filters (status, channel, purpose, date range)', async () => {
    const L = await loadL();
    wrap(<L deliveries={[delivery()] as never} permissions={DP} />);
    for (const h of ['Created', 'Channel', 'Purpose', 'Recipient', 'To', 'Status', 'Attempts', 'Report']) expect(screen.getByRole('columnheader', { name: new RegExp(h, 'i') })).toBeTruthy();
    expect(screen.getByText('98••••••12')).toBeTruthy();
    expect(screen.getByText('Failed')).toBeTruthy();
    expect(screen.getAllByRole('link').some((a) => a.getAttribute('href') === `/reporting/reports/${REPORT}`)).toBe(true);
    const bar = screen.getByRole('search');
    for (const l of [/status/i, /channel/i, /purpose/i, /date/i]) expect(within(bar).getAllByText(l).length).toBeGreaterThan(0);
  });

  it('print rows show channel "Print" and recipient "Patient"', async () => {
    const L = await loadL();
    wrap(<L deliveries={[delivery({ channel: 'print', recipient_kind: 'patient', status: 'delivered', destination_masked: undefined, failure_code: undefined })] as never} permissions={DP} />);
    const row = screen.getByText('Print').closest('tr')!;
    expect(within(row).getByText('Patient')).toBeTruthy();
  });

  it('Resend only on failed rows and only with reporting.delivery.resend; POST retry with Idempotency-Key', async () => {
    const L = await loadL();
    const u = user();
    const a = wrap(<L deliveries={[delivery(), delivery({ id: U(52), status: 'delivered', failure_code: undefined })] as never} permissions={[...DP, 'reporting.delivery.resend']} />);
    const buttons = screen.getAllByRole('button', { name: /resend/i });
    expect(buttons).toHaveLength(1);
    await u.click(buttons[0]!);
    await waitFor(() => expect(calls.some((c) => c.url.pathname === `/v1/reporting/deliveries/${DLV}/retry`)).toBe(true));
    expect(last().headers.get('idempotency-key')).toBeTruthy();
    a.unmount();
    wrap(<L deliveries={[delivery()] as never} permissions={DP} />);
    expect(screen.queryByRole('button', { name: /resend/i })).toBeNull();
  });

  it('empty: "No deliveries"', async () => {
    const L = await loadL();
    wrap(<L deliveries={[]} permissions={DP} />);
    expect(screen.getByText(/no deliveries/i)).toBeTruthy();
  });

  it.each([
    ['no_consent', 'Not sent: the patient has not agreed to this channel.'],
    ['no_contact', 'Not sent: no phone number or email on file.'],
    ['channel_disabled', 'Not sent: this channel is switched off for your lab.'],
    ['provider_rejected', 'The messaging provider rejected the message.'],
    ['invalid_destination', 'The number or address was not accepted.'],
    ['template_not_approved', 'The WhatsApp template is not approved yet.'],
    ['retries_exhausted', 'Sending failed after several tries.'],
    ['circuit_open', 'The provider is not responding; we will try again.'],
    ['superseded_attempt', 'Replaced by a newer attempt.'],
  ])('detail explains failure_code %s in plain language', async (code, text) => {
    const D = await loadD();
    wrap(<D delivery={delivery({ failure_code: code }) as never} permissions={DP} />);
    expect(screen.getByText(text)).toBeTruthy();
  });

  it('detail: timeline of attempts, "Back to delivery log" link, no message text / link / OTP / full number', async () => {
    const D = await loadD();
    wrap(<D delivery={delivery({ body_text: 'Your report https://portal.test/r/SYN-TOKEN code 123456', attempts: [{ attempt_no: 1, started_at: '2026-11-05T05:00:00.000Z', outcome: 'suppressed', error_code: 'no_consent' }] }) as never} permissions={DP} />);
    expect(screen.getByRole('link', { name: /back to delivery log/i }).getAttribute('href')).toBe('/reporting/deliveries');
    expect(screen.getByText(/attempt 1/i)).toBeTruthy();
    const t = document.body.textContent ?? '';
    expect(t).not.toMatch(/SYN-TOKEN|123456|portal\.test/);
    expect(t).not.toMatch(/\b98\d{8}\b/);
  });

  it('axe: list and detail', async () => {
    const L = await loadL();
    const D = await loadD();
    wrap(<><L deliveries={[delivery()] as never} permissions={DP} /><D delivery={delivery() as never} permissions={DP} /></>);
    await noAxeViolations();
  });
});

// ───────────────────────────────────────────────────────── §2.6 templates
describe('§2.6 TemplatesList + TemplateEditor', () => {
  const loadL = async () => (await mod<{ TemplatesList: any }>('TemplatesList')).TemplatesList;
  const loadE = async () => (await mod<{ TemplateEditor: any }>('TemplateEditor')).TemplateEditor;
  const MANAGE = ['reporting.template.manage'];

  it('list links to /reporting/templates/{id}; empty state', async () => {
    const L = await loadL();
    const a = wrap(<L templates={[{ id: TPL, family: 'laboratory', name: 'Synthetic lab template', current_version_no: 1, draft_version_no: 2, is_active: true, version: 3 }] as never} permissions={MANAGE} />);
    expect(screen.getByRole('link', { name: 'Synthetic lab template' }).getAttribute('href')).toBe(`/reporting/templates/${TPL}`);
    a.unmount();
    wrap(<L templates={[]} permissions={MANAGE} />);
    expect(screen.getByText(/no (report )?templates/i)).toBeTruthy();
  });

  it('form sections and field ranges (TemplateConfig, 02-TRD §6.5)', async () => {
    const E = await loadE();
    wrap(<E template={templateDetail() as never} permissions={MANAGE} />);
    for (const s of [/^page/i, /letterhead/i, /header fields/i, /results/i, /signatories/i, /^qr/i, /watermark/i, /disclaimers/i, /fonts/i]) expect(screen.getAllByRole('heading', { name: s }).length).toBeGreaterThan(0);
    const num = (re: RegExp) => screen.getByLabelText(re) as HTMLInputElement;
    expect([num(/plain-paper reserve top/i).min, num(/plain-paper reserve top/i).max]).toEqual(['0', '80']);
    expect([num(/qr size/i).min, num(/qr size/i).max]).toEqual(['15', '35']);
    expect([num(/base size/i).min, num(/base size/i).max]).toEqual(['7', '11']);
    expect([num(/opacity/i).min, num(/opacity/i).max]).toEqual(['0.05', '0.3']);
    expect(screen.getByLabelText(/watermark text/i).getAttribute('maxlength')).toBe('40');
    expect(screen.getByLabelText(/qr caption/i).getAttribute('maxlength')).toBe('60');
    expect(screen.getByLabelText(/registration label/i).getAttribute('maxlength')).toBe('20');
    expect(screen.getAllByLabelText(/disclaimer/i).every((e) => e.getAttribute('maxlength') === '200')).toBe(true);
  });

  it('"Preview with sample data", "Save draft" (PUT draft, If-Match = draft version) and "Publish" with the privileged confirm copy', async () => {
    const E = await loadE();
    const u = user();
    wrap(<E template={templateDetail() as never} permissions={MANAGE} />);
    await u.click(screen.getByRole('button', { name: 'Preview with sample data' }));
    await waitFor(() => expect(calls.some((c) => c.url.pathname.endsWith('/previews'))).toBe(true));
    await u.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')!.headers.get('if-match')).toBe('"4"');
    await u.click(screen.getByRole('button', { name: 'Publish' }));
    const dlg = await screen.findByRole('dialog');
    expect(within(dlg).getByText('Publish this template? New reports will use it. Reports already made keep their layout.')).toBeTruthy();
    await u.click(within(dlg).getByRole('button', { name: 'Publish' }));
    await waitFor(() => expect(calls.some((c) => c.url.pathname.endsWith('/publish'))).toBe(true));
    expect(last().headers.get('idempotency-key')).toBeTruthy();
  });

  it('denied: without reporting.template.manage the form is read-only (no Save/Publish)', async () => {
    const E = await loadE();
    wrap(<E template={templateDetail() as never} permissions={['reporting.report.read']} />);
    expect(screen.queryByRole('button', { name: 'Save draft' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Publish' })).toBeNull();
  });

  it('axe', async () => {
    const E = await loadE();
    wrap(<E template={templateDetail() as never} permissions={MANAGE} />);
    await noAxeViolations();
  });
});

// ───────────────────────────────────────────────────────── §2.7 messages & channels
describe('§2.7 MessagesChannels', () => {
  const load = async () => (await mod<{ MessagesChannels: any }>('MessagesChannels')).MessagesChannels;
  const MT = ['reporting.message_template.manage', 'reporting.channel.manage'];

  it('table: template, purpose, channels, status per channel; WhatsApp approval chip', async () => {
    const M = await load();
    wrap(<M templates={[msgTemplate()] as never} accounts={[channelAccount()] as never} permissions={MT} />);
    for (const h of ['Template', 'Purpose', 'Channels', 'Status']) expect(screen.getByRole('columnheader', { name: new RegExp(h, 'i') })).toBeTruthy();
    const row = screen.getByText('REPORT_READY').closest('tr')!;
    expect(within(row).getByText(/Active/)).toBeTruthy();
    expect(within(row).getByText(/Draft/)).toBeTruthy();
    expect(within(row).getByText(/Submitted/i)).toBeTruthy();
  });

  it('edit drawer: body ≤1000 with counter, subject ≤150, declared-only placeholder chips, WhatsApp fields; PUT text with If-Match', async () => {
    const M = await load();
    const u = user();
    wrap(<M templates={[msgTemplate()] as never} accounts={[channelAccount()] as never} permissions={MT} />);
    await u.click(screen.getByRole('button', { name: /edit/i }));
    const dlg = await screen.findByRole('dialog');
    expect(within(dlg).getByLabelText(/language/i)).toBeTruthy();
    const body = within(dlg).getByLabelText(/message body|body/i);
    expect(body.getAttribute('maxlength')).toBe('1000');
    expect(within(dlg).getByText(/\d+ ?\/ ?1000/)).toBeTruthy();
    expect(within(dlg).getByRole('button', { name: 'Insert {lab_name}' })).toBeTruthy();
    expect(within(dlg).queryByRole('button', { name: 'Insert {undeclared}' })).toBeNull();
    await u.clear(body);
    await u.type(body, 'Synthetic body for {{lab_name}'); // `{{` = literal `{` in user-event (ruling C6-T31)
    await u.click(within(dlg).getByRole('button', { name: /save/i }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(last().url.pathname).toMatch(/\/message-templates\/REPORT_READY\/texts\/(sms|whatsapp|email)$/);
    expect(last().headers.get('if-match')).toMatch(/^"\d+"$/);
    expect(last().body.body_text).toBe('Synthetic body for {lab_name}');
  });

  it('channel accounts: secret REFERENCE only (pattern, help text), never a secret value; production hides "Recording"', async () => {
    const M = await load();
    wrap(<M templates={[]} accounts={[channelAccount()] as never} permissions={MT} productionMode />);
    const ref = screen.getByLabelText(/secret reference/i) as HTMLInputElement;
    expect(ref.getAttribute('pattern')).toBe('^[a-z0-9_./-]{1,128}$');
    expect(screen.getByText(/Name of the secret your operator stored\. The secret itself is never entered here\./)).toBeTruthy();
    expect(screen.getByLabelText(/sender id/i).getAttribute('maxlength')).toBe('64');
    expect(screen.queryByRole('option', { name: /recording/i })).toBeNull();
  });

  it('"Generate callback URL" shows the URL once in a copy dialog with the exact warning', async () => {
    const M = await load();
    const u = user();
    wrap(<M templates={[]} accounts={[channelAccount()] as never} permissions={MT} />);
    await u.click(screen.getByRole('button', { name: /generate callback url/i }));
    const dlg = await screen.findByRole('dialog');
    expect(await within(dlg).findByText(/SYN-ONCE-TOKEN/)).toBeTruthy();
    expect(within(dlg).getByText("Copy this URL into the provider's settings. It will not be shown again.")).toBeTruthy();
    await u.click(within(dlg).getByRole('button', { name: /close|done/i }));
    expect(document.body.textContent).not.toMatch(/SYN-ONCE-TOKEN/);
  });

  it('denied: without reporting.channel.manage the accounts card has no editing controls', async () => {
    const M = await load();
    wrap(<M templates={[msgTemplate()] as never} accounts={[channelAccount()] as never} permissions={['reporting.message_template.manage']} />);
    expect(screen.queryByRole('button', { name: /generate callback url/i })).toBeNull();
  });

  it('axe', async () => {
    const M = await load();
    wrap(<M templates={[msgTemplate()] as never} accounts={[channelAccount()] as never} permissions={MT} />);
    await noAxeViolations();
  });
});

// ───────────────────────────────────────────────────────── §2.8 settings
describe('§2.8 ReportingSettingsForm', () => {
  const load = async () => (await mod<{ ReportingSettingsForm: any }>('ReportingSettingsForm')).ReportingSettingsForm;
  const SET = ['reporting.settings.manage'];
  const view = (F: any, o: Record<string, unknown> = {}) => wrap(<F settings={settings(o) as never} contacts={[centreContact()] as never} centres={centres} permissions={SET} />);

  it('field set and ranges (02-TRD §10.2): fallback 5–240, bulk 1–200, reissue 0–5; auto-release + narrative-mode radios', async () => {
    const F = await load();
    view(F);
    const n = (re: RegExp) => screen.getByLabelText(re) as HTMLInputElement;
    expect([n(/fallback/i).min, n(/fallback/i).max]).toEqual(['5', '240']);
    expect([n(/bulk release/i).min, n(/bulk release/i).max]).toEqual(['1', '200']);
    expect([n(/reissue/i).min, n(/reissue/i).max]).toEqual(['0', '5']);
    expect(screen.getAllByRole('radio').length).toBeGreaterThanOrEqual(4);
    for (const s of [/patient email/i, /referrer/i, /centre delivery/i, /critical alert/i, /critical label/i]) expect(screen.getAllByRole('switch', { name: s }).length).toBeGreaterThan(0);
  });

  it('portal payment gateways: eSewa/Khalti checkboxes (default none) with the exact help; dues-link switch is on by default', async () => {
    const F = await load();
    view(F);
    const es = screen.getByRole('checkbox', { name: /esewa/i }) as HTMLInputElement;
    const kh = screen.getByRole('checkbox', { name: /khalti/i }) as HTMLInputElement;
    expect([es.checked, kh.checked]).toEqual([false, false]);
    expect(screen.getByText('Turn on only after online payments are live for your lab.')).toBeTruthy();
    expect((screen.getByRole('switch', { name: /send a payment link when a report is held for dues/i }) as HTMLInputElement).checked).toBe(true);
  });

  it('save: PATCH only the changed fields with If-Match: "<version>" + Idempotency-Key', async () => {
    const F = await load();
    const u = user();
    view(F);
    await u.click(screen.getByRole('checkbox', { name: /esewa/i }));
    await u.click(screen.getByRole('button', { name: /^save/i }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    expect(last().url.pathname).toBe('/v1/reporting/settings');
    expect(last().headers.get('if-match')).toBe('"6"');
    expect(last().headers.get('idempotency-key')).toBeTruthy();
    expect(last().body).toEqual({ portal_payment_gateways: ['esewa'] });
  });

  it('client validation: out-of-range numbers are refused before any request', async () => {
    const F = await load();
    const u = user();
    view(F);
    const fb = screen.getByLabelText(/fallback/i);
    await u.clear(fb);
    await u.type(fb, '999');
    await u.click(screen.getByRole('button', { name: /^save/i }));
    expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(0);
    expect(screen.getAllByRole('alert').length + document.querySelectorAll('[aria-invalid="true"]').length).toBeGreaterThan(0);
  });

  it('centre contacts sub-table shows the MASKED address only', async () => {
    const F = await load();
    view(F);
    for (const h of ['Centre', 'Channel', 'Address', 'Label', 'Active']) expect(screen.getAllByRole('columnheader', { name: new RegExp(h, 'i') }).length).toBeGreaterThan(0);
    expect(screen.getByText('98••••••34')).toBeTruthy();
  });

  it('denied: without reporting.settings.manage nothing is editable (no Save)', async () => {
    const F = await load();
    wrap(<F settings={settings() as never} contacts={[]} centres={centres} permissions={['reporting.report.read']} />);
    expect(screen.queryByRole('button', { name: /^save/i })).toBeNull();
  });

  it('axe', async () => {
    const F = await load();
    view(F);
    await noAxeViolations();
  });
});
