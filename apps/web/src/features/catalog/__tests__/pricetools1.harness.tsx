// T0D-PRICETOOLS-1 shared harness (tester-owned): synthetic fixtures + a stateful MSW stand-in for the 7 price list tool operations of
// contracts/openapi/catalog.yaml (downloadPriceListTemplate, dryRunPriceListImport, commitPriceListImport, listPriceListImportBatches, bulkUpdatePriceListDraft,
// copyPriceList, comparePriceLists) plus the reads and the assignments PUT the price list screens already use. Screens are reached through the PAGE default
// exports (async server components) or, for the version editor, through the component and its existing prop contract (web-t34). Synthetic data only.
import { render } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { vi } from 'vitest';
import { ToastProvider } from '@lims/ui/components/Toast';
import { parseMultipart, type ParsedForm } from './web-t35.multipart';

export const ORIGIN = 'http://api.test';
process.env.LIMS_ORIGIN_API = ORIGIN;

type TMState = {
  nav: { search: string; path: string };
  session: { permissions: string[] };
  navLog: string[];
  push: { mockClear: () => void; mock: { calls: unknown[][] } };
  replace: { mockClear: () => void; mock: { calls: unknown[][] } };
  refresh: { mockReset: () => void; mockClear: () => void; mock: { calls: unknown[][] } };
};
export const TM = (globalThis as unknown as { __TM: TMState }).__TM;

export const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const MB = 1024 * 1024;
export const ID = (n: number) => `01a1a98a-ac40-7000-8000-0000000d${String(n).padStart(4, '0')}`;
export const READ = ['catalog.price_list.read'];
export const MANAGE = ['catalog.price_list.read', 'catalog.price_list.manage'];

type Rec = Record<string, any>;
export const money = (amount_paisa: number) => ({ amount_paisa, currency: 'NPR' });
export const ref = (n: number, no: number, from = '2026-10-01T12:00:00.000Z') => ({ id: ID(n), version_no: no, effective_from: from });
export const pl = (n: number, o: Rec = {}): Rec => ({ id: ID(n), code: 'DEFAULT', name: 'Default price list', owner_kind: 'default', falls_through: false, assignments: [], current_version: ref(70, 2), is_active: true, version: 3, ...o });
export const ver = (n: number, no: number, status: string, o: Rec = {}): Rec => ({ id: ID(n), price_list_id: ID(60), version_no: no, status, item_count: 3, version: 5, ...o });

/** Default price list DEFAULT (ID 60): current v2 (ID 70), a draft v3 (ID 73), v1 (ID 71). */
export const DEFAULT_LIST = pl(60, { draft_version_id: ID(73) });
export const DEFAULT_DETAIL: Rec = { ...DEFAULT_LIST, versions: [ver(73, 3, 'draft', { item_count: 4 }), ver(70, 2, 'published', { effective_from: '2026-10-01T12:00:00.000Z', change_reason: 'Synthetic yearly revision' }), ver(71, 1, 'published', { effective_from: '2026-01-01T12:00:00.000Z', change_reason: 'Initial prices' })] };
/** Hospital list HOSP_A (ID 61): two assignments with periods (credit parties ID 90, 91). */
export const CP_LIST = pl(61, { code: 'HOSP_A', name: 'Synthetic General Hospital list', owner_kind: 'credit_party', falls_through: true, current_version: ref(75, 1), assignments: [{ owner_id: ID(90), effective_from: '2026-10-01T00:00:00.000Z', effective_to: '2026-12-31T00:00:00.000Z' }, { owner_id: ID(91), effective_from: '2026-10-01T00:00:00.000Z' }] });
export const CP_DETAIL: Rec = { ...CP_LIST, versions: [ver(75, 1, 'published', { price_list_id: ID(61), effective_from: '2026-10-01T12:00:00.000Z' })] };
export const OTHER_LIST = pl(62, { code: 'DR_X', name: 'Dr Synthetic Alpha list', owner_kind: 'referrer', current_version: ref(76, 4) });
export const LISTS = [DEFAULT_LIST, CP_LIST, OTHER_LIST];
export const PARTIES = [{ id: ID(90), party_code: 'GH', name: 'Synthetic General Hospital', kind: 'hospital', is_active: true, version: 1 }, { id: ID(91), party_code: 'AC', name: 'Synthetic Affiliate Clinic', kind: 'hospital', is_active: true, version: 1 }];

export const prob = (status: number, code: string, detail = `Synthetic server detail for ${code}.`) =>
  HttpResponse.json({ type: `urn:lims:error:${code}`, title: 'Synthetic title', status, code, detail }, { status, headers: { 'content-type': 'application/problem+json' } });

export const batch = (o: Rec = {}): Rec => ({
  id: ID(501), price_list_id: ID(60), status: 'dry_run', row_count: 120, error_count: 0, file_sha256: 'ab'.repeat(32),
  summary: { rows: 120, added: 4, changed: 10, unchanged: 106, errors: 0 }, created_at: '2026-11-17T04:15:00.000Z', created_by: ID(900), ...o,
});
export const CLEAN = (o: Rec = {}) => ({ batch: batch(o), errors: [] as Rec[] });
export const rowErr = (n: number, o: Rec = {}): Rec => ({ row_no: 6 + n, column: n % 2 ? 'test_code' : 'price_rupees', code: n % 2 ? 'code_not_found' : 'price_invalid', message: `Synthetic server problem number ${n}: value is not allowed here.`, ...o });
export const BAD = (n = 3, o: Rec = {}) => ({
  batch: batch({ id: ID(502), error_count: n, summary: { rows: 120, errors: n }, ...o }),
  errors: Array.from({ length: n }, (_, i) => rowErr(i + 1)),
});
export const committedBatch = (n: number, o: Rec = {}): Rec => batch({ id: ID(n), status: 'committed', result_price_list_version_id: ID(505), ...o });

export type Call = { method: string; path: string; search: URLSearchParams; headers: Headers; form?: ParsedForm; json?: any };
export const API = {
  calls: [] as Call[],
  detail: DEFAULT_DETAIL as Rec,
  lists: LISTS as Rec[],
  batches: [] as Rec[],
  batchesFail: undefined as undefined | 403 | 500,
  detailFail: undefined as undefined | 404 | 403,
  templateFail: false,
  /** One response per POST import-dry-run; the last one repeats. */
  dryRun: [] as Array<() => Response | Promise<Response>>,
  dryRunDelayMs: 0,
  commit: [] as Array<() => Response | Promise<Response>>,
  commitDelayMs: 0,
  bulk: [] as Array<() => Response | Promise<Response>>,
  bulkDelayMs: 0,
  copy: [] as Array<() => Response | Promise<Response>>,
  copyDelayMs: 0,
  assignments: [] as Array<() => Response | Promise<Response>>,
  /** comparePriceLists: keyed by cursor ('' = first page). */
  compare: {} as Record<string, () => Response | Promise<Response>>,
  compareFail: undefined as undefined | 403 | 404 | 500,
  reset() {
    this.calls.length = 0; this.detail = DEFAULT_DETAIL; this.lists = LISTS; this.batches = []; this.batchesFail = undefined; this.detailFail = undefined; this.templateFail = false;
    this.dryRun = [() => HttpResponse.json(CLEAN(), { status: 201 })]; this.dryRunDelayMs = 0;
    this.commit = [() => HttpResponse.json(ver(505, 4, 'draft', { item_count: 120, change_reason: 'Synthetic yearly rate revision', version: 1 }), { status: 201 })]; this.commitDelayMs = 0;
    this.bulk = [() => HttpResponse.json({ price_list_version_id: ID(73), changed_count: 98, unchanged_count: 22 })]; this.bulkDelayMs = 0;
    this.copy = [() => HttpResponse.json(ver(521, 2, 'draft', { price_list_id: ID(62), item_count: 340, version: 1 }), { status: 201 })]; this.copyDelayMs = 0;
    this.assignments = [() => HttpResponse.json({ ...CP_LIST, version: 4 })];
    this.compare = {}; this.compareFail = undefined;
  },
  find: (method: string, re: RegExp) => API.calls.filter((c) => c.method === method && re.test(c.path)),
};
const nth = (list: Array<() => Response | Promise<Response>>, i: number) => list[Math.min(i, list.length - 1)]!();
const rec = async (request: Request, extra: Partial<Call> = {}) => { const u = new URL(request.url); API.calls.push({ method: request.method, path: u.pathname, search: u.searchParams, headers: request.headers, ...extra }); };
const wait = (ms: number) => (ms ? new Promise((r) => setTimeout(r, ms)) : undefined);

const C = `${ORIGIN}/v1/catalog`;
export const api = setupServer(
  http.get(`${C}/price-list-import-template`, async ({ request }) => {
    await rec(request);
    if (API.templateFail) return prob(500, 'common.internal');
    return new HttpResponse(new Uint8Array([0x50, 0x4b, 3, 4, 1, 2, 3, 4]), { status: 200, headers: { 'content-type': XLSX, 'content-disposition': 'attachment; filename=price-list-template.xlsx' } });
  }),
  http.post(`${C}/price-lists/:id/import-dry-run`, async ({ request }) => {
    const n = API.find('POST', /import-dry-run$/).length;
    await rec(request, { form: parseMultipart(request.headers.get('content-type') ?? '', await request.text()) });
    await wait(API.dryRunDelayMs);
    return nth(API.dryRun, n);
  }),
  http.get(`${C}/price-list-import-batches`, async ({ request }) => {
    await rec(request);
    if (API.batchesFail === 403) return prob(403, 'auth.forbidden');
    if (API.batchesFail === 500) return prob(500, 'common.internal');
    return HttpResponse.json({ data: API.batches, page: { limit: 50 } });
  }),
  http.post(`${C}/price-list-import-batches/:id/commit`, async ({ request }) => {
    const n = API.find('POST', /\/commit$/).length;
    await rec(request, { json: await request.json().catch(() => undefined) });
    await wait(API.commitDelayMs);
    return nth(API.commit, n);
  }),
  http.post(`${C}/price-list-versions/:id/bulk-update`, async ({ request }) => {
    const n = API.find('POST', /bulk-update$/).length;
    await rec(request, { json: await request.json().catch(() => undefined) });
    await wait(API.bulkDelayMs);
    return nth(API.bulk, n);
  }),
  http.post(`${C}/price-lists/:id/copy`, async ({ request }) => {
    const n = API.find('POST', /\/copy$/).length;
    await rec(request, { json: await request.json().catch(() => undefined) });
    await wait(API.copyDelayMs);
    return nth(API.copy, n);
  }),
  http.put(`${C}/price-lists/:id/assignments`, async ({ request }) => {
    const n = API.find('PUT', /assignments$/).length;
    await rec(request, { json: await request.json().catch(() => undefined) });
    return nth(API.assignments, n);
  }),
  http.get(`${C}/price-list-comparisons`, async ({ request }) => {
    await rec(request);
    if (API.compareFail === 403) return prob(403, 'auth.forbidden');
    if (API.compareFail === 404) return prob(404, 'common.not_found', 'Synthetic: that version does not exist.');
    if (API.compareFail === 500) return prob(500, 'common.internal');
    const cursor = new URL(request.url).searchParams.get('cursor') ?? '';
    const f = API.compare[cursor];
    return f ? f() : HttpResponse.json({ data: [], page: { limit: 50 } });
  }),
  http.get(`${C}/price-lists/:id`, async ({ request, params }) => {
    await rec(request);
    if (API.detailFail === 403) return prob(403, 'auth.forbidden');
    if (API.detailFail === 404) return prob(404, 'common.not_found');
    return HttpResponse.json({ ...API.detail, id: params['id'] === API.detail['id'] ? API.detail['id'] : params['id'] });
  }),
  http.get(`${C}/price-lists`, async ({ request }) => { await rec(request); return HttpResponse.json({ data: API.lists, page: { limit: 200 } }); }),
  http.get(`${C}/credit-parties`, async ({ request }) => { await rec(request); return HttpResponse.json({ data: PARTIES, page: { limit: 200 } }); }),
  http.get(`${ORIGIN}/v1/identity/centres`, async ({ request }) => { await rec(request); return HttpResponse.json({ data: [], page: { limit: 200 } }); }),
  http.get(`${C}/*`, async ({ request }) => { await rec(request); return HttpResponse.json({ data: [], page: { limit: 50 } }); }),
);

type PageMod = { default: (p: unknown) => Promise<React.ReactNode> };
const mount = (ui: React.ReactNode) => render(<ToastProvider>{ui}</ToastProvider>);

/** /catalog/price-lists/<id> like Next: the server page runs first (a throw = error.tsx / notFound), then the client parts render. */
export async function openDetail(detail: Rec = DEFAULT_DETAIL, perms: string[] = MANAGE): Promise<ReturnType<typeof render>> {
  API.detail = detail;
  TM.session.permissions = perms;
  TM.nav.search = '';
  TM.nav.path = `/catalog/price-lists/${detail['id']}`;
  const mod = (await import('@/app/(staff)/catalog/price-lists/[price_list_id]/page')) as PageMod;
  return mount(await mod.default({ params: Promise.resolve({ price_list_id: detail['id'] }), searchParams: Promise.resolve({}) }));
}

/** /catalog/price-lists?<search> (list view, or ?view=compare). */
export async function openLists(search = '', perms: string[] = MANAGE): Promise<ReturnType<typeof render>> {
  TM.session.permissions = perms;
  TM.nav.search = search;
  TM.nav.path = '/catalog/price-lists';
  const mod = (await import('@/app/(staff)/catalog/price-lists/page')) as PageMod;
  return mount(await mod.default({ params: Promise.resolve({}), searchParams: Promise.resolve(Object.fromEntries(new URLSearchParams(search))) }));
}

/** Anchor downloads: jsdom cannot navigate, so every programmatic `a.click()` with a download name is recorded; blobs are kept so a test can read the CSV. */
export const downloads: { name: string; href: string }[] = [];
export const blobs: Blob[] = [];
export function captureDownloads() {
  downloads.length = 0; blobs.length = 0;
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { downloads.push({ name: this.download, href: this.href }); });
  (URL as unknown as Record<string, unknown>).createObjectURL = vi.fn((b: Blob) => { blobs.push(b); return `blob:synthetic-${blobs.length}`; });
  (URL as unknown as Record<string, unknown>).revokeObjectURL = vi.fn();
}
/** Text of a Blob (jsdom's Blob has no .text() in some versions). */
export const blobText = (b: Blob): Promise<string> => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsText(b); });

export const xlsxFile = (name = 'prices.xlsx', size = 64, type = XLSX) => new File([new Uint8Array(size).fill(0x50)], name, { type });
