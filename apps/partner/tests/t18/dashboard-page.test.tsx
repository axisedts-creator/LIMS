// C13.T18 — PH-1 Home (dashboard) component tests, rendered to static markup (no jsdom in this package; T05 harness: fake next/*, fetch fake for the API).
// ACs: US-14.1 (tiles: submitted today, in lab, reported today, rejected = "New sample needed", new reports, open pickups, outstanding; each tile links to the filtered list),
//      US-14.2 (no data -> every tile 0 + onboarding empty state "Create your first manifest"), 04-UI-UX PH-1, 03-APP-FLOW §6 states (loading / error), LD-140 (design system), REQ-SEC-088/098.
// LEAD DECISION LD-140 (cited): feature code builds only from @lims/ui components and tokens; no hex colours, no inline style objects; one primary button per page; every status shows tone, icon and word.
// SEAMS (spec fixes the screen, not the files; the writer follows them or disputes):
//  - Page: apps/partner/src/app/(app)/page.tsx (02-TRD §3.6 tree; NOTE the T01 placeholder src/app/page.tsx also claims "/" and tests/scaffold.test.ts requires it: the writer must dispute/resolve that, not this file), default export = (async) server component, called with {} / {searchParams}.
//    Segment states: (app)/loading.tsx (LoadingSkeleton variant page), (app)/error.tsx (client error boundary, props {error, reset}, ErrorState with retry).
//  - Data: BFF partnerApi GETs /v1/partners/dashboard (A2), /v1/partners/me (A1: tenant.display_name = "{lab name}"), /v1/partners/manifests?limit=5 (PM-1 list: "Recent manifests", 5 rows). Nothing else.
//  - Tiles are @lims/ui StatTile (markup: lims-stat-label / lims-stat-value, <a href> for app-relative links). Outstanding = MoneyText lakh format ("Rs. 1,23,456.78") + "as of {time}" when outstanding_as_of exists.
//  - Tile hrefs (list filters of 02-TRD §5.2: O1 tracking_status, R1 is_new): In lab -> /orders?tracking_status=in_lab; Reported today -> /orders?tracking_status=reported; New sample needed ->
//    /orders?tracking_status=action_needed; New reports -> /reports?is_new=true; Submitted today -> /manifests*; Open pickups -> /pickups*; Outstanding -> /statements*. (* extra params allowed.)
//  - Empty state = counts all 0 AND no manifests (EmptyState title "Welcome", body "Create your first manifest to send samples to {lab name}.", action "New manifest").
//  - Not asserted (spec gap / not renderable here): 2-col / 4-col grid, 320 px reflow, Alt+W shortcut, warning-tone colour, real-browser focus order.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTH, JWT, installFetch, json, reply, resetApi, resolved, restoreFetch, seen, setEnv } from '../t05/harness';

vi.mock('server-only', () => ({}));
vi.mock('next/headers', async () => (await import('../t05/harness')).headersMock);
vi.mock('next/navigation', async () => ({
  ...(await import('../t05/harness')).navigationMock,
  useRouter: () => ({ push() {}, replace() {}, refresh() {} }),
  usePathname: () => '/',
}));
vi.mock('next/link', () => ({ default: ({ href, children, ...rest }: { href: string; children?: unknown }) => createElement('a', { href, ...rest }, children as never) }));

const APP = join(__dirname, '..', '..', 'src');
const LAB = 'Synthetic Lab Alpha';
const urls: string[] = [];

const DASH = { submitted_today: 5, in_lab: 3, reported_today: 2, rejected_open: 2, new_reports: 3, open_pickups: 4, outstanding: { amount_paisa: 12345678, currency: 'NPR' }, outstanding_as_of: '2026-11-13T05:10:00.000Z' };
const ZERO = { submitted_today: 0, in_lab: 0, reported_today: 0, rejected_open: 0, new_reports: 0, open_pickups: 0 };
const manifestRow = (n: number, o: Record<string, unknown> = {}) => ({ id: `01940e00-0000-7000-8000-c13180000${String(n).padStart(3, '0')}`, manifest_no: `MF2600000${n}`, state: 'submitted', line_count: 3, lines_converted: 0, lines_failed: 0,
  created_at: '2026-11-12T05:00:00.000Z', submitted_at: '2026-11-12T06:00:00.000Z', ...o });
const MANIFESTS = { data: [1, 2, 3, 4, 5].map((n) => manifestRow(n)), page: { limit: 5 } };
const ctxBody = (lab = LAB) => ({ partner: { id: '01940e00-0000-7000-8000-c13180000900', name: 'Synthetic Partner X' }, tenant: { display_name: lab, calendar_display: 'bs', timezone: 'Asia/Kathmandu' }, permissions: ['partners.order.read'] });

function serve(o: { dash?: unknown | Response; manifests?: unknown; lab?: string } = {}) {
  reply[`${AUTH}/session/resolve`] = () => json(200, resolved('active'));
  reply['/v1/partners/dashboard'] = () => (o.dash instanceof Response ? o.dash : json(200, o.dash ?? DASH));
  reply['/v1/partners/me'] = () => json(200, ctxBody(o.lab));
  reply['/v1/partners/manifests'] = () => json(200, o.manifests ?? MANIFESTS);
}
async function render(): Promise<string> {
  const mod = (await import('../../src/app/(app)/page')) as { default: (p: unknown) => unknown };
  return renderToStaticMarkup((await mod.default({ searchParams: Promise.resolve({}) })) as never);
}
const decode = (s: string) => s.replace(/&amp;/g, '&').replace(/&#x27;/g, "'");
const chunks = (html: string) => html.split(/(?=<(?:a|div) class="lims-stat(?: |"))/);
const tile = (html: string, label: string) => chunks(html).find((c) => c.includes(`lims-stat-label">${label}<`));
const value = (html: string, label: string) => /lims-stat-value">([^<]*)</.exec(tile(html, label) ?? '')?.[1];
const href = (html: string, label: string) => { const c = tile(html, label); const m = c && /^<a [^>]*href="([^"]*)"/.exec(c); return m ? decode(m[1]!) : undefined; };
const LABELS = ['Submitted today', 'In lab', 'Reported today', 'New sample needed', 'New reports', 'Open pickups', 'Outstanding'];
const primaries = (html: string) => (html.match(/lims-btn-primary/g) ?? []).length;

beforeAll(async () => {
  setEnv();
  installFetch();
  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => { urls.push(new Request(input as never, init).url); return inner(input, init); }) as typeof fetch;
});
afterAll(() => restoreFetch());
beforeEach(() => { resetApi(); urls.length = 0; });

describe('PH-1 tiles with data (US-14.1)', () => {
  it('title "Home" and the seven tiles in the specified order with the API values', async () => {
    serve();
    const html = await render();
    expect(html).toContain('Home');
    const pos = LABELS.map((l) => html.indexOf(`lims-stat-label">${l}<`));
    for (const [i, p] of pos.entries()) expect(p, LABELS[i]).toBeGreaterThan(-1);
    expect([...pos].sort((a, b) => a - b)).toEqual(pos);
    expect(value(html, 'Submitted today')).toBe('5');
    expect(value(html, 'In lab')).toBe('3');
    expect(value(html, 'Reported today')).toBe('2');
    expect(value(html, 'New sample needed')).toBe('2');
    expect(value(html, 'New reports')).toBe('3');
    expect(value(html, 'Open pickups')).toBe('4');
  });
  it('Outstanding uses lakh grouping (Rs. 1,23,456.78) with "as of" its sync time', async () => {
    serve();
    const t = tile(await render(), 'Outstanding')!;
    expect(t).toContain('1,23,456.78');
    expect(t).toMatch(/as of/i);
  });
  it('without outstanding in the response the Outstanding tile is still shown, with no "as of"', async () => {
    serve({ dash: ZERO, manifests: { data: [manifestRow(1)], page: { limit: 5 } } });
    const html = await render();
    expect(tile(html, 'Outstanding')).toBeDefined();
    expect(tile(html, 'Outstanding')!).not.toMatch(/as of/i);
  });
  it('each tile links to its filtered list (app-relative links)', async () => {
    serve();
    const html = await render();
    const u = (l: string) => new URL(href(html, l) ?? 'x:invalid', 'https://p.test');
    expect(href(html, 'In lab')).toMatch(/^\/orders\?/); expect(u('In lab').searchParams.get('tracking_status')).toBe('in_lab');
    expect(u('Reported today').pathname).toBe('/orders'); expect(u('Reported today').searchParams.get('tracking_status')).toBe('reported');
    expect(u('New sample needed').pathname).toBe('/orders'); expect(u('New sample needed').searchParams.get('tracking_status')).toBe('action_needed');
    expect(u('New reports').pathname).toBe('/reports'); expect(u('New reports').searchParams.get('is_new')).toBe('true');
    expect(u('Submitted today').pathname).toBe('/manifests');
    expect(u('Open pickups').pathname).toBe('/pickups');
    expect(u('Outstanding').pathname).toBe('/statements');
    for (const l of LABELS) expect(href(html, l), l).toMatch(/^\/(?!\/)/);
  });
  it('"New sample needed" shows a warning tone only when > 0 (tone is not colour alone: the label word stays)', async () => {
    serve();
    const warn = (h: string) => { const c = tile(h, 'New sample needed') ?? ''; const i = h.indexOf(c); return /warning/.test(h.slice(Math.max(0, i - 120), i) + c); }; // marker on the tile or on a wrapper right before it
    expect(warn(await render())).toBe(true);
    serve({ dash: { ...DASH, rejected_open: 0 } });
    expect(warn(await render())).toBe(false);
  });
});

describe('PH-1 recent manifests + primary action', () => {
  it('lists up to 5 recent manifests (request limit=5) with number and state word; exactly one primary "New manifest" action', async () => {
    serve();
    const html = await render();
    expect(html).toContain('Recent manifests');
    for (const n of [1, 2, 3, 4, 5]) expect(html).toContain(`MF2600000${n}`);
    expect(html).toMatch(/Submitted/);
    expect(html).toContain('New manifest');
    expect(primaries(html)).toBeLessThanOrEqual(1);
    const call = urls.find((x) => new URL(x).pathname === '/v1/partners/manifests')!;
    expect(new URL(call).searchParams.get('limit')).toBe('5');
    expect(html).not.toContain('Welcome');
  });
  it('zero counts but existing manifests -> no onboarding empty state; tiles show 0', async () => {
    serve({ dash: ZERO, manifests: { data: [manifestRow(1, { state: 'draft', submitted_at: undefined })], page: { limit: 5 } } });
    const html = await render();
    expect(html).not.toContain('Welcome');
    expect(value(html, 'In lab')).toBe('0');
    expect(html).toContain('MF26000001');
  });
});

describe('PH-1 empty state (US-14.2)', () => {
  it('no data: every count tile shows 0 and the "Welcome" empty state offers "New manifest" with the lab name; one primary button only', async () => {
    serve({ dash: ZERO, manifests: { data: [], page: { limit: 5 } } });
    const html = await render();
    for (const l of LABELS.slice(0, 6)) expect(value(html, l), l).toBe('0');
    expect(tile(html, 'Outstanding')).toBeDefined();
    expect(html).toContain('Welcome');
    expect(html).toContain(`Create your first manifest to send samples to ${LAB}.`);
    expect(html).toContain('New manifest');
    expect(primaries(html)).toBe(1);
  });
});

describe('PH-1 failure, loading, error boundary', () => {
  it('dashboard API 500: no tiles with made-up zeros; either the page throws (error.tsx) or renders an ErrorState; no token / upstream body in the output', async () => {
    serve({ dash: json(500, { code: 'common.internal', status: 500, title: 'common.internal', detail: 'UPSTREAM-SECRET-DETAIL' }) });
    const out = await render().then((h) => ({ html: h, err: undefined as unknown }), (e) => ({ html: '', err: e as Error }));
    if (out.err) { expect(String(out.err)).not.toMatch(/UPSTREAM-SECRET-DETAIL|eyJ/); } else {
      expect(out.html).toContain('data-tone="danger"');
      expect(out.html).not.toContain('lims-stat-label');
      expect(out.html).not.toContain('UPSTREAM-SECRET-DETAIL');
    }
  });
  it('loading.tsx renders LoadingSkeleton (aria-busy status)', async () => {
    const p = join(APP, 'app', '(app)', 'loading.tsx');
    expect(existsSync(p), p).toBe(true);
    const mod = (await import('../../src/app/(app)/loading')) as { default: () => unknown };
    const html = renderToStaticMarkup(createElement(mod.default as never));
    expect(html).toContain('aria-busy="true"');
  });
  it('error.tsx renders an ErrorState with a retry button and never prints the error message', async () => {
    const p = join(APP, 'app', '(app)', 'error.tsx');
    expect(existsSync(p), p).toBe(true);
    const mod = (await import('../../src/app/(app)/error')) as { default: (p: unknown) => unknown };
    const err = Object.assign(new Error('PLANTED-INTERNAL-MESSAGE patient Binita'), { digest: 'abc123' });
    const html = renderToStaticMarkup(createElement(mod.default as never, { error: err, reset: () => undefined }));
    expect(html).toContain('data-tone="danger"');
    expect(html).toMatch(/<button/);
    expect(html).not.toContain('PLANTED-INTERNAL-MESSAGE');
    expect(html).not.toContain('Binita');
  });
});

describe('PH-1 security (REQ-SEC-088 / REQ-SEC-098) and design-system rules (LD-140)', () => {
  it('only the three BFF reads are made (GET, no query other than limit on manifests); the access token never reaches the markup', async () => {
    serve();
    const html = await render();
    const paths = seen.filter((s) => !s.path.startsWith(AUTH));
    expect(new Set(paths.map((s) => s.path))).toEqual(new Set(['/v1/partners/dashboard', '/v1/partners/me', '/v1/partners/manifests']));
    for (const s of paths) expect(s.method).toBe('GET');
    expect(html).not.toContain(JWT);
    expect(html).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
  });
  it('lab name and manifest numbers are escaped (no HTML injection)', async () => {
    serve({ dash: ZERO, manifests: { data: [], page: { limit: 5 } }, lab: '<img src=x onerror=alert(1)>' });
    const html = await render();
    expect(html).not.toContain('<img src=x');
    serve({ manifests: { data: [manifestRow(1, { manifest_no: '<script>alert(1)</script>' })], page: { limit: 5 } } });
    expect(await render()).not.toContain('<script>alert');
  });
  it('the dashboard lives at src/app/(app)/page.tsx (02-TRD §3.6)', () => {
    expect(existsSync(join(APP, 'app', '(app)', 'page.tsx'))).toBe(true);
  });
  it('feature code: no hex colours, no inline style objects, no raw HTML injection (LD-140)', () => {
    const files: string[] = [];
    const walk = (d: string) => { for (const n of readdirSync(d)) { const p = join(d, n); statSync(p).isDirectory() ? walk(p) : /\.(tsx?|css)$/.test(n) && files.push(p); } };
    for (const d of [join(APP, 'app', '(app)'), join(APP, 'features', 'dashboard')]) if (existsSync(d)) walk(d);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      expect(src, f).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(src, f).not.toMatch(/style=\{\{|style=\{[a-zA-Z]/);
      expect(src, f).not.toMatch(/dangerouslySetInnerHTML/);
      expect(src, f).not.toMatch(/console\.(log|info|debug)/);
    }
  });
});
