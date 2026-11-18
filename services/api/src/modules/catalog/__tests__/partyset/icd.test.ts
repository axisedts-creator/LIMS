// T0B-PARTYSET-1 done_when (1,2,7) ICD master (catalog.icd_code): list, search, create, update, deactivate. Real PG17, additive to the catalog module.
// Pins: code ^[0-9A-Z][0-9A-Z.]{0,15}$ unique per tenant (dup -> common.validation_failed /code, same code fine in another tenant), title 1..500, chapter 1..120, code never changes,
// If-Match on update / deactivate, deactivate keeps the row (is_active false), search needs q and answers at most `limit` (1..50, default 20) rows of the caller's tenant,
// needs catalog.icd.manage, tenant isolation (another tenant's id = common.not_found).
import { beforeEach, describe, expect, it } from 'vitest';
import { manifest } from '../../index.js';
import { ADMIN_A, ADMIN_B, P, T, TENANT_A, TENANT_B, dbRow, dbRows, fire, forbidden, idem, ifm, mkIcd, noWrites, notFound, ok, only, rejected, req, wipe } from '../../../partners/__tests__/partyset/helpers.js';

const M = { manifest: manifest as never };
const create = (body: unknown, who = ADMIN_A) => fire('createIcdMasterCode', req({ headers: idem(), body }), who, M);
const update = (id: string, body: unknown, v = 1, who = ADMIN_A) => fire('updateIcdMasterCode', req({ params: { icd_code_id: id }, headers: ifm(v), body }), who, M);
const deact = (id: string, v = 1, who = ADMIN_A) => fire('deactivateIcdMasterCode', req({ params: { icd_code_id: id }, headers: ifm(v) }), who, M);
const list = (q: object = {}, who = ADMIN_A) => fire('listIcdMasterCodes', req({ query: q }), who, M);
const search = (q: object, who = ADMIN_A) => fire('searchIcdMasterCodes', req({ query: q }), who, M);
const IDS = ['listIcdMasterCodes', 'searchIcdMasterCodes', 'createIcdMasterCode', 'updateIcdMasterCode', 'deactivateIcdMasterCode'];

beforeEach(async () => { await wipe(TENANT_A, TENANT_B); }, T);

describe('registration', () => {
  it.each(IDS)('%s has a handler and is not pending', (id) => {
    expect(typeof (manifest.handlers as Record<string, unknown>)[id]).toBe('function');
    expect(((manifest as { pendingOperations?: readonly string[] }).pendingOperations ?? [])).not.toContain(id);
  });
  it('every operation needs catalog.icd.manage', async () => {
    const w = only(1, P.priceRead, P.referrerManage, P.settingManage);
    for (const o of [await create({ code: 'A00', title: 'x' }, w), await list({}, w), await search({ q: 'a' }, w), await update('01a1a98a-ac40-7000-8000-00000000dead', { title: 'x' }, 1, w), await deact('01a1a98a-ac40-7000-8000-00000000dead', 1, w)]) {
      forbidden(o);
      expect(o.probe.identity).toContain(P.icd);
      expect(o.probe.writes).toEqual([]);
    }
  }, T);
});

describe('create', () => {
  it('201: active, version 1, fields echoed; the row is stored under the caller tenant', async () => {
    const b = ok(await create({ code: 'E11.9', title: 'Synthetic: type 2 diabetes', chapter: 'Chapter IV (synthetic)' }), 201);
    expect(b).toMatchObject({ code: 'E11.9', title: 'Synthetic: type 2 diabetes', chapter: 'Chapter IV (synthetic)', is_active: true, version: 1 });
    expect(await dbRow('catalog.icd_code', b.id)).toMatchObject({ tenant_id: TENANT_A, code: 'E11.9' });
    ok(await create({ code: 'J45' , title: 'Synthetic: asthma' }), 201);
  }, T);
  it('a used code is /code; the same code in another tenant is fine', async () => {
    ok(await create({ code: 'A00', title: 'one' }), 201);
    const o = await create({ code: 'A00', title: 'two' });
    rejected(o, 'common.validation_failed', '/code');
    ok(await create({ code: 'A00', title: 'two B' }, ADMIN_B), 201);
    expect(await dbRows('catalog.icd_code', "code = 'A00'")).toHaveLength(2);
  }, T);
  it.each([
    [{ code: 'e11', title: 'x' }, '/code'], [{ code: '.A1', title: 'x' }, '/code'], [{ code: 'A'.repeat(17), title: 'x' }, '/code'], [{ code: '', title: 'x' }, '/code'], [{ code: 'A 1', title: 'x' }, '/code'], [{ code: 5, title: 'x' }, '/code'],
    [{ code: 'A00', title: '' }, '/title'], [{ code: 'A00', title: 't'.repeat(501) }, '/title'], [{ code: 'A00' }, '/title'], [{ code: 'A00', title: 'x', chapter: '' }, '/chapter'],
    [{ code: 'A00', title: 'x', chapter: 'c'.repeat(121) }, '/chapter'], [{ title: 'x' }, '/code'], [{ code: 'A00', title: 'x', is_active: false }, '*'],
  ])('%j is refused at %s, nothing written', async (body, path) => {
    const o = await create(body);
    rejected(o, 'common.validation_failed', path);
    noWrites(o);
  }, T);
  it('the limits are valid: a 16 character code, a 500 character title, a 120 character chapter, a code starting with a digit', async () => {
    ok(await create({ code: '1' + 'A.'.repeat(7) + 'B', title: 't'.repeat(500), chapter: 'c'.repeat(120) }), 201);
  }, T);
});

describe('update and deactivate', () => {
  it('update title / chapter with If-Match (version + 1); the code never changes', async () => {
    const a = await mkIcd(TENANT_A, 'B20', 'Synthetic old title');
    expect(ok(await update(a.id, { title: 'Synthetic new title', chapter: 'Chapter I' }))).toMatchObject({ code: 'B20', title: 'Synthetic new title', chapter: 'Chapter I', version: 2 });
    rejected(await update(a.id, { code: 'B21' }, 2), 'common.validation_failed', '*');
    rejected(await update(a.id, {}, 2), 'common.validation_failed', '*');
    rejected(await update(a.id, { title: '' }, 2), 'common.validation_failed', '/title');
    expect(await dbRow('catalog.icd_code', a.id)).toMatchObject({ code: 'B20', version: 2 });
  }, T);
  it('stale If-Match -> version_conflict, missing -> precondition_required', async () => {
    const a = await mkIcd(TENANT_A, 'B20', 'x');
    rejected(await update(a.id, { title: 'y' }, 5), 'common.version_conflict');
    rejected(await fire('updateIcdMasterCode', req({ params: { icd_code_id: a.id }, body: { title: 'y' } }), ADMIN_A, M), 'common.precondition_required');
    rejected(await deact(a.id, 5), 'common.version_conflict');
    rejected(await fire('deactivateIcdMasterCode', req({ params: { icd_code_id: a.id } }), ADMIN_A, M), 'common.precondition_required');
  }, T);
  it('deactivate keeps the row with is_active false; the list hides it by is_active filter and search no longer offers it', async () => {
    const a = await mkIcd(TENANT_A, 'C50', 'Synthetic carcinoma of breast');
    expect(ok(await deact(a.id))).toMatchObject({ is_active: false, version: 2, code: 'C50' });
    expect(await dbRow('catalog.icd_code', a.id)).toMatchObject({ is_active: false });
    expect(ok(await list({ is_active: true })).data.map((x: any) => x.id)).not.toContain(a.id);
    expect(ok(await list({ is_active: false })).data.map((x: any) => x.id)).toContain(a.id);
    expect(ok(await search({ q: 'C50' })).data.map((x: any) => x.id)).not.toContain(a.id);
  }, T);
  it('another tenant and an unknown id are common.not_found; the row is unchanged', async () => {
    const a = await mkIcd(TENANT_A, 'D50', 'x');
    notFound(await update(a.id, { title: 'hacked' }, 1, ADMIN_B));
    notFound(await deact(a.id, 1, ADMIN_B));
    notFound(await update('01a1a98a-ac40-7000-8000-00000000dead', { title: 'x' }));
    expect(await dbRow('catalog.icd_code', a.id)).toMatchObject({ title: 'x', is_active: true, version: 1 });
  }, T);
});

describe('list and search', () => {
  it('list: q matches code and title case insensitively, chapter filter, tenant isolation, cursor paging in a stable order', async () => {
    const rows = [await mkIcd(TENANT_A, 'E10', 'Synthetic type 1 diabetes', { chapter: 'Endocrine' }), await mkIcd(TENANT_A, 'E11', 'Synthetic type 2 diabetes', { chapter: 'Endocrine' }), await mkIcd(TENANT_A, 'J45', 'Synthetic asthma', { chapter: 'Respiratory' })];
    await mkIcd(TENANT_B, 'E12', 'Synthetic diabetes elsewhere');
    expect(ok(await list()).data.map((x: any) => x.code).sort()).toEqual(['E10', 'E11', 'J45']);
    expect(ok(await list({ q: 'DIABETES' })).data.map((x: any) => x.code).sort()).toEqual(['E10', 'E11']);
    expect(ok(await list({ q: 'j45' })).data.map((x: any) => x.code)).toEqual(['J45']);
    expect(ok(await list({ chapter: 'Respiratory' })).data.map((x: any) => x.id)).toEqual([rows[2]!.id]);
    const p1 = ok(await list({ limit: 2 }));
    const p2 = ok(await list({ limit: 2, cursor: p1.page.next_cursor }));
    expect([...p1.data, ...p2.data].map((x: any) => x.code)).toEqual(expect.arrayContaining(['E10', 'E11', 'J45']));
    expect(new Set([...p1.data, ...p2.data].map((x: any) => x.id)).size).toBe(3);
    rejected(await list({ cursor: 'garbage' }), 'common.invalid_cursor');
  }, T);
  it('search needs q (1..64), honours limit 1..50 (default 20), finds a code prefix, and never shows another tenant', async () => {
    for (let i = 0; i < 25; i++) await mkIcd(TENANT_A, `Z${String(i).padStart(2, '0')}`, `Synthetic zebra condition ${i}`);
    await mkIcd(TENANT_B, 'Z99', 'Synthetic zebra elsewhere');
    expect(ok(await search({ q: 'zebra' })).data).toHaveLength(20);
    expect(ok(await search({ q: 'zebra', limit: 5 })).data).toHaveLength(5);
    expect(ok(await search({ q: 'zebra', limit: 50 })).data).toHaveLength(25);
    expect(ok(await search({ q: 'Z0' })).data.every((x: any) => x.code.startsWith('Z0'))).toBe(true);
    expect(JSON.stringify(ok(await search({ q: 'zebra', limit: 50 })))).not.toContain('Z99');
    for (const q of [{}, { q: '' }, { q: 'x'.repeat(65) }, { q: 'zebra', limit: 0 }, { q: 'zebra', limit: 51 }, { q: 'zebra', limit: 1.5 }]) rejected(await search(q), 'common.validation_failed', '*');
  }, T);
});
