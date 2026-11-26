// T0D-MISREPORTS-1 shared harness (tester-owned; NOT a test file). Contract definitions + a recording MSW stand-in for the API + page opener.
// Screens are reached through the PAGE default exports (async server components: page -> serverFetch -> MSW -> client parts), like Next does. Synthetic data only.
//
// CONTRACT GAP (see .orchestra/notes/T0D-MISREPORTS-1-cr-needed.md): the 11 MIS report definitions (contracts/openapi/analytics.yaml x-report-definitions) have NO
// HTTP read operation: they run only through createAnalyticsExport / createReportSchedule. So this harness cannot (and must not) invent a read path. Every
// other GET answers an EMPTY page `{ data: [], page: { limit: 50 } }`, so the tests below prove what the screens must show WITHOUT rows: headers, filters,
// permission states, print, CSV export request, schedule option. Rows, totals row, paging and the payment mode totals are NOT tested until the CR is ruled.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { ReactNode } from 'react';
import { parse } from 'yaml';
import { ToastProvider } from '@lims/ui/components/Toast';

export const ORIGIN = 'http://api.test';
process.env.LIMS_ORIGIN_API = ORIGIN;
process.env.LIMS_ANALYTICS_PDF_ENABLED = 'false';

type TMState = {
  nav: { search: string; path: string };
  session: { permissions: string[] };
  navLog: string[];
  push: { mockClear: () => void; mock: { calls: unknown[][] } };
  replace: { mockClear: () => void; mock: { calls: unknown[][] } };
  refresh: { mockReset: () => void; mockClear: () => void; mock: { calls: unknown[][] } };
};
export const TM = (globalThis as unknown as { __TM: TMState }).__TM;

const WEB = join(import.meta.dirname, '..', '..', '..', '..'); // apps/web
export const ROOT = join(WEB, '..', '..');
export const SRC = join(WEB, 'src');
export const read = (p: string) => readFileSync(p, 'utf8');

// ------------------------------------------------------------------ the definitions (read from the contract, never restated)
export interface Col { name: string; type: string; title: string }
export interface Def { code: string; title: string; description: string; permission: string; flag?: string; params: string[]; columns: Col[]; default_sort: { column: string; direction: string }; row_cap: number; exportable: boolean; schedulable: boolean }
export const DEFS: Def[] = (parse(read(join(ROOT, 'contracts', 'openapi', 'analytics.yaml'))) as { 'x-report-definitions': Def[] })['x-report-definitions'];
export const def = (code: string) => DEFS.find((d) => d.code === code)!;
export const slugOf = (code: string) => code.replace(/_/g, '-');
export const MONEY = ['two_level_commission', 'tds'] as const; // A39 / LD-342: behind the flag and analytics.referral_report.read
export const BOTD = 'bill_of_the_day';
/** The ten definitions that open from the analytics catalogue (the eleventh, Bill of the Day, has its own billing screen). */
export const CATALOGUE = DEFS.filter((d) => d.code !== BOTD);
export const nonMoney = CATALOGUE.filter((d) => !(MONEY as readonly string[]).includes(d.code));

/** The headers a table of this definition must show: every column whose name is not an id (ids are never printed, 07-SECURITY: no raw ids on screen). */
export const shownTitles = (d: Def) => d.columns.filter((c) => !c.name.endsWith('_id')).map((c) => c.title);

/** Filter param -> the label of its control. Centre / branch ids are never rendered; labels are the ElabAssist names. */
export const FILTER_LABEL: Record<string, RegExp> = {
  centre_id: /^Centre$/, party_id: /^Party$/, representative_id: /^Representative$/, referrer_id: /^(Consultant|Referrer|Doctor)$/, department_id: /^Department$/,
  collector_id: /^(Collector|Collection boy)$/, min_repeat_count: /^(Minimum|Min\.?) (visits|repeat|repeats|repeat count|count)/i, visit_type: /^(Patient type|Visit type)$/,
};
export const DATE_PARAMS = ['business_date_from', 'business_date_to'];

// ------------------------------------------------------------------ fixtures
export const ID = (n: number) => `01a1a98a-ac40-7000-8000-0000000e${String(n).padStart(4, '0')}`;
export const CENTRE_A = ID(2);
export const PARTY_A = ID(31);
export const FILTER_OPTIONS = {
  centres: [{ id: CENTRE_A, label: 'Synthetic Centre A', branch_id: ID(4), is_active: true }, { id: ID(3), label: 'Synthetic Centre B', branch_id: ID(4), is_active: true }],
  branches: [], departments: [{ id: ID(5), label: 'Synthetic Biochemistry', is_active: true }], payment_methods: [{ code: 'cash', display: 'Cash' }, { code: 'esewa', display: 'eSewa' }], specimen_types: [],
  recipients: [{ membership_id: ID(40), display_name: 'Synthetic Owner' }],
};
const PERIOD = { business_date_from: '2026-11-01', business_date_to: '2026-12-01', days: 30, label_ad: '01 Nov – 30 Nov 2026', label_bs: '2083-07-15 – 2083-08-15', timezone: 'Asia/Kathmandu' };
const FRESH = [{ family: 'income', refreshed_at: '2026-11-19T04:30:00.000Z', is_stale: false, live: false }];
export const INCOME_BODY = { report_code: 'income', period: PERIOD, scope: { all_centres: true, centre_ids: [], tenant_wide_sections_hidden: [] }, freshness: FRESH, generated_at: '2026-11-19T04:30:00.000Z', group_by: 'day', rows: [], totals: {} };

// ------------------------------------------------------------------ recording API
export type Call = { method: string; path: string; search: URLSearchParams; headers: Headers; json?: any };
export const API = {
  calls: [] as Call[],
  /** every GET under /v1/analytics except filter-options answers this status instead (403 / 500); `code` is the problem code */
  readFail: undefined as undefined | { status: number; code: string },
  /** POST /v1/analytics/exports answers this status instead of 202 */
  exportFail: undefined as undefined | { status: number; code: string },
  reset() { this.calls.length = 0; this.readFail = undefined; this.exportFail = undefined; },
  find: (method: string, re: RegExp) => API.calls.filter((c) => c.method === method && re.test(c.path)),
  exports: () => API.calls.filter((c) => c.method === 'POST' && c.path === '/v1/analytics/exports'),
  /** reads that are not filter options (what a report screen fetches for its rows) */
  dataReads: () => API.calls.filter((c) => c.method === 'GET' && c.path.startsWith('/v1/analytics/') && !c.path.startsWith('/v1/analytics/filter-options')),
};
export const prob = (status: number, code: string) =>
  HttpResponse.json({ type: `urn:lims:error:${code}`, title: 'Synthetic failure', status, code, request_id: '01933b6f-0a11-7e2b-8c55-1d2e3f405162' }, { status, headers: { 'content-type': 'application/problem+json' } });

const rec = async (request: Request) => {
  const u = new URL(request.url);
  API.calls.push({ method: request.method, path: u.pathname, search: u.searchParams, headers: request.headers, ...(request.method === 'GET' ? {} : { json: await request.clone().json().catch(() => undefined) }) });
};
const page = () => HttpResponse.json({ data: [], rows: [], columns: [], page: { limit: 50 }, next_cursor: null });

export const api = setupServer(
  http.get(`${ORIGIN}/v1/analytics/filter-options/collections`, async ({ request }) => { await rec(request); return HttpResponse.json({ centres: FILTER_OPTIONS.centres, branches: [], payment_methods: FILTER_OPTIONS.payment_methods }); }),
  http.get(`${ORIGIN}/v1/analytics/filter-options`, async ({ request }) => { await rec(request); return HttpResponse.json(FILTER_OPTIONS); }),
  http.get(`${ORIGIN}/v1/analytics/reports/income`, async ({ request }) => { await rec(request); return API.readFail ? prob(API.readFail.status, API.readFail.code) : HttpResponse.json(INCOME_BODY); }),
  http.get(`${ORIGIN}/v1/analytics/freshness`, async ({ request }) => { await rec(request); return HttpResponse.json({ data: FRESH }); }),
  http.post(`${ORIGIN}/v1/analytics/exports`, async ({ request }) => {
    await rec(request);
    if (API.exportFail) return prob(API.exportFail.status, API.exportFail.code);
    return HttpResponse.json({ id: ID(60), report_code: API.calls.at(-1)?.json?.report_code, format: API.calls.at(-1)?.json?.format, status: 'queued', params: API.calls.at(-1)?.json?.params ?? {}, requested_at: '2026-11-20T04:30:00.000Z', downloads_used: 0, downloads_allowed: 3 }, { status: 202 });
  }),
  http.get(`${ORIGIN}/v1/analytics/*`, async ({ request }) => { await rec(request); return API.readFail ? prob(API.readFail.status, API.readFail.code) : page(); }),
  http.get(`${ORIGIN}/v1/*`, async ({ request }) => { await rec(request); return page(); }),
);

// ------------------------------------------------------------------ opening a page
type PageMod = { default: (p: any) => Promise<ReactNode> | ReactNode };
/** `rel` is relative to apps/web/src/app/(staff)/, e.g. 'analytics/reports/[reportCode]' or 'billing/bill-of-the-day'. A missing page file fails the test with a clear message. */
export async function openPage(rel: string, opts: { perms: string[]; params?: Record<string, string>; search?: string; path?: string }): Promise<ReturnType<typeof render>> {
  TM.session.permissions = opts.perms;
  TM.nav.search = opts.search ?? '';
  TM.nav.path = opts.path ?? `/${rel}`;
  let mod: PageMod;
  try { mod = (await import(/* @vite-ignore */ `../../../app/(staff)/${rel}/page`)) as PageMod; } catch (e) { throw new Error(`missing or broken page file app/(staff)/${rel}/page.tsx: ${(e as Error).message}`); }
  return render(<ToastProvider>{await mod.default({ params: Promise.resolve(opts.params ?? {}), searchParams: Promise.resolve(Object.fromEntries(new URLSearchParams(opts.search ?? ''))) })}</ToastProvider>);
}
export const REPORT_PAGE = 'analytics/reports/[reportCode]';
export const openReport = (code: string, perms: string[], search = ''): Promise<ReturnType<typeof render>> => openPage(REPORT_PAGE, { perms, params: { reportCode: slugOf(code) }, search, path: `/analytics/reports/${slugOf(code)}` });
export const BOTD_PAGE = 'billing/bill-of-the-day';

export const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
export const headers = () => screen.queryAllByRole('columnheader').map((h) => norm(h.textContent));
export const isDisabled = (el: HTMLElement) => (el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true';
export const quiet = (ms = 60) => new Promise((r) => setTimeout(r, ms));
/** What a screen with the given gate failure must NOT leak: any commission / TDS word or column title. */
export const MONEY_WORDS = /commission|tds|withheld|net payable/i;

/** Permission sets. A person who may read the MIS reports, and one who may also export and schedule. */
export const PERM = {
  dashboard: 'analytics.dashboard.read', collections: 'analytics.collections.read', referral: 'analytics.referral_report.read', export: 'analytics.data.export', schedule: 'analytics.schedule.manage',
} as const;
