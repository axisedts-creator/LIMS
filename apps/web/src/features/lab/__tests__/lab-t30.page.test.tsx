// C5.T-30 — page wiring for `/lab/specimens/{specimen_id}` + the BFF server actions it uses (node env, MSW). Synthetic data only.
// 04-UI-UX §3.14, 02-TRD §5.1 rows #3 getSpecimen, #10 requestRecollection, #11 createAliquots, #12 storeSpecimen, #13 discardSpecimen (02-TRD §4: If-Match on #9–#13, Idempotency-Key R on #10/#11, O on #12/#13), REQ-SEC-028 (ids validated), P-01 (no existence oracle).
// ASSUMED contract (dispute to rename): app/(staff)/lab/specimens/[specimen_id]/page.tsx default async Page({ params: Promise<{ specimen_id }> }) → <SpecimenDetail specimen rejectionReasons recollectionDefault permissions/>
//   (components/specimens/SpecimenDetail.tsx, see lab-t30.detail.test.tsx). specimen = GET /v1/lab/specimens/{id} body as is. Not a UUID → notFound() with NO request. Session without lab.specimen.read → notFound() with NO request.
//   404 → notFound(); any other failure (403/5xx) throws (error.tsx — an empty detail would look like "no such specimen"). rejectionReasons (GET /v1/lab/coded-sets/rejection_reasons) and recollectionDefault (GET /v1/lab/settings) are read ONLY for a holder
//   of lab.specimen.reject and are best-effort (refused → [] / false), as the receive page. The route folder carries page.tsx, error.tsx, loading.tsx.
//   Actions (server/actions.ts → write.server.ts): storeSpecimenAction(id, version, { location }, key?) POST …/store; discardSpecimenAction(id, version, { discard_reason }, key?) POST …/discard;
//   requestRecollectionAction(id, version, key) POST …/recollect body {}; createAliquotsAction(id, version, { aliquots }, key) POST …/aliquots. Each: If-Match "<version>", Idempotency-Key when given, ids/limits validated BEFORE any request,
//   ApiError → { ok:false, status, code, title }.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { ReactElement } from 'react';
import { LAB, ORIGIN, calls, problem, rec, sent, uuid } from './lab-t11.fixtures';

vi.mock('server-only', () => ({}));
const session = vi.hoisted(() => ({ permissions: [] as string[] }));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: session.permissions, displayName: 'Synthetic Technologist', tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => '/lab/specimens/x',
}));
vi.mock('next/navigation', () => ({ redirect: vi.fn(), notFound: () => { throw new Error('NEXT_NOT_FOUND'); } }));
process.env.LIMS_ORIGIN_API = ORIGIN;

const ID = uuid(5, 30);
const READ = ['lab.specimen.read'];
const DETAIL = { id: ID, version: 4, barcode: 'SYN0000030', order_id: uuid(4, 30), registration_no: 'REG260030', specimen_type_code: 'serum', status: 'received', priority: 'routine', centre_id: uuid(2, 1),
  is_active: true, collection_barcode_unverified: false, label_print_count: 1, tests: [{ test_id: uuid(3, 1), test_code: 'TSTA' }], transitions: [{ to_status: 'ordered', at: '2026-11-11T03:00:00.000Z' }],
  results_summary: { total: 1, resulted: 0, verified: 0, approved: 0 } };
const KEY = 'idem-key-t30-0001';

const api = setupServer(
  http.get(`${LAB}/specimens/${ID}`, async ({ request }) => { await rec(request); return HttpResponse.json(DETAIL); }),
  http.get(`${LAB}/coded-sets/rejection_reasons`, async ({ request }) => { await rec(request); return HttpResponse.json({ data: [{ code: 'haemolysed', display: 'Haemolysed', sort_order: 1, is_active: true }, { code: 'old', display: 'Old', sort_order: 2, is_active: false }] }); }),
  http.get(`${LAB}/settings`, async ({ request }) => { await rec(request); return HttpResponse.json({ recollection_default: true }); }),
);
beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
afterEach(() => { api.resetHandlers(); calls.length = 0; session.permissions = []; });
afterAll(() => api.close());

const render = async (id = ID) => (await (await import('@/app/(staff)/lab/specimens/[specimen_id]/page')).default({ params: Promise.resolve({ specimen_id: id }) })) as ReactElement;
const props = (el: ReactElement) => el.props as { specimen: unknown; rejectionReasons: { code: string; display: string }[]; recollectionDefault: boolean; permissions: string[] };

describe('/lab/specimens/[specimen_id] page', () => {
  it('renders <SpecimenDetail> with the specimen as served, the session permissions and a single GET (no query string)', async () => {
    session.permissions = READ;
    const el = await render();
    const { SpecimenDetail } = await import('../components/specimens/SpecimenDetail');
    expect(el.type).toBe(SpecimenDetail);
    expect(props(el).specimen).toEqual(DETAIL);
    expect(props(el).permissions).toEqual(READ);
    const gets = calls.filter((c) => c.url.pathname === `/v1/lab/specimens/${ID}`);
    expect(gets).toHaveLength(1);
    expect(gets[0]!.url.search).toBe('');
    expect(gets[0]!.headers.get('authorization')).toBe('Bearer jwt-synthetic');
  });

  it('a holder of lab.specimen.reject also gets the active rejection reasons (sorted) and recollection_default', async () => {
    session.permissions = [...READ, 'lab.specimen.reject'];
    const p = props(await render());
    expect(p.rejectionReasons).toEqual([{ code: 'haemolysed', display: 'Haemolysed' }]);
    expect(p.recollectionDefault).toBe(true);
  });

  it('without lab.specimen.reject neither reference read is made (no 403 noise): reasons [], default false', async () => {
    session.permissions = [...READ, 'lab.specimen.receive'];
    const p = props(await render());
    expect(p.rejectionReasons).toEqual([]);
    expect(p.recollectionDefault).toBe(false);
    expect(calls.filter((c) => /coded-sets|\/settings$/.test(c.url.pathname))).toEqual([]);
  });

  it('refused reference reads never take the page down (reasons [], default false)', async () => {
    session.permissions = [...READ, 'lab.specimen.reject'];
    api.use(
      http.get(`${LAB}/coded-sets/rejection_reasons`, async ({ request }) => { await rec(request); return problem(403, 'auth.forbidden', 'Forbidden'); }),
      http.get(`${LAB}/settings`, async ({ request }) => { await rec(request); return problem(500, 'common.internal', 'Boom'); }),
    );
    const p = props(await render());
    expect(p.specimen).toEqual(DETAIL);
    expect(p.rejectionReasons).toEqual([]);
    expect(p.recollectionDefault).toBe(false);
  });

  it('a value that is not a UUID → notFound() and no request is made (REQ-SEC-028)', async () => {
    session.permissions = READ;
    for (const bad of ['abc', '../../etc/passwd', `${ID}%00`, '1; DROP TABLE lab.specimens', '']) await expect(render(bad), bad).rejects.toThrow('NEXT_NOT_FOUND');
    expect(calls).toEqual([]);
  });

  it('a session without lab.specimen.read → notFound() and no request (S-15: no screen for a role that cannot read)', async () => {
    session.permissions = ['lab.worklist.read', 'lab.result.read'];
    await expect(render()).rejects.toThrow('NEXT_NOT_FOUND');
    expect(calls).toEqual([]);
  });

  it('unknown or out-of-scope specimen (404) → notFound() (P-01: same answer as a missing id)', async () => {
    session.permissions = READ;
    api.use(http.get(`${LAB}/specimens/${ID}`, async ({ request }) => { await rec(request); return problem(404, 'common.not_found', 'Not found'); }));
    await expect(render()).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('any other failure (403 / 500) throws so error.tsx renders, not an empty detail', async () => {
    session.permissions = READ;
    for (const [status, code] of [[403, 'auth.forbidden'], [500, 'common.internal']] as const) {
      api.use(http.get(`${LAB}/specimens/${ID}`, async ({ request }) => { await rec(request); return problem(status, code, 'x'); }));
      await expect(render(), String(status)).rejects.toMatchObject({ status }); // the ApiError itself, not notFound()
    }
  });

  it('the route folder carries page.tsx, error.tsx and loading.tsx like its siblings', () => {
    const dir = fileURLToPath(new URL('../../../app/(staff)/lab/specimens/[specimen_id]/', import.meta.url));
    for (const f of ['page.tsx', 'error.tsx', 'loading.tsx']) expect(existsSync(`${dir}${f}`), f).toBe(true);
  });
});

describe('BFF actions (#10–#13)', () => {
  const act = async () => import('../server/actions') as Promise<Record<string, (...a: unknown[]) => Promise<{ ok: boolean; data?: unknown; status?: number; code?: string; title?: string }>>>;
  const reply = (re: RegExp) => api.use(http.post(re, async ({ request }) => { await rec(request); return HttpResponse.json({ ...DETAIL, status: 'stored', version: 5 }); }));

  it('#12 storeSpecimenAction: POST …/store { location }, If-Match "4", Idempotency-Key forwarded; the tenant/actor are never in the body', async () => {
    reply(/\/specimens\/[^/]+\/store$/);
    const r = await (await act()).storeSpecimenAction!(ID, 4, { location: 'Freezer F2' }, KEY);
    expect(r.ok).toBe(true);
    const c = sent('POST', /\/store$/);
    expect(c).toHaveLength(1);
    expect(c[0]!.url.pathname).toBe(`/v1/lab/specimens/${ID}/store`);
    expect(c[0]!.body).toEqual({ location: 'Freezer F2' });
    expect(c[0]!.headers.get('if-match')).toBe('"4"');
    expect(c[0]!.headers.get('idempotency-key')).toBe(KEY);
  });

  it('#13 discardSpecimenAction: POST …/discard { discard_reason } with If-Match', async () => {
    reply(/\/specimens\/[^/]+\/discard$/);
    const r = await (await act()).discardSpecimenAction!(ID, 4, { discard_reason: 'Retention over' }, KEY);
    expect(r.ok).toBe(true);
    const c = sent('POST', /\/discard$/);
    expect(c[0]!.body).toEqual({ discard_reason: 'Retention over' });
    expect(c[0]!.headers.get('if-match')).toBe('"4"');
  });

  it('#10 requestRecollectionAction: POST …/recollect with body {}, If-Match and the required Idempotency-Key', async () => {
    reply(/\/specimens\/[^/]+\/recollect$/);
    const r = await (await act()).requestRecollectionAction!(ID, 4, KEY);
    expect(r.ok).toBe(true);
    const c = sent('POST', /\/recollect$/);
    expect(c[0]!.body).toEqual({});
    expect(c[0]!.headers.get('if-match')).toBe('"4"');
    expect(c[0]!.headers.get('idempotency-key')).toBe(KEY);
  });

  it('#11 createAliquotsAction: POST …/aliquots { aliquots:[{ specimen_type_code?, test_ids }] } with If-Match + Idempotency-Key', async () => {
    reply(/\/specimens\/[^/]+\/aliquots$/);
    const body = { aliquots: [{ test_ids: [uuid(3, 1)] }, { specimen_type_code: 'plasma', test_ids: [uuid(3, 1), uuid(3, 2)] }] };
    const r = await (await act()).createAliquotsAction!(ID, 4, body, KEY);
    expect(r.ok).toBe(true);
    const c = sent('POST', /\/aliquots$/);
    expect(c[0]!.body).toEqual(body);
    expect(c[0]!.headers.get('if-match')).toBe('"4"');
    expect(c[0]!.headers.get('idempotency-key')).toBe(KEY);
  });

  it('validation happens before any request: bad id / version / key, location 0 or >120, reason 0 or >200, aliquots 0 or >10, empty or non-UUID test_ids', async () => {
    const a = await act();
    const long = (n: number) => 'x'.repeat(n);
    const bad: [string, () => Promise<unknown>][] = [
      ['store id', () => a.storeSpecimenAction!('not-a-uuid', 4, { location: 'L' }, KEY)],
      ['store version 0', () => a.storeSpecimenAction!(ID, 0, { location: 'L' }, KEY)],
      ['store version 1.5', () => a.storeSpecimenAction!(ID, 1.5, { location: 'L' }, KEY)],
      ['store empty location', () => a.storeSpecimenAction!(ID, 4, { location: '' }, KEY)],
      ['store location 121', () => a.storeSpecimenAction!(ID, 4, { location: long(121) }, KEY)],
      ['store bad key', () => a.storeSpecimenAction!(ID, 4, { location: 'L' }, 'k')],
      ['discard empty', () => a.discardSpecimenAction!(ID, 4, { discard_reason: '' }, KEY)],
      ['discard 201', () => a.discardSpecimenAction!(ID, 4, { discard_reason: long(201) }, KEY)],
      ['discard id', () => a.discardSpecimenAction!('../x', 4, { discard_reason: 'r' }, KEY)],
      ['recollect id', () => a.requestRecollectionAction!('x', 4, KEY)],
      ['recollect bad key', () => a.requestRecollectionAction!(ID, 4, '')],
      ['aliquots 0', () => a.createAliquotsAction!(ID, 4, { aliquots: [] }, KEY)],
      ['aliquots 11', () => a.createAliquotsAction!(ID, 4, { aliquots: Array.from({ length: 11 }, () => ({ test_ids: [uuid(3, 1)] })) }, KEY)],
      ['aliquot without tests', () => a.createAliquotsAction!(ID, 4, { aliquots: [{ test_ids: [] }] }, KEY)],
      ['aliquot test id', () => a.createAliquotsAction!(ID, 4, { aliquots: [{ test_ids: ['nope'] }] }, KEY)],
      ['aliquot id', () => a.createAliquotsAction!('x', 4, { aliquots: [{ test_ids: [uuid(3, 1)] }] }, KEY)],
    ];
    for (const [name, f] of bad) {
      const r = (await f().catch((e: unknown) => ({ ok: false, code: 'threw', e }))) as { ok: boolean; code?: string };
      expect(r.ok, name).toBe(false);
    }
    expect(calls, 'no request may leave the BFF for invalid input').toEqual([]);
  });

  it('API errors become { ok:false, status, code, title } (the code survives the action boundary)', async () => {
    api.use(
      http.post(/\/specimens\/[^/]+\/store$/, async ({ request }) => { await rec(request); return problem(409, 'lab.specimen_invalid_transition', 'Not allowed from this status'); }),
      http.post(/\/specimens\/[^/]+\/discard$/, async ({ request }) => { await rec(request); return problem(409, 'common.version_conflict', 'Version conflict'); }),
      http.post(/\/specimens\/[^/]+\/recollect$/, async ({ request }) => { await rec(request); return problem(403, 'auth.forbidden', 'Forbidden'); }),
    );
    const a = await act();
    expect(await a.storeSpecimenAction!(ID, 4, { location: 'L' }, KEY)).toMatchObject({ ok: false, status: 409, code: 'lab.specimen_invalid_transition', title: 'Not allowed from this status' });
    expect(await a.discardSpecimenAction!(ID, 4, { discard_reason: 'r' }, KEY)).toMatchObject({ ok: false, status: 409, code: 'common.version_conflict' });
    expect(await a.requestRecollectionAction!(ID, 4, KEY)).toMatchObject({ ok: false, status: 403, code: 'auth.forbidden' });
  });
});
