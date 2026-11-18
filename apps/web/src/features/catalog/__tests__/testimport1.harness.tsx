// T0D-TESTIMPORT-1 shared harness (tester-owned): synthetic fixtures + a stateful MSW stand-in for the six test-import operations of
// contracts/openapi/catalog.yaml (downloadCatalogImportTemplate, validateCatalogImport, listCatalogImports, getCatalogImport, commitCatalogImport,
// downloadCatalogImportErrors). The screen is reached through the page default export of /catalog/imports (async server component), exactly like
// testfix1; no component or file name is pinned. Synthetic data only. Every request is recorded in `calls`.
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
  replace: { mockClear: () => void };
  refresh: { mockReset: () => void; mockClear: () => void; mock: { calls: unknown[][] } };
};
export const TM = (globalThis as unknown as { __TM: TMState }).__TM;

export const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const MB = 1024 * 1024;
export const ID = (n: number) => `01a1a98a-ac40-7000-8000-0000000e${String(n).padStart(4, '0')}`;
export const READ = ['catalog.test.read'];
export const MANAGE = ['catalog.test.read', 'catalog.test.manage'];
export const TEMPLATE_FILE = 'test-import-template-v1.xlsx'; // contract: the template version is "1" (services/api import/fields.ts TEMPLATE_VERSION)

type Rec = Record<string, any>;
export const batch = (o: Rec = {}): Rec => ({
  id: ID(1), file_name: 'tests.xlsx', file_sha256: 'ab'.repeat(32), template_version: '1', mode: 'create_only', status: 'validated',
  counts: { tests: 2, analytes: 5, ranges: 7, panels: 1, errors: 0 }, created_by: ID(900), created_at: '2026-11-17T10:00:00.000Z', validated_at: '2026-11-17T10:00:01.000Z', version: 1, ...o,
});
export const PREVIEW = { tests: [
  { code: 'HB', name: 'Hemoglobin', action: 'create', analytes: 2, ranges: 3 },
  { code: 'CBC', name: 'Complete blood count', action: 'create', analytes: 3, ranges: 4 },
] };
export const CLEAN = (o: Rec = {}) => ({ batch: batch(o), errors: [] as Rec[], preview: PREVIEW });
export const err = (n: number, o: Rec = {}) => ({ sheet: n % 2 ? 'Parameters' : 'Reference Ranges', row: 10 + n, column: n % 2 ? 'Short Name' : 'Normal High', code: 'code_exists', message: `Synthetic server problem number ${n}: value is not allowed here.`, ...o });
export const BAD = (n = 3, o: Rec = {}) => ({
  batch: batch({ id: ID(2), status: 'rejected', counts: { tests: 2, analytes: 5, ranges: 7, panels: 1, errors: n }, ...o }),
  errors: Array.from({ length: n }, (_, i) => err(i + 1)),
  preview: PREVIEW,
});

export const prob = (status: number, code: string, detail = `Synthetic server detail for ${code}.`) =>
  HttpResponse.json({ type: `urn:lims:error:${code}`, title: 'Synthetic title', status, code, detail }, { status, headers: { 'content-type': 'application/problem+json' } });

export type Call = { method: string; path: string; headers: Headers; form?: ParsedForm; json?: any };
export const API = {
  calls: [] as Call[],
  history: [] as Rec[],
  listFail: undefined as undefined | 403 | 500,
  /** One response per POST test-import-batches; the last one repeats. */
  validate: [] as Array<() => Response | Promise<Response>>,
  validateDelayMs: 0,
  commit: [] as Array<() => Response | Promise<Response>>,
  templateFail: false,
  errorsFileFail: false,
  reset() {
    this.calls.length = 0; this.history = []; this.listFail = undefined; this.validate = [() => HttpResponse.json(CLEAN(), { status: 201 })];
    this.validateDelayMs = 0; this.templateFail = false; this.errorsFileFail = false;
    this.commit = [() => HttpResponse.json({ batch: batch({ status: 'committed', version: 2, committed_at: '2026-11-17T10:05:00.000Z', committed_by: ID(900) }), created: { tests: 2, analytes: 5, ranges: 7, panels: 1 } }, { status: 201 })];
  },
  count: (method: string, re: RegExp) => API.calls.filter((c) => c.method === method && re.test(c.path)),
};
const nth = (list: Array<() => Response | Promise<Response>>, i: number) => list[Math.min(i, list.length - 1)]!();

const P = '/v1/catalog/test-import-batches';
export const api = setupServer(
  http.get(`${ORIGIN}/v1/catalog/test-import-template`, ({ request }) => {
    API.calls.push({ method: 'GET', path: new URL(request.url).pathname, headers: request.headers });
    if (API.templateFail) return prob(500, 'common.internal');
    return new HttpResponse(new Uint8Array([0x50, 0x4b, 3, 4, 1, 2, 3, 4]), { status: 200, headers: { 'content-type': XLSX, 'content-disposition': 'attachment; filename=test-import-template.xlsx' } });
  }),
  http.get(`${ORIGIN}${P}/:id/errors-file`, ({ request }) => {
    API.calls.push({ method: 'GET', path: new URL(request.url).pathname, headers: request.headers });
    if (API.errorsFileFail) return prob(500, 'common.internal');
    return new HttpResponse(new Uint8Array([0x50, 0x4b, 3, 4, 9, 9]), { status: 200, headers: { 'content-type': XLSX, 'content-disposition': 'attachment; filename=test-import-errors.xlsx' } });
  }),
  http.post(`${ORIGIN}${P}/:id/commit`, async ({ request }) => {
    const n = API.count('POST', /\/commit$/).length;
    API.calls.push({ method: 'POST', path: new URL(request.url).pathname, headers: request.headers, json: await request.json().catch(() => undefined) });
    return nth(API.commit, n);
  }),
  http.post(`${ORIGIN}${P}`, async ({ request }) => {
    const n = API.count('POST', /test-import-batches$/).length;
    API.calls.push({ method: 'POST', path: new URL(request.url).pathname, headers: request.headers, form: parseMultipart(request.headers.get('content-type') ?? '', await request.text()) });
    if (API.validateDelayMs) await new Promise((r) => setTimeout(r, API.validateDelayMs));
    return nth(API.validate, n);
  }),
  http.get(`${ORIGIN}${P}`, ({ request }) => {
    API.calls.push({ method: 'GET', path: new URL(request.url).pathname, headers: request.headers });
    if (API.listFail === 403) return prob(403, 'common.forbidden');
    if (API.listFail === 500) return prob(500, 'common.internal');
    return HttpResponse.json({ data: API.history, page: { limit: 50 } });
  }),
  // the default view of /catalog/imports (price lists, exports, imports, price list picker)
  http.get(`${ORIGIN}/v1/catalog/*`, ({ request }) => {
    API.calls.push({ method: 'GET', path: new URL(request.url).pathname, headers: request.headers });
    return HttpResponse.json({ data: [], page: { limit: 50 } });
  }),
);

/** Render /catalog/imports?<search> like Next: the server page runs first (a throw = error.tsx), then the client parts render. */
export async function openPage(search = '', perms: string[] = MANAGE) {
  TM.session.permissions = perms;
  TM.nav.search = search;
  TM.nav.path = '/catalog/imports';
  const mod = (await import('@/app/(staff)/catalog/imports/page')) as { default: (p: unknown) => Promise<React.ReactNode> };
  const ui = await mod.default({ params: Promise.resolve({}), searchParams: Promise.resolve(Object.fromEntries(new URLSearchParams(search))) });
  return render(<ToastProvider>{ui}</ToastProvider>);
}
export const openTests = (perms: string[] = MANAGE) => openPage('view=tests', perms);

/** Anchor downloads: jsdom cannot navigate, so every programmatic `a.click()` with a download name is recorded. */
export const downloads: { name: string; href: string }[] = [];
export function captureDownloads() {
  downloads.length = 0;
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { downloads.push({ name: this.download, href: this.href }); });
  (URL as any).createObjectURL = vi.fn(() => 'blob:synthetic');
  (URL as any).revokeObjectURL = vi.fn();
}

export const xlsxFile = (name = 'tests.xlsx', size = 64, type = XLSX) => new File([new Uint8Array(size).fill(0x50)], name, { type });
