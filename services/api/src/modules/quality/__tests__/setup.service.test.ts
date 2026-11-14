// C9 T-06 — set-up service #1-#13 (materials, levels, lots, control-ID maps). AC-01.1-01.4, AC-02.5; 07-SECURITY S-01/S-03/S-04/S-07, REQ-SEC-002/013/080/081/095.
// FakeRepo emulates RLS + the DDL uniques/FKs; seams: setup.helpers.ts header. Business date: ctx.now() 19:00Z = 2026-11-14 00:45 Asia/Kathmandu (UTC date is the 13th).
import { describe, expect, it } from 'vitest';
import { toProblem } from '../../../core/errors.js';
import { createSetupService } from '../service/setup.service.js';
import { INS, INS_B, LOT, LVL, MAP, MAT, OPS, PLANTED, REQ_ID, TENANT_A, TENANT_B, TODAY, UUID7, baseSeed, code, forbidden, lotRow, makeCtx, makeRepo, mapRow, noRights, readOnly, rejection, type FakeSeed, type Row } from './setup.helpers.js';

const w = (seed: FakeSeed = baseSeed(), over: Parameters<typeof makeCtx>[0] = {}) => {
  const f = makeRepo(seed), c = makeCtx(over), svc: any = createSetupService({ repo: f.repo });
  return { f, svc, ...c, call: (op: string, input: Row = {}) => svc[op](c.ctx, input) };
};
const keys = (o: object) => Object.keys(o).sort();
const MATERIAL_KEYS = ['code', 'created_at', 'id', 'is_active', 'levels', 'lots_expiring_30d', 'manufacturer', 'matrix', 'name', 'version'];
const LEVEL_KEYS = ['display_name', 'id', 'is_active', 'level_code', 'material_id', 'sort_order', 'version'];
const LOT_KEYS = ['expires_on', 'id', 'is_active', 'is_expired', 'level_id', 'lot_no', 'material_id', 'version'];
const MAP_KEYS = ['control_id_raw', 'control_lot_raw', 'id', 'instrument_id', 'instrument_label', 'is_active', 'lot_id', 'version'];
const MAT_BODY = { code: 'MCS-NEW', name: 'New synthetic control', manufacturer: 'Synthetic Maker', matrix: 'serum', levels: [{ level_code: '1', display_name: 'Level 1', sort_order: 1 }, { level_code: '2', display_name: 'Level 2', sort_order: 2 }] };
const noLeak = (o: unknown) => { const s = JSON.stringify(o); for (const bad of ['tenant_id', 'created_by', 'updated_by', 'updated_at', 'internal_note', PLANTED]) expect(s, bad).not.toContain(bad); };
const seedWith = (f: (s: FakeSeed) => void): FakeSeed => { const s = baseSeed(); f(s); return s; };

describe('AC-01.1 #2 createControlMaterial', () => {
  it('creates the material and its two levels, active; 201, version 1; DTO = §5.10 allowlist only', async () => {
    const t = w();
    const r = await t.call('createControlMaterial', { body: MAT_BODY });
    expect(r.status).toBe(201); expect(r.version).toBe(1);
    expect(keys(r.body)).toEqual(MATERIAL_KEYS);
    expect(r.body).toMatchObject({ code: 'MCS-NEW', name: 'New synthetic control', is_active: true, version: 1, lots_expiring_30d: 0 });
    expect(r.body.id).toMatch(UUID7);
    expect(r.body.levels).toHaveLength(2);
    for (const l of r.body.levels) { expect(keys(l).filter((k) => k !== 'lots')).toEqual(LEVEL_KEYS); expect(l).toMatchObject({ material_id: r.body.id, is_active: true, version: 1 }); }
    noLeak(r.body);
  });
  it('writes tenant and actor from the context, never from the body: tenant A, created_by = actor, one insertMaterial + one insertLevel per level', async () => {
    const t = w(); await t.call('createControlMaterial', { body: MAT_BODY });
    const [m] = t.f.callsOf('insertMaterial'); expect(m!.tenantId).toBe(TENANT_A);
    expect(m!.args[0]).toMatchObject({ code: 'MCS-NEW', created_by: expect.any(String) });
    expect((m!.args[0] as Row)['id']).toMatch(UUID7);
    expect(t.f.callsOf('insertLevel')).toHaveLength(2);
    for (const c of t.f.callsOf('insertLevel')) expect(c.args[0]).toMatchObject({ material_id: (m!.args[0] as Row)['id'], created_by: expect.any(String) });
  });
  it('levels come back ordered by sort_order', async () => {
    const t = w(); const body = { ...MAT_BODY, levels: [{ level_code: '2', display_name: 'High', sort_order: 2 }, { level_code: '1', display_name: 'Low', sort_order: 1 }] };
    expect((await t.call('createControlMaterial', { body })).body.levels.map((l: Row) => l['level_code'])).toEqual(['1', '2']);
  });
  it('optional manufacturer / matrix absent -> keys omitted (no null on the wire)', async () => {
    const t = w(); const { manufacturer: _m, matrix: _x, ...rest } = MAT_BODY;
    const r = await t.call('createControlMaterial', { body: rest });
    expect(r.body).not.toHaveProperty('manufacturer'); expect(r.body).not.toHaveProperty('matrix'); expect(JSON.stringify(r.body)).not.toContain('null');
  });
  it('a second material with code MCS-SYN in the same tenant -> 409 quality.code_duplicate (HTTP 409); nothing else is written', async () => {
    const t = w(); const e = await rejection(t.call('createControlMaterial', { body: { ...MAT_BODY, code: 'MCS-SYN' } }));
    expect(code(e)).toBe('quality.code_duplicate'); expect(toProblem(e, '/v1/quality/control-materials', REQ_ID).status).toBe(409);
    expect(t.f.callsOf('insertLevel')).toHaveLength(0);
  });
  it('the same code existing only in tenant B is no duplicate for tenant A (RLS: B is invisible)', async () => {
    const t = w(seedWith((s) => s.materials!.push({ ...s.materials![0]!, id: MAT(8), tenant_id: TENANT_B, code: 'B-ONLY' })));
    expect((await t.call('createControlMaterial', { body: { ...MAT_BODY, code: 'B-ONLY' } })).status).toBe(201);
  });
  it('duplicate level_code inside one body -> 409 quality.code_duplicate', async () => {
    const t = w(); const body = { ...MAT_BODY, levels: [{ level_code: '1', display_name: 'A', sort_order: 0 }, { level_code: '1', display_name: 'B', sort_order: 1 }] };
    expect(code(await rejection(t.call('createControlMaterial', { body })))).toBe('quality.code_duplicate');
  });
  it('a failed create enqueues nothing', async () => { const t = w(); await rejection(t.call('createControlMaterial', { body: { ...MAT_BODY, code: 'MCS-SYN' } })); expect(t.enqueues()).toEqual([]); });
});

describe('request validation (REQ-SEC-080, DB CHECKs of 05-SCHEMA §2) -> 400 common.validation_failed with the field path; nothing written', () => {
  const lvl = (o: Row = {}) => ({ level_code: '1', display_name: 'L', sort_order: 0, ...o });
  const bad: Array<[string, Row, string]> = [
    ['code lower-case', { ...MAT_BODY, code: 'mcs-syn' }, '/code'], ['code 1 char', { ...MAT_BODY, code: 'A' }, '/code'], ['code 33 chars', { ...MAT_BODY, code: 'A'.repeat(33) }, '/code'],
    ['code with space', { ...MAT_BODY, code: 'MCS SYN' }, '/code'], ['name empty', { ...MAT_BODY, name: '' }, '/name'], ['name 121 chars', { ...MAT_BODY, name: 'x'.repeat(121) }, '/name'],
    ['manufacturer 121 chars', { ...MAT_BODY, manufacturer: 'x'.repeat(121) }, '/manufacturer'], ['matrix 61 chars', { ...MAT_BODY, matrix: 'x'.repeat(61) }, '/matrix'],
    ['no levels', { ...MAT_BODY, levels: [] }, '/levels'], ['7 levels', { ...MAT_BODY, levels: Array.from({ length: 7 }, (_, i) => lvl({ level_code: String(i) })) }, '/levels'],
    ['levels missing', (({ levels: _l, ...r }) => r)(MAT_BODY), '/levels'],
    ['level_code with dash', { ...MAT_BODY, levels: [lvl({ level_code: 'L-1' })] }, '/levels/0/level_code'], ['level_code 17 chars', { ...MAT_BODY, levels: [lvl({ level_code: 'A'.repeat(17) })] }, '/levels/0/level_code'],
    ['level display_name 61 chars', { ...MAT_BODY, levels: [lvl({ display_name: 'x'.repeat(61) })] }, '/levels/0/display_name'],
    ['sort_order 100', { ...MAT_BODY, levels: [lvl({ sort_order: 100 })] }, '/levels/0/sort_order'], ['sort_order -1', { ...MAT_BODY, levels: [lvl({ sort_order: -1 })] }, '/levels/0/sort_order'],
    ['sort_order 1.5', { ...MAT_BODY, levels: [lvl({ sort_order: 1.5 })] }, '/levels/0/sort_order'],
    ['code not a string', { ...MAT_BODY, code: 12345 }, '/code'],
  ];
  it.each(bad)('createControlMaterial: %s', async (_n, body, path) => {
    const t = w(); const e = await rejection(t.call('createControlMaterial', { body }));
    expect(code(e)).toBe('common.validation_failed'); expect(e.errors.map((x: Row) => x['path'])).toContain(path); expect(toProblem(e, '/x', REQ_ID).status).toBe(400);
    expect(t.f.mutations()).toEqual([]);
  });
  it.each([null, undefined, 'x', [], 42])('createControlMaterial: body %j is not an object -> 400', async (body) => {
    const t = w(); expect(code(await rejection(t.call('createControlMaterial', { body })))).toBe('common.validation_failed'); expect(t.f.mutations()).toEqual([]);
  });
  // S-03 mass assignment
  const extra = ['tenant_id', 'created_by', 'updated_by', 'status', 'outcome', 'version', 'id', 'is_active', 'created_at'];
  it.each(extra)('createControlMaterial: body field %s is rejected as common.unknown_field and nothing is written (S-03)', async (k) => {
    const t = w(); const e = await rejection(t.call('createControlMaterial', { body: { ...MAT_BODY, [k]: k === 'version' ? 5 : TENANT_B } }));
    expect(code(e)).toBe('common.validation_failed'); expect(e.errors).toEqual(expect.arrayContaining([expect.objectContaining({ path: `/${k}`, code: 'common.unknown_field' })]));
    expect(t.f.mutations()).toEqual([]);
  });
  it('a level object with an unknown field is rejected too', async () => {
    const t = w(); const e = await rejection(t.call('createControlMaterial', { body: { ...MAT_BODY, levels: [{ level_code: '1', display_name: 'L', sort_order: 0, tenant_id: TENANT_B }] } }));
    expect(e.errors).toEqual(expect.arrayContaining([expect.objectContaining({ path: '/levels/0/tenant_id', code: 'common.unknown_field' })]));
  });
});

describe('#1 listControlMaterials + #3 getControlMaterial', () => {
  it('default lists active materials of the tenant only (sort code); DTO allowlist incl. levels and lots_expiring_30d; page envelope {limit} without next_cursor', async () => {
    const t = w(seedWith((s) => s.materials!.push({ ...s.materials![1]!, id: MAT(3), code: 'OLD-ONE', is_active: false })));
    const r = await t.call('listControlMaterials', {});
    expect(r.status).toBe(200); expect(r.body.data.map((m: Row) => m['code'])).toEqual(['CHEM-LOW', 'MCS-SYN']);
    for (const m of r.body.data) { expect(keys(m)).toEqual(MATERIAL_KEYS); expect(Array.isArray(m.levels)).toBe(true); noLeak(m); }
    expect(r.body.page).toEqual({ limit: 50 });
    expect(t.f.callsOf('listMaterials')[0]!.args[0]).toMatchObject({ isActive: true, sort: 'code', limit: 50 });
  });
  it('is_active=false lists the deactivated ones; q, sort, cursor, limit are handed to the repo; next_cursor appears only when the repo returns one', async () => {
    const t = w(seedWith((s) => s.materials!.push({ ...s.materials![1]!, id: MAT(3), code: 'OLD-ONE', is_active: false })));
    expect((await t.call('listControlMaterials', { isActive: false })).body.data.map((m: Row) => m['code'])).toEqual(['OLD-ONE']);
    await t.call('listControlMaterials', { q: 'MCS', sort: '-created_at', cursor: 'CUR1', limit: 10 });
    expect(t.f.callsOf('listMaterials').at(-1)!.args[0]).toMatchObject({ q: 'MCS', sort: '-created_at', cursor: 'CUR1', limit: 10 });
    const f2 = makeRepo(); const orig = f2.repo.listMaterials; f2.repo.listMaterials = async (...a) => ({ ...(await orig(...a)), nextCursor: 'NEXT' });
    expect((await (createSetupService({ repo: f2.repo }) as any).listControlMaterials(makeCtx().ctx, { limit: 1 })).body.page).toEqual({ limit: 1, next_cursor: 'NEXT' });
  });
  it.each([[0], [201], [-1], [1.5]])('limit %j -> 400', async (limit) => { expect(code(await rejection(w().call('listControlMaterials', { limit })))).toBe('common.validation_failed'); });
  it('q longer than 40 characters -> 400; unknown sort -> 400', async () => {
    const t = w(); expect(code(await rejection(t.call('listControlMaterials', { q: 'x'.repeat(41) })))).toBe('common.validation_failed');
    expect(code(await rejection(t.call('listControlMaterials', { sort: 'name' })))).toBe('common.validation_failed'); expect(t.f.callsOf('listMaterials')).toEqual([]);
  });
  it('an invalid cursor from the repo is answered as common.invalid_cursor', async () => {
    const f = makeRepo(); f.repo.listMaterials = async () => { const { LimsError } = await import('../../../core/errors.js'); throw new LimsError('common.invalid_cursor'); };
    expect(code(await rejection((createSetupService({ repo: f.repo }) as any).listControlMaterials(makeCtx().ctx, { cursor: 'junk' })))).toBe('common.invalid_cursor');
  });
  it('#3 returns the material with its levels and, on each level, its lots (inactive and expired included); ETag version in the result', async () => {
    const t = w(); const r = await t.call('getControlMaterial', { materialId: MAT(1) });
    expect(r.status).toBe(200); expect(r.version).toBe(1); expect(keys(r.body)).toEqual(MATERIAL_KEYS);
    const l1 = r.body.levels.find((l: Row) => l['id'] === LVL(1));
    expect(keys(l1)).toEqual([...LEVEL_KEYS, 'lots'].sort()); expect(l1.lots.map((x: Row) => x['id'])).toEqual([LOT(1)]);
    expect(keys(l1.lots[0])).toEqual(LOT_KEYS); noLeak(r.body);
  });
  it('lots_expiring_30d = active lots with expires_on in [today, today+30] on the tenant business date (2026-11-14 .. 2026-12-14); is_expired = expires_on < today', async () => {
    const t = w(seedWith((s) => s.lots!.push(
      lotRow(11, 1, 1, { expires_on: '2026-11-14' }), lotRow(12, 1, 1, { expires_on: '2026-12-14' }), lotRow(13, 1, 1, { expires_on: '2026-12-15' }),
      lotRow(14, 1, 1, { expires_on: '2026-11-13' }), lotRow(15, 1, 1, { expires_on: '2026-11-20', is_active: false }), lotRow(16, 2, 1, { expires_on: '2026-11-30' }),
    )));
    const r = await t.call('getControlMaterial', { materialId: MAT(1) });
    expect(r.body.lots_expiring_30d).toBe(3);                    // 11, 12, 16 — not 13 (day 31), 14 (yesterday for Kathmandu), 15 (inactive); tenant B's lot 9 (2026-11-20) is in the window but never counts
    const lots = Object.fromEntries(r.body.levels.flatMap((l: Row) => l['lots']).map((x: Row) => [x['expires_on'] + (x['is_active'] ? '' : '!'), x['is_expired']]));
    expect(lots).toMatchObject({ '2026-11-14': false, '2026-12-14': false, '2026-11-13': true, '2027-03-31': false, '2026-11-20!': false });
    expect((await t.call('listControlMaterials', {})).body.data.find((m: Row) => m['id'] === MAT(1)).lots_expiring_30d).toBe(3);
  });
  it('unknown id and another tenant\'s id are indistinguishable: 404 common.not_found, no data', async () => {
    const t = w(); const a = await rejection(t.call('getControlMaterial', { materialId: MAT(9) })), b = await rejection(t.call('getControlMaterial', { materialId: MAT(77) }));
    expect([code(a), code(b)]).toEqual(['common.not_found', 'common.not_found']); expect(toProblem(a, '/x', REQ_ID).status).toBe(404);
    expect(toProblem(a, '/x', REQ_ID)).toMatchObject({ code: 'common.not_found' }); expect(JSON.stringify(toProblem(a, '/x', REQ_ID))).not.toContain(MAT(9));
  });
});

describe('#4 updateControlMaterial — If-Match', () => {
  const upd = (t: ReturnType<typeof w>, patch: Row, o: Row = {}) => t.call('updateControlMaterial', { materialId: MAT(1), expectedVersion: 1, patch, ...o });
  it('200, new version, ETag version in the result; only the allowed fields change', async () => {
    const t = w(); const r = await upd(t, { name: 'Renamed', matrix: 'plasma' });
    expect(r.status).toBe(200); expect(r.version).toBe(2); expect(r.body).toMatchObject({ id: MAT(1), name: 'Renamed', matrix: 'plasma', version: 2, code: 'MCS-SYN' }); noLeak(r.body);
    expect(t.f.callsOf('updateMaterial')[0]!.args.slice(0, 2)).toEqual([MAT(1), 1]);
  });
  it('unset: [manufacturer, matrix] clears them; the DTO omits the keys', async () => {
    const t = w(); const r = await upd(t, { unset: ['manufacturer', 'matrix'] });
    expect(r.body).not.toHaveProperty('manufacturer'); expect(r.body).not.toHaveProperty('matrix');
  });
  it('missing If-Match -> 428 common.precondition_required (HTTP 428); stale -> 409 common.version_conflict (HTTP 409); neither writes', async () => {
    const t = w(); const a = await rejection(upd(t, { name: 'x' }, { expectedVersion: undefined })), b = await rejection(upd(t, { name: 'x' }, { expectedVersion: 7 }));
    expect([code(a), code(b)]).toEqual(['common.precondition_required', 'common.version_conflict']);
    expect([toProblem(a, '/x', REQ_ID).status, toProblem(b, '/x', REQ_ID).status]).toEqual([428, 409]); expect(t.f.mutations()).toEqual([]);
  });
  it('a concurrent writer wins between the read and the write (repo returns undefined) -> 409 common.version_conflict', async () => {
    const t = w(); t.f.repo.updateMaterial = async () => undefined; expect(code(await rejection(upd(t, { name: 'x' })))).toBe('common.version_conflict');
  });
  it('code is immutable and system fields are rejected (unknown_field): code, tenant_id, is_active, version', async () => {
    for (const k of ['code', 'tenant_id', 'is_active', 'version', 'created_by']) {
      const t = w(); const e = await rejection(upd(t, { [k]: 'MCS-X' })); expect(code(e), k).toBe('common.validation_failed'); expect(e.errors[0]).toMatchObject({ path: `/${k}`, code: 'common.unknown_field' }); expect(t.f.mutations()).toEqual([]);
    }
  });
  it.each([[{ name: '' }, '/name'], [{ name: 'x'.repeat(121) }, '/name'], [{ manufacturer: 'x'.repeat(121) }, '/manufacturer'], [{ matrix: 'x'.repeat(61) }, '/matrix'], [{ unset: ['name'] }, '/unset/0'], [{ unset: 'manufacturer' }, '/unset']])('patch %j -> 400 at %s', async (patch, path) => {
    const t = w(); const e = await rejection(upd(t, patch as Row)); expect(code(e)).toBe('common.validation_failed'); expect(e.errors.map((x: Row) => x['path'])).toContain(path);
  });
  it('another tenant\'s material -> 404 and nothing is written (RLS)', async () => { const t = w(); expect(code(await rejection(upd(t, { name: 'x' }, { materialId: MAT(9) })))).toBe('common.not_found'); expect(t.f.mutations()).toEqual([]); });
});

describe('AC-01.4 #5 deactivateControlMaterial', () => {
  it('sets is_active=false, bumps the version; the material stays readable (get, and list with is_active=false) with its levels and lots', async () => {
    const t = w(); const r = await t.call('deactivateControlMaterial', { materialId: MAT(1), expectedVersion: 1 });
    expect(r.status).toBe(200); expect(r.body).toMatchObject({ id: MAT(1), is_active: false, version: 2 }); expect(r.version).toBe(2);
    const g = await t.call('getControlMaterial', { materialId: MAT(1) }); expect(g.status).toBe(200); expect(g.body.is_active).toBe(false);
    expect(g.body.levels.flatMap((l: Row) => l['lots']).map((x: Row) => x['id'])).toEqual(expect.arrayContaining([LOT(1), LOT(2)]));
    expect((await t.call('listControlMaterials', { isActive: false })).body.data.map((m: Row) => m['id'])).toContain(MAT(1));
    expect((await t.call('listControlMaterials', {})).body.data.map((m: Row) => m['id'])).not.toContain(MAT(1));
  });
  it('nothing is deleted: the repo is only asked to update', async () => { const t = w(); await t.call('deactivateControlMaterial', { materialId: MAT(1), expectedVersion: 1 }); expect(t.f.calls.map((c) => c.op).filter((o) => !/^(find|list|update)/.test(o))).toEqual([]); expect(t.f.materials.some((m) => m['id'] === MAT(1))).toBe(true); });
  it('missing If-Match -> 428, stale -> 409, another tenant -> 404; none writes; no enqueue', async () => {
    const t = w(); const c = (o: Row) => rejection(t.call('deactivateControlMaterial', { materialId: MAT(1), expectedVersion: 1, ...o }));
    expect([code(await c({ expectedVersion: undefined })), code(await c({ expectedVersion: 3 })), code(await c({ materialId: MAT(9) }))]).toEqual(['common.precondition_required', 'common.version_conflict', 'common.not_found']);
    expect(t.f.mutations()).toEqual([]); expect(t.enqueues()).toEqual([]);
  });
});

describe('#6 createControlLevel / #7 updateControlLevel', () => {
  const body = { level_code: '3', display_name: 'Level 3', sort_order: 3 };
  it('201 ControlLevelDto, version 1, material_id from the path; tenant/actor from the context', async () => {
    const t = w(); const r = await t.call('createControlLevel', { materialId: MAT(1), body });
    expect(r.status).toBe(201); expect(r.version).toBe(1); expect(keys(r.body).filter((k) => k !== 'lots')).toEqual(LEVEL_KEYS);
    expect(r.body).toMatchObject({ material_id: MAT(1), level_code: '3', display_name: 'Level 3', sort_order: 3, is_active: true }); noLeak(r.body);
    expect(t.f.callsOf('insertLevel')[0]).toMatchObject({ tenantId: TENANT_A }); expect(t.f.callsOf('insertLevel')[0]!.args[0]).toMatchObject({ material_id: MAT(1), created_by: expect.any(String) });
  });
  it('level_code already on the material -> 409 quality.code_duplicate; allowed on another material', async () => {
    const t = w(); expect(code(await rejection(t.call('createControlLevel', { materialId: MAT(1), body: { ...body, level_code: '1' } })))).toBe('quality.code_duplicate');
    expect((await t.call('createControlLevel', { materialId: MAT(2), body: { ...body, level_code: '1' } })).status).toBe(201);
  });
  it('unknown / other tenant material -> 404; bad body -> 400 (level_code, display_name, sort_order, tenant_id)', async () => {
    const t = w(); expect(code(await rejection(t.call('createControlLevel', { materialId: MAT(9), body })))).toBe('common.not_found');
    for (const [b, p] of [[{ ...body, level_code: 'L-3' }, '/level_code'], [{ ...body, display_name: '' }, '/display_name'], [{ ...body, sort_order: 100 }, '/sort_order'], [{ ...body, tenant_id: TENANT_B }, '/tenant_id'], [{ display_name: 'x', sort_order: 1 }, '/level_code']] as Array<[Row, string]>) {
      const e = await rejection(t.call('createControlLevel', { materialId: MAT(1), body: b })); expect(code(e)).toBe('common.validation_failed'); expect(e.errors.map((x: Row) => x['path'])).toContain(p);
    }
    expect(t.f.mutations()).toEqual([]);
  });
  const up = (t: ReturnType<typeof w>, patch: Row, o: Row = {}) => t.call('updateControlLevel', { levelId: LVL(1), expectedVersion: 1, patch, ...o });
  it('#7 display_name / sort_order / is_active change; 200 + version 2', async () => {
    const t = w(); const r = await up(t, { display_name: 'Low', sort_order: 9, is_active: false });
    expect(r.status).toBe(200); expect(r.version).toBe(2); expect(r.body).toMatchObject({ id: LVL(1), display_name: 'Low', sort_order: 9, is_active: false, level_code: '1' }); noLeak(r.body);
  });
  it('#7 If-Match: 428 / 409; level_code and material_id are immutable (unknown_field); another tenant -> 404', async () => {
    const t = w();
    expect(code(await rejection(up(t, { display_name: 'x' }, { expectedVersion: undefined })))).toBe('common.precondition_required');
    expect(code(await rejection(up(t, { display_name: 'x' }, { expectedVersion: 4 })))).toBe('common.version_conflict');
    for (const k of ['level_code', 'material_id', 'tenant_id']) expect((await rejection(up(t, { [k]: 'x' }))).errors[0]).toMatchObject({ path: `/${k}`, code: 'common.unknown_field' });
    expect(code(await rejection(up(t, { display_name: 'x' }, { levelId: LVL(9) })))).toBe('common.not_found'); expect(t.f.mutations()).toEqual([]);
  });
});

describe('AC-01.2 #8 createControlLot', () => {
  const mk = (t: ReturnType<typeof w>, body: Row, o: Row = {}) => t.call('createControlLot', { levelId: LVL(1), body, ...o });
  it('lot LOT-SYN-01 expiring 2027-03-31 is created (201, v1) and listed under that level; material_id comes from the level; is_expired=false', async () => {
    const t = w(); const r = await mk(t, { lot_no: 'LOT-SYN-01', expires_on: '2027-03-31' });
    expect(r.status).toBe(201); expect(r.version).toBe(1); expect(keys(r.body)).toEqual(LOT_KEYS);
    expect(r.body).toMatchObject({ lot_no: 'LOT-SYN-01', expires_on: '2027-03-31', level_id: LVL(1), material_id: MAT(1), is_expired: false, is_active: true }); expect(r.body.id).toMatch(UUID7); noLeak(r.body);
    expect((await t.call('listControlLots', { levelId: LVL(1) })).body.data.map((l: Row) => l['lot_no'])).toContain('LOT-SYN-01');
    expect((await t.call('getControlMaterial', { materialId: MAT(1) })).body.levels.find((l: Row) => l['id'] === LVL(1)).lots.map((l: Row) => l['lot_no'])).toContain('LOT-SYN-01');
  });
  it('expires_on earlier than today in the TENANT timezone -> 422 quality.lot_expired (HTTP 422); 2026-11-13 is today in UTC but yesterday in Asia/Kathmandu; nothing is inserted', async () => {
    const t = w(); const e = await rejection(mk(t, { lot_no: 'LOT-OLD', expires_on: '2026-11-13' }));
    expect(code(e)).toBe('quality.lot_expired'); expect(toProblem(e, '/v1/quality/control-levels/x/lots', REQ_ID).status).toBe(422); expect(t.f.callsOf('insertLot')).toEqual([]);
    expect(code(await rejection(mk(t, { lot_no: 'LOT-OLD', expires_on: '2020-01-01' })))).toBe('quality.lot_expired');
  });
  it('expires_on = today (2026-11-14, Kathmandu) is allowed; the lot is not expired yet', async () => {
    const t = w(); const r = await mk(t, { lot_no: 'LOT-TODAY', expires_on: TODAY }); expect(r.status).toBe(201); expect(r.body.is_expired).toBe(false);
  });
  it('the clock is ctx.now(): one minute later (2026-11-14T19:00Z = 15 Nov in Kathmandu) today moves on', async () => {
    const t = w(baseSeed(), { now: '2026-11-14T19:00:00.000Z' }); expect(code(await rejection(mk(t, { lot_no: 'LOT-TODAY', expires_on: TODAY })))).toBe('quality.lot_expired');
  });
  it('same lot_no twice on one level -> 409 quality.code_duplicate; the same lot_no on another level is fine', async () => {
    const t = w(); await mk(t, { lot_no: 'LOT-DUP', expires_on: '2027-01-01' });
    const e = await rejection(mk(t, { lot_no: 'LOT-DUP', expires_on: '2027-01-01' })); expect(code(e)).toBe('quality.code_duplicate'); expect(toProblem(e, '/x', REQ_ID).status).toBe(409);
    expect((await mk(t, { lot_no: 'LOT-DUP', expires_on: '2027-01-01' }, { levelId: LVL(2) })).status).toBe(201);
  });
  it('level of another tenant / unknown level -> 404 and no insert', async () => {
    const t = w(); expect(code(await rejection(mk(t, { lot_no: 'LOT-X', expires_on: '2027-01-01' }, { levelId: LVL(9) })))).toBe('common.not_found'); expect(t.f.mutations()).toEqual([]);
  });
  it.each([['missing lot_no', { expires_on: '2027-01-01' }, '/lot_no'], ['missing expires_on', { lot_no: 'LOT-X' }, '/expires_on'], ['2027-02-30', { lot_no: 'LOT-X', expires_on: '2027-02-30' }, '/expires_on'],
    ['2027-3-1', { lot_no: 'LOT-X', expires_on: '2027-3-1' }, '/expires_on'], ['datetime', { lot_no: 'LOT-X', expires_on: '2027-03-01T00:00:00Z' }, '/expires_on'], ['number', { lot_no: 'LOT-X', expires_on: 20270301 }, '/expires_on'],
    ['unknown field', { lot_no: 'LOT-X', expires_on: '2027-01-01', is_active: false }, '/is_active'], ['tenant_id', { lot_no: 'LOT-X', expires_on: '2027-01-01', tenant_id: TENANT_B }, '/tenant_id'],
  ])('%s -> 400 at %s', async (_n, body, path) => {
    const t = w(); const e = await rejection(mk(t, body as Row)); expect(code(e)).toBe('common.validation_failed'); expect(e.errors.map((x: Row) => x['path'])).toContain(path); expect(t.f.mutations()).toEqual([]);
  });
  it('lot_no is stored exactly as sent (not trimmed, inner spaces kept); a value the DB CHECK would refuse never reaches the repo (leading/trailing space -> 400 /lot_no)', async () => {
    const t = w(); expect((await mk(t, { lot_no: 'LOT A 1', expires_on: '2027-01-01' })).body.lot_no).toBe('LOT A 1'); expect(t.f.callsOf('insertLot')[0]!.args[0]).toMatchObject({ lot_no: 'LOT A 1' });
    for (const lot_no of [' LOT', 'LOT ', ' ', '', 'LOT\t1', 'LOT\n', 'LÖT', 'A'.repeat(65)]) {
      const e = await rejection(mk(t, { lot_no, expires_on: '2027-01-01' })); expect(code(e), JSON.stringify(lot_no)).toBe('common.validation_failed'); expect(e.errors.map((x: Row) => x['path'])).toContain('/lot_no');
    }
    expect(t.f.callsOf('insertLot')).toHaveLength(1);
  });
});

describe('#9 listControlLots / #10 updateControlLot', () => {
  it('filters (material_id, level_id, is_active, expires_on_to), sort and paging go to the repo; default sort expires_on, limit 50; DTO allowlist; only tenant A lots', async () => {
    const t = w(); const r = await t.call('listControlLots', {});
    expect(r.body.data.map((l: Row) => l['id']).sort()).toEqual([LOT(1), LOT(2)]); for (const l of r.body.data) { expect(keys(l)).toEqual(LOT_KEYS); noLeak(l); }
    expect(r.body.page).toEqual({ limit: 50 }); expect(t.f.callsOf('listLots')[0]!.args[0]).toMatchObject({ sort: 'expires_on', limit: 50 });
    await t.call('listControlLots', { materialId: MAT(1), levelId: LVL(2), isActive: true, expiresOnTo: '2027-01-01', sort: '-created_at', cursor: 'C', limit: 5 });
    expect(t.f.callsOf('listLots').at(-1)!.args[0]).toMatchObject({ materialId: MAT(1), levelId: LVL(2), isActive: true, expiresOnTo: '2027-01-01', sort: '-created_at', cursor: 'C', limit: 5 });
  });
  it('a filter id of another tenant yields an empty list, never B data (mixed-tenant ids in list filters, REQ-SEC-044)', async () => {
    const t = w(); expect((await t.call('listControlLots', { materialId: MAT(9) })).body.data).toEqual([]); expect((await t.call('listControlLots', { levelId: LVL(9) })).body.data).toEqual([]);
  });
  it.each([[{ expiresOnTo: '2027-13-01' }], [{ sort: 'lot_no' }], [{ limit: 500 }], [{ materialId: 'not-a-uuid' }], [{ isActive: 'yes' }]])('bad query %j -> 400', async (q) => { expect(code(await rejection(w().call('listControlLots', q)))).toBe('common.validation_failed'); });
  const up = (t: ReturnType<typeof w>, patch: Row, o: Row = {}) => t.call('updateControlLot', { lotId: LOT(1), expectedVersion: 1, patch, ...o });
  it('#10 expires_on / is_active change; 200 + version 2; is_expired recomputed', async () => {
    const t = w(); const r = await up(t, { expires_on: '2028-01-31', is_active: false }); expect(r.status).toBe(200); expect(r.version).toBe(2);
    expect(r.body).toMatchObject({ id: LOT(1), expires_on: '2028-01-31', is_active: false, is_expired: false, lot_no: 'LOT-SYN-1' }); noLeak(r.body);
  });
  it('#10 new expiry in the past (tenant date) -> 422 quality.lot_expired, no write; today is allowed', async () => {
    const t = w(); expect(code(await rejection(up(t, { expires_on: '2026-11-13' })))).toBe('quality.lot_expired'); expect(t.f.mutations()).toEqual([]);
    expect((await up(t, { expires_on: TODAY })).status).toBe(200);
  });
  it('#10 deactivating an already-expired lot works (the guard applies to a NEW expires_on only)', async () => {
    const t = w(seedWith((s) => s.lots!.push(lotRow(14, 1, 1, { expires_on: '2026-11-13' })))); const r = await up(t, { is_active: false }, { lotId: LOT(14) });
    expect(r.status).toBe(200); expect(r.body).toMatchObject({ is_active: false, is_expired: true });
  });
  it('#10 If-Match 428 / 409; lot_no, level_id, material_id are immutable (unknown_field); another tenant -> 404', async () => {
    const t = w();
    expect(code(await rejection(up(t, { is_active: false }, { expectedVersion: undefined })))).toBe('common.precondition_required');
    expect(code(await rejection(up(t, { is_active: false }, { expectedVersion: 2 })))).toBe('common.version_conflict');
    for (const k of ['lot_no', 'level_id', 'material_id', 'tenant_id']) expect((await rejection(up(t, { [k]: 'x' }))).errors[0]).toMatchObject({ path: `/${k}`, code: 'common.unknown_field' });
    expect(code(await rejection(up(t, { expires_on: 'soon' })))).toBe('common.validation_failed');
    expect(code(await rejection(up(t, { is_active: false }, { lotId: LOT(9) })))).toBe('common.not_found'); expect(t.f.mutations()).toEqual([]);
  });
});

describe('#11-#13 control-ID maps', () => {
  const body = (o: Row = {}) => ({ instrument_id: INS(1), control_id_raw: 'QC-L2', control_lot_raw: 'LOT-SYN-01', lot_id: LOT(1), ...o });
  const mk = (t: ReturnType<typeof w>, b: Row = body()) => t.call('createControlIdMap', { body: b });
  it('201 ControlIdMapDto (version 1) with the instrument label "display_name (instrument_code)" from the directory view; no tenant/actor columns', async () => {
    const t = w(); const r = await mk(t);
    expect(r.status).toBe(201); expect(r.version).toBe(1); expect(keys(r.body)).toEqual(MAP_KEYS);
    expect(r.body).toMatchObject({ instrument_id: INS(1), control_id_raw: 'QC-L2', control_lot_raw: 'LOT-SYN-01', lot_id: LOT(1), is_active: true, instrument_label: 'Synthetic chemistry analyser (SIM-CHEM-1)' }); noLeak(r.body);
    expect(t.f.callsOf('insertMap')[0]).toMatchObject({ tenantId: TENANT_A }); expect(t.f.callsOf('insertMap')[0]!.args[0]).toMatchObject({ created_by: expect.any(String) });
  });
  it('control_lot_raw absent = any lot: stored as null, omitted from the DTO', async () => {
    const t = w(); const { control_lot_raw: _c, ...b } = body(); const r = await mk(t, b);
    expect(r.status).toBe(201); expect(r.body).not.toHaveProperty('control_lot_raw'); expect(t.f.callsOf('insertMap')[0]!.args[0]).toMatchObject({ control_lot_raw: null });
  });
  it('creating a map enqueues quality.reprocess_pending_observations for the instrument, once, in the request tx (job key reproc:<instrument_id>)', async () => {
    const t = w(); await mk(t);
    expect(t.enqueues()).toEqual([{ task: 'quality.reprocess_pending_observations', payload: { tenant_id: TENANT_A, instrument_id: INS(1) }, key: `reproc:${INS(1)}` }]);
  });
  it('the enqueue is not swallowed: a queue failure fails the request (the core rolls the tx back)', async () => {
    const t = w(baseSeed(), { enqueueFails: true }); await expect(mk(t)).rejects.toThrow();
  });
  it('AC-02.5 instrument_id that does not exist in the tenant (FK violation) -> 400 common.validation_failed at /instrument_id (not 500, not 409); no enqueue; value not echoed', async () => {
    const t = w(); const e = await rejection(mk(t, body({ instrument_id: INS(99) })));
    expect(code(e)).toBe('common.validation_failed'); expect(e.errors).toEqual([expect.objectContaining({ path: '/instrument_id' })]); expect(toProblem(e, '/v1/quality/control-id-maps', REQ_ID).status).toBe(400);
    expect(JSON.stringify([e.message, e.detail, e.errors, toProblem(e, '/x', REQ_ID)])).not.toContain(INS(99)); expect(t.enqueues()).toEqual([]);
  });
  it('S-04 / AB-11 an instrument of tenant B in the body is the same 400 at /instrument_id, nothing in B is touched', async () => {
    const t = w(); const e = await rejection(mk(t, body({ instrument_id: INS_B }))); expect(code(e)).toBe('common.validation_failed'); expect(e.errors[0]).toMatchObject({ path: '/instrument_id' });
    expect(t.f.calls.every((c) => c.tenantId === TENANT_A)).toBe(true); expect(t.enqueues()).toEqual([]);
  });
  it('S-04 a lot of tenant B / an unknown lot -> 400 at /lot_id, no insert, no enqueue', async () => {
    const t = w(); for (const lot_id of [LOT(9), LOT(77)]) { const e = await rejection(mk(t, body({ lot_id }))); expect(code(e)).toBe('common.validation_failed'); expect(e.errors[0]).toMatchObject({ path: '/lot_id' }); }
    expect(t.f.callsOf('insertMap')).toEqual([]); expect(t.enqueues()).toEqual([]);
  });
  it('a lot that has expired (tenant date) -> 422 quality.lot_expired (HTTP 422); no insert; no enqueue', async () => {
    const t = w(seedWith((s) => s.lots!.push(lotRow(14, 1, 1, { expires_on: '2026-11-13' })))); const e = await rejection(mk(t, body({ lot_id: LOT(14) })));
    expect(code(e)).toBe('quality.lot_expired'); expect(toProblem(e, '/x', REQ_ID).status).toBe(422); expect(t.f.callsOf('insertMap')).toEqual([]); expect(t.enqueues()).toEqual([]);
  });
  it('same (instrument, control_id_raw, lot_raw) twice while active -> 409 quality.code_duplicate, no second enqueue; a wildcard and an exact map for the same control id coexist; a deactivated map no longer blocks', async () => {
    const t = w(); const first = await mk(t); const e = await rejection(mk(t)); expect(code(e)).toBe('quality.code_duplicate'); expect(toProblem(e, '/x', REQ_ID).status).toBe(409); expect(t.enqueues()).toHaveLength(1);
    const { control_lot_raw: _c, ...wild } = body(); expect((await mk(t, wild)).status).toBe(201); expect((await mk(t, body({ control_lot_raw: 'LOT-SYN-02' }))).status).toBe(201);
    await t.call('deactivateControlIdMap', { mapId: first.body.id, expectedVersion: 1 }); expect((await mk(t)).status).toBe(201);
  });
  it.each([['empty control_id_raw', { control_id_raw: '' }, '/control_id_raw'], ['65-char control_id_raw', { control_id_raw: 'x'.repeat(65) }, '/control_id_raw'], ['empty control_lot_raw', { control_lot_raw: '' }, '/control_lot_raw'],
    ['65-char control_lot_raw', { control_lot_raw: 'x'.repeat(65) }, '/control_lot_raw'], ['instrument_id not a uuid', { instrument_id: 'SIM-CHEM-1' }, '/instrument_id'], ['lot_id not a uuid', { lot_id: '1' }, '/lot_id'],
    ['tenant_id in body', { tenant_id: TENANT_B }, '/tenant_id'], ['is_active in body', { is_active: false }, '/is_active'], ['null control_lot_raw', { control_lot_raw: null }, '/control_lot_raw'],
  ])('%s -> 400 at %s', async (_n, o, path) => { const t = w(); const e = await rejection(mk(t, body(o as Row))); expect(code(e)).toBe('common.validation_failed'); expect(e.errors.map((x: Row) => x['path'])).toContain(path); expect(t.f.mutations()).toEqual([]); expect(t.enqueues()).toEqual([]); });
  it.each(['instrument_id', 'lot_id', 'control_id_raw'])('missing %s -> 400 at /%s', async (k) => { const t = w(); const b: Row = body(); delete b[k]; const e = await rejection(mk(t, b)); expect(e.errors.map((x: Row) => x['path'])).toContain(`/${k}`); });

  it('#11 lists maps of the tenant with labels; filters instrument_id / lot_id / is_active go to the repo; a map whose instrument is not in the directory has no label key', async () => {
    const t = w(seedWith((s) => s.maps!.push(mapRow(1, 1), mapRow(2, 2, { instrument_id: INS(50), control_lot_raw: 'X' }))));
    const r = await t.call('listControlIdMaps', {}); expect(r.status).toBe(200); expect(r.body.data.map((m: Row) => m['id']).sort()).toEqual([MAP(1), MAP(2)]); expect(r.body.page).toEqual({ limit: 50 });
    const m1 = r.body.data.find((m: Row) => m['id'] === MAP(1)), m2 = r.body.data.find((m: Row) => m['id'] === MAP(2));
    expect(keys(m1)).toEqual(MAP_KEYS.filter((k) => k !== 'control_lot_raw')); expect(m1.instrument_label).toBe('Synthetic chemistry analyser (SIM-CHEM-1)'); expect(m2).not.toHaveProperty('instrument_label'); noLeak(r.body);
    await t.call('listControlIdMaps', { instrumentId: INS(1), lotId: LOT(1), isActive: false, cursor: 'C', limit: 7 });
    expect(t.f.callsOf('listMaps').at(-1)!.args[0]).toMatchObject({ instrumentId: INS(1), lotId: LOT(1), isActive: false, cursor: 'C', limit: 7 });
    expect((await t.call('listControlIdMaps', { instrumentId: INS_B })).body.data).toEqual([]);
  });
  it('#13 deactivate: 200, is_active=false, version 2; 428 / 409 / 404 (other tenant); no enqueue', async () => {
    const t = w(seedWith((s) => s.maps!.push(mapRow(1, 1)))); const r = await t.call('deactivateControlIdMap', { mapId: MAP(1), expectedVersion: 1 });
    expect(r.status).toBe(200); expect(r.version).toBe(2); expect(r.body).toMatchObject({ id: MAP(1), is_active: false, version: 2 });
    const c = (o: Row) => rejection(t.call('deactivateControlIdMap', { mapId: MAP(1), expectedVersion: 2, ...o }));
    expect([code(await c({ expectedVersion: undefined })), code(await c({ expectedVersion: 1 })), code(await c({ mapId: MAP(9) }))]).toEqual(['common.precondition_required', 'common.version_conflict', 'common.not_found']);
    expect(t.enqueues()).toEqual([]);
  });
});

describe('S-07 / AC-01.3 authorisation (02-TRD §5.0): quality.qc_run.read for #1 #3 #9 #11, quality.qc.manage for every write', () => {
  const READS: Array<[string, Row]> = [['listControlMaterials', {}], ['getControlMaterial', { materialId: MAT(1) }], ['listControlLots', {}], ['listControlIdMaps', {}]];
  const WRITES: Array<[string, Row]> = [
    ['createControlMaterial', { body: MAT_BODY }], ['updateControlMaterial', { materialId: MAT(1), expectedVersion: 1, patch: { name: 'x' } }], ['deactivateControlMaterial', { materialId: MAT(1), expectedVersion: 1 }],
    ['createControlLevel', { materialId: MAT(1), body: { level_code: '3', display_name: 'L3', sort_order: 3 } }], ['updateControlLevel', { levelId: LVL(1), expectedVersion: 1, patch: { display_name: 'x' } }],
    ['createControlLot', { levelId: LVL(1), body: { lot_no: 'LOT-N', expires_on: '2027-01-01' } }], ['updateControlLot', { lotId: LOT(1), expectedVersion: 1, patch: { is_active: false } }],
    ['createControlIdMap', { body: { instrument_id: INS(1), control_id_raw: 'QC-1', lot_id: LOT(1) } }], ['deactivateControlIdMap', { mapId: MAP(1), expectedVersion: 1 }],
  ];
  it('the 13 operations are exactly the ones asserted here', () => { expect([...READS, ...WRITES].map(([o]) => o).sort()).toEqual([...OPS].sort()); });
  it.each(WRITES)('lab_technologist (read only): %s -> 403 auth.forbidden, no repo write, no enqueue', async (op, input) => {
    const t = w(seedWith((s) => s.maps!.push(mapRow(1, 1))), { roles: readOnly }); const e = await rejection(t.call(op, input));
    expect(code(e)).toBe('auth.forbidden'); expect(toProblem(e, '/x', REQ_ID).status).toBe(403); expect(t.f.mutations()).toEqual([]); expect(t.enqueues()).toEqual([]);
  });
  it.each(WRITES)('%s asks for quality.qc.manage (and nothing weaker)', async (op, input) => {
    const t = w(seedWith((s) => s.maps!.push(mapRow(1, 1)))); await t.call(op, input);
    expect(t.asserted.length).toBeGreaterThan(0); expect(t.asserted.every((a) => a.permission === 'quality.qc.manage')).toBe(true);
  });
  it.each(READS)('lab_technologist can read: %s -> 200; it asks for quality.qc_run.read', async (op, input) => {
    const t = w(baseSeed(), { roles: readOnly }); expect((await t.call(op, input)).status).toBe(200); expect(t.asserted.map((a) => a.permission)).toEqual(expect.arrayContaining(['quality.qc_run.read']));
  });
  it.each(READS)('a user with no quality rights: %s -> 403 and the repo is never asked', async (op, input) => {
    const t = w(baseSeed(), { roles: noRights }); expect(code(await rejection(t.call(op, input)))).toBe('auth.forbidden'); expect(t.f.calls).toEqual([]);
  });
});

describe('S-01 / REQ-SEC-002 tenant isolation across all 13 operations (RLS tenants A and B)', () => {
  const PROBES: Array<[string, Row, string]> = [   // tenant-B ids presented by a tenant-A caller -> what the caller sees
    ['getControlMaterial', { materialId: MAT(9) }, 'common.not_found'], ['updateControlMaterial', { materialId: MAT(9), expectedVersion: 1, patch: { name: 'x' } }, 'common.not_found'],
    ['deactivateControlMaterial', { materialId: MAT(9), expectedVersion: 1 }, 'common.not_found'], ['createControlLevel', { materialId: MAT(9), body: { level_code: '5', display_name: 'x', sort_order: 1 } }, 'common.not_found'],
    ['updateControlLevel', { levelId: LVL(9), expectedVersion: 1, patch: { display_name: 'x' } }, 'common.not_found'], ['createControlLot', { levelId: LVL(9), body: { lot_no: 'X-1', expires_on: '2027-01-01' } }, 'common.not_found'],
    ['updateControlLot', { lotId: LOT(9), expectedVersion: 1, patch: { is_active: false } }, 'common.not_found'], ['deactivateControlIdMap', { mapId: MAP(9), expectedVersion: 1 }, 'common.not_found'],
    ['createControlIdMap', { body: { instrument_id: INS(1), control_id_raw: 'Q', lot_id: LOT(9) } }, 'common.validation_failed'], ['createControlIdMap', { body: { instrument_id: INS_B, control_id_raw: 'Q', lot_id: LOT(1) } }, 'common.validation_failed'],
  ];
  it.each(PROBES)('tenant A -> tenant B ids: %s %#', async (op, input, expected) => {
    const t = w(); expect(code(await rejection(t.call(op, input)))).toBe(expected);
    expect(t.f.mutations().filter((m) => m.op !== 'insertMap')).toEqual([]); expect(t.f.materials.concat(t.f.levels, t.f.lots, t.f.maps).filter((r) => r['tenant_id'] === TENANT_B).every((r) => r['version'] === 1 && r['is_active'] !== false)).toBe(true);
    expect(t.enqueues()).toEqual([]); expect(t.f.calls.every((c) => c.tenantId === TENANT_A)).toBe(true);
  });
  it('lists never contain tenant B rows, and tenant B sees only its own (including the code both tenants use)', async () => {
    const a = w(), b = w(baseSeed(), { tenantId: TENANT_B });
    const ids = async (x: ReturnType<typeof w>, op: string, q: Row = {}) => (await x.call(op, q)).body.data.map((r: Row) => r['id']);
    expect(await ids(a, 'listControlMaterials')).not.toContain(MAT(9)); expect(await ids(a, 'listControlLots')).not.toContain(LOT(9)); expect(await ids(a, 'listControlIdMaps')).not.toContain(MAP(9));
    expect(await ids(b, 'listControlMaterials')).toEqual([MAT(9)]); expect(await ids(b, 'listControlLots')).toEqual([LOT(9)]); expect(await ids(b, 'listControlIdMaps')).toEqual([MAP(9)]);
    expect((await b.call('getControlMaterial', { materialId: MAT(9) })).body.levels.flatMap((l: Row) => l['lots']).map((l: Row) => l['id'])).toEqual([LOT(9)]);
  });
  it('every repo call of every operation carries the caller\'s tenant id', async () => {
    const t = w(); await Promise.allSettled([...PROBES.map(([op, i]) => t.call(op, i)), t.call('listControlMaterials', {}), t.call('getControlMaterial', { materialId: MAT(1) }), t.call('listControlLots', {}), t.call('listControlIdMaps', {})]);
    expect(t.f.calls.length).toBeGreaterThan(10); expect(t.f.calls.every((c) => c.tenantId === TENANT_A)).toBe(true);
  });
});

describe('HTTP contract per error code (contracts/errors.yaml via the core problem renderer; REQ-SEC-095)', () => {
  it.each([['quality.code_duplicate', 409], ['quality.lot_expired', 422], ['common.validation_failed', 400], ['common.precondition_required', 428], ['common.version_conflict', 409], ['common.not_found', 404], ['auth.forbidden', 403]])('%s -> %i', async (c, status) => {
    const t = w(); const thrown: Record<string, () => Promise<unknown>> = {
      'quality.code_duplicate': () => t.call('createControlMaterial', { body: { ...MAT_BODY, code: 'MCS-SYN' } }), 'quality.lot_expired': () => t.call('createControlLot', { levelId: LVL(1), body: { lot_no: 'PLANTED-LOT-9', expires_on: '2020-01-01' } }),
      'common.validation_failed': () => t.call('createControlMaterial', { body: { ...MAT_BODY, code: 'bad code' } }), 'common.precondition_required': () => t.call('updateControlMaterial', { materialId: MAT(1), patch: { name: 'x' } }),
      'common.version_conflict': () => t.call('updateControlMaterial', { materialId: MAT(1), expectedVersion: 9, patch: { name: 'x' } }), 'common.not_found': () => t.call('getControlMaterial', { materialId: MAT(77) }),
      'auth.forbidden': () => w(baseSeed(), { roles: () => { throw forbidden(); } }).call('createControlMaterial', { body: MAT_BODY }),
    };
    const e = await rejection(thrown[c]!()); const p = toProblem(e, '/v1/quality/x', REQ_ID);
    expect(p).toMatchObject({ code: c, status }); const s = JSON.stringify(p); expect(s).not.toMatch(/PLANTED|MCS-SYN|MCS-NEW|SELECT |INSERT |at .*\.ts/);
  });
});
