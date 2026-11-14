// T-12 (C3) — HTTP contract + probes for #52 listPanels, #53 createPanel, #54 getPanelDetail, #55 updatePanel, #56 replacePanelMembers, #3 resolveOrderablesPreview.
// Spec: 06-PLAN T-12, 02-TRD §5.2 (permissions / idempotency / If-Match; #3 is a read-only POST: no If-Match, no Idempotency-Key), §5.0; 07-SECURITY S-1, S-4 (x-permission
//       floor), S-5, S-16, AB-20; CR-C3-008 (stubs leave probes/pending.json when swapped).
// Same conventions as tests.handlers.test.ts: handlers driven with a request-shaped object + the service's HandlerContext subset; responses validated against the OpenAPI
// schemas. Path param is `panel_id`; If-Match arrives as the raw header '"<n>"'; context without tenantId/actor/tx/events -> auth.unauthenticated.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isLimsError } from '../../../../core/errors.js';
import { REPO_ROOT, loadSpec, operationIds } from '../../../../core/module.js';
import { handlers } from '../../handlers/index.js';
import { manifest } from '../../index.js';
import { TENANT_A, TENANT_B } from '../helpers/catalogDb.js';
import { BASIC, CBC, HP_ELITE_M, ID, LIPID, PANEL_B, T, TC, TEST_B, HDL, mem, pBody, rejection, setup12 } from '../helpers/t12.js';

const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/catalog.yaml'));
const requireAjv = createRequire(createRequire(import.meta.url).resolve('@fastify/ajv-compiler'));
const Ajv2020 = requireAjv('ajv/dist/2020.js').default as new (o: object) => any;
const ajv = new Ajv2020({ strict: false, allErrors: true });
const validatorFor = (name: string) => {
  const v = ajv.compile({ $ref: `#/components/schemas/${name}`, components: spec.components });
  return (x: unknown) => { const ok = v(x); return ok ? [] : (v.errors as any[]).map((e) => `${e.instancePath} ${e.message}`); };
};
const opOf = (id: string): any => { for (const p of Object.values<any>(spec.paths)) for (const m of Object.values<any>(p)) if (m?.operationId === id) return m; };

const IDS = ['listPanels', 'createPanel', 'getPanelDetail', 'updatePanel', 'replacePanelMembers', 'resolveOrderablesPreview'] as const;
const H = handlers as Record<string, (req: any, ctx: any) => Promise<{ status: number; body?: any; headers?: Record<string, string> }>>;
const req = (o: { params?: object; query?: object; headers?: object; body?: unknown } = {}) => ({ params: {}, query: {}, headers: {}, body: undefined, ...o });
const bare = (operationId: string) => ({ operationId, clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} } });
const snap = (db: ReturnType<typeof setup12>['db']) => JSON.stringify({ o: db.rows('orderables'), p: db.rows('panels'), m: db.rows('panel_members'), ev: db.events.length });

describe('contract: the six operations exist with the TRD permissions / idempotency / If-Match (S-4, S-16)', () => {
  it('operationIds are in catalog.yaml and in the manifest handlers', () => {
    const ids = operationIds(spec);
    for (const id of IDS) { expect(ids).toContain(id); expect(typeof (manifest.handlers as any)[id]).toBe('function'); expect((manifest.handlers as any)[id]).toBe(H[id]); }
  });
  it('reads need catalog.test.read, writes catalog.test.manage; only createPanel needs an Idempotency-Key; update/replace need If-Match; #3 has neither (E3 read-only POST)', () => {
    for (const id of ['listPanels', 'getPanelDetail', 'resolveOrderablesPreview']) { expect(opOf(id)['x-permission']).toBe('catalog.test.read'); expect(opOf(id)['x-idempotency']).toBe('none'); }
    for (const id of ['createPanel', 'updatePanel', 'replacePanelMembers']) expect(opOf(id)['x-permission']).toBe('catalog.test.manage');
    expect(opOf('createPanel')['x-idempotency']).toBe('required');
    for (const id of ['updatePanel', 'replacePanelMembers']) { expect(opOf(id)['x-idempotency']).toBe('none'); expect(JSON.stringify(opOf(id).parameters)).toContain('IfMatch'); }
    expect(JSON.stringify(opOf('resolveOrderablesPreview').parameters ?? [])).not.toMatch(/IfMatch|IdempotencyKey/);
  });
  it('request schemas are strict and carry no server-owned fields (REQ-SEC-080); code and panel_kind are not patchable', () => {
    for (const n of ['PanelCreate', 'PanelUpdate', 'PanelMembersReplace', 'PanelMember', 'OrderableResolveRequest']) {
      const s = spec.components.schemas[n];
      expect(s.additionalProperties, n).toBe(false);
      for (const k of ['tenant_id', 'version', 'revision', 'created_by', 'updated_by', 'kind', 'is_orderable', 'status']) {
        if (n === 'PanelMember' && k === 'kind') continue;                         // a member's `kind` is declared
        expect(Object.keys(s.properties), `${n}.${k}`).not.toContain(k);
      }
    }
    expect(Object.keys(spec.components.schemas['PanelUpdate'].properties)).not.toContain('code');
    expect(Object.keys(spec.components.schemas['PanelUpdate'].properties)).not.toContain('panel_kind');
    expect(Object.keys(spec.components.schemas['PanelUpdate'].properties)).not.toContain('members');
  });
});

describe('probes (CR-C3-008): the six stubs are gone', () => {
  const pending: string[] = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'probes', 'pending.json'), 'utf8'));
  it('none of the six operationIds is listed in probes/pending.json any more', () => {
    for (const id of IDS) expect(pending, id).not.toContain(id);
  });
  it.each(IDS)('%s does not answer 503 common.service_unavailable / not_implemented', { timeout: T }, async (id) => {
    const env = setup12();
    const e = await env.db.run((ctx) => H[id]!(req({ params: { panel_id: ID(0x1) }, headers: { 'if-match': '"1"', 'idempotency-key': 'k-1' }, body: {} }), ctx)).then(() => undefined, (x) => x);
    expect(e?.code).not.toBe('common.service_unavailable');
    expect(e?.detail).not.toBe('not_implemented');
  });
});

describe('handlers over the service, validated against the OpenAPI schemas', () => {
  it('createPanel -> 201 with a body that is exactly the contract Panel; the Idempotency-Key header is accepted', { timeout: T }, async () => {
    const { db } = setup12();
    const r = await db.run((ctx) => H['createPanel']!(req({ headers: { 'idempotency-key': 'k-1' }, body: pBody({ code: 'hp2', panel_kind: 'package', sex_restriction: 'female',
      members: [mem('test', CBC.test.id, 1), mem('panel', LIPID.panel.id, 2)] }) }), ctx));
    expect(r.status).toBe(201);
    expect(validatorFor('Panel')(r.body)).toEqual([]);
    expect(r.body).toMatchObject({ code: 'HP2', panel_kind: 'package', sex_restriction: 'female', version: 1, is_active: true });
  });
  it('getPanelDetail -> 200 Panel; path param is panel_id', { timeout: T }, async () => {
    const { db } = setup12();
    const r = await db.run((ctx) => H['getPanelDetail']!(req({ params: { panel_id: HP_ELITE_M.panel.id } }), ctx));
    expect(r.status).toBe(200);
    expect(validatorFor('Panel')(r.body)).toEqual([]);
    expect(r.body).toMatchObject({ id: HP_ELITE_M.panel.id, code: 'HP_ELITE_M', panel_kind: 'package', sex_restriction: 'male' });
  });
  it('updatePanel with If-Match "1" -> 200 Panel version 2', { timeout: T }, async () => {
    const { db } = setup12();
    const r = await db.run((ctx) => H['updatePanel']!(req({ params: { panel_id: BASIC.panel.id }, headers: { 'if-match': '"1"' }, body: { name: 'Basic v2', unset: ['department_id'] } }), ctx));
    expect(r.status).toBe(200);
    expect(validatorFor('Panel')(r.body)).toEqual([]);
    expect(r.body).toMatchObject({ name: 'Basic v2', version: 2 });
  });
  it('replacePanelMembers with If-Match "1" -> 200 Panel with the new members', { timeout: T }, async () => {
    const { db } = setup12();
    const r = await db.run((ctx) => H['replacePanelMembers']!(req({ params: { panel_id: BASIC.panel.id }, headers: { 'if-match': '"1"' }, body: { members: [mem('test', TC.test.id, 1), mem('test', HDL.test.id, 2)] } }), ctx));
    expect(r.status).toBe(200);
    expect(validatorFor('Panel')(r.body)).toEqual([]);
    expect(r.body.members).toEqual([mem('test', TC.test.id, 1), mem('test', HDL.test.id, 2)]);
    expect(r.body.version).toBe(2);
  });
  it('listPanels -> 200 exactly the contract PanelPage; next_cursor appears when more rows exist', { timeout: T }, async () => {
    const { db } = setup12();
    const r = await db.run((ctx) => H['listPanels']!(req(), ctx));
    expect(r.status).toBe(200);
    expect(validatorFor('PanelPage')(r.body)).toEqual([]);
    expect(r.body.data.map((x: any) => x.code)).toEqual(['BASIC', 'HP_ELITE_M', 'LIPID']);
    const page = await db.run((ctx) => H['listPanels']!(req({ query: { limit: 1 } }), ctx));
    expect(validatorFor('PanelPage')(page.body)).toEqual([]);
    expect(typeof page.body.page.next_cursor).toBe('string');
  });
  it('resolveOrderablesPreview -> 200 (not 201) exactly the contract ResolvedOrderables, no If-Match / Idempotency-Key needed (AC-07.1)', { timeout: T }, async () => {
    const { db } = setup12();
    const r = await db.run((ctx) => H['resolveOrderablesPreview']!(req({ body: { orderable_ids: [HP_ELITE_M.panel.id], as_of: '2026-11-05T04:15:00.000Z' } }), ctx));
    expect(r.status).toBe(200);
    expect(validatorFor('ResolvedOrderables')(r.body)).toEqual([]);
    expect(r.body.orderables[0].test_ids).toHaveLength(6);
    expect(r.body.tests).toHaveLength(6);
    expect(db.events).toHaveLength(0);
  });
});

describe('error mapping through the handlers', () => {
  it('AC-07.3: cycle -> 422 catalog.panel_cycle; AC-07.4: depth -> 400 common.validation_failed /members; inactive member -> 409 catalog.test_inactive', { timeout: T }, async () => {
    const { db } = setup12();
    const put = (id: string, members: unknown) => db.run((ctx) => H['replacePanelMembers']!(req({ params: { panel_id: id }, headers: { 'if-match': '"1"' }, body: { members } }), ctx));
    const cyc = await rejection(put(LIPID.panel.id, [mem('panel', HP_ELITE_M.panel.id, 1)]));
    expect(isLimsError(cyc, 'catalog.panel_cycle')).toBe(true); expect(cyc.statusCode).toBe(422);
    const dead = await rejection(put(BASIC.panel.id, [mem('test', ID(0x1008), 1)]));          // OLD (inactive test)
    expect(isLimsError(dead, 'catalog.test_inactive')).toBe(true); expect(dead.statusCode).toBe(409);
  });
  it('resolve: inactive -> 409 catalog.test_inactive; stored cycle -> 422 catalog.panel_cycle; unknown -> 404', { timeout: T }, async () => {
    const { db } = setup12();
    const go = (ids: string[]) => db.run((ctx) => H['resolveOrderablesPreview']!(req({ body: { orderable_ids: ids } }), ctx));
    const a = await rejection(go([ID(0x1008)])); expect(isLimsError(a, 'catalog.test_inactive')).toBe(true); expect(a.statusCode).toBe(409);
    const b = await rejection(go([ID(0xdead)])); expect(isLimsError(b, 'common.not_found')).toBe(true); expect(b.statusCode).toBe(404);
  });
});

describe('If-Match handling', () => {
  it.each(['updatePanel', 'replacePanelMembers'])('%s: no header -> 428 common.precondition_required; stale -> 409 common.version_conflict', { timeout: T }, async (id) => {
    const { db } = setup12();
    const b = id === 'updatePanel' ? { name: 'x' } : { members: [mem('test', TC.test.id, 1)] };
    const e1 = await rejection(db.run((ctx) => H[id]!(req({ params: { panel_id: BASIC.panel.id }, body: b }), ctx)));
    expect(isLimsError(e1, 'common.precondition_required')).toBe(true); expect(e1.statusCode).toBe(428);
    const e2 = await rejection(db.run((ctx) => H[id]!(req({ params: { panel_id: BASIC.panel.id }, headers: { 'if-match': '"2"' }, body: b }), ctx)));
    expect(isLimsError(e2, 'common.version_conflict')).toBe(true); expect(e2.statusCode).toBe(409);
    expect(db.row('panels', BASIC.panel.id)!['version']).toBe(1);
  });
  it.each([['unquoted', '1'], ['weak', 'W/"1"'], ['star', '*'], ['zero', '"0"'], ['leading zero', '"01"'], ['non numeric', '"abc"'], ['negative', '"-1"'], ['beyond int32', '"99999999999"'], ['empty', '']])(
    'malformed If-Match (%s) -> 400, never 500 and never a write', { timeout: T }, async (_n, h) => {
      const { db } = setup12(); const before = snap(db);
      for (const [id, b] of [['updatePanel', { name: 'x' }], ['replacePanelMembers', { members: [mem('test', TC.test.id, 1)] }]] as const) {
        const e = await rejection(db.run((ctx) => H[id]!(req({ params: { panel_id: BASIC.panel.id }, headers: { 'if-match': h }, body: b }), ctx)));
        expect(isLimsError(e)).toBe(true); expect(e.statusCode).toBe(400);
      }
      expect(snap(db)).toBe(before);
    });
});

describe('probes S-1 / S-5 through the handlers', () => {
  it('S-1: a path id of tenant B (and a test id) -> 404 common.not_found on get/update/replace; B untouched; B never listed', { timeout: T }, async () => {
    const { db } = setup12();
    for (const id of [PANEL_B.panel.id, TC.test.id]) {
      for (const [op, extra] of [['getPanelDetail', {}], ['updatePanel', { headers: { 'if-match': '"1"' }, body: { name: 'hijack' } }],
        ['replacePanelMembers', { headers: { 'if-match': '"1"' }, body: { members: [mem('test', TC.test.id, 1)] } }]] as const) {
        const e = await rejection(db.run((ctx) => H[op]!(req({ params: { panel_id: id }, ...extra }), ctx)));
        expect(isLimsError(e, 'common.not_found'), `${op} ${e?.code}`).toBe(true); expect(e.statusCode).toBe(404);
      }
    }
    expect(db.row('orderables', PANEL_B.panel.id)).toMatchObject({ name: 'Tenant B panel', tenant_id: TENANT_B });
    expect(db.row('panels', PANEL_B.panel.id)!['version']).toBe(1);
    const listed = await db.run((ctx) => H['listPanels']!(req({ query: { is_active: 'all' } }), ctx));
    expect(JSON.stringify(listed.body)).not.toContain('BPANEL');
  });
  it('S-1: bulk ids mixing A and B in resolve / member lists -> 404 for the whole call, nothing of B in the body, nothing written', { timeout: T }, async () => {
    const { db } = setup12(); const before = snap(db);
    const e1 = await rejection(db.run((ctx) => H['resolveOrderablesPreview']!(req({ body: { orderable_ids: [TC.test.id, TEST_B.test.id] } }), ctx)));
    const e2 = await rejection(db.run((ctx) => H['createPanel']!(req({ headers: { 'idempotency-key': 'k-1' }, body: pBody({ members: [mem('test', TC.test.id, 1), mem('test', TEST_B.test.id, 2)] }) }), ctx)));
    for (const e of [e1, e2]) { expect(isLimsError(e, 'common.not_found')).toBe(true); expect(JSON.stringify({ m: e.message, d: e.detail, errs: e.errors })).not.toMatch(/BTEST|Tenant B/); }
    expect(snap(db)).toBe(before);
  });
  it('S-5: mass assignment through the handler (tenant_id, id, kind, version, revision, is_active) -> 400 and nothing written', { timeout: T }, async () => {
    const { db } = setup12(); const before = snap(db);
    for (const extra of [{ tenant_id: TENANT_B }, { id: ID(0xbad) }, { kind: 'test' }, { version: 7 }, { revision: 3 }, { is_active: false }]) {
      const e = await rejection(db.run((ctx) => H['createPanel']!(req({ headers: { 'idempotency-key': 'k-1' }, body: { ...pBody({ code: 'new' }), ...extra } }), ctx)));
      expect(e.statusCode).toBe(400);
    }
    expect(snap(db)).toBe(before);
  });
  it('duplicate code (also against a test) -> 409 catalog.code_duplicate', { timeout: T }, async () => {
    const { db } = setup12();
    for (const code of ['lipid', 'cbc']) {
      const e = await rejection(db.run((ctx) => H['createPanel']!(req({ headers: { 'idempotency-key': 'k-1' }, body: pBody({ code }) }), ctx)));
      expect(isLimsError(e, 'catalog.code_duplicate')).toBe(true); expect(e.statusCode).toBe(409);
    }
  });
  it('bad queries / bodies are rejected with 400 before any SQL', { timeout: T }, async () => {
    const { db } = setup12();
    for (const [op, r] of [['listPanels', { query: { limit: 0 } }], ['listPanels', { query: { panel_kind: 'x' } }], ['resolveOrderablesPreview', { body: { orderable_ids: [] } }],
      ['resolveOrderablesPreview', { body: {} }], ['getPanelDetail', { params: { panel_id: 'not-a-uuid' } }]] as const) {
      const e = await rejection(db.run((ctx) => H[op]!(req(r), ctx)));
      expect(e.statusCode, `${op} ${JSON.stringify(r)}`).toBe(400);
    }
    expect(db.stmts.filter((s) => s.tenantId === TENANT_A)).toHaveLength(0);
  });
  it('fails closed without an authenticated request context: auth.unauthenticated, nothing reflected', { timeout: T }, async () => {
    const planted = 'PLANTED-TOKEN-9c2d';
    for (const id of IDS) {
      const e = await rejection(H[id]!(req({ params: { panel_id: ID(1) }, query: { panel_kind: planted }, headers: { 'if-match': '"1"', 'idempotency-key': 'k-1' }, body: pBody({ name: planted }) }), bare(id)));
      expect(isLimsError(e, 'auth.unauthenticated'), `${id} ${e?.code}`).toBe(true);
      expect(JSON.stringify({ m: e.message, d: e.detail, errs: e.errors })).not.toContain(planted);
    }
  });
});
