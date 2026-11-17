// C13.T19 — PO-1 Samples, PO-2 Sample detail, PR-1 Reports, PR-3 Report versions (04-UI-UX §3), static-markup component tests (T05 harness).
// ACs: US-07.1/07.5 (tracking words + rejected -> "A new sample is needed"), US-07.6 (list only own orders), US-07.8 (patient search = POST body, never the URL; REQ-SEC-098), US-08.1 ("New"),
//      US-08.2/08.4 (download buttons; Released/Superseded), US-16.1 (cards on phones, see responsive.test.tsx), ST16 (XSS inert).
// SEAMS: pages (app)/orders/page.tsx, (app)/orders/[order_id]/page.tsx, (app)/reports/page.tsx, (app)/reports/[report_id]/page.tsx (the existing app/reports/[report_id]/slip stays PR-2).
//  - List data: GET /v1/partners/orders | /reports; query params = the API names of 02-TRD §5.2 (tracking_status csv, manifest_id, referrer_id, registered_at_from/to, has_new_report, sort | released_at_from/to, is_new, include_superseded) as page searchParams; others dropped.
//  - PO-1 may also read /v1/partners/manifests (Manifest filter) and /v1/partners/referrers (Doctor filter); never POST /orders/search while rendering. The search box is a client form that POSTs via the BFF.
//  - PR-3: R1 has no report_id filter (spec gap, 02-TRD §5.2 R1): the page reads GET /v1/partners/reports?include_superseded=true and keeps only rows whose report_id matches; no row -> "This report is no longer available."
//  - Download controls carry aria-label "Download report version {n} for registration {registration_no}" (04-UI-UX §7).
import { createElement } from 'react';
import { AUTH } from '../t05/harness';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { attempt, boot, calls, chipTone, failing, headers, helpKey, hrefs, id, order, primaries, renderPage, report, resetApi, restoreFetch, seen, serve, title, urls } from './kit';

vi.mock('server-only', () => ({}));
vi.mock('next/headers', async () => (await import('../t05/harness')).headersMock);
vi.mock('next/navigation', async () => ({ ...(await import('../t05/harness')).navigationMock, useRouter: () => ({ push() {}, replace() {}, refresh() {} }), usePathname: () => '/orders', useSearchParams: () => new URLSearchParams() }));
vi.mock('next/link', () => ({ default: ({ href, children, ...rest }: { href: string; children?: unknown }) => createElement('a', { href, ...rest }, children as never) }));

beforeAll(boot);
afterAll(restoreFetch);
beforeEach(() => { resetApi(); urls.length = 0; });
const list = (rows: unknown[]) => ({ data: rows, page: { limit: 50 } });
const aria = (html: string, re: RegExp) => [...html.matchAll(/aria-label="([^"]*)"/g)].map((m) => m[1]!).filter((a) => re.test(a));

describe('PO-1 Samples (US-07.1/07.5/07.6/07.8)', () => {
  const STATUSES: [string, string, string][] = [['registered', 'Registered', 'neutral'], ['in_transit', 'On the way to lab', 'info'], ['in_lab', 'In lab', 'info'], ['action_needed', 'New sample needed', 'warning'], ['partially_reported', 'Partly reported', 'info'], ['reported', 'Report ready', 'success'], ['cancelled', 'Cancelled by lab', 'danger']];
  const rows = STATUSES.map(([s], i) => order(i + 1, { tracking_status: s, has_new_report: s === 'reported' }));
  it('title, helpKey, search box + button, filter labels, and the specified columns', async () => {
    serve({ '/v1/partners/orders': list(rows), '/v1/partners/manifests': list([]), '/v1/partners/referrers': list([]) });
    const html = await renderPage('orders');
    expect(title(html)).toBe('Samples');
    expect(helpKey(html)).toMatch(/^partners\.[a-z_.]+$/);
    expect(html).toContain('Search by patient name, your reference or registration no.');
    expect(html).toMatch(/>Search</);
    for (const l of ['Status', 'Manifest', 'Doctor', 'Registered', 'Only with new reports']) expect(html, l).toContain(l);
    for (const h of ['Registration no.', 'Patient', 'Status', 'Registered', 'New report']) expect(headers(html), h).toContain(h);
  });
  it('each tracking status shows its word and tone (never colour alone)', async () => {
    serve({ '/v1/partners/orders': list(rows), '/v1/partners/manifests': list([]), '/v1/partners/referrers': list([]) });
    const html = await renderPage('orders');
    for (const [, word, tone] of STATUSES) expect(chipTone(html, word), word).toBe(tone);
  });
  it('rows link to /orders/{id}; the "New" badge shows only for orders with a new report', async () => {
    serve({ '/v1/partners/orders': list([order(1, { has_new_report: true }), order(2)]), '/v1/partners/manifests': list([]), '/v1/partners/referrers': list([]) });
    const html = await renderPage('orders');
    expect(hrefs(html)).toEqual(expect.arrayContaining([`/orders/${id(1, 200)}`, `/orders/${id(2, 200)}`]));
    expect((html.match(/>New</g) ?? []).length).toBe(1);
  });
  it('dashboard tile links work: tracking_status / has_new_report are forwarded; unknown params and non-enum sorts are not', async () => {
    serve({ '/v1/partners/orders': list([]), '/v1/partners/manifests': list([]), '/v1/partners/referrers': list([]) });
    await renderPage('orders', {}, { tracking_status: 'in_lab,reported', has_new_report: 'true', manifest_id: id(1, 100), registered_at_from: '2026-11-01', sort: '-last_event_at', evil: '1' });
    const q = calls('/v1/partners/orders')[0]!.searchParams;
    expect(q.get('tracking_status')).toBe('in_lab,reported');
    expect(q.get('has_new_report')).toBe('true');
    expect(q.get('manifest_id')).toBe(id(1, 100));
    expect(q.get('registered_at_from')).toBe('2026-11-01');
    expect(q.get('sort')).toBe('-last_event_at');
    expect(q.has('evil')).toBe(false);
  });
  it('US-07.8 / REQ-SEC-098: a patient name in the page URL is never forwarded and never triggers a search while rendering; the search form does not submit by GET', async () => {
    serve({ '/v1/partners/orders': list([]), '/v1/partners/manifests': list([]), '/v1/partners/referrers': list([]), '/v1/partners/orders/search': list([]) });
    const html = await renderPage('orders', {}, { q: 'Binita Sharma', search: 'Binita Sharma', name: 'Binita' });
    expect(urls.join(' ')).not.toMatch(/Binita/i);
    expect(JSON.stringify(seen.map((s) => s.body))).not.toMatch(/Binita/i);
    expect(seen.some((s) => s.path === '/v1/partners/orders/search')).toBe(false);
    expect(html).not.toMatch(/<form[^>]*method="get"/i);
  });
  it('empty list shows an EmptyState, not an empty table; at most one primary button', async () => {
    serve({ '/v1/partners/orders': list([]), '/v1/partners/manifests': list([]), '/v1/partners/referrers': list([]) });
    const html = await renderPage('orders');
    expect(html).toContain('lims-state');
    expect(primaries(html)).toBeLessThanOrEqual(1);
  });
  it('API failure: ErrorState with no upstream detail', async () => {
    serve({ '/v1/partners/orders': failing(500), '/v1/partners/manifests': list([]), '/v1/partners/referrers': list([]) });
    const o = await attempt('orders');
    if (o.err) expect(String(o.err)).not.toMatch(/UPSTREAM-SECRET-DETAIL|eyJ/);
    else { expect(o.html).toContain('data-tone="danger"'); expect(o.html).not.toContain('UPSTREAM-SECRET-DETAIL'); }
  });
  it('patient names are escaped (ST16)', async () => {
    serve({ '/v1/partners/orders': list([order(1, { patient: { full_name: '<img src=x onerror=alert(1)>', sex: 'male' } })]), '/v1/partners/manifests': list([]), '/v1/partners/referrers': list([]) });
    expect(await renderPage('orders')).not.toContain('<img src=x');
  });
});

describe('PO-2 Sample detail (US-07.1/07.5, US-08.4)', () => {
  const P = { order_id: id(1, 200) };
  const spec = (n: number, o: Record<string, unknown> = {}) => ({ specimen_id: id(n, 210), specimen_type_code: 'SERUM', specimen_type_display: `Serum ${n}`, status: 'received', ...o });
  const detail = (o: Record<string, unknown> = {}) => ({
    ...order(1, { tracking_status: 'in_lab', referrer: { display_name: 'Dr Synthetic' } }), orderables: [{ code: 'CBC', name: 'Complete blood count' }, { code: 'LFT', name: 'Liver function' }],
    specimens: [spec(1, { collected_at: '2026-11-12T04:00:00.000Z', in_transit_at: '2026-11-12T05:00:00.000Z', received_at: '2026-11-12T06:00:00.000Z' })], reports: [], timeline: [], ...o,
  });
  const go = (d: unknown, meO: Parameters<typeof serve>[1] = {}) => { serve({ [`/v1/partners/orders/${P.order_id}`]: d }, meO); return renderPage('orders/[order_id]', P); };

  it('header "Registration {no}", status chip, description terms and the manifest link', async () => {
    const html = await go(detail());
    expect(title(html)).toBe('Registration 0001SY000101');
    expect(chipTone(html, 'In lab')).toBe('info');
    for (const t of ['Patient name', 'Sex/Age', 'Your ref', 'Manifest no.', 'Doctor', 'Priority', 'Tests']) expect(html, t).toContain(t);
    expect(hrefs(html)).toContain(`/manifests/${id(1, 100)}`);
    expect(html).toContain('Dr Synthetic');
    expect(html).toContain('Complete blood count');
    expect(helpKey(html)).toMatch(/^partners\.[a-z_.]+$/);
  });
  it('specimen card: type, status chip and only the timeline steps that have happened (Collected, Sent to lab, Received at lab)', async () => {
    const html = await go(detail({ specimens: [spec(1, { collected_at: '2026-11-12T04:00:00.000Z', in_transit_at: '2026-11-12T05:00:00.000Z', received_at: '2026-11-12T06:00:00.000Z' }), spec(2, { status: 'collected', collected_at: '2026-11-12T04:00:00.000Z' })] }));
    expect(html).toContain('Serum 1');
    expect(html).toContain('Serum 2');
    for (const w of ['Collected', 'Sent to lab', 'Received at lab']) expect(html, w).toContain(w);
    expect((html.match(/Received at lab/g) ?? []).length).toBe(1);
    expect((html.match(/Sent to lab/g) ?? []).length).toBe(1);
    expect((html.match(/>Collected</g) ?? []).length).toBe(3); // 04-UI-UX:124 — chip "Collected" (specimen 2) + two Timeline steps
  });
  it('US-07.5: a rejected specimen shows "Rejected", the humanised reason (danger tone) and "A new sample is needed" while no replacement is received', async () => {
    const rejected = spec(1, { status: 'rejected', rejected_at: '2026-11-12T07:00:00.000Z', rejection_reason_code: 'haemolysed', rejection_reason_display: 'Haemolysed' });
    let html = await go(detail({ tracking_status: 'action_needed', specimens: [rejected] }));
    expect(html).toContain('Rejected');
    expect(html).toContain('Haemolysed');
    expect(html).toContain('A new sample is needed');
    expect(chipTone(html, 'New sample needed')).toBe('warning');
    html = await go(detail({ tracking_status: 'in_lab', specimens: [rejected, spec(2, { status: 'received', received_at: '2026-11-13T06:00:00.000Z', replaces_specimen_id: id(1, 210) })] }));
    expect(html).toContain('Replaced by new sample');
    expect(html).not.toContain('A new sample is needed');
  });
  it('no specimens yet: "The lab has not labelled this sample yet."', async () => {
    expect(await go(detail({ specimens: [] }))).toContain('The lab has not labelled this sample yet.');
  });
  it('reports section: versions with kind, Released/Superseded chips, panel names, accessible download names; slip button only with the feature on', async () => {
    const reports = [report(1, { version_no: 2, panel_names: ['Lipid panel'] }), report(1, { version_no: 1, status: 'superseded', panel_names: ['Lipid panel'] })];
    let html = await go(detail({ tracking_status: 'reported', reports }));
    expect(chipTone(html, 'Released')).toBe('success');
    expect(chipTone(html, 'Superseded')).toBe('neutral');
    expect(html).toContain('Lipid panel');
    expect(aria(html, /^Download report version/)).toEqual(expect.arrayContaining(['Download report version 2 for registration 0001SY000101', 'Download report version 1 for registration 0001SY000101']));
    expect(html).toContain('Download PDF');
    expect(html).toContain('Print patient slip');
    html = await go(detail({ tracking_status: 'reported', reports }), { slips: false });
    expect(html).not.toContain('Print patient slip');
    expect(html).toContain('Download PDF');
  });
  it('other partner / unknown order: 404 -> not found, no body data (US-15.1)', async () => {
    serve({ [`/v1/partners/orders/${P.order_id}`]: failing(404, 'common.not_found') });
    const o = await attempt('orders/[order_id]', P);
    expect(String(o.err ?? o.html)).toMatch(/NEXT_NOT_FOUND|not found|no longer available/i);
    expect(String(o.err ?? o.html)).not.toContain('UPSTREAM-SECRET-DETAIL');
  });
  it('stored script in the patient name / referrer renders inert (ST16); read-only page', async () => {
    const html = await go(detail({ patient: { full_name: '<script>alert(1)</script>', sex: 'male' }, referrer: { display_name: '<img src=x onerror=alert(2)>' } }));
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('<img src=x');
    for (const s of seen.filter((s) => !s.path.startsWith(AUTH))) expect(s.method).toBe('GET');
  });
});

describe('PR-1 Reports (US-08.1/08.2/08.4)', () => {
  const rows = [report(1, { version_no: 2, is_new: true, panel_names: ['Lipid panel', 'Liver panel'] }), report(2, { version_no: 1, status: 'superseded' })];
  it('title, filters, columns, New badge, version wording and linked rows', async () => {
    serve({ '/v1/partners/reports': list(rows) });
    const html = await renderPage('reports');
    expect(title(html)).toBe('Reports');
    expect(helpKey(html)).toMatch(/^partners\.[a-z_.]+$/);
    for (const l of ['Released', 'New only', 'Show older versions']) expect(html, l).toContain(l);
    for (const h of ['Patient', 'Registration no.', 'Report', 'Version', 'Released']) expect(headers(html), h).toContain(h);
    expect((html.match(/>New</g) ?? []).length).toBe(1);
    expect(html).toMatch(/v2/);
    expect(html).toMatch(/v1 · Superseded/);
    expect(html).toContain('Lipid panel');
    expect(hrefs(html)).toContain(`/reports/${id(1, 300)}`); // PR-3
  });
  it('Download / Patient slip actions: accessible names carry version + registration no.; slip only for current versions and when enabled', async () => {
    serve({ '/v1/partners/reports': list(rows) });
    let html = await renderPage('reports');
    expect(aria(html, /^Download/)).toEqual(expect.arrayContaining(['Download report version 2 for registration 0001SY000101', 'Download report version 1 for registration 0001SY000102']));
    expect((html.match(/Patient slip/g) ?? []).length).toBe(1); // v2 valid only; v1 superseded has none
    serve({ '/v1/partners/reports': list(rows) }, { slips: false });
    html = await renderPage('reports');
    expect(html).not.toContain('Patient slip');
  });
  it('filters map to API params: superseded hidden by default; is_new / include_superseded / released range forwarded; unknown params dropped', async () => {
    serve({ '/v1/partners/reports': list([]) });
    await renderPage('reports');
    expect(['false', null]).toContain(calls('/v1/partners/reports')[0]!.searchParams.get('include_superseded'));
    urls.length = 0;
    await renderPage('reports', {}, { is_new: 'true', include_superseded: 'true', released_at_from: '2026-11-01', released_at_to: '2026-11-13', evil: '1', sort: '-evil' });
    const q = calls('/v1/partners/reports')[0]!.searchParams;
    expect(q.get('is_new')).toBe('true');
    expect(q.get('include_superseded')).toBe('true');
    expect(q.get('released_at_from')).toBe('2026-11-01');
    expect(q.has('evil')).toBe(false);
    expect(['-released_at', null]).toContain(q.get('sort'));
  });
  it('empty: "No reports released yet."; failure: ErrorState without upstream detail', async () => {
    serve({ '/v1/partners/reports': list([]) });
    expect(await renderPage('reports')).toContain('No reports released yet.');
    serve({ '/v1/partners/reports': failing(500) });
    const o = await attempt('reports');
    if (o.err) expect(String(o.err)).not.toMatch(/UPSTREAM-SECRET-DETAIL|eyJ/);
    else { expect(o.html).toContain('data-tone="danger"'); expect(o.html).not.toContain('UPSTREAM-SECRET-DETAIL'); }
  });
  it('the signed URL / file location is never in the markup (downloads stream through the BFF); no JWT either', async () => {
    serve({ '/v1/partners/reports': list(rows) });
    const html = await renderPage('reports');
    expect(html).not.toMatch(/https?:\/\/[^"]*(signed|token|X-Amz|storage)/i);
    expect(html).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
    expect(hrefs(html).filter((h) => /\/file(\?|$)/.test(h)).every((h) => h.startsWith('/api/bff/reports/'))).toBe(true);
  });
});

describe('PR-3 Report versions (US-08.4; routes.yaml partner.report)', () => {
  const P = { report_id: id(1, 300) };
  const versions = [report(1, { version_no: 2, panel_names: ['Lipid panel'] }), report(1, { version_no: 1, status: 'superseded' }), report(2, { version_no: 1 })];
  it('title "Report for registration {no}", helpKey partners.report, registration link to PO-2, only this report\'s versions', async () => {
    serve({ '/v1/partners/reports': list(versions) });
    const html = await renderPage('reports/[report_id]', P);
    expect(title(html)).toBe('Report for registration 0001SY000101');
    expect(helpKey(html)).toBe('partners.report');
    for (const t of ['Patient name', 'Registration no.']) expect(html, t).toContain(t);
    expect(hrefs(html)).toContain(`/orders/${id(1, 200)}`);
    expect(html).not.toContain('0001SY000102'); // another report's row is not shown
    for (const h of ['Version', 'Kind', 'Panels', 'Released', 'Status']) expect(headers(html), h).toContain(h);
    expect(chipTone(html, 'Released')).toBe('success');
    expect(chipTone(html, 'Superseded')).toBe('neutral');
    expect(calls('/v1/partners/reports')[0]!.searchParams.get('include_superseded')).toBe('true');
  });
  it('actions: Download per version; "Patient slip" (-> /reports/{id}/slip) only on the current valid version and only when enabled', async () => {
    serve({ '/v1/partners/reports': list(versions) });
    let html = await renderPage('reports/[report_id]', P);
    expect(aria(html, /^Download/).length).toBe(2);
    expect((html.match(/Patient slip/g) ?? []).length).toBe(1);
    expect(hrefs(html)).toContain(`/reports/${id(1, 300)}/slip`);
    serve({ '/v1/partners/reports': list(versions) }, { slips: false });
    html = await renderPage('reports/[report_id]', P);
    expect(html).not.toContain('Patient slip');
  });
  it('unknown / other partner report: "This report is no longer available." and no data', async () => {
    serve({ '/v1/partners/reports': list([report(2)]) });
    const o = await attempt('reports/[report_id]', P);
    expect(String(o.err ?? o.html)).toMatch(/This report is no longer available\.|NEXT_NOT_FOUND/);
    expect(String(o.err ?? o.html)).not.toContain('0001SY000102');
  });
});
