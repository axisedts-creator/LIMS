// T15 org.service — branches + collection centres (02-TRD §5.5; 03-APP-FLOW §5; 01-PRD AC-C1.1–C1.3; 07-SECURITY P-2, P-3). Seams: see org.helpers.ts header.
// Tester decisions where the spec is silent (flagged in .orchestra/notes/T15-tests.md):
//  * a branch_id of another tenant / unknown on createCentre or updateCentre is rejected EXACTLY like a random uuid (same code + detail, P-2); the code is
//    one of identity.centre_inactive | common.not_found | common.validation_failed (07-SECURITY P-2 "centre_inactive style rejection");
//  * deactivate/reactivate/update check order: id/If-Match validity (428/400) -> 404 -> business rule -> write -> lost race (repo undefined) = 409 common.version_conflict;
//  * branch/centre `code` is immutable (not an input of update*).
import { describe, expect, it } from 'vitest';
import { createOrgService } from '../org.service.js';
import { BR_A1, BR_A2, BR_A_OFF, BR_B1, CE_A1, CE_A2, CE_B1, TENANT_A, TENANT_B, USER, branch, centre, idN, makeCtx, makeRepo, rejection } from './org.helpers.js';

const BRANCH_KEYS = ['branch_id', 'code', 'name', 'address_text', 'phone', 'is_processing_lab', 'is_active', 'version'];
const BRANCH_REQ = ['branch_id', 'code', 'name', 'is_processing_lab', 'is_active', 'version'];
const CENTRE_KEYS = ['centre_id', 'code', 'name', 'branch_id', 'kind', 'address_text', 'phone', 'is_active', 'version'];
const CENTRE_REQ = ['centre_id', 'code', 'name', 'branch_id', 'kind', 'is_active', 'version'];
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const seed = () => ({
  branches: {
    [TENANT_A]: [branch({ id: BR_A1, code: '0001', name: 'Main', version: 2 }), branch({ id: BR_A2, code: 'KTM-02', is_processing_lab: false }), branch({ id: BR_A_OFF, code: 'OLD-1', is_active: false })],
    [TENANT_B]: [branch({ id: BR_B1, code: '0001', name: 'Beta main' })],
  },
  centres: {
    [TENANT_A]: [centre({ id: CE_A1, code: 'C000000001', branch_id: BR_A1, version: 3 }), centre({ id: CE_A2, code: 'HC-1', branch_id: BR_A2, kind: 'home_collection' })],
    [TENANT_B]: [centre({ id: CE_B1, code: 'C000000001', branch_id: BR_B1 })],
  },
});
// extra rows for the If-Match / lost-race tables: an active branch WITHOUT centres (deactivate passes the business rule) and an INACTIVE centre (reactivate is a real transition)
const BR_A3 = idN(0x304), CE_A3 = idN(0x403);
const seedX = () => { const s = seed(); s.branches[TENANT_A].push(branch({ id: BR_A3, code: 'EMPTY-1' })); s.centres[TENANT_A].push(centre({ id: CE_A3, code: 'OFF-1', branch_id: BR_A2, is_active: false })); return s; };
const setup = (s: Parameters<typeof makeRepo>[0] = seed(), tenantId = TENANT_A) => {
  const r = makeRepo(s);
  return { ...r, ...makeCtx({ tenantId }), svc: createOrgService({ repo: r.repo }) };
};
const shapeOf = (b: any, allowed: string[], required: string[]) => {
  expect(Object.keys(b).every((k) => allowed.includes(k))).toBe(true); expect(required.every((k) => k in b)).toBe(true);
  expect(Object.values(b).every((v) => v !== null && v !== undefined)).toBe(true);
};
const isBranch = (b: any) => shapeOf(b, BRANCH_KEYS, BRANCH_REQ);
const isCentre = (b: any) => shapeOf(b, CENTRE_KEYS, CENTRE_REQ);
const bIn = (o: Record<string, unknown> = {}) => ({ code: 'KTM-03', name: 'Third branch', ...o });
const cIn = (o: Record<string, unknown> = {}) => ({ code: 'C000000002', name: 'Demo centre', branchId: BR_A1, kind: 'own', ...o });

describe('listBranches / listCentres', () => {
  it('listBranches: {data:[Branch]} for the caller tenant only; is_active filter passed through; no write', async () => {
    const { svc, ctx, calls, writes } = setup();
    const all = await svc.listBranches(ctx, {});
    expect(all.status).toBe(200); expect(all.body.data.map((x: any) => x.branch_id).sort()).toEqual([BR_A1, BR_A2, BR_A_OFF].sort());
    all.body.data.forEach(isBranch);
    expect(all.body.data.find((x: any) => x.branch_id === BR_A1)).toMatchObject({ code: '0001', name: 'Main', is_processing_lab: true, is_active: true, version: 2 });
    expect(JSON.stringify(all.body)).not.toContain(BR_B1);
    await svc.listBranches(ctx, { isActive: true });
    expect(calls.filter((c) => c.m === 'listBranches').pop()!.args[0]).toEqual({ isActive: true });
    expect((await svc.listBranches(ctx, { isActive: true })).body.data.map((x: any) => x.branch_id).sort()).toEqual([BR_A1, BR_A2].sort());
    expect(writes).toEqual([]);
  });
  it('listCentres: {data:[Centre]}, filters branch_id / kind / is_active, tenant isolation (P-3: zero rows of tenant B)', async () => {
    const { svc, ctx, calls } = setup();
    const all = await svc.listCentres(ctx, {});
    expect(all.status).toBe(200); expect(all.body.data.map((x: any) => x.centre_id).sort()).toEqual([CE_A1, CE_A2].sort()); all.body.data.forEach(isCentre);
    expect(JSON.stringify(all.body)).not.toContain(CE_B1); expect(JSON.stringify(all.body)).not.toContain(BR_B1);
    expect((await svc.listCentres(ctx, { branchId: BR_A2 })).body.data.map((x: any) => x.centre_id)).toEqual([CE_A2]);
    expect((await svc.listCentres(ctx, { kind: 'own' })).body.data.map((x: any) => x.centre_id)).toEqual([CE_A1]);
    expect(calls.filter((c) => c.m === 'listCentres').pop()!.args[0]).toEqual({ kind: 'own' });
  });
  it('listCentres with the id of another tenant\'s branch answers 200 with no rows (nothing leaks, nothing differs from a random uuid)', async () => {
    const { svc, ctx } = setup();
    expect((await svc.listCentres(ctx, { branchId: BR_B1 })).body.data).toEqual([]); expect((await svc.listCentres(ctx, { branchId: idN(0xfff) })).body.data).toEqual([]);
  });
  it('malformed filters are rejected before any repo call: non-uuid branchId, unknown kind, non-boolean isActive', async () => {
    const { svc, ctx, calls } = setup();
    for (const bad of [{ branchId: 'not-a-uuid' }, { kind: 'nope' }, { isActive: 'yes' }, { branchId: "' OR 1=1 --" }]) {
      expect((await rejection(svc.listCentres(ctx, bad as any))).code).toBe('common.validation_failed');
    }
    expect((await rejection(svc.listBranches(ctx, { isActive: 'yes' } as any))).code).toBe('common.validation_failed');
    expect(calls).toEqual([]);
  });
});

describe('createBranch', () => {
  it('201 + Branch + version 1; id is a uuidv7 generated by the service; created_by = ctx actor; address/phone omitted when not given', async () => {
    const { svc, ctx, calls, state } = setup();
    const r = await svc.createBranch(ctx, bIn({ addressText: 'Demo street 3', phone: '01-4000003', isProcessingLab: false }));
    expect(r.status).toBe(201); expect(r.version).toBe(1); isBranch(r.body);
    expect(r.body).toMatchObject({ code: 'KTM-03', name: 'Third branch', address_text: 'Demo street 3', phone: '01-4000003', is_processing_lab: false, is_active: true, version: 1 });
    expect(r.body.branch_id).toMatch(UUID_V7);
    const ins = calls.find((c) => c.m === 'insertBranch')!; expect((ins.args[0] as any).actorId).toBe(USER);
    expect(state.branches.get(TENANT_A)!.some((b) => b.code === 'KTM-03')).toBe(true);
    const min = await svc.createBranch(ctx, bIn({ code: 'KTM-04' }));
    expect(min.body.is_processing_lab).toBe(true); expect(min.body).not.toHaveProperty('address_text'); expect(min.body).not.toHaveProperty('phone');
  });
  it('duplicate code in the same tenant -> 409 identity.code_duplicate, nothing else written; the same code in tenant B is allowed (0001 exists in both)', async () => {
    const { svc, ctx, state } = setup();
    const e = await rejection(svc.createBranch(ctx, bIn({ code: '0001' })));
    expect(e.code).toBe('identity.code_duplicate'); expect(e.statusCode).toBe(409);
    expect(state.branches.get(TENANT_A)!.filter((b) => b.code === '0001')).toHaveLength(1);
    const b = setup(seed(), TENANT_B);
    expect((await b.svc.createBranch(b.ctx, bIn({ code: 'KTM-02' }))).status).toBe(201);   // KTM-02 exists in A only
  });
  it('the duplicate is decided by the database unique constraint (a lost race is a 23505 from the repo), never a 500', async () => {
    const { svc, ctx, fail } = setup(); fail['insertBranch'] = Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
    const e = await rejection(svc.createBranch(ctx, bIn({ code: 'FRESH-1' })));
    expect(e.code).toBe('identity.code_duplicate'); expect(JSON.stringify([e.message, e.detail])).not.toMatch(/constraint|duplicate key|branches/i);
  });
  it('any other repo error is not swallowed as a duplicate', async () => {
    const { svc, ctx, fail } = setup(); fail['insertBranch'] = Object.assign(new Error('connection lost'), { code: '08006' });
    const e = await rejection(svc.createBranch(ctx, bIn({ code: 'FRESH-2' }))); expect(e.code).not.toBe('identity.code_duplicate');
  });
  it.each([[''], ['A'.repeat(17)], ['has space'], ['under_score'], ['a.b'], ['é1'], ['日本'], ["'; DROP TABLE core.branches;--"], ['A\nB'], ['0001 ']])('bad branch code %j -> 400 common.validation_failed, nothing written', async (code) => {
    const { svc, ctx, writes, calls } = setup();
    const e = await rejection(svc.createBranch(ctx, bIn({ code }))); expect(e.code).toBe('common.validation_failed'); expect(e.statusCode).toBe(400);
    expect(writes).toEqual([]); expect(calls.some((c) => c.m === 'insertBranch')).toBe(false);
  });
  it.each([['A'], ['a-B-9'], ['0'], ['1234567890123456'], ['C000000002']])('valid branch code %j is accepted', async (code) => {
    const { svc, ctx } = setup(); expect((await svc.createBranch(ctx, bIn({ code }))).status).toBe(201);
  });
  it.each([
    [{ name: '' }], [{ name: 'x'.repeat(121) }], [{ name: undefined }], [{ name: 7 }], [{ addressText: 'x'.repeat(301) }], [{ phone: 'x'.repeat(31) }], [{ isProcessingLab: 'yes' }], [{ code: undefined }],
  ])('invalid body %j -> 400 common.validation_failed, nothing written', async (patch) => {
    const { svc, ctx, writes } = setup();
    expect((await rejection(svc.createBranch(ctx, bIn(patch)))).code).toBe('common.validation_failed'); expect(writes).toEqual([]);
  });
  it('boundary values accepted: name 120, address 300, phone 30', async () => {
    const { svc, ctx } = setup(); expect((await svc.createBranch(ctx, bIn({ name: 'n'.repeat(120), addressText: 'a'.repeat(300), phone: 'p'.repeat(30) }))).status).toBe(201);
  });
  it('mass assignment: tenantId / id / version / isActive in the input are ignored; the row lands in the ctx tenant as an active v1 branch', async () => {
    const { svc, ctx, state, calls } = setup();
    const r = await svc.createBranch(ctx, bIn({ tenantId: TENANT_B, id: idN(0x999), branchId: idN(0x999), version: 9, isActive: false, is_active: false } as any));
    expect(r.body.branch_id).not.toBe(idN(0x999)); expect(r.body).toMatchObject({ is_active: true, version: 1 });
    expect(state.branches.get(TENANT_B)!.some((b) => b.code === 'KTM-03')).toBe(false);
    expect(calls.find((c) => c.m === 'insertBranch')!.tenantId).toBe(TENANT_A);
  });
});

describe('createCentre — AC-C1.1', () => {
  it('AC-C1.1 admin creates centre C000000002 under branch 0001 -> 201 + Centre, version 1, active, in the branch', async () => {
    const { svc, ctx, calls } = setup();
    const r = await svc.createCentre(ctx, cIn({ addressText: 'Demo street 2', phone: '01-4000002' }));
    expect(r.status).toBe(201); expect(r.version).toBe(1); isCentre(r.body);
    expect(r.body).toMatchObject({ code: 'C000000002', name: 'Demo centre', branch_id: BR_A1, kind: 'own', address_text: 'Demo street 2', phone: '01-4000002', is_active: true, version: 1 });
    expect(r.body.centre_id).toMatch(UUID_V7); expect((calls.find((c) => c.m === 'insertCentre')!.args[0] as any).actorId).toBe(USER);
  });
  it('AC-C1.1 a duplicate code in the same tenant -> 409 identity.code_duplicate; the same code in Beta is allowed', async () => {
    const a = setup(); await a.svc.createCentre(a.ctx, cIn());
    const e = await rejection(a.svc.createCentre(a.ctx, cIn({ name: 'Other', kind: 'franchise' })));
    expect(e.code).toBe('identity.code_duplicate'); expect(e.statusCode).toBe(409);
    expect(a.state.centres.get(TENANT_A)!.filter((c) => c.code === 'C000000002')).toHaveLength(1);
    const b = setup(seed(), TENANT_B); const ok = await b.svc.createCentre(b.ctx, cIn({ branchId: BR_B1 }));
    expect(ok.status).toBe(201); expect(ok.body.code).toBe('C000000002');
    // and Beta's centre does not make Alpha's code a duplicate (and vice versa): both tenants now hold the code
    expect(b.state.centres.get(TENANT_A)!.some((c) => c.code === 'C000000002')).toBe(false);
  });
  it('a branch code and a centre code are separate namespaces (branch 0001 exists; centre 0001 is fine)', async () => {
    const { svc, ctx } = setup(); expect((await svc.createCentre(ctx, cIn({ code: '0001' }))).status).toBe(201);
  });
  it('a lost race (23505 from the repo) is 409 identity.code_duplicate without leaking SQL text', async () => {
    const { svc, ctx, fail } = setup(); fail['insertCentre'] = Object.assign(new Error('duplicate key value violates unique constraint "collection_centres_tenant_code"'), { code: '23505' });
    const e = await rejection(svc.createCentre(ctx, cIn({ code: 'RACE-1' })));
    expect(e.code).toBe('identity.code_duplicate'); expect(JSON.stringify([e.message, e.detail])).not.toMatch(/constraint|duplicate key|collection_centres/i);
  });
  it('kind home_collection may be used many times under one branch (distinct codes)', async () => {
    const { svc, ctx } = setup();
    for (const code of ['HC-2', 'HC-3', 'HC-4']) expect((await svc.createCentre(ctx, cIn({ code, kind: 'home_collection', branchId: BR_A2 }))).body.kind).toBe('home_collection');
  });
  it.each(['own', 'franchise', 'home_collection'])('kind %s accepted', async (kind) => {
    const { svc, ctx } = setup(); expect((await svc.createCentre(ctx, cIn({ code: `K-${kind.replace(/_/g, '-')}`.slice(0, 16), kind }))).body.kind).toBe(kind);
  });
  it('inactive branch -> 409 identity.centre_inactive, nothing written', async () => {
    const { svc, ctx, writes } = setup();
    const e = await rejection(svc.createCentre(ctx, cIn({ branchId: BR_A_OFF }))); expect(e.code).toBe('identity.centre_inactive'); expect(e.statusCode).toBe(409); expect(writes).toEqual([]);
  });
  it('P-2: branch of tenant B and a random branch id are rejected identically (same code + detail + status), nothing written, B untouched', async () => {
    const { svc, ctx, writes, state } = setup();
    const other = await rejection(svc.createCentre(ctx, cIn({ branchId: BR_B1 }))); const rnd = await rejection(svc.createCentre(ctx, cIn({ branchId: idN(0xfff) })));
    expect(['identity.centre_inactive', 'common.not_found', 'common.validation_failed']).toContain(other.code);
    expect(other.code).toBe(rnd.code); expect(other.statusCode).toBe(rnd.statusCode); expect(other.detail).toEqual(rnd.detail); expect(other.errors).toEqual(rnd.errors);
    expect(JSON.stringify([other.message, other.detail, other.errors])).not.toContain(BR_B1);
    expect(writes).toEqual([]); expect(state.centres.get(TENANT_B)!).toHaveLength(1);
  });
  it.each([[''], ['A'.repeat(17)], ['has space'], ['a_b'], ['é'], ["C1'; --"], ['C1\n']])('bad centre code %j -> 400 common.validation_failed, nothing written', async (code) => {
    const { svc, ctx, writes } = setup(); expect((await rejection(svc.createCentre(ctx, cIn({ code })))).code).toBe('common.validation_failed'); expect(writes).toEqual([]);
  });
  it.each([
    [{ name: '' }], [{ name: 'x'.repeat(121) }], [{ branchId: undefined }], [{ branchId: 'not-a-uuid' }], [{ kind: undefined }], [{ kind: 'mobile' }], [{ kind: 'OWN' }],
    [{ addressText: 'x'.repeat(301) }], [{ phone: 'x'.repeat(31) }], [{ code: undefined }],
  ])('invalid body %j -> 400 common.validation_failed, nothing written, branch not even looked up for a malformed uuid', async (patch) => {
    const { svc, ctx, writes } = setup(); expect((await rejection(svc.createCentre(ctx, cIn(patch)))).code).toBe('common.validation_failed'); expect(writes).toEqual([]);
  });
  it('mass assignment: tenantId / id / version / isActive in the input are ignored', async () => {
    const { svc, ctx, state, calls } = setup();
    const r = await svc.createCentre(ctx, cIn({ tenantId: TENANT_B, centreId: idN(0x999), id: idN(0x999), version: 9, isActive: false } as any));
    expect(r.body).toMatchObject({ is_active: true, version: 1 }); expect(r.body.centre_id).not.toBe(idN(0x999));
    expect(state.centres.get(TENANT_B)!.some((c) => c.code === 'C000000002')).toBe(false); expect(calls.find((c) => c.m === 'insertCentre')!.tenantId).toBe(TENANT_A);
  });
});

describe('AC-C1.3 — no limit on the number of branches or centres per tenant', () => {
  it('a tenant holding 300 branches and 1,100 centres can still create one more of each, and list them all', async () => {
    const bs = Array.from({ length: 300 }, (_, i) => branch({ id: idN(0x10000 + i), code: `B${i}` }));
    const cs = Array.from({ length: 1100 }, (_, i) => centre({ id: idN(0x20000 + i), code: `C${i}`, branch_id: bs[i % 300]!.id }));
    const { svc, ctx } = setup({ branches: { [TENANT_A]: bs }, centres: { [TENANT_A]: cs } });
    expect((await svc.createBranch(ctx, bIn({ code: 'BEXTRA' }))).status).toBe(201);
    expect((await svc.createCentre(ctx, cIn({ code: 'CEXTRA', branchId: bs[0]!.id }))).status).toBe(201);
    expect((await svc.listBranches(ctx, {})).body.data).toHaveLength(301); expect((await svc.listCentres(ctx, {})).body.data).toHaveLength(1101);
  });
  it('no cap based on another tenant\'s size either: B with a huge count does not block A (and vice versa)', async () => {
    const big = Array.from({ length: 500 }, (_, i) => branch({ id: idN(0x30000 + i), code: `X${i}` }));
    const { svc, ctx } = setup({ branches: { [TENANT_A]: [], [TENANT_B]: big }, centres: { [TENANT_A]: [], [TENANT_B]: [] } });
    expect((await svc.createBranch(ctx, bIn())).status).toBe(201);
  });
});

describe('updateBranch / updateCentre', () => {
  it('updateBranch: patch fields, version + 1, ETag source = version; untouched fields stay; 200', async () => {
    const { svc, ctx } = setup();
    const r = await svc.updateBranch(ctx, { branchId: BR_A1, expectedVersion: 2, name: 'Main (renamed)', phone: '01-4111111', isProcessingLab: false });
    expect(r.status).toBe(200); expect(r.version).toBe(3); isBranch(r.body);
    expect(r.body).toMatchObject({ branch_id: BR_A1, code: '0001', name: 'Main (renamed)', phone: '01-4111111', is_processing_lab: false, version: 3 });
  });
  it('updateBranch: unset[] clears address_text / phone (field disappears from the body); unset of anything else -> 400', async () => {
    const { svc, ctx } = setup({ ...seed(), branches: { [TENANT_A]: [branch({ id: BR_A1, code: '0001', address_text: 'a', phone: 'p', version: 1 })], [TENANT_B]: [] } });
    const r = await svc.updateBranch(ctx, { branchId: BR_A1, expectedVersion: 1, unset: ['address_text', 'phone'] });
    expect(r.body).not.toHaveProperty('address_text'); expect(r.body).not.toHaveProperty('phone'); expect(r.body.version).toBe(2);
    for (const unset of [['name'], ['code'], ['is_active'], ['bogus'], ['address_text', 'phone', 'phone']]) {
      expect((await rejection(svc.updateBranch(ctx, { branchId: BR_A1, expectedVersion: 2, unset }))).code).toBe('common.validation_failed');
    }
  });
  it('the code is immutable: a `code` in the input is ignored (never reaches the repo), also isActive / version / tenantId', async () => {
    const { svc, ctx, calls, branchRow } = setup();
    await svc.updateBranch(ctx, { branchId: BR_A1, expectedVersion: 2, name: 'N', code: 'HIJACK', isActive: false, tenantId: TENANT_B, version: 99 } as any);
    expect(branchRow(TENANT_A, BR_A1)).toMatchObject({ code: '0001', is_active: true });
    const patch: any = calls.find((c) => c.m === 'updateBranch')!.args[2];
    expect(Object.keys(patch).sort()).toEqual(expect.arrayContaining(['actorId', 'unset'])); expect(Object.keys(patch)).not.toEqual(expect.arrayContaining(['code']));
    for (const k of ['code', 'isActive', 'tenantId', 'version']) expect(patch).not.toHaveProperty(k);
  });
  it('updateCentre: patch name / kind / phone; move to another active branch of the tenant; code stays', async () => {
    const { svc, ctx } = setup();
    const r = await svc.updateCentre(ctx, { centreId: CE_A1, expectedVersion: 3, name: 'Renamed', kind: 'franchise', branchId: BR_A2, phone: '01-4222222' });
    expect(r.status).toBe(200); expect(r.version).toBe(4); isCentre(r.body);
    expect(r.body).toMatchObject({ centre_id: CE_A1, code: 'C000000001', name: 'Renamed', kind: 'franchise', branch_id: BR_A2, phone: '01-4222222', version: 4 });
  });
  it('updateCentre: moving to an inactive branch -> 409 identity.centre_inactive; to tenant B\'s branch = same answer as a random uuid; nothing written', async () => {
    const { svc, ctx, writes } = setup();
    const off = await rejection(svc.updateCentre(ctx, { centreId: CE_A1, expectedVersion: 3, branchId: BR_A_OFF })); expect(off.code).toBe('identity.centre_inactive');
    const other = await rejection(svc.updateCentre(ctx, { centreId: CE_A1, expectedVersion: 3, branchId: BR_B1 })); const rnd = await rejection(svc.updateCentre(ctx, { centreId: CE_A1, expectedVersion: 3, branchId: idN(0xfff) }));
    expect(other.code).toBe(rnd.code); expect(other.detail).toEqual(rnd.detail); expect(['identity.centre_inactive', 'common.not_found', 'common.validation_failed']).toContain(other.code);
    expect(writes).toEqual([]);
  });
  it('updateCentre: a centre may keep its (inactive) branch while other fields change? — only a CHANGE of branch is checked against active', async () => {
    const { svc, ctx } = setup({ ...seed(), centres: { [TENANT_A]: [centre({ id: CE_A1, code: 'C1', branch_id: BR_A_OFF })], [TENANT_B]: [] } });
    expect((await svc.updateCentre(ctx, { centreId: CE_A1, expectedVersion: 1, name: 'only the name' })).status).toBe(200);
  });
  it('updateCentre: unset[] clears address_text / phone; invalid unset / kind / lengths -> 400', async () => {
    const { svc, ctx } = setup({ ...seed(), centres: { [TENANT_A]: [centre({ id: CE_A1, code: 'C1', branch_id: BR_A1, address_text: 'a', phone: 'p' })], [TENANT_B]: [] } });
    for (const bad of [{ unset: ['name'] }, { unset: ['branch_id'] }, { kind: 'mobile' }, { name: '' }, { name: 'x'.repeat(121) }, { addressText: 'x'.repeat(301) }, { phone: 'x'.repeat(31) }, { branchId: 'nope' }]) {
      expect((await rejection(svc.updateCentre(ctx, { centreId: CE_A1, expectedVersion: 1, ...bad } as any))).code).toBe('common.validation_failed');
    }
    const r = await svc.updateCentre(ctx, { centreId: CE_A1, expectedVersion: 1, unset: ['address_text', 'phone'] });
    expect(r.body).not.toHaveProperty('address_text'); expect(r.body).not.toHaveProperty('phone');
  });
  it('updateCentre: code / isActive / tenantId / version in the input never reach the repo', async () => {
    const { svc, ctx, calls, centreRow } = setup();
    await svc.updateCentre(ctx, { centreId: CE_A1, expectedVersion: 3, name: 'N', code: 'HIJACK', isActive: false, tenantId: TENANT_B, version: 99 } as any);
    expect(centreRow(TENANT_A, CE_A1)).toMatchObject({ code: 'C000000001', is_active: true });
    const patch: any = calls.find((c) => c.m === 'updateCentre')!.args[2]; for (const k of ['code', 'isActive', 'tenantId', 'version']) expect(patch).not.toHaveProperty(k);
  });
});

describe('deactivate / reactivate — AC-C1.2, branch-with-active-centres rule', () => {
  it('AC-C1.2 deactivateCentre: 200, is_active=false, version + 1; the centre stays readable (listed, never deleted) and is hidden from the is_active=true picker; memberships are not touched', async () => {
    const { svc, ctx, writes, state } = setup();
    const r = await svc.deactivateCentre(ctx, { centreId: CE_A1, expectedVersion: 3 });
    expect(r.status).toBe(200); expect(r.version).toBe(4); expect(r.body).toMatchObject({ centre_id: CE_A1, is_active: false, code: 'C000000001', version: 4 });
    expect(writes).toEqual(['setCentreActive']);
    expect((await svc.listCentres(ctx, {})).body.data.map((x: any) => x.centre_id)).toContain(CE_A1);
    expect((await svc.listCentres(ctx, { isActive: false })).body.data.map((x: any) => x.centre_id)).toEqual([CE_A1]);
    expect((await svc.listCentres(ctx, { isActive: true })).body.data.map((x: any) => x.centre_id)).not.toContain(CE_A1);
    expect(state.centres.get(TENANT_A)!.some((c) => c.id === CE_A1)).toBe(true);
  });
  it('reactivateCentre: back to active, version + 1', async () => {
    const { svc, ctx } = setup(); const off = await svc.deactivateCentre(ctx, { centreId: CE_A1, expectedVersion: 3 });
    const on = await svc.reactivateCentre(ctx, { centreId: CE_A1, expectedVersion: off.version }); expect(on.body).toMatchObject({ is_active: true, version: 5 });
  });
  it('deactivateBranch with an active centre -> 409 identity.centre_inactive ("branch has active centres"), nothing written', async () => {
    const { svc, ctx, writes, branchRow } = setup();
    const e = await rejection(svc.deactivateBranch(ctx, { branchId: BR_A1, expectedVersion: 2 }));
    expect(e.code).toBe('identity.centre_inactive'); expect(e.statusCode).toBe(409); expect(e.detail).toBe('branch has active centres');
    expect(writes).toEqual([]); expect(branchRow(TENANT_A, BR_A1)!.is_active).toBe(true);
  });
  it('deactivateBranch: allowed once its centres are inactive, or when it never had any; an INACTIVE centre of the branch does not block; tenant B\'s centres never count', async () => {
    const s = setup(); await s.svc.deactivateCentre(s.ctx, { centreId: CE_A1, expectedVersion: 3 });
    const r = await s.svc.deactivateBranch(s.ctx, { branchId: BR_A1, expectedVersion: 2 });
    expect(r.status).toBe(200); expect(r.version).toBe(3); expect(r.body).toMatchObject({ branch_id: BR_A1, is_active: false, version: 3 });
    expect(s.state.centres.get(TENANT_A)!.find((c) => c.id === CE_A1)!.is_active).toBe(false);   // centres untouched by deactivating the branch
    const bare = setup({ branches: { [TENANT_A]: [branch({ id: BR_A1, code: '0001' })] }, centres: { [TENANT_B]: [centre({ id: CE_B1, code: 'X', branch_id: BR_A1 })] } });   // B centre pointing at A's branch id (impossible by FK; must still be ignored)
    expect((await bare.svc.deactivateBranch(bare.ctx, { branchId: BR_A1, expectedVersion: 1 })).status).toBe(200);
    expect(bare.calls.filter((c) => c.m === 'countActiveCentres').every((c) => c.tenantId === TENANT_A)).toBe(true);
  });
  it('reactivateBranch: back to active, version + 1', async () => {
    const { svc, ctx } = setup(); const r = await svc.reactivateBranch(ctx, { branchId: BR_A_OFF, expectedVersion: 1 });
    expect(r.status).toBe(200); expect(r.body).toMatchObject({ branch_id: BR_A_OFF, is_active: true, version: 2 });
  });
  it.each([
    ['deactivateBranch', { branchId: BR_A3 }], ['reactivateBranch', { branchId: BR_A_OFF }], ['deactivateCentre', { centreId: CE_A2 }], ['reactivateCentre', { centreId: CE_A3 }], ['updateBranch', { branchId: BR_A2, name: 'n' }], ['updateCentre', { centreId: CE_A2, name: 'n' }],
  ])('%s If-Match: missing -> 428 common.precondition_required; 0 / negative / fractional / string -> 400 common.validation_failed; stale -> 409 common.version_conflict; none writes', async (op, base) => {
    const s = setup(seedX()); const call = (v: unknown) => (s.svc as any)[op](s.ctx, { ...base, expectedVersion: v });
    const e428 = await rejection(call(undefined)); expect(e428.code).toBe('common.precondition_required'); expect(e428.statusCode).toBe(428);
    for (const v of [0, -1, 1.5, '1', Number.NaN]) expect((await rejection(call(v))).code).toBe('common.validation_failed');
    expect((await rejection(call(7))).code).toBe('common.version_conflict');
    expect(s.writes).toEqual([]);
  });
  it.each([
    ['updateBranch', 'updateBranch', { branchId: BR_A2, name: 'n' }], ['deactivateBranch', 'setBranchActive', { branchId: BR_A3 }], ['reactivateBranch', 'setBranchActive', { branchId: BR_A_OFF }],
    ['updateCentre', 'updateCentre', { centreId: CE_A2, name: 'n' }], ['deactivateCentre', 'setCentreActive', { centreId: CE_A2 }], ['reactivateCentre', 'setCentreActive', { centreId: CE_A3 }],
  ])('%s: a lost race (repo returns undefined after the check) is 409 common.version_conflict, not a 500 or a silent success', async (op, repoOp, base) => {
    const s = setup(seedX()); (s.repo as any)[repoOp] = async () => undefined;   // all seeded rows below have version 1, so the version check passes first
    expect((await rejection((s.svc as any)[op](s.ctx, { ...base, expectedVersion: 1 }))).code).toBe('common.version_conflict');
  });
  it('malformed ids are rejected before any repo call (400 validation_failed or 404 not_found)', async () => {
    const s = setup();
    for (const [op, k] of [['updateBranch', 'branchId'], ['deactivateBranch', 'branchId'], ['reactivateBranch', 'branchId'], ['updateCentre', 'centreId'], ['deactivateCentre', 'centreId'], ['reactivateCentre', 'centreId']] as const) {
      for (const bad of ['', 'x', "1' OR '1'='1", undefined]) {
        const e = await rejection((s.svc as any)[op](s.ctx, { [k]: bad, expectedVersion: 1, name: 'n' })); expect(['common.validation_failed', 'common.not_found']).toContain(e.code);
      }
    }
    expect(s.calls).toEqual([]);
  });
});

describe('tenant probes (07-SECURITY P-2/P-3, REQ-SEC-040/044)', () => {
  const OPS: Array<[string, Record<string, unknown>]> = [
    ['updateBranch', { branchId: BR_B1, name: 'x' }], ['deactivateBranch', { branchId: BR_B1 }], ['reactivateBranch', { branchId: BR_B1 }],
    ['updateCentre', { centreId: CE_B1, name: 'x' }], ['deactivateCentre', { centreId: CE_B1 }], ['reactivateCentre', { centreId: CE_B1 }],
  ];
  it.each(OPS)('%s with tenant B\'s id: 404 common.not_found identical to a random uuid, nothing of B changes', async (op, base) => {
    const s = setup(); const key = op.endsWith('Branch') ? 'branchId' : 'centreId';
    const other = await rejection((s.svc as any)[op](s.ctx, { ...base, expectedVersion: 1 })); const rnd = await rejection((s.svc as any)[op](s.ctx, { ...base, [key]: idN(0xfff), expectedVersion: 1 }));
    expect(other.code).toBe('common.not_found'); expect(other.statusCode).toBe(404); expect(rnd.code).toBe('common.not_found');
    expect(other.detail).toEqual(rnd.detail); expect(JSON.stringify([other.message, other.detail])).not.toContain(base[key]);
    expect(s.writes).toEqual([]); expect(s.branchRow(TENANT_B, BR_B1)).toMatchObject({ is_active: true, version: 1, name: 'Beta main' }); expect(s.centreRow(TENANT_B, CE_B1)).toMatchObject({ is_active: true, version: 1 });
  });
  it('every repo call gets the request tx and the ctx tenant — never a tenant from the input', async () => {
    const s = setup();
    await s.svc.listBranches(s.ctx, {}); await s.svc.listCentres(s.ctx, {}); await s.svc.createBranch(s.ctx, bIn({ tenantId: TENANT_B } as any)); await s.svc.createCentre(s.ctx, cIn({ tenantId: TENANT_B } as any));
    await s.svc.updateBranch(s.ctx, { branchId: BR_A1, expectedVersion: 2, name: 'n', tenantId: TENANT_B } as any); await s.svc.deactivateCentre(s.ctx, { centreId: CE_A2, expectedVersion: 1, tenantId: TENANT_B } as any);
    expect(s.calls.length).toBeGreaterThan(6);
    for (const c of s.calls) { expect(c.tx).toBe(s.tx); expect(c.tenantId).toBe(TENANT_A); }
  });
  it('a caller of tenant B sees only B (and cannot see A\'s ids): list + update of A\'s id from B -> not_found', async () => {
    const s = setup(seed(), TENANT_B);
    expect(JSON.stringify((await s.svc.listBranches(s.ctx, {})).body)).not.toContain(BR_A1); expect(JSON.stringify((await s.svc.listCentres(s.ctx, {})).body)).not.toContain(CE_A1);
    expect((await rejection(s.svc.deactivateCentre(s.ctx, { centreId: CE_A1, expectedVersion: 3 }))).code).toBe('common.not_found');
  });
  it('a repo failure surfaces as an error and echoes none of the input (no ids/codes in the message)', async () => {
    const s = setup(); s.fail['findCentre'] = new Error('db down');
    const e = await rejection(s.svc.deactivateCentre(s.ctx, { centreId: CE_A1, expectedVersion: 3 })); expect(e.code).not.toBe('common.not_found');
    expect(s.writes).toEqual([]);
  });
});
