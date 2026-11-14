// C13.T19 — partner shell, per-segment states (loading / error), 320 px reflow + "cards on phones" seams, LD-140 source rules, PHI/browser-storage rules for every screen.
// ACs: US-16.1 (320 CSS px, no horizontal page scroll — the CSS part is checked by the T22 axe/E2E scans; here the structural half), 04-UI-UX §1.1 (shell, filtered nav), §7 (captions, cards keep the row-header first),
//      02-TRD §3.6 (each segment: page.tsx, loading.tsx, error.tsx), 03-APP-FLOW §6 (states), REQ-SEC-088/098, ST14/ST16, LD-140.
// SEAMS (spec fixes behaviour, not file names; the writer follows or disputes):
//  - Shell = src/app/(app)/layout.tsx default export (server component, props {children}); reads GET /v1/partners/me. Links: Home /, Manifests /manifests, Samples /orders, Reports /reports, Pickups /pickups, Prices /price-list,
//    Statements /statements, Doctors /referrers, Users /users. Filter: Reports needs partners.report.read, Prices partners.price_list.read, Statements partners.statement.read, Doctors partners.referrer.read, Users partners.partner_user.manage.
//    Phones: Tabs bottom bar (Home, Manifests, Samples, Reports, More).  Suspended partner (403 partners.partner_inactive from /me) -> full-page ErrorState, no nav, no children.
//  - Cards on phones: every list screen renders its rows ALSO as a card list inside an element with data-view="cards" (kit Card per row, row-header field first); the table is hidden below md by kit CSS classes (hideBelow).
//  - Optional columns use DataTable hideBelow (lims-hide-below-md|lg) exactly as 04-UI-UX lists them.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { LAB, PARTNER, settle, boot, failing, hrefs, id, line, manifest, me, mf, order, renderPage, report, resetApi, restoreFetch, serve, urls } from './kit';

vi.mock('server-only', () => ({}));
vi.mock('next/headers', async () => (await import('../t05/harness')).headersMock);
vi.mock('next/navigation', async () => ({ ...(await import('../t05/harness')).navigationMock, useRouter: () => ({ push() {}, replace() {}, refresh() {} }), usePathname: () => '/', useSearchParams: () => new URLSearchParams() }));
vi.mock('next/link', () => ({ default: ({ href, children, ...rest }: { href: string; children?: unknown }) => createElement('a', { href, ...rest }, children as never) }));

beforeAll(boot);
afterAll(restoreFetch);
beforeEach(() => { resetApi(); urls.length = 0; });

const SRC = join(__dirname, '..', '..', 'src');
const APP = join(SRC, 'app', '(app)');
const SEGMENTS = ['manifests', 'orders', 'reports', 'pickups', 'price-list', 'statements', 'referrers', 'users', 'account'];
const PAGES = ['manifests/[manifest_id]', 'manifests/[manifest_id]/print', 'orders/[order_id]', 'reports/[report_id]', 'pickups/new', 'statements/[period_month]'];

describe('partner shell (04-UI-UX §1.1)', () => {
  const layout = async () => {
    const mod = (await import('../../src/app/(app)/layout.tsx')) as { default: (p: { children: unknown }) => unknown };
    return renderToStaticMarkup((await mod.default({ children: createElement('p', null, 'CHILD-MARK') })) as never);
  };
  it('shows the lab and partner names, the children, the nav links and a phone Tabs bar ending in "More"', async () => {
    serve({});
    const html = await layout();
    expect(html).toContain('CHILD-MARK');
    expect(html).toContain(LAB);
    expect(html).toContain(PARTNER);
    for (const h of ['/', '/manifests', '/orders', '/reports', '/pickups', '/price-list', '/statements', '/referrers', '/users']) expect(hrefs(html), h).toContain(h);
    expect(html).toMatch(/role="tablist"/);
    expect(html).toContain('More');
    expect(html).toContain('lims-shell'); // built from PageShell, not hand-rolled markup
  });
  it('entries are filtered by permissions: a member has no Users; missing report/price/statement/referrer permissions hide those entries', async () => {
    serve({}, { role: 'partner_member' });
    expect(hrefs(await layout())).not.toContain('/users');
    serve({}, { perms: ['partners.order.read', 'partners.manifest.submit'] });
    const h = hrefs(await layout());
    for (const gone of ['/reports', '/price-list', '/statements', '/referrers', '/users']) expect(h, gone).not.toContain(gone);
    for (const kept of ['/', '/manifests', '/orders']) expect(h, kept).toContain(kept);
  });
  it('suspended partner / inactive user (403 partners.partner_inactive): full-page ErrorState, no nav, no children', async () => {
    serve({ '/v1/partners/me': failing(403, 'partners.partner_inactive') });
    const out = await settle(layout());
    const text = String(out.err ?? out.html);
    expect(text).not.toContain('CHILD-MARK');
    expect(text).not.toContain('UPSTREAM-SECRET-DETAIL');
    if (!out.err) { expect(out.html).toContain('data-tone="danger"'); expect(hrefs(out.html)).not.toContain('/manifests'); }
  });
  it('lab / partner names are escaped', async () => {
    serve({ '/v1/partners/me': me({ lab: '<img src=x onerror=alert(1)>', name: '<script>alert(2)</script>' }) });
    const html = await layout();
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>alert');
  });
});

describe('every screen has its states (02-TRD §3.6, 03-APP-FLOW §6)', () => {
  it.each(SEGMENTS)('segment %s: page.tsx + loading.tsx + error.tsx exist', (seg) => {
    for (const f of ['page.tsx', 'loading.tsx', 'error.tsx']) expect(existsSync(join(APP, seg, f)), `${seg}/${f}`).toBe(true);
  });
  it.each(PAGES)('page %s exists', (p) => { expect(existsSync(join(APP, p, 'page.tsx')), p).toBe(true); });
  it('PR-3 loading state is the "detail" skeleton (04-UI-UX PR-3)', () => {
    const p = join(APP, 'reports', '[report_id]', 'loading.tsx');
    expect(existsSync(p), p).toBe(true);
    expect(readFileSync(p, 'utf8')).toMatch(/variant=["']detail["']/);
  });
  it.each(SEGMENTS)('segment %s: loading renders an aria-busy skeleton; error renders ErrorState with retry and never the error message', async (seg) => {
    const load = (await import(/* @vite-ignore */ `../../src/app/(app)/${seg}/loading.tsx`)) as { default: () => unknown };
    expect(renderToStaticMarkup(createElement(load.default as never))).toContain('aria-busy="true"');
    const err = (await import(/* @vite-ignore */ `../../src/app/(app)/${seg}/error.tsx`)) as { default: (p: unknown) => unknown };
    const html = renderToStaticMarkup(createElement(err.default as never, { error: Object.assign(new Error('PLANTED-INTERNAL-MESSAGE patient Binita'), { digest: 'abc123' }), reset: () => undefined }));
    expect(html).toContain('data-tone="danger"');
    expect(html).toMatch(/<button/);
    expect(html).not.toContain('PLANTED-INTERNAL-MESSAGE');
    expect(html).not.toContain('Binita');
  });
});

describe('320 px reflow + cards on phones (US-16.1, 04-UI-UX §7)', () => {
  const list = (rows: unknown[], extra: Record<string, unknown> = {}) => ({ data: rows, page: { limit: 50 }, ...extra });
  const SCREENS: { rel: string; first: string; hide: ('md' | 'lg')[]; map: Record<string, unknown> }[] = [
    { rel: 'manifests', first: 'MF2600001', hide: ['md', 'lg'], map: { '/v1/partners/manifests': list([mf(1)]) } },
    { rel: 'orders', first: '0001SY000101', hide: ['md', 'lg'], map: { '/v1/partners/orders': list([order(1)]), '/v1/partners/manifests': list([]), '/v1/partners/referrers': list([]) } },
    { rel: 'reports', first: 'Synthetic Patient 1', hide: [], map: { '/v1/partners/reports': list([report(1)]) } },
    { rel: 'pickups', first: 'MF2600001', hide: ['md'], map: { '/v1/partners/pickup-requests': list([{ id: id(1, 400), state: 'requested', window_start: '2026-11-14T05:00:00.000Z', window_end: '2026-11-14T08:00:00.000Z', packages_count: 2, manifests: [{ id: id(1, 100), manifest_no: 'MF2600001' }], created_at: '2026-11-13T05:00:00.000Z', version: 1 }]) } },
    { rel: 'price-list', first: 'T1', hide: ['md', 'lg'], map: { '/v1/partners/price-list': list([{ orderable_id: id(1, 120), kind: 'test', code: 'T1', name: 'Synthetic test', department_name: 'Haematology', unit_price: { amount_paisa: 100, currency: 'NPR' }, source: 'partner', price_list_version: 1, effective_from: '2026-10-01' }], { price_list_version: 1, synced_at: '2026-11-13T04:00:00.000Z' }) } },
    { rel: 'referrers', first: 'Dr Synthetic 1', hide: ['md'], map: { '/v1/partners/referrers': list([{ id: id(1, 500), display_name: 'Dr Synthetic 1', is_active: true, mapping_state: 'unmapped', samples_this_month: 1, version: 1 }]) } },
    { rel: 'users', first: 'Synthetic User 1', hide: [], map: { '/v1/partners/users': list([{ id: id(1, 600), display_name: 'Synthetic User 1', email_masked: 'u***@example.test', partner_role: 'partner_member', status: 'active', mfa_enrolled: false, version: 1 }]) } },
  ];
  it.each(SCREENS)('$rel: rows also render as cards (data-view="cards") with the row-header field first; optional columns hide below md/lg; the table has a caption', async ({ rel, first, hide, map }) => {
    serve(map);
    const html = await renderPage(rel);
    const cards = /data-view="cards"[^>]*>([^]*)/.exec(html)?.[1];
    expect(cards, 'a data-view="cards" container').toBeDefined();
    expect(cards!).toContain(first);
    expect(cards!).toContain('lims-card');
    expect(html).toContain('lims-table');
    expect(html).toMatch(/<caption|<table[^>]*aria-label="[^"]+"|<div[^>]*role="grid"[^>]*aria-label="[^"]+"/);
    for (const h of hide) expect(html, `hide-below-${h}`).toContain(`lims-hide-below-${h}`);
  });
  it('detail screens collapse to one column (kit Grid/Stack only; no fixed-width tables): sample + manifest detail render a single description list, not a wide table', async () => {
    serve({ [`/v1/partners/manifests/${id(1, 100)}`]: manifest(1, [line(1, { state: 'submitted' })]) });
    const html = await renderPage('manifests/[manifest_id]', { manifest_id: id(1, 100) });
    expect(html).toContain('lims-dl');
    expect(html).toContain('data-view="cards"');
  });
});

describe('LD-140 + browser-storage + PHI-in-URL rules for all T19 code (REQ-SEC-088/098, ST14/ST16)', () => {
  const files = () => {
    const out: string[] = [];
    const walk = (d: string) => { for (const n of readdirSync(d)) { const p = join(d, n); statSync(p).isDirectory() ? walk(p) : /\.(tsx?|css)$/.test(n) && out.push(p); } };
    walk(APP);
    const feat = join(SRC, 'features');
    if (existsSync(feat)) walk(feat);
    return out;
  };
  const code = (f: string) => readFileSync(f, 'utf8').replace(/\/\*[^]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''); // comments may mention forbidden words
  it('there is feature code for the screens (not just the dashboard)', () => {
    expect(files().filter((f) => /(manifests|orders|reports|pickups|price-list|statements|referrers|users|account)/.test(f)).length).toBeGreaterThan(8);
  });
  it('no hex colours, pixel radii, inline style objects, raw HTML injection, eval or console logging (LD-140)', () => {
    for (const f of files()) {
      const s = code(f);
      expect(s, f).not.toMatch(/#[0-9a-fA-F]{3,8}\b(?![-\w])/);
      expect(s, f).not.toMatch(/border-radius:\s*\d+px/);
      expect(s, f).not.toMatch(/style=\{\{|style=\{[a-zA-Z]/);
      expect(s, f).not.toMatch(/dangerouslySetInnerHTML|\beval\(|new Function\(/);
      expect(s, f).not.toMatch(/console\.(log|info|debug)/);
    }
  });
  it('one primary button per page: no file declares two variant="primary" buttons in the same component', () => {
    for (const f of files().filter((x) => x.endsWith('.tsx'))) expect((readFileSync(f, 'utf8').match(/variant=["']primary["']/g) ?? []).length, f).toBeLessThanOrEqual(2); // a conditional pair (e.g. empty vs filled) is the most one file may hold
  });
  it('nothing is written to localStorage / sessionStorage / document.cookie; no token handling in client code (ST14, 02-TRD §3.7)', () => {
    for (const f of files()) {
      const s = code(f);
      if (/lims\.partner\.density/.test(s)) continue; // the single permitted non-PHI UI preference
      expect(s, f).not.toMatch(/localStorage|sessionStorage|document\.cookie|indexedDB/);
      if (/^\s*['"]use client['"]/m.test(s)) expect(s, f).not.toMatch(/access_token|accessToken|Authorization|Bearer/);
    }
  });
  it('no PHI is put into URLs by the code: no router.push / href / redirect template with a patient name, search term or phone (REQ-SEC-098)', () => {
    for (const f of files().filter((x) => x.endsWith('.tsx') || x.endsWith('.ts'))) {
      const s = code(f);
      expect(s, f).not.toMatch(/(push|replace|redirect)\(\s*[`'"][^`'"]*\?[^`'"]*(\bq=|name=|patient|phone|full_name)/i);
      expect(s, f).not.toMatch(/\/orders\/search\?|searchPartnerOrders[^;]*\?q=/);
    }
  });
  it('patient search posts through the BFF: some client code calls POST /api/bff/.../orders/search with the term in the body', () => {
    const hit = files().find((f) => /orders\/search/.test(code(f)));
    expect(hit, 'a file that posts to orders/search').toBeDefined();
    expect(code(hit!)).toMatch(/method:\s*['"]POST['"]/);
    expect(code(hit!)).toMatch(/JSON\.stringify\(\s*\{\s*q/);
  });
  it('screens never print the failure code of a manifest line or an upstream error body', () => {
    for (const f of files().filter((x) => x.endsWith('.tsx'))) expect(code(f), f).not.toMatch(/\.failure\??\.code|problem\.detail|\.problem\?*\.title|error\.message/);
  });
});
