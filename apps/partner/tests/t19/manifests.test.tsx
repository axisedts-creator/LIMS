// C13.T19 — PM-1 Manifests, PM-2 draft editor, PM-3 manifest detail, PM-4 print view (04-UI-UX §3), rendered to static markup (T05 harness; no jsdom in this package).
// ACs: US-04.1 (draft + number), US-04.2 (line list), US-04.4/04.5 (submit needs >= 1 line; submit confirm), US-04.7 (submitted = read-only), US-04.9/04.10 (withdraw only when allowed), US-05.1 (print view columns), US-05.2 (other partner -> 404), ST16 (XSS inert).
// SEAMS (spec fixes the screens, not the files):
//  - Pages (Next 16, props {params: Promise, searchParams: Promise}): (app)/manifests/page.tsx, (app)/manifests/[manifest_id]/page.tsx (draft -> PM-2, else PM-3), (app)/manifests/[manifest_id]/print/page.tsx.
//  - Data: PM-1 GET /v1/partners/manifests (only whitelisted query params are forwarded); PM-2/PM-3 GET /v1/partners/manifests/{id} + GET /v1/partners/me (features.conversion_mode, tenant); PM-4 GET .../print-view + /me (lab name).
//  - Detail-link for "Request pickup" is /pickups/new?manifest_id={id}; print link is /manifests/{id}/print.
//  - Not asserted here (needs a browser; see tests/e2e/partner-screens.spec.ts): line form in the Drawer, Alt+A/Alt+S, ConfirmDialogs, ErrorSummary, beforeunload guard.
import { createElement } from 'react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTH } from '../t05/harness';
import { LAB, PARTNER, attempt, boot, buttons, calls, chipTone, failing, headers, helpKey, hrefs, id, line, manifest, mf, primaries, renderPage, resetApi, restoreFetch, seen, serve, title, urls } from './kit';

vi.mock('server-only', () => ({}));
vi.mock('next/headers', async () => (await import('../t05/harness')).headersMock);
vi.mock('next/navigation', async () => ({ ...(await import('../t05/harness')).navigationMock, useRouter: () => ({ push() {}, replace() {}, refresh() {} }), usePathname: () => '/manifests', useSearchParams: () => new URLSearchParams() }));
vi.mock('next/link', () => ({ default: ({ href, children, ...rest }: { href: string; children?: unknown }) => createElement('a', { href, ...rest }, children as never) }));

beforeAll(boot);
afterAll(restoreFetch);
beforeEach(() => { resetApi(); urls.length = 0; });

const list = (rows: unknown[]) => ({ data: rows, page: { limit: 50 } });
const SIX = [mf(1, { state: 'draft', submitted_at: undefined }), mf(2, { state: 'submitted' }), mf(3, { state: 'partially_received' }), mf(4, { state: 'received' }), mf(5, { state: 'withdrawn' }), mf(6, { state: 'discarded' })];

describe('PM-1 Manifests', () => {
  it('title, helpKey, filter labels and the specified columns', async () => {
    serve({ '/v1/partners/manifests': list(SIX) });
    const html = await renderPage('manifests');
    expect(title(html)).toBe('Manifests');
    expect(helpKey(html)).toMatch(/^partners\.[a-z_.]+$/);
    for (const l of ['State', 'Created']) expect(html).toContain(l);
    for (const h of ['Manifest no.', 'State', 'Samples', 'Registered', 'Needs lab check', 'Submitted', 'Pickup']) expect(headers(html), h).toContain(h);
    expect(html).toMatch(/<caption|aria-label="[^"]*[Mm]anifests/); // every table has a caption (04-UI-UX §7)
  });
  it('state chips carry word + tone (draft/withdrawn/discarded neutral, submitted/partly info, received success)', async () => {
    serve({ '/v1/partners/manifests': list(SIX) });
    const html = await renderPage('manifests');
    expect(chipTone(html, 'Draft')).toBe('neutral');
    expect(chipTone(html, 'Submitted')).toBe('info');
    expect(chipTone(html, 'Partly received')).toBe('info');
    expect(chipTone(html, 'Received')).toBe('success');
    expect(chipTone(html, 'Withdrawn')).toBe('neutral');
    expect(chipTone(html, 'Discarded')).toBe('neutral');
  });
  it('rows link to the manifest (draft and non-draft use /manifests/{id}); "Needs lab check" shows a warning badge only when lines_failed > 0', async () => {
    serve({ '/v1/partners/manifests': list([mf(1, { state: 'draft' }), mf(2, { lines_failed: 2 })]) });
    const html = await renderPage('manifests');
    expect(hrefs(html)).toEqual(expect.arrayContaining([`/manifests/${id(1, 100)}`, `/manifests/${id(2, 100)}`]));
    expect(html).toContain('MF2600001');
    expect(html).toMatch(/lims-tone-warning/);
    serve({ '/v1/partners/manifests': list([mf(1, { lines_failed: 0 })]) });
    expect(await renderPage('manifests')).not.toMatch(/lims-tone-warning/);
  });
  it('forwards only whitelisted filters to the API (state csv, created_at_from/to, sort, cursor); drops unknown params and non-enum sorts', async () => {
    serve({ '/v1/partners/manifests': list([]) });
    await renderPage('manifests', {}, { state: 'submitted,received', created_at_from: '2026-10-01', created_at_to: '2026-11-01', sort: '-submitted_at', cursor: 'abc', evil: '1', 'x[y]': '2' });
    const q = calls('/v1/partners/manifests')[0]!.searchParams;
    expect(q.get('state')).toBe('submitted,received');
    expect(q.get('created_at_from')).toBe('2026-10-01');
    expect(q.get('sort')).toBe('-submitted_at');
    expect(q.get('cursor')).toBe('abc');
    expect(q.has('evil')).toBe(false);
    urls.length = 0;
    await renderPage('manifests', {}, { sort: '-patient_name; DROP TABLE' });
    expect(['-created_at', '-submitted_at', null]).toContain(calls('/v1/partners/manifests')[0]!.searchParams.get('sort'));
  });
  it('empty: "No manifests yet." with a "New manifest" action; at most one primary button', async () => {
    serve({ '/v1/partners/manifests': list([]) });
    const html = await renderPage('manifests');
    expect(html).toContain('No manifests yet.');
    expect(html).toContain('New manifest');
    expect(primaries(html)).toBeLessThanOrEqual(1);
  });
  it('API failure: ErrorState (danger tone) and no upstream detail', async () => {
    serve({ '/v1/partners/manifests': failing(500) });
    const o = await attempt('manifests');
    if (o.err) expect(String(o.err)).not.toMatch(/UPSTREAM-SECRET-DETAIL|eyJ/);
    else { expect(o.html).toContain('data-tone="danger"'); expect(o.html).not.toContain('UPSTREAM-SECRET-DETAIL'); }
  });
  it('manifest numbers are escaped (ST16)', async () => {
    serve({ '/v1/partners/manifests': list([mf(1, { manifest_no: '<script>alert(1)</script>' })]) });
    expect(await renderPage('manifests')).not.toContain('<script>alert');
  });
});

describe('PM-2 draft editor (US-04.1/04.2/04.4)', () => {
  const lines = [
    line(1, { priority: 'urgent', orderables: ['CBC', 'LFT', 'RFT', 'TSH'].map((c, i) => ({ orderable_id: id(i, 120), kind: 'test', code: c, name: `Test ${c}` })) }),
    line(2, { patient: { full_name: 'Synthetic Patient 2', sex: 'male', age_years: 7 } }),
  ];
  const draft = (ls = lines, o: Record<string, unknown> = {}) => manifest(1, ls, { state: 'draft', submitted_at: undefined, ...o });
  const P = { manifest_id: id(1, 100) };

  it('header: title with the number, collection date + notes fields with the D-102 helper text; reads only the manifest and /me', async () => {
    serve({ [`/v1/partners/manifests/${P.manifest_id}`]: draft() });
    const html = await renderPage('manifests/[manifest_id]', P);
    expect(title(html)).toBe('Manifest MF2600001');
    expect(helpKey(html)).toMatch(/^partners\.[a-z_.]+$/);
    expect(html).toContain('Collection date');
    expect(html).toContain('Notes for the lab');
    expect(html).toContain('Shown to the receiving lab staff; not part of the lab order or the report');
    expect(html).toMatch(/maxlength="500"/i);
    for (const s of seen.filter((s) => !s.path.startsWith(AUTH))) expect(s.method).toBe('GET');
  });
  it('lines list: #, ref, patient with sex/age, truncated tests, Urgent badge only on the urgent line', async () => {
    serve({ [`/v1/partners/manifests/${P.manifest_id}`]: draft() });
    const html = await renderPage('manifests/[manifest_id]', P);
    for (const h of ['#', 'Sample ref', 'Patient', 'Tests', 'Priority', 'Doctor']) expect(headers(html), h).toContain(h);
    expect(html).toContain('REF-001');
    expect(html).toContain('Synthetic Patient 1');
    expect(html).toMatch(/F 43 y/);
    expect(html).toMatch(/M 7 y/);
    expect(html).toMatch(/CBC[^]*\+[1-9]/); // truncated "+N" after the first codes
    expect(html).not.toContain('TSH,'); // not every code is listed in full
    expect((html.match(/>Urgent</g) ?? []).length).toBe(1);
  });
  it('footer actions: exactly one primary ("Submit manifest"), "Add sample" is secondary; Submit is disabled with 0 lines and enabled with lines', async () => {
    serve({ [`/v1/partners/manifests/${P.manifest_id}`]: draft([]) });
    let html = await renderPage('manifests/[manifest_id]', P);
    const submit = buttons(html).find((b) => b.text.includes('Submit manifest'));
    expect(submit, 'Submit manifest button').toBeDefined();
    expect(submit!.attrs).toMatch(/disabled/);
    expect(buttons(html).find((b) => b.text.includes('Add sample'))!.attrs).not.toMatch(/lims-btn-primary/);
    expect(primaries(html)).toBe(1);
    serve({ [`/v1/partners/manifests/${P.manifest_id}`]: draft() });
    html = await renderPage('manifests/[manifest_id]', P);
    expect(buttons(html).find((b) => b.text.includes('Submit manifest'))!.attrs).not.toMatch(/disabled/);
    expect(primaries(html)).toBe(1);
  });
  it('a draft shows no "Withdraw", "Print" or "Request pickup" action (those belong to PM-3)', async () => {
    serve({ [`/v1/partners/manifests/${P.manifest_id}`]: draft() });
    const html = await renderPage('manifests/[manifest_id]', P);
    expect(html).not.toContain('Withdraw');
    expect(hrefs(html).some((h) => h.includes('/print') || h.includes('/pickups/new'))).toBe(false);
  });
  it('another partner / unknown id: 404 -> not found, nothing of the body is rendered (US-15.1)', async () => {
    serve({ [`/v1/partners/manifests/${P.manifest_id}`]: failing(404, 'common.not_found') });
    const o = await attempt('manifests/[manifest_id]', P);
    expect(String(o.err ?? o.html)).toMatch(/NEXT_NOT_FOUND|not found|no longer available/i);
    expect(String(o.err ?? o.html)).not.toContain('UPSTREAM-SECRET-DETAIL');
  });
  it('stored script in patient name / notes renders inert (ST16)', async () => {
    serve({ [`/v1/partners/manifests/${P.manifest_id}`]: draft([line(1, { patient: { full_name: '<img src=x onerror=alert(1)>', sex: 'male', age_years: 1 } })], { notes: '<script>alert(2)</script>' }) });
    const html = await renderPage('manifests/[manifest_id]', P);
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>alert');
  });
});

describe('PM-3 manifest detail (US-04.7/04.9/04.10)', () => {
  const P = { manifest_id: id(1, 100) };
  const LINES = [
    line(1, { state: 'submitted' }), line(2, { state: 'converting' }), line(3, { state: 'conversion_failed', failure: { code: 'catalog.no_price', message_key: 'partners.inbox.failure.catalog.no_price' } }),
    line(4, { state: 'not_received' }), line(5, { state: 'converted', order: { order_id: id(5, 200), registration_no: '0001SY000105' } }),
  ];
  const serveM = (o: Record<string, unknown> = {}, lines = LINES, meO: Parameters<typeof serve>[1] = {}) => serve({ [`/v1/partners/manifests/${P.manifest_id}`]: manifest(1, lines, o) }, meO);

  it('title, status chip, DescriptionList terms and the lines columns', async () => {
    serveM();
    const html = await renderPage('manifests/[manifest_id]', P);
    expect(title(html)).toBe('Manifest MF2600001');
    expect(chipTone(html, 'Submitted')).toBe('info');
    for (const t of ['Receiving centre', 'Submitted', 'Received', 'Pickup state', 'Notes']) expect(html, t).toContain(t);
    expect(html).toContain('Synthetic Centre');
    for (const h of ['#', 'Sample ref', 'Patient', 'Tests', 'Status', 'Registration no.', 'Updated']) expect(headers(html), h).toContain(h);
  });
  it('line status uses the partner wording (03-APP-FLOW §3) and never the failure code', async () => {
    serveM();
    const html = await renderPage('manifests/[manifest_id]', P);
    for (const w of ['Waiting for lab', 'Registering', 'Lab is checking this sample', 'Not received']) expect(html, w).toContain(w);
    expect(html).not.toContain('catalog.no_price');
    expect(html).not.toContain('partners.inbox.failure');
  });
  it('a registered line links its registration no. to the order (PO-2)', async () => {
    serveM();
    const html = await renderPage('manifests/[manifest_id]', P);
    expect(hrefs(html)).toContain(`/orders/${id(5, 200)}`);
    expect(html).toContain('0001SY000105');
  });
  it('actions: Print -> /manifests/{id}/print; Request pickup -> /pickups/new?manifest_id={id} only when submitted and not on an open pickup', async () => {
    serveM({}, [line(1, { state: 'submitted' })]);
    let html = await renderPage('manifests/[manifest_id]', P);
    expect(hrefs(html)).toContain(`/manifests/${id(1, 100)}/print`);
    const pk = hrefs(html).find((h) => h.startsWith('/pickups/new'));
    expect(pk && new URL(pk, 'https://p.test').searchParams.get('manifest_id')).toBe(id(1, 100));
    serveM({ pickup_request_id: id(1, 400) }, [line(1, { state: 'submitted' })]);
    html = await renderPage('manifests/[manifest_id]', P);
    expect(hrefs(html).some((h) => h.startsWith('/pickups/new'))).toBe(false);
    serveM({ state: 'received' }, [line(1, { state: 'converted', order: { order_id: id(1, 200), registration_no: 'R1' } })]);
    html = await renderPage('manifests/[manifest_id]', P);
    expect(hrefs(html).some((h) => h.startsWith('/pickups/new'))).toBe(false);
  });
  it('Withdraw: only submitted + mode on_receipt + nothing registered (US-04.9 / 04.10 / D-104)', async () => {
    const withdraw = async (o: Record<string, unknown>, lines: unknown[], mode: 'on_receipt' | 'on_submit') => { serveM(o, lines, { mode }); return buttons(await renderPage('manifests/[manifest_id]', P)).some((b) => b.text === 'Withdraw'); };
    const fresh = [line(1, { state: 'submitted' }), line(2, { state: 'submitted' })];
    expect(await withdraw({ lines_converted: 0 }, fresh, 'on_receipt')).toBe(true);
    expect(await withdraw({ lines_converted: 0 }, fresh, 'on_submit')).toBe(false);
    expect(await withdraw({ lines_converted: 1 }, [line(1, { state: 'converted', order: { order_id: id(1, 200), registration_no: 'R1' } })], 'on_receipt')).toBe(false);
    expect(await withdraw({ state: 'withdrawn' }, fresh, 'on_receipt')).toBe(false);
    expect(await withdraw({ state: 'received' }, fresh, 'on_receipt')).toBe(false);
  });
  it('at most one primary button; no write call is made while rendering', async () => {
    serveM();
    const html = await renderPage('manifests/[manifest_id]', P);
    expect(primaries(html)).toBeLessThanOrEqual(1);
    for (const s of seen.filter((s) => !s.path.startsWith(AUTH))) expect(s.method).toBe('GET');
  });
  it('words never used on partner screens: commission / invoice (04-UI-UX §6)', async () => {
    serveM();
    expect(await renderPage('manifests/[manifest_id]', P)).not.toMatch(/commission|invoice/i);
  });
});

describe('PM-4 print view (US-05.1/05.2)', () => {
  const P = { manifest_id: id(1, 100) };
  const PV = { manifest: manifest(1, [line(1, { state: 'submitted', priority: 'urgent' }), line(2, { state: 'submitted' })], { state: 'submitted' }), partner: { name: PARTNER, partner_code: 'SPX' }, receiving_centre: { name: 'Synthetic Centre', code: 'SC1' }, printed_at: '2026-11-13T05:00:00.000Z' };
  it('header (lab, "Sample manifest", number, partner + code, centre), the specified columns with th scope, a Received tick column and the hand-over footer', async () => {
    serve({ [`/v1/partners/manifests/${P.manifest_id}/print-view`]: PV });
    const html = await renderPage('manifests/[manifest_id]/print', P);
    for (const t of [LAB, 'Sample manifest', 'MF2600001', PARTNER, 'SPX', 'Synthetic Centre', 'Handed over by', 'Received by', 'Time']) expect(html, t).toContain(t);
    for (const h of ['#', 'Sample ref', 'Patient name', 'Sex/Age', 'Tests', 'Priority', 'Collected at', 'Received']) expect(headers(html), h).toContain(h);
    expect(html).toMatch(/<th[^>]*scope="col"/);
    expect((html.match(/☐/g) ?? []).length).toBe(2);
    expect(html).toContain('Print'); // button calling window.print()
  });
  it('draft/discarded (409) and another partner (404) render no manifest data', async () => {
    for (const [st, code] of [[409, 'partners.manifest_invalid_transition'], [404, 'common.not_found']] as const) {
      serve({ [`/v1/partners/manifests/${P.manifest_id}/print-view`]: failing(st, code) });
      const o = await attempt('manifests/[manifest_id]/print', P);
      const text = String(o.err ?? o.html);
      expect(text).not.toMatch(/Synthetic Patient|UPSTREAM-SECRET-DETAIL/);
    }
  });
  it('print stylesheet: A4 portrait, 12 mm margins, black on white (kit tokens only, no hex colours)', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');
    const css: string[] = [];
    const walk = (d: string) => { for (const n of readdirSync(d)) { const p = join(d, n); statSync(p).isDirectory() ? walk(p) : n.endsWith('.css') && css.push(readFileSync(p, 'utf8')); } };
    walk(join(__dirname, '..', '..', 'src'));
    const all = css.join('\n');
    expect(all).toMatch(/@page[^}]*size:\s*A4\s+portrait/i);
    expect(all).toMatch(/@page[^}]*margin:\s*12mm/i);
    expect(all).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
  it('XSS: stored script in patient name is inert on the print view (ST16)', async () => {
    const pv = { ...PV, manifest: manifest(1, [line(1, { state: 'submitted', patient: { full_name: '<script>alert(1)</script>', sex: 'male', age_years: 3 } })]) };
    serve({ [`/v1/partners/manifests/${P.manifest_id}/print-view`]: pv });
    expect(await renderPage('manifests/[manifest_id]/print', P)).not.toContain('<script>alert');
  });
});
