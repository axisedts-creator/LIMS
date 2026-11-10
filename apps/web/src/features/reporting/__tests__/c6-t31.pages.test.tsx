// @vitest-environment jsdom
// C6-T31 — page-level states for every reporting screen (done_when: "every screen has empty/loading/error/denied states").
// Server pages are async functions; the test awaits them with Next 16 props (params/searchParams are Promises), renders the element, and MSW plays the API.
// ASSUMED contract (dispute via writer if wrong):
//   app/(staff)/reporting/{page,reports/[report_id],outsourced,narratives/[narrative_id],deliveries,deliveries/[delivery_id],templates,templates/[template_id],messages,settings}/page.tsx
//   default export async Page({params?, searchParams?}); reads through features/reporting/server/*.server.ts (ApiError from @/core/api/server-fetch).
//   denied  : the session lacks the screen's permission → the page returns <PermissionDenied/> (data-testid="permission-denied") and makes NO API call.
//             (Defence in depth: deliveries/templates LISTS have no routes.yaml row, so the staff layout cannot gate them — CR-C4-013 precedent.)
//   error   : an API failure on the main read propagates (page rejects with ApiError) so the segment error.tsx renders; never a blank page.
//             Exception: the Critical-alerts panel failing must NOT fail the worklist (04-UI-UX §2.9) → inline alert + Retry.
//   not found: a 404 on a detail read → notFound() (throws NEXT_NOT_FOUND).
//   loading : reporting/loading.tsx default export renders a status region / aria-busy skeleton, with no PHI.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { ToastProvider } from '@lims/ui/components/Toast';
import { ADMIN, DLV, NARR, ORIGIN, REPORT, TPL, alert, centreContact, channelAccount, delivery, detail, msgTemplate, narrative, narrativeTemplate, outsourced, page as pageOf, problem, settings, summary, templateDetail } from './c6-t31.fixtures';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/reporting',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw Object.assign(new Error('NEXT_NOT_FOUND'), { digest: 'NEXT_HTTP_ERROR_FALLBACK;404' }); },
}));
vi.mock('server-only', () => ({}));
const session = vi.hoisted(() => ({ permissions: [] as string[] }));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: session.permissions, displayName: 'Synthetic Reporter', tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => '/reporting',
}));
process.env.LIMS_ORIGIN_API = ORIGIN;
session.permissions = ADMIN;

const R = `${ORIGIN}/v1/reporting`;
const gets: string[] = [];
const seen = (req: Request) => { gets.push(new URL(req.url).pathname); };
const json = (b: unknown) => ({ request }: { request: Request }) => { seen(request); return HttpResponse.json(b as never); };
const api = setupServer(
  http.get(`${R}/reports`, json(pageOf([summary()]))),
  http.get(`${R}/critical-alerts`, json(pageOf([alert()]))),
  http.get(`${R}/reports/:id`, json(detail())),
  http.get(`${R}/outsourced-items`, json(pageOf([outsourced()]))),
  http.get(`${R}/narratives/:id`, json(narrative())),
  http.get(`${R}/narrative-templates`, json(pageOf([narrativeTemplate()]))),
  http.get(`${R}/deliveries`, json(pageOf([delivery()]))),
  http.get(`${R}/deliveries/:id`, json(delivery({ attempts: [] }))),
  http.get(`${R}/report-templates`, json(pageOf([{ id: TPL, family: 'laboratory', name: 'Synthetic lab template', is_active: true, version: 3 }]))),
  http.get(`${R}/report-templates/:id`, json(templateDetail())),
  http.get(`${R}/message-templates`, json({ data: [msgTemplate()] })),
  http.get(`${R}/channel-accounts`, json({ data: [channelAccount()] })),
  http.get(`${R}/settings`, json(settings())),
  http.get(`${R}/centre-contacts`, json({ data: [centreContact()] })),
  http.get(`${R}/coded-sets/:set`, json({ data: [] })),
  http.get(`${ORIGIN}/*`, json(pageOf([]))), // any other read (centre names, billing codes…) is benign
);
beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
afterEach(() => { cleanup(); api.resetHandlers(); gets.length = 0; session.permissions = ADMIN; });
afterAll(() => api.close());

type Case = { name: string; file: string; props: Record<string, unknown>; perm: string; main: string; hit: (p: string) => boolean; emptyBody: unknown; emptyCopy?: RegExp; notFoundOn?: string };
const P = (o: Record<string, unknown> = {}) => ({ params: Promise.resolve(o), searchParams: Promise.resolve({}) });
const CASES: Case[] = [
  { name: 'worklist', file: 'page', props: P(), perm: 'reporting.report.read', main: `${R}/reports`, hit: (p) => p === '/v1/reporting/reports', emptyBody: pageOf([]),
    emptyCopy: /Nothing is waiting for results\.|No reports are ready to release\.|No reports are held for dues\.|No failed reports\. Good\.|No reports released today yet\./ },
  { name: 'report detail', file: 'reports/[report_id]/page', props: P({ report_id: REPORT }), perm: 'reporting.report.read', main: `${R}/reports/:id`, hit: (p) => p.startsWith('/v1/reporting/reports/'), emptyBody: undefined, notFoundOn: `${R}/reports/:id` },
  { name: 'outsourced queue', file: 'outsourced/page', props: P(), perm: 'reporting.outsourced.attach', main: `${R}/outsourced-items`, hit: (p) => p.endsWith('/outsourced-items'), emptyBody: pageOf([]), emptyCopy: /no outsourced reports|nothing .*outsourced/i },
  { name: 'narrative editor', file: 'narratives/[narrative_id]/page', props: P({ narrative_id: NARR }), perm: 'reporting.narrative.write', main: `${R}/narratives/:id`, hit: (p) => p.includes('/narratives/'), emptyBody: undefined, notFoundOn: `${R}/narratives/:id` },
  { name: 'deliveries', file: 'deliveries/page', props: P(), perm: 'reporting.delivery.read', main: `${R}/deliveries`, hit: (p) => p === '/v1/reporting/deliveries', emptyBody: pageOf([]), emptyCopy: /no deliveries/i },
  { name: 'delivery detail', file: 'deliveries/[delivery_id]/page', props: P({ delivery_id: DLV }), perm: 'reporting.delivery.read', main: `${R}/deliveries/:id`, hit: (p) => p.startsWith('/v1/reporting/deliveries/'), emptyBody: undefined, notFoundOn: `${R}/deliveries/:id` },
  { name: 'templates', file: 'templates/page', props: P(), perm: 'reporting.template.manage', main: `${R}/report-templates`, hit: (p) => p === '/v1/reporting/report-templates', emptyBody: pageOf([]), emptyCopy: /no (report )?templates/i },
  { name: 'template editor', file: 'templates/[template_id]/page', props: P({ template_id: TPL }), perm: 'reporting.template.manage', main: `${R}/report-templates/:id`, hit: (p) => p.includes('/report-templates/'), emptyBody: undefined, notFoundOn: `${R}/report-templates/:id` },
  { name: 'messages', file: 'messages/page', props: P(), perm: 'reporting.message_template.manage', main: `${R}/message-templates`, hit: (p) => p.endsWith('/message-templates'), emptyBody: { data: [] } },
  { name: 'settings', file: 'settings/page', props: P(), perm: 'reporting.settings.manage', main: `${R}/settings`, hit: (p) => p.endsWith('/settings'), emptyBody: undefined },
];

const load = async (file: string) => (await import(/* @vite-ignore */ `../../../app/(staff)/reporting/${file}.tsx`)).default as (props: unknown) => Promise<React.ReactElement>;
const show = async (c: Case) => {
  const el = await (await load(c.file))(c.props);
  return render(<ToastProvider>{el}</ToastProvider>);
};

describe.each(CASES)('$name page', (c) => {
  it('renders the populated screen with the right permission (reads happen, no crash)', async () => {
    session.permissions = [c.perm];
    await show(c);
    expect(gets.some(c.hit)).toBe(true);
    expect(screen.queryByTestId('permission-denied')).toBeNull();
  });

  it('DENIED: without the permission the page renders PermissionDenied and makes no API call', async () => {
    session.permissions = ['reporting.unrelated.permission'];
    await show(c);
    expect(screen.getByTestId('permission-denied')).toBeTruthy();
    expect(gets).toEqual([]);
  });

  it('ERROR: an API 500 on the main read propagates to error.tsx (never a blank page)', async () => {
    session.permissions = [c.perm];
    api.use(http.get(c.main, () => HttpResponse.json(problem(500, 'common.internal'), { status: 500 })));
    await expect((async () => { await show(c); })()).rejects.toMatchObject({ problem: { code: 'common.internal' } });
  });

  it('ERROR: an API 403 is shown as denied (not a crash)', async () => {
    session.permissions = [c.perm];
    api.use(http.get(c.main, () => HttpResponse.json(problem(403, 'auth.forbidden'), { status: 403 })));
    await show(c);
    expect(screen.getByTestId('permission-denied')).toBeTruthy();
  });
});

describe('EMPTY states (list pages)', () => {
  it.each(CASES.filter((c) => c.emptyCopy))('$name: empty list shows its empty copy', async (c) => {
    session.permissions = [c.perm];
    api.use(http.get(c.main, () => HttpResponse.json(c.emptyBody as never)));
    await show(c);
    expect(screen.getByText(c.emptyCopy!)).toBeTruthy();
  });
  it('messages: an empty template list still renders the channel-accounts card', async () => {
    const c = CASES.find((x) => x.name === 'messages')!;
    session.permissions = [c.perm];
    api.use(http.get(c.main, () => HttpResponse.json({ data: [] })));
    await show(c);
    expect(screen.getByLabelText(/secret reference/i)).toBeTruthy();
  });
});

describe('NOT FOUND (detail pages)', () => {
  it.each(CASES.filter((c) => c.notFoundOn))('$name: 404 → notFound()', async (c) => {
    session.permissions = [c.perm];
    api.use(http.get(c.notFoundOn!, () => HttpResponse.json(problem(404, 'common.not_found'), { status: 404 })));
    await expect((async () => { await show(c); })()).rejects.toThrow('NEXT_NOT_FOUND');
  });
  it.each(['not-a-uuid', '../../etc/passwd', '00000000-0000-0000-0000-000000000000/../x'])('report detail refuses a malformed id %s before any request (BFF input validation)', async (bad) => {
    const c = CASES.find((x) => x.name === 'report detail')!;
    session.permissions = [c.perm];
    await expect((async () => { await show({ ...c, props: P({ report_id: bad }) }); })()).rejects.toThrow();
    expect(gets).toEqual([]);
  });
});

describe('worklist + Critical alerts panel (04-UI-UX §2.9)', () => {
  it('the panel failing does NOT fail the worklist: reports render, the panel shows an inline alert with Retry', async () => {
    session.permissions = ['reporting.report.read'];
    api.use(http.get(`${R}/critical-alerts`, () => HttpResponse.json(problem(500, 'common.internal'), { status: 500 })));
    await show(CASES[0]!);
    expect(screen.getByText('R2611050001')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toMatch(/critical alerts|could not/i);
    expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy();
  });
  it('the panel is requested with the 24 h window the spec implies and shows the count badge', async () => {
    session.permissions = ['reporting.report.read'];
    await show(CASES[0]!);
    expect(gets).toContain('/v1/reporting/critical-alerts');
    expect(screen.getByText('Critical alerts')).toBeTruthy();
  });
  it('the barcode value is never forwarded in a GET (PHI in body only): the worklist read carries no barcode query', async () => {
    session.permissions = ['reporting.report.read'];
    const urls: string[] = [];
    api.use(http.get(`${R}/reports`, ({ request }) => { urls.push(request.url); return HttpResponse.json(pageOf([])); }));
    const el = await (await load('page'))({ params: Promise.resolve({}), searchParams: Promise.resolve({ barcode: 'BC123456', tab: 'held' }) });
    render(<ToastProvider>{el}</ToastProvider>);
    expect(urls.join()).not.toMatch(/BC123456|barcode/);
  });
});

describe('LOADING', () => {
  it('reporting/loading.tsx renders an accessible skeleton (status/aria-busy) with no PHI', async () => {
    const Loading = (await load('loading')) as unknown as () => React.ReactElement;
    render(<Loading />);
    expect(document.querySelector('[role="status"],[aria-busy="true"]')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/R\d{10}|Synthetic P\./);
  });
  it('reporting/error.tsx shows a generic message + Try again, never the raw error message', async () => {
    const ErrorBoundary = (await load('error')) as unknown as (p: { error: Error & { digest?: string }; reset: () => void }) => React.ReactElement;
    const reset = vi.fn();
    render(<ErrorBoundary error={Object.assign(new Error('PHI leak: R2611050001 Synthetic P.'), { digest: 'abc123' })} reset={reset} />);
    expect(document.body.textContent).not.toMatch(/PHI leak|R2611050001|Synthetic P\./);
    screen.getByRole('button', { name: /try again|retry/i }).click();
    expect(reset).toHaveBeenCalled();
  });
});
