// C3.T-33 — BFF server functions for SCR-09…12 (02-CONVENTIONS §2.4: server/<operationId>.server.ts). MSW stands in for the C3 API
// (contracts/openapi/catalog.yaml). Synthetic data only.
// ASSUMED signatures (same conventions as T-31: create*(input, idempotencyKey?), update*(id, version, input) → PATCH + If-Match "<version>"):
//   listPanels({panelKind?, isActive?, limit?, cursor?})  getPanelDetail(id)  createPanel(input, key?)  updatePanel(id, version, input)
//   replacePanelMembers(id, version, {members})           searchOrderables({q, kind?, panelKind?, limit?})  resolveOrderablesPreview({orderable_ids})
//   listCommentCodes({departmentId?, codePrefix?, isActive?})  createCommentCode(input, key?)  updateCommentCode(id, version, input)
//   listDoctors({isVerified?, isActive?, source?, sort?, limit?, cursor?})  searchDoctors({q, includeUnverified?, includeInactive?, limit?}) → POST body
//   getDoctor(id)  createDoctor(input, key?)  updateDoctor(id, version, input)  verifyDoctor(id, version)  mergeDoctor(id, version, {into_doctor_id}, key?)
//   listCreditParties({isActive?, limit?, cursor?})  getCreditParty(id)  createCreditParty(input, key?)  updateCreditParty(id, version, input)
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({ getAccessToken: async () => 'jwt-synthetic', getShellSession: async () => undefined }));

const ORIGIN = 'http://api.test';
process.env.LIMS_ORIGIN_API = ORIGIN;
const ID = '01a1a98a-ac40-7000-8000-0000000d0201';
const ID2 = '01a1a98a-ac40-7000-8000-0000000d0202';

const seen: { url: URL; method: string; headers: Headers; body?: any }[] = [];
const rec = async (r: Request) => { seen.push({ url: new URL(r.url), method: r.method, headers: r.headers, body: ['POST', 'PATCH', 'PUT'].includes(r.method) ? await r.clone().json().catch(() => undefined) : undefined }); };
const entity = { id: ID, version: 4, is_active: true };
const server = setupServer(
  http.get(`${ORIGIN}/v1/catalog/*`, async ({ request }) => { await rec(request); return HttpResponse.json({ data: [], page: { limit: 50 } }); }),
  http.post(`${ORIGIN}/v1/catalog/*`, async ({ request }) => { await rec(request); return HttpResponse.json({ ...entity, data: [] }, { status: 201 }); }),
  http.patch(`${ORIGIN}/v1/catalog/*`, async ({ request }) => { await rec(request); return HttpResponse.json(entity); }),
  http.put(`${ORIGIN}/v1/catalog/*`, async ({ request }) => { await rec(request); return HttpResponse.json(entity); }),
);
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => { server.resetHandlers(); seen.length = 0; });
afterAll(() => server.close());

const problem = (status: number, code: string, extra: Record<string, unknown> = {}) => HttpResponse.json({ type: `urn:lims:error:${code}`, title: 'x', status, code, ...extra }, { status });
const mod = async (op: string) => (await import(`../server/${op}.server.ts`))[op];
const rejects = async (p: Promise<unknown>) => { const e: any = await p.then(() => undefined, (x: unknown) => x); expect(e?.status, 'ApiError 400').toBe(400); expect(e.problem.code).toBe('common.validation_failed'); };

describe('panels (SCR-09; AC-07.3, AC-07.4)', () => {
  const member = (n: number, kind = 'test') => ({ kind, orderable_id: `01a1a98a-ac40-7000-8000-0000000d03${String(n).padStart(2, '0')}`, sort_order: n });

  it('listPanels → GET /v1/catalog/panels with panel_kind / is_active', async () => {
    await (await mod('listPanels'))({ panelKind: 'package', isActive: 'all', limit: 100 });
    const r = seen[0]!;
    expect(r.url.pathname).toBe('/v1/catalog/panels');
    expect(r.url.searchParams.get('panel_kind')).toBe('package');
    expect(r.url.searchParams.get('is_active')).toBe('all');
    expect(r.headers.get('authorization')).toBe('Bearer jwt-synthetic');
    await rejects((await mod('listPanels'))({ panelKind: 'x&admin=1' }));
  });

  it('createPanel: code trimmed + upper-cased, Idempotency-Key sent, only declared fields forwarded (mass-assignment)', async () => {
    await (await mod('createPanel'))({ code: ' lipid ', name: 'Lipid profile', panel_kind: 'clinical', members: [member(1), member(2)], tenant_id: ID, is_active: false, revision: 9, kind: 'test', is_orderable: false }, 'idem-key-0001-aaaa');
    const r = seen[0]!;
    expect(r.method).toBe('POST');
    expect(r.url.pathname).toBe('/v1/catalog/panels');
    expect(r.headers.get('idempotency-key')).toBe('idem-key-0001-aaaa');
    expect(r.body).toEqual({ code: 'LIPID', name: 'Lipid profile', panel_kind: 'clinical', members: [member(1), member(2)] });
  });

  it('createPanel rejects before the network: bad code, bad panel_kind, 0 members, 101 members (AC-07.4 max 100), bad member kind', async () => {
    const create = await mod('createPanel');
    const ok = { code: 'P1', name: 'n', panel_kind: 'clinical', members: [member(1)] };
    await rejects(create({ ...ok, code: 'bad code' }));
    await rejects(create({ ...ok, panel_kind: 'bundle' }));
    await rejects(create({ ...ok, members: [] }));
    await rejects(create({ ...ok, members: Array.from({ length: 101 }, (_, i) => member(i % 100)) }));
    await rejects(create({ ...ok, members: [{ ...member(1), kind: 'group' }] }));
    await rejects(create({ ...ok, name: 'x'.repeat(201) }));
    expect(seen).toEqual([]);
  });

  it('updatePanel: PATCH + If-Match, `unset` forwarded for clearing optional fields; replacePanelMembers: PUT + If-Match + members only', async () => {
    await (await mod('updatePanel'))(ID, 3, { name: 'Lipid', unset: ['sex_restriction'], panel_kind: 'package', code: 'NEW' });
    await (await mod('replacePanelMembers'))(ID, 3, { members: [member(1)], is_active: false });
    expect(seen[0]!.method).toBe('PATCH');
    expect(seen[0]!.headers.get('if-match')).toBe('"3"');
    expect(seen[0]!.body).toEqual({ name: 'Lipid', unset: ['sex_restriction'] }); // panel_kind + code are create-only
    expect(seen[1]!.method).toBe('PUT');
    expect(seen[1]!.url.pathname).toBe(`/v1/catalog/panels/${ID}/members`);
    expect(seen[1]!.headers.get('if-match')).toBe('"3"');
    expect(seen[1]!.body).toEqual({ members: [member(1)] });
  });

  it('replacePanelMembers surfaces catalog.panel_cycle (422) and catalog.test_inactive as ApiError with the code (AC-07.3, AC-07.5)', async () => {
    const put = await mod('replacePanelMembers');
    for (const code of ['catalog.panel_cycle', 'catalog.test_inactive']) {
      server.use(http.put(`${ORIGIN}/v1/catalog/panels/:id/members`, () => problem(422, code)));
      const e: any = await put(ID, 3, { members: [member(1)] }).then(() => undefined, (x: unknown) => x);
      expect(e.status).toBe(422);
      expect(e.problem.code).toBe(code);
    }
  });

  it('bad ids / versions never reach the API', async () => {
    await rejects((await mod('updatePanel'))('../../admin', 1, { name: 'x' }));
    await rejects((await mod('replacePanelMembers'))(ID, 0, { members: [member(1)] }));
    await rejects((await mod('getPanelDetail'))('not-a-uuid'));
    expect(seen).toEqual([]);
  });

  it('searchOrderables → GET /v1/catalog/orderables?q=…; resolveOrderablesPreview → POST body {orderable_ids} (AC-07.1 preview)', async () => {
    await (await mod('searchOrderables'))({ q: 'HDL', kind: 'test' });
    await (await mod('resolveOrderablesPreview'))({ orderable_ids: [ID, ID2] });
    expect(seen[0]!.url.pathname).toBe('/v1/catalog/orderables');
    expect(seen[0]!.url.searchParams.get('q')).toBe('HDL');
    expect(seen[1]!.url.pathname).toBe('/v1/catalog/orderables/resolve');
    expect(seen[1]!.body).toEqual({ orderable_ids: [ID, ID2] });
    await rejects((await mod('searchOrderables'))({ q: '' }));
    await rejects((await mod('searchOrderables'))({ q: 'x'.repeat(65) }));
    await rejects((await mod('resolveOrderablesPreview'))({ orderable_ids: [] }));
  });
});

describe('comment codes (SCR-10; AC-09.1…09.3)', () => {
  it('createCommentCode: upper-cased, department optional, Idempotency-Key; only code/department_id/text forwarded', async () => {
    await (await mod('createCommentCode'))({ code: 'hypo', department_id: ID, text: 'Hypochromia present.', version: 9, is_active: false }, 'idem-key-0002-bbbb');
    expect(seen[0]!.body).toEqual({ code: 'HYPO', department_id: ID, text: 'Hypochromia present.' });
    expect(seen[0]!.headers.get('idempotency-key')).toBe('idem-key-0002-bbbb');
  });

  it('createCommentCode / updateCommentCode validation: code ^[A-Z0-9_]{1,16}$, text 1–2000, code immutable on update', async () => {
    const create = await mod('createCommentCode');
    await rejects(create({ code: 'A-B', text: 'x' }));
    await rejects(create({ code: 'A'.repeat(17), text: 'x' }));
    await rejects(create({ code: 'OK', text: '' }));
    await rejects(create({ code: 'OK', text: 'x'.repeat(2001) }));
    expect(seen).toEqual([]);
    await (await mod('updateCommentCode'))(ID, 2, { text: 'New text', code: 'CHANGED', department_id: ID2, is_active: false });
    expect(seen[0]!.headers.get('if-match')).toBe('"2"');
    expect(seen[0]!.body).toEqual({ text: 'New text', is_active: false });
  });

  it('listCommentCodes passes the department filter and code prefix as query params', async () => {
    await (await mod('listCommentCodes'))({ departmentId: ID, codePrefix: 'HY' });
    expect(seen[0]!.url.pathname).toBe('/v1/catalog/comment-codes');
    expect(seen[0]!.url.searchParams.get('department_id')).toBe(ID);
    expect(seen[0]!.url.searchParams.get('code_prefix')).toBe('HY');
  });
});

describe('doctors (SCR-11; AC-11.1…11.4)', () => {
  it('searchDoctors posts the query in the BODY — the name never appears in the URL (D-C3-06)', async () => {
    await (await mod('searchDoctors'))({ q: 'Dr Test Referrer 0007', includeUnverified: true, limit: 20 });
    const r = seen[0]!;
    expect(r.method).toBe('POST');
    expect(r.url.pathname).toBe('/v1/catalog/doctors/search');
    expect(r.url.search).toBe('');
    expect(decodeURIComponent(r.url.href)).not.toMatch(/Referrer/);
    expect(r.body).toEqual({ q: 'Dr Test Referrer 0007', include_unverified: true, limit: 20 });
    await rejects((await mod('searchDoctors'))({ q: '' }));
    await rejects((await mod('searchDoctors'))({ q: 'x'.repeat(65) }));
    await rejects((await mod('searchDoctors'))({ q: 'ok', limit: 51 }));
  });

  it('listDoctors maps is_verified / is_active / source / sort; rejects unknown enum values', async () => {
    const list = await mod('listDoctors');
    await list({ isVerified: false, isActive: 'all', source: 'quick_add', sort: '-created_at' });
    const q = seen[0]!.url.searchParams;
    expect([q.get('is_verified'), q.get('is_active'), q.get('source'), q.get('sort')]).toEqual(['false', 'all', 'quick_add', '-created_at']);
    await rejects(list({ source: 'manual' }));
    await rejects(list({ sort: 'display_name' }));
  });

  it('createDoctor: code optional (auto DR{seq:5}), Idempotency-Key, no is_verified/source/merged_into_id/tenant_id from the client (AC-11.1)', async () => {
    await (await mod('createDoctor'))({ display_name: 'Dr Test Referrer 0007', phone_e164: '+97798XXXXXXXX'.replace(/X/g, '1'), is_verified: true, source: 'back_office', merged_into_id: ID, tenant_id: ID, quick_add: true }, 'idem-key-0003-cccc');
    expect(seen[0]!.headers.get('idempotency-key')).toBe('idem-key-0003-cccc');
    expect(Object.keys(seen[0]!.body).sort()).toEqual(['display_name', 'phone_e164']);
  });

  it('createDoctor / updateDoctor validation: name 1–120, E.164 phone, email, notes ≤500, unset enum', async () => {
    const create = await mod('createDoctor');
    await rejects(create({ display_name: '' }));
    await rejects(create({ display_name: 'x'.repeat(121) }));
    await rejects(create({ display_name: 'Dr A', phone_e164: '9841234567' }));
    await rejects(create({ display_name: 'Dr A', email: 'not-an-email' }));
    await rejects(create({ display_name: 'Dr A', notes: 'n'.repeat(501) }));
    await rejects(create({ display_name: 'Dr A', doctor_code: 'bad code' }));
    await rejects((await mod('updateDoctor'))(ID, 1, { unset: ['is_verified'] }));
    expect(seen).toEqual([]);
    await (await mod('updateDoctor'))(ID, 5, { qualification: 'MD', unset: ['notes'], is_verified: true, doctor_code: 'X' });
    expect(seen[0]!.headers.get('if-match')).toBe('"5"');
    expect(seen[0]!.body).toEqual({ qualification: 'MD', unset: ['notes'] });
  });

  it('verifyDoctor → POST /doctors/{id}/verify with If-Match and no body fields', async () => {
    await (await mod('verifyDoctor'))(ID, 7);
    expect(seen[0]!.method).toBe('POST');
    expect(seen[0]!.url.pathname).toBe(`/v1/catalog/doctors/${ID}/verify`);
    expect(seen[0]!.headers.get('if-match')).toBe('"7"');
    await rejects((await mod('verifyDoctor'))('x', 7));
  });

  it('mergeDoctor → POST /doctors/{id}/merge: If-Match + Idempotency-Key + body is exactly {into_doctor_id} (AC-11.3)', async () => {
    await (await mod('mergeDoctor'))(ID, 7, { into_doctor_id: ID2, is_active: true, merged_into_id: ID }, 'idem-key-0004-dddd');
    const r = seen[0]!;
    expect(r.url.pathname).toBe(`/v1/catalog/doctors/${ID}/merge`);
    expect(r.headers.get('if-match')).toBe('"7"');
    expect(r.headers.get('idempotency-key')).toBe('idem-key-0004-dddd');
    expect(r.body).toEqual({ into_doctor_id: ID2 });
  });

  it('mergeDoctor rejects a missing/invalid target, a self-merge, and a bad key before the network; a generated key is used when none is given', async () => {
    const merge = await mod('mergeDoctor');
    await rejects(merge(ID, 7, {}));
    await rejects(merge(ID, 7, { into_doctor_id: 'nope' }));
    await rejects(merge(ID, 7, { into_doctor_id: ID }));
    await rejects(merge(ID, 7, { into_doctor_id: ID2 }, 'short'));
    expect(seen).toEqual([]);
    await merge(ID, 7, { into_doctor_id: ID2 });
    expect(seen[0]!.headers.get('idempotency-key')).toMatch(/^[A-Za-z0-9_-]{8,}$/);
  });

  it('mergeDoctor surfaces 422 common.validation_failed and 409 common.version_conflict as ApiError', async () => {
    const merge = await mod('mergeDoctor');
    for (const [status, code] of [[422, 'common.validation_failed'], [409, 'common.version_conflict']] as const) {
      server.use(http.post(`${ORIGIN}/v1/catalog/doctors/:id/merge`, () => problem(status, code)));
      const e: any = await merge(ID, 7, { into_doctor_id: ID2 }).then(() => undefined, (x: unknown) => x);
      expect([e.status, e.problem.code]).toEqual([status, code]);
    }
  });

  it('getDoctor returns the API body as-is — contact fields are only ever what the API sent (AC-11.4, S-11)', async () => {
    const body = { id: ID, doctor_code: 'DR00001', display_name: 'Dr Synthetic', is_verified: true, source: 'back_office', is_active: true, version: 2 };
    server.use(http.get(`${ORIGIN}/v1/catalog/doctors/:id`, () => HttpResponse.json(body)));
    expect(await (await mod('getDoctor'))(ID)).toEqual(body);
  });
});

describe('credit parties (SCR-12; AC-12.1, AC-12.4)', () => {
  it('createCreditParty: blank party_code is omitted (server assigns CP{seq:5}), allows_credit boolean, Idempotency-Key, no tenant_id/price_list_id', async () => {
    await (await mod('createCreditParty'))({ party_code: '  ', name: 'Synthetic General Hospital', kind: 'hospital', allows_credit: true, price_list_id: ID, tenant_id: ID }, 'idem-key-0005-eeee');
    expect(seen[0]!.url.pathname).toBe('/v1/catalog/credit-parties');
    expect(seen[0]!.headers.get('idempotency-key')).toBe('idem-key-0005-eeee');
    expect(seen[0]!.body).toEqual({ name: 'Synthetic General Hospital', kind: 'hospital', allows_credit: true });
  });

  it('create/update validation: kind enum, name ≤160, PAN ≤20, E.164 phone, email, address ≤500; a typed party_code is upper-cased', async () => {
    const create = await mod('createCreditParty');
    const ok = { name: 'Synthetic Co', kind: 'company' };
    await rejects(create({ ...ok, kind: 'ngo' }));
    await rejects(create({ ...ok, name: '' }));
    await rejects(create({ ...ok, name: 'x'.repeat(161) }));
    await rejects(create({ ...ok, pan: 'p'.repeat(21) }));
    await rejects(create({ ...ok, contact_phone_e164: '01-4444444' }));
    await rejects(create({ ...ok, contact_email: 'nope' }));
    await rejects(create({ ...ok, billing_address: 'a'.repeat(501) }));
    await rejects(create({ ...ok, party_code: 'bad code' }));
    expect(seen).toEqual([]);
    await create({ ...ok, party_code: 'cp_syn1' });
    expect(seen[0]!.body.party_code).toBe('CP_SYN1');
    await (await mod('updateCreditParty'))(ID, 3, { allows_credit: false, party_code: 'X', is_active: false });
    expect(seen[1]!.headers.get('if-match')).toBe('"3"');
    expect(seen[1]!.body).toEqual({ allows_credit: false, is_active: false });
  });

  it('listCreditParties / getCreditParty hit the documented paths; 403 stays an ApiError (page shows no-access)', async () => {
    await (await mod('listCreditParties'))({ isActive: 'all' });
    await (await mod('getCreditParty'))(ID);
    expect(seen[0]!.url.pathname).toBe('/v1/catalog/credit-parties');
    expect(seen[1]!.url.pathname).toBe(`/v1/catalog/credit-parties/${ID}`);
    server.use(http.get(`${ORIGIN}/v1/catalog/credit-parties`, () => problem(403, 'auth.forbidden')));
    const e: any = await (await mod('listCreditParties'))({}).then(() => undefined, (x: unknown) => x);
    expect([e.status, e.problem.code]).toEqual([403, 'auth.forbidden']);
  });
});
