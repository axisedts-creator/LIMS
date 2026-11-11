// C5.T-23 — page wiring for `/lab/ingest-exceptions` (route staff.lab.ingest_exceptions, CR-C7-014) and `/lab/ingest-exceptions/{exception_id}` (staff.lab.ingest_exception). Server components; node env, MSW.
// Synthetic data only.
// ASSUMED contract (dispute to rename): app/(staff)/lab/ingest-exceptions/page.tsx default async Page({searchParams}) → <IngestExceptionList items status permissions/>
//   (features/lab/components/IngestExceptionList); app/(staff)/lab/ingest-exceptions/[exception_id]/page.tsx default async Page({params}) → <IngestExceptionDetail exception permissions discardReasons/>
//   (features/lab/components/IngestExceptionDetail). Data: GET /v1/lab/ingest-exceptions (#38, lab.result.read), GET /v1/lab/ingest-exceptions/{id} (#39), GET /v1/lab/coded-sets/exception_discard_reasons (#53, active only,
//   sorted by sort_order → discardReasons [{code, display}]). Only the documented filters status (open|resolved|discarded), reason (csv of the documented reasons), instrument_id (uuid), cursor are forwarded from the
//   page's searchParams (a stray `barcode`/`q`/`patient` never reaches the API, REQ-SEC-028); invalid values are dropped. A refused/failed read must NOT render an empty list (a 5xx would say
//   "No open instrument exceptions." while exceptions wait) → the page throws so error.tsx renders, like every other lab page. Unknown / non-uuid / foreign id → notFound().
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { ReactElement } from 'react';

const ORIGIN = 'http://api.test';
const LIST = `${ORIGIN}/v1/lab/ingest-exceptions`;
const CODED = `${ORIGIN}/v1/lab/coded-sets/exception_discard_reasons`;
vi.mock('server-only', () => ({}));
const session = vi.hoisted(() => ({ permissions: [] as string[] }));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: session.permissions, displayName: 'Synthetic Tech', tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => '/lab/ingest-exceptions',
}));
vi.mock('next/navigation', () => ({ redirect: vi.fn(), notFound: () => { throw new Error('NEXT_NOT_FOUND'); } }));
process.env.LIMS_ORIGIN_API = ORIGIN;

const id = (n: number) => `01a1a98a-ac40-7000-8000-${String(n).padStart(12, '0')}`;
const EXC = id(0x23), INSTR = id(0x99);
const dto = { id: EXC, status: 'open', reason: 'unmapped_code', instrument_id: INSTR, result_key: 'k1', sample_barcode: 'SN0001', instrument_analyte_code: 'HGB', created_at: '2026-06-15T04:56:30.000Z' };
const detail = { ...dto, raw_value: '13.4', raw_flags: ['H'], unit_raw: 'g/dL' };
const seen: URL[] = [];
const api = setupServer(
  http.get(LIST, ({ request }) => { seen.push(new URL(request.url)); return HttpResponse.json({ data: [dto], page: { limit: 50 } }); }),
  http.get(`${LIST}/${EXC}`, ({ request }) => { seen.push(new URL(request.url)); return HttpResponse.json(detail); }),
  http.get(CODED, ({ request }) => { seen.push(new URL(request.url)); return HttpResponse.json({ data: [
    { code: 'TEST_SAMPLE', display: 'Test sample', sort_order: 2, is_active: true, source: 'global' },
    { code: 'DUPLICATE_RUN', display: 'Duplicate run', sort_order: 1, is_active: true, source: 'global' },
    { code: 'OLD_REASON', display: 'Old reason', sort_order: 3, is_active: false, source: 'tenant' },
  ] }); }),
);
beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
afterEach(() => { api.resetHandlers(); seen.length = 0; });
afterAll(() => api.close());

const listPage = () => import('@/app/(staff)/lab/ingest-exceptions/page');
const detailPage = () => import('@/app/(staff)/lab/ingest-exceptions/[exception_id]/page');
const renderList = async (sp: Record<string, string> = {}) => (await (await listPage()).default({ searchParams: Promise.resolve(sp) })) as ReactElement;
const renderDetail = async (exception_id: string) => (await (await detailPage()).default({ params: Promise.resolve({ exception_id }) })) as ReactElement;
const problem = (status: number, code: string) => HttpResponse.json({ type: 'about:blank', title: code, status, code }, { status, headers: { 'content-type': 'application/problem+json' } });
const listCalls = () => seen.filter((u) => u.pathname === '/v1/lab/ingest-exceptions');

describe('route table (CR-C7-014): the list page is served at staff.lab.ingest_exceptions', () => {
  it('contracts/routes.yaml maps staff.lab.ingest_exceptions to /lab/ingest-exceptions and staff.lab.ingest_exception to /lab/ingest-exceptions/{exception_id}, both permission lab.result.read', () => {
    const yaml = readFileSync(fileURLToPath(new URL('../../../../../../contracts/routes.yaml', import.meta.url)), 'utf8');
    expect(yaml).toMatch(/id: staff\.lab\.ingest_exceptions,[^\n]*path: \/lab\/ingest-exceptions,[^\n]*permission: lab\.result\.read/);
    expect(yaml).toMatch(/id: staff\.lab\.ingest_exception,[^\n]*path: "\/lab\/ingest-exceptions\/\{exception_id\}",[^\n]*permission: lab\.result\.read/);
  });
  it('the route files exist with error + loading siblings like the other lab screens', () => {
    for (const rel of ['', '[exception_id]/']) {
      for (const f of rel === '' ? ['page.tsx', 'error.tsx', 'loading.tsx'] : ['page.tsx']) {
        expect(existsSync(fileURLToPath(new URL(`../../../app/(staff)/lab/ingest-exceptions/${rel}${f}`, import.meta.url))), `${rel}${f}`).toBe(true);
      }
    }
  });
});

describe('/lab/ingest-exceptions list page', () => {
  it('renders <IngestExceptionList> with the rows and the session permissions (AC-14.3: the unmapped_code exception is visible)', async () => {
    session.permissions = ['lab.result.read', 'lab.result.enter'];
    const el = await renderList();
    const { IngestExceptionList } = await import('../components/IngestExceptionList');
    expect(el.type).toBe(IngestExceptionList);
    const p = el.props as { items: { id: string; reason: string }[]; permissions: string[]; status?: string };
    expect(p.items.map((i) => [i.id, i.reason])).toEqual([[EXC, 'unmapped_code']]);
    expect(p.permissions).toEqual(['lab.result.read', 'lab.result.enter']);
    expect(p.status ?? 'open').toBe('open');
    expect(listCalls()).toHaveLength(1);
  });

  it('forwards ONLY status, reason, instrument_id, cursor; a stray barcode/q/patient param is dropped; invalid values are dropped', async () => {
    session.permissions = ['lab.result.read'];
    await renderList({ status: 'resolved', reason: 'unmapped_code,unknown_barcode', instrument_id: INSTR, cursor: 'CUR1', barcode: 'SN0001', q: 'x', patient: 'Jane Doe' });
    expect(Object.fromEntries(listCalls()[0]!.searchParams)).toEqual({ status: 'resolved', reason: 'unmapped_code,unknown_barcode', instrument_id: INSTR, cursor: 'CUR1' });
    seen.length = 0;
    await renderList({ status: 'everything', reason: 'drop table', instrument_id: 'not-a-uuid' });
    const forwarded = Object.fromEntries(listCalls()[0]!.searchParams);
    delete (forwarded as Record<string, string>)['status'];   // the writer may send the default `open` explicitly
    expect(forwarded).toEqual({});
  });

  it('a 5xx read throws (error.tsx), it does not render "No open instrument exceptions."', async () => {
    session.permissions = ['lab.result.read'];
    api.use(http.get(LIST, () => problem(500, 'common.internal')));
    const err = await renderList().then(() => undefined, (e: unknown) => e);
    expect(err).toBeDefined();
    expect(String((err as Error)?.message)).not.toMatch(/Cannot find|Failed to (resolve|load)/);   // must fail on the 500, not on a missing module
    expect((err as { status?: number }).status).toBe(500);
  });
});

describe('/lab/ingest-exceptions/[exception_id] detail page', () => {
  it('renders <IngestExceptionDetail> with the detail (raw value included), permissions and the ACTIVE discard reasons in sort order', async () => {
    session.permissions = ['lab.result.read', 'lab.result.enter'];
    const el = await renderDetail(EXC);
    const { IngestExceptionDetail } = await import('../components/IngestExceptionDetail');
    expect(el.type).toBe(IngestExceptionDetail);
    const p = el.props as { exception: { id: string; raw_value?: string }; permissions: string[]; discardReasons: { code: string; display: string }[] };
    expect(p.exception).toMatchObject({ id: EXC, raw_value: '13.4' });
    expect(p.permissions).toEqual(['lab.result.read', 'lab.result.enter']);
    expect(p.discardReasons).toEqual([{ code: 'DUPLICATE_RUN', display: 'Duplicate run' }, { code: 'TEST_SAMPLE', display: 'Test sample' }]);
  });

  it('a non-uuid id is notFound() without any API call (no path injection into the request)', async () => {
    session.permissions = ['lab.result.read'];
    const err = await renderDetail('../../admin').then(() => undefined, (e: unknown) => e);
    expect(String((err as Error)?.message)).toBe('NEXT_NOT_FOUND');
    expect(seen).toHaveLength(0);
  });

  it('an unknown / foreign-tenant id (404 from the API) is notFound(), not an error page', async () => {
    session.permissions = ['lab.result.read'];
    api.use(http.get(`${LIST}/${EXC}`, () => problem(404, 'common.not_found')));
    const err = await renderDetail(EXC).then(() => undefined, (e: unknown) => e);
    expect(String((err as Error)?.message)).toBe('NEXT_NOT_FOUND');
  });

  it('a 5xx read throws (error.tsx)', async () => {
    session.permissions = ['lab.result.read'];
    api.use(http.get(`${LIST}/${EXC}`, () => problem(500, 'common.internal')));
    const err = await renderDetail(EXC).then(() => undefined, (e: unknown) => e);
    expect(String((err as Error)?.message)).not.toMatch(/Cannot find|Failed to (resolve|load)/);
    expect((err as { status?: number }).status).toBe(500);
  });
});
