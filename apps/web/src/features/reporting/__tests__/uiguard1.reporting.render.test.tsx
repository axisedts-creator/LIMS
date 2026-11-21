// @vitest-environment jsdom
// T0D-UIGUARD-1-REPORTING (LD-436 worklist and Today mocks, LD-437 exact match, LD-439 a, LD-441): rendered DOM of the reporting area.
// Worklist (/reporting): PageHeader with the one line caption, Tabs (one tablist, six statuses, Ready to release selected by default), ONE FilterBar (lookup, status, centre,
// family, registered, review flag, "Clear filters") inside the tab panel, DataTable header row drawn when empty, StatusChip in the status cell.
// Report detail: Card title rows (.lims-card-head), Timeline for versions, StatusChip, the buttons for the permission set exactly as before (display only).
// All ten pages: no raw h2 to h4 outside a Card title or the kit, no ul/ol of the old lims-list / lims-plain-list / rpt-chips kind.
// Tab COUNTS: the API has no per-status count read (read.server.ts lists one tab at a time), so counts are NOT pinned here; the writer lists the gap in the notes (no invented numbers).
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { ToastProvider } from '@lims/ui/components/Toast';
import { expectEmptyState, expectFilterBars, expectHeader, expectTable } from '@/__tests__/uilist1.helpers';
import { ADMIN, DLV, NARR, ORIGIN, READ, REPORT, TPL, alert, centreContact, channelAccount, delivery, detail, msgTemplate, narrative, narrativeTemplate, outsourced, page as pageOf, settings, summary, templateDetail } from './c6-t31.fixtures';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/reporting',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
  redirect: (to: string) => { throw new Error(`NEXT_REDIRECT ${to}`); },
}));
vi.mock('server-only', () => ({}));
const session = vi.hoisted(() => ({ permissions: [] as string[] }));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: session.permissions, displayName: 'Synthetic Reporter', membershipId: '01950c12-0000-7000-8000-000000000900', tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => '/reporting',
}));
process.env['LIMS_ORIGIN_API'] = ORIGIN;
const ALL = [...ADMIN, 'reporting.outsourced.attach', 'reporting.narrative.write', 'reporting.template.manage', 'reporting.message_template.manage', 'reporting.settings.manage'];
session.permissions = ALL;

const R = `${ORIGIN}/v1/reporting`;
const CENTRES = { data: [{ id: '01a1a98a-ac40-7000-8000-000000000003', name: 'Synthetic Centre A1' }] };
const api = setupServer(
  http.get(`${R}/reports`, () => HttpResponse.json(pageOf([summary()]))),
  http.get(`${R}/critical-alerts`, () => HttpResponse.json(pageOf([alert()]))),
  http.get(`${R}/reports/:id`, () => HttpResponse.json(detail() as never)),
  http.get(`${R}/outsourced-items`, () => HttpResponse.json(pageOf([outsourced()]))),
  http.get(`${R}/narratives/:id`, () => HttpResponse.json(narrative() as never)),
  http.get(`${R}/narrative-templates`, () => HttpResponse.json(pageOf([narrativeTemplate()]))),
  http.get(`${R}/deliveries`, () => HttpResponse.json(pageOf([delivery()]))),
  http.get(`${R}/deliveries/:id`, () => HttpResponse.json(delivery({ attempts: [] }) as never)),
  http.get(`${R}/report-templates`, () => HttpResponse.json(pageOf([{ id: TPL, family: 'laboratory', name: 'Synthetic lab template', is_active: true, version: 3 }]))),
  http.get(`${R}/report-templates/:id`, () => HttpResponse.json(templateDetail() as never)),
  http.get(`${R}/message-templates`, () => HttpResponse.json({ data: [msgTemplate()] })),
  http.get(`${R}/channel-accounts`, () => HttpResponse.json({ data: [channelAccount()] })),
  http.get(`${R}/settings`, () => HttpResponse.json(settings() as never)),
  http.get(`${R}/centre-contacts`, () => HttpResponse.json({ data: [centreContact()] })),
  http.get(`${R}/coded-sets/:set`, () => HttpResponse.json({ data: [] })),
  http.get(`${ORIGIN}/v1/identity/centres`, () => HttpResponse.json(CENTRES)),
  http.get(`${ORIGIN}/*`, () => HttpResponse.json(pageOf([]))),
);
beforeAll(() => api.listen({ onUnhandledFrame: 'error' }));
afterEach(() => { cleanup(); api.resetHandlers(); session.permissions = ALL; });
afterAll(() => api.close());

const P = (o: Record<string, unknown> = {}) => ({ params: Promise.resolve(o), searchParams: Promise.resolve({}) }) as never;
const show = async (file: string, props: unknown = P()) => {
  const mod = await import(/* @vite-ignore */ `../../../app/(staff)/reporting/${file}.tsx`);
  return render(<ToastProvider>{await (mod.default as (p: never) => Promise<never>)(props as never)}</ToastProvider>);
};
const txt = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
/** The critical alerts panel also lists the synthetic registration no., so wait for at least one match. */
const ready = () => screen.findAllByText('R2611050001');

describe('/reporting worklist is the Front-desk worklist look', () => {
  it('title, one caption line under it saying reports are found by registration number or barcode or by a status', async () => {
    const { container } = await show('page');
    await ready();
    expectHeader(container, '/reporting', { noAction: true });
    const cap = container.querySelector('.lims-page-header .lims-page-caption');
    expect(cap, 'PageHeader caption line').not.toBeNull();
    expect(txt(cap)).toMatch(/registration (no\.|number)/i);
    expect(txt(cap)).toMatch(/barcode/i);
    expect(txt(cap)).toMatch(/status/i);
    expect(container.querySelector('h1')!.nextElementSibling, 'the caption sits right under the title').toBe(cap);
  });

  it('one Tabs tablist with the six statuses, Ready to release selected (the unchanged default)', async () => {
    const { container } = await show('page');
    await ready();
    const lists = container.querySelectorAll('[role="tablist"]');
    expect(lists.length, 'exactly one tab bar (Tabs)').toBe(1);
    const tabs = [...lists[0]!.querySelectorAll('[role="tab"]')];
    expect(tabs.map((t) => txt(t).replace(/\s*\d+\+?$/, ''))).toEqual(['Awaiting content', 'Ready to release', 'Held (dues)', 'Render failed', 'Released today', 'All']);
    const on = tabs.filter((t) => t.getAttribute('aria-selected') === 'true');
    expect(on.length).toBe(1);
    expect(txt(on[0]).replace(/\s*\d+\+?$/, '')).toBe('Ready to release');
    expect(container.querySelectorAll('.lims-tabs').length, 'Tabs is the kit part').toBe(1);
  });

  it('ONE FilterBar in the tab panel: lookup, status, centre, family, registered from and to, review flag, Clear filters', async () => {
    const { container } = await show('page');
    await ready();
    expectFilterBars(container, '/reporting', 1);
    const bar = container.querySelector('.lims-filter-bar') as HTMLElement;
    expect(bar.closest('.lims-tabpanel'), 'the FilterBar sits inside the Tabs panel (mock: tabs above, filter row, table)').not.toBeNull();
    expect(screen.getByLabelText(/registration no\. or barcode/i)).toBeTruthy();
    for (const l of [/status/i, /centre/i, /family/i, /review flag/i]) expect(within(bar).getAllByText(l).length, String(l)).toBeGreaterThan(0);
    expect(within(bar).getAllByText(/registered/i).length).toBeGreaterThan(0);
    expect([...bar.querySelectorAll('button')].map(txt), 'reset button reads Clear filters').toContain('Clear filters');
    expect(bar.querySelectorAll('input[name="registered_from"], input[name="registered_to"]').length, 'registered from and to').toBeGreaterThanOrEqual(2);
  });

  it('no rows: header row drawn in the scroll box, ONE EmptyState in the body, caption and tabs stay', async () => {
    api.use(http.get(`${R}/reports`, () => HttpResponse.json(pageOf([]))));
    const { container } = await show('page');
    await screen.findByText(/no reports are ready to release/i);
    expectHeader(container, '/reporting', { noAction: true });
    expectTable(container, '/reporting', { min: 6, headers: ['Reg no', 'Patient', 'Centre', 'Status'] });
    expectEmptyState(container, '/reporting', { title: /no reports/i });
    expect(container.querySelector('.lims-page-caption')).not.toBeNull();
    expect(container.querySelectorAll('[role="tablist"]').length).toBe(1);
  });

  it('a row shows its status as a StatusChip (dot and word) and the registration number as a link in the mono family', async () => {
    const { container } = await show('page');
    await ready();
    const link = [...container.querySelectorAll('a')].find((a) => txt(a) === 'R2611050001');
    expect(link, 'the registration no. is a link').toBeTruthy();
    expect(link!.className).toMatch(/lims-mono/);
    const chip = container.querySelector('tbody .lims-chip, [role="row"] .lims-chip');
    expect(chip, 'StatusChip in the row').not.toBeNull();
    expect(txt(chip).length, 'a word, not colour alone').toBeGreaterThan(0);
    expect(chip!.getAttribute('data-tone')).toBeTruthy();
  });

  it('display only: a read-only user sees no selection column and no Release button', async () => {
    session.permissions = READ;
    const { container } = await show('page');
    await ready();
    expect(container.querySelectorAll('input[type="checkbox"]').length).toBe(0);
    expect([...container.querySelectorAll('button')].map(txt).filter((t) => /^Release/.test(t))).toEqual([]);
  });
});

describe('/reporting/reports/[report_id]: Card title rows, Timeline, StatusChip, the same buttons per permission', () => {
  const props = P({ report_id: REPORT });
  it('Report, Items, Versions, Deliveries are Card title rows, versions are a Timeline, status a StatusChip', async () => {
    const { container } = await show('reports/[report_id]/page', props);
    await screen.findByText(/^Versions$/);
    const heads = [...container.querySelectorAll('.lims-card-head .lims-card-title')].map(txt);
    for (const h of ['Report', 'Items', 'Versions', 'Deliveries']) expect(heads, h).toContain(h);
    expect([...container.querySelectorAll('h2, h3, h4')].filter((h) => !h.classList.contains('lims-card-title') && !h.closest('[role="dialog"], .lims-state')).map(txt), 'no raw heading outside a Card title').toEqual([]);
    expect(container.querySelectorAll('.lims-timeline').length, 'versions are drawn by Timeline').toBeGreaterThanOrEqual(1);
    expect(container.querySelectorAll('ol.lims-list, ul.lims-list, ul.rpt-chips').length, 'no hand-built lists').toBe(0);
    expect(container.querySelectorAll('.lims-chip').length, 'StatusChip').toBeGreaterThanOrEqual(1);
    expect(container.querySelectorAll('h1').length).toBe(1);
  });
  it('buttons for the full permission set: Release, Print, Download and the more menu stay; read only: none of Release, Print', async () => {
    const full = await show('reports/[report_id]/page', props);
    await screen.findByText(/^Versions$/);
    const names = [...full.container.querySelectorAll('button, a')].map(txt);
    expect(names.some((n) => /^Release/.test(n)), 'Release').toBe(true);
    expect(names.some((n) => /^Print/.test(n)), 'Print').toBe(true);
    expect(names.some((n) => /^Download/.test(n))).toBe(true);
    cleanup();
    session.permissions = READ;
    const ro = await show('reports/[report_id]/page', props);
    await screen.findByText(/^Versions$/);
    const roNames = [...ro.container.querySelectorAll('button')].map(txt);
    expect(roNames.some((n) => /^Release/.test(n)), 'no Release').toBe(false);
    expect(roNames.some((n) => /^Print/.test(n)), 'no Print').toBe(false);
  });
});

describe('every reporting page: no raw heading or list structure in the rendered DOM (LD-439 a, rule 7)', () => {
  const CASES: Array<[string, string, unknown]> = [
    ['/reporting', 'page', P()],
    ['/reporting/reports/[report_id]', 'reports/[report_id]/page', P({ report_id: REPORT })],
    ['/reporting/deliveries', 'deliveries/page', P()],
    ['/reporting/deliveries/[delivery_id]', 'deliveries/[delivery_id]/page', P({ delivery_id: DLV })],
    ['/reporting/messages', 'messages/page', P()],
    ['/reporting/narratives/[narrative_id]', 'narratives/[narrative_id]/page', P({ narrative_id: NARR })],
    ['/reporting/outsourced', 'outsourced/page', P()],
    ['/reporting/settings', 'settings/page', P()],
    ['/reporting/templates', 'templates/page', P()],
    ['/reporting/templates/[template_id]', 'templates/[template_id]/page', P({ template_id: TPL })],
  ];
  it.each(CASES)('%s', async (_route, file, props) => {
    const { container } = await show(file, props);
    await new Promise((r) => setTimeout(r, 50));
    expect(container.querySelectorAll('h1').length, 'one h1, from PageHeader').toBe(1);
    expect(container.querySelector('h1')!.closest('.lims-page-header'), 'h1 in PageHeader').not.toBeNull();
    const rawHeads = [...container.querySelectorAll('h2, h3, h4')].filter((h) => !h.classList.contains('lims-card-title') && !h.classList.contains('lims-state-title') && !h.closest('[role="dialog"], .lims-drawer, .lims-state, .lims-action-list'));
    expect(rawHeads.map(txt), 'every h2 to h4 is a Card title (or sits in a kit part)').toEqual([]);
    expect(container.querySelectorAll('ul.lims-list, ol.lims-list, ul.lims-plain-list, ul.rpt-chips').length, 'no hand-built list structure').toBe(0);
  });
});
