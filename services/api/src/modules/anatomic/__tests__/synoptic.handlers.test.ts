// C11.T-12 — synoptic templates lifecycle: K13 list, K14 create draft, K15 get, K16 update draft, K17 publish, K18 retire, K19 new version.
// Spec: 02-TRD §5.6 (K13–K19 rows + "Errors for K-ops"), §4.5.1 (SynopticDefinitionV1), §5.7 (SynopticTemplateSummary / SynopticTemplate); 05-SCHEMA synoptic_templates (status draft|published|retired,
//       unique (tenant,key,version_no), partial unique index "one published per key", guard trigger: published/retired rows immutable except status published→retired + bookkeeping);
//       01-PRD AC-08.1, 08.2, 08.3, 08.4, 08.6, AC-14.4; 07-SECURITY (privileged ops, AB-5 closed bodies, AB-8 plain text, AB-10 guard trigger, tenant isolation → 404, no payload in logs).
// LD-140 (UI only) does not apply: backend task.
// Drives the REAL handlers (manifest.handlers) on an IN-MEMORY templates.repo (vi.mock with the T-04 signatures). The mock reproduces the DB rules the service must respect:
//   unique (tenant_id, template_key, version_no) → pg 23505; partial unique index (one published per tenant+key) → 23505 on an UPDATE that publishes a second row; CHECK published_at ⟺ not draft → 23514;
//   guard trigger → raw pg P0001 'immutable_row' (requestTx would map it to 409 common.immutable_record; this file has no requestTx, so the SERVICE must check status first and throw the LimsError itself);
//   setClause column whitelist; version check (stale → undefined); undo journal on ctx.tx (a throwing handler rolls back, like requestTx).
//   What a mock cannot prove (real trigger, real index, RLS, real parallelism) is in integration/synoptic.live.test.ts (GATED like T-11).
//
// SEAMS (spec fixes behaviour; names chosen here, writer follows or disputes):
//   handlers K13–K19 in the manifest, backed by a service (service/synoptic.service.ts suggested). Every handler: IdentityPort.assertRole FIRST — reads 'anatomic.case.read', writes 'anatomic.config.manage'
//   (the privileged aal2 check is behind assertRole; its error propagates unchanged).
//   Repo calls (existing T-04 names, repository/templates.repo.ts): insertSynopticTemplate, getSynopticTemplate({tenantId,id}), listSynopticTemplates({tenantId,limit,offset}) — key lookups / max(version_no)
//   are done by the service through the list function (limit ≤ 500, like T-11), updateSynopticTemplate({tenantId,id,expectedVersion,actorId,patch}).
//   Stored row on create: status 'draft', version_no 1, title = definition.title, applies_to_case_kinds = definition.applies_to_case_kinds, definition as sent, created_by/updated_by = ctx.actor.id.
//   Publish = [retire the key's currently published version (patch {status:'retired', retired_at}) FIRST, then patch {status:'published', published_at, published_by}] — the partial unique index fails the other order.
//   Wire shapes: SynopticTemplateSummary { id, template_key, version_no, status, title, applies_to_case_kinds, published_at? }, SynopticTemplate = Summary + { definition, version }; closed key sets, no nulls,
//   no tenant/audit columns. list → {status:200, body:{data}}; create/new-version → 201; others 200. If-Match '"<version>"' on K16–K18; K19 needs none.
//   Errors: definition violations → LimsError 'anatomic.template_invalid' (422) whose errors[] carry JSON-Pointer paths (T-03 validator paths); edit/publish of a non-draft → 'common.immutable_record' (409);
//   retire of a non-published → 'anatomic.template_not_published' (409); duplicate template_key on K14 → 'common.validation_failed' at /template_key (TRD line "K4/K9/K14/K21 duplicate codes"); other tenant's id → 'common.not_found'.
// Fails now: K13–K19 are 501 / common.internal stubs.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LimsError, isLimsError, toProblem } from '../../../core/errors.js';

type Row = Record<string, any>;
const S = vi.hoisted(() => ({
  rows: new Map<string, Row>(), writes: 0, order: [] as string[], guardHits: 0, yieldOnList: false,
}));
const pgErr = (code: string, constraint: string, message = 'constraint violation') => Object.assign(new Error(message), { code, constraint });
const SETCOLS = ['status', 'title', 'applies_to_case_kinds', 'definition', 'published_at', 'published_by', 'retired_at', 'is_active'];
const GUARD_FREE = ['status', 'retired_at', 'updated_at', 'updated_by', 'version', 'is_active']; // 05-SCHEMA guard_synoptic_template()
const touch = (what: string, write = false) => { S.order.push(what); if (write) S.writes++; };
const undo = (tx: unknown, f: () => void) => { (tx as { undo?: (() => void)[] } | undefined)?.undo?.push(f); };
const cp = (r: Row): Row => structuredClone(r);
const lim = (i: Row) => { const l = Math.trunc(Number(i['limit'] ?? 200)); return Number.isFinite(l) && l >= 1 ? Math.min(l, 500) : 200; };
const off = (i: Row) => { const o = Math.trunc(Number(i['offset'] ?? 0)); return Number.isFinite(o) && o >= 0 ? o : 0; };

function dbChecks(r: Row) { // synoptic_templates__published__ck
  if (!((r['status'] === 'draft') === (r['published_at'] == null) || r['status'] === 'retired')) throw pgErr('23514', 'synoptic_templates__published__ck');
}
vi.mock('../repository/templates.repo.js', () => ({
  async insertSynopticTemplate(tx: unknown, row: Row) {
    touch('repo', true);
    if ([...S.rows.values()].some((r) => r['tenant_id'] === row['tenant_id'] && r['template_key'] === row['template_key'] && r['version_no'] === row['version_no'])) throw pgErr('23505', 'synoptic_templates__tenant_id_key_version__uq');
    const r: Row = {
      status: 'draft', version: 1, is_active: true, published_at: null, published_by: null, retired_at: null, created_at: '2026-11-13T00:00:00Z', updated_at: '2026-11-13T00:00:00Z',
      ...Object.fromEntries(Object.entries(row).filter(([k, v]) => v !== undefined && ['id', 'tenant_id', 'template_key', 'version_no', 'status', 'title', 'applies_to_case_kinds', 'definition', 'published_at', 'published_by', 'retired_at', 'created_by', 'updated_by'].includes(k))),
    };
    if (r['status'] === 'published' && [...S.rows.values()].some((x) => x['tenant_id'] === r['tenant_id'] && x['template_key'] === r['template_key'] && x['status'] === 'published')) throw pgErr('23505', 'synoptic_templates__tenant_id_key_published__p_uq');
    dbChecks(r); S.rows.set(r['id'], cp(r)); undo(tx, () => S.rows.delete(r['id'])); return cp(r);
  },
  async getSynopticTemplate(_tx: unknown, i: Row) { touch('repo'); const r = S.rows.get(i['id']); return r && r['tenant_id'] === i['tenantId'] ? cp(r) : undefined; },
  async listSynopticTemplates(_tx: unknown, i: Row) {
    touch('repo'); if (S.yieldOnList) await Promise.resolve();
    const all = [...S.rows.values()].filter((r) => r['tenant_id'] === i['tenantId'] && (!i['activeOnly'] || r['is_active']))
      .sort((a, b) => (a['template_key'] < b['template_key'] ? -1 : a['template_key'] > b['template_key'] ? 1 : b['version_no'] - a['version_no'] || (a['id'] < b['id'] ? -1 : 1)));
    return all.slice(off(i), off(i) + lim(i)).map(cp);
  },
  async updateSynopticTemplate(tx: unknown, i: { tenantId: string; id: string; expectedVersion: number; actorId: string; patch: Row }) {
    touch('repo', true);
    for (const k of Object.keys(i.patch)) if (i.patch[k] !== undefined && !SETCOLS.includes(k)) throw new Error(`anatomic repo: column '${k}' is not updatable`);
    const r = S.rows.get(i.id);
    if (!r || r['tenant_id'] !== i.tenantId || r['version'] !== i.expectedVersion) return undefined;
    const next: Row = { ...cp(r), ...cp(Object.fromEntries(Object.entries(i.patch).filter(([, v]) => v !== undefined))), version: r['version'] + 1, updated_by: i.actorId };
    if (r['status'] !== 'draft') { // BEFORE UPDATE guard trigger
      const changed = Object.keys(next).filter((k) => !GUARD_FREE.includes(k) && JSON.stringify(r[k]) !== JSON.stringify(next[k]));
      if (changed.length || !(r['status'] === next['status'] || (r['status'] === 'published' && next['status'] === 'retired'))) { S.guardHits++; throw pgErr('P0001', 'anatomic.synoptic_templates', 'immutable_row'); }
    }
    if (next['status'] === 'published' && [...S.rows.values()].some((x) => x['id'] !== r['id'] && x['tenant_id'] === r['tenant_id'] && x['template_key'] === r['template_key'] && x['status'] === 'published')) {
      throw pgErr('23505', 'synoptic_templates__tenant_id_key_published__p_uq');
    }
    dbChecks(next); S.rows.set(i.id, next); undo(tx, () => S.rows.set(i.id, r)); return cp(next);
  },
  // text templates belong to T-11 and are not used here
  async insertTextTemplate() { throw new Error('unused'); }, async getTextTemplate() { return undefined; }, async listTextTemplates() { return []; }, async updateTextTemplate() { return undefined; },
}));

const { manifest } = await import('../index.js');

const T = '01a1a98a-ac40-7000-8000-00000000a001', T_OTHER = '01a1a98a-ac40-7000-8000-00000000b001', ACTOR = '01a1a98a-ac40-7000-8000-00000000a300', MEMBERSHIP = '01a1a98a-ac40-7000-8000-00000000a500';
const uid = (n: number) => `0190c412-0000-7000-8000-${String(n).padStart(12, '0')}`;
const ID = { D1: uid(1), P1: uid(2), R1: uid(3), OTHER: uid(4), OTHER_KEY: uid(5), X1: uid(6) };
const NOW = '2026-11-13T01:30:00.000Z';
const FORBIDDEN_KEYS = ['tenant_id', 'created_by', 'updated_by', 'created_at', 'updated_at', 'published_by', 'retired_at', 'is_active'];

interface CtxOpts { deny?: Record<string, 'auth.forbidden' | 'auth.mfa_required'>; tenant?: string }
const calls = { assertRole: [] as Row[], logs: [] as string[] };
const mkCtx = (o: CtxOpts = {}) => ({
  operationId: 'op', clientIp: '203.0.113.7', requestId: uid(9999),
  log: { info: (x: object) => calls.logs.push(JSON.stringify(x)), warn: (x: object) => calls.logs.push(JSON.stringify(x)), error: (x: object) => calls.logs.push(JSON.stringify(x)) },
  tenantId: o.tenant ?? T, actor: { type: 'user', id: ACTOR, membershipId: MEMBERSHIP }, tx: { undo: [] as (() => void)[], async query() { touch('tx.query', true); return { rows: [] }; } }, now: () => new Date(NOW),
  ports: { IdentityPort: { async assertRole(_c: unknown, i: Row) { touch('assertRole'); calls.assertRole.push(structuredClone(i)); const d = o.deny?.[i['permission']]; if (d) throw new LimsError(d); } } },
}) as any;
const TECH = { 'anatomic.config.manage': 'auth.forbidden' } as const; // lab_technologist: case.read yes, config.manage no
const AAL1 = { 'anatomic.config.manage': 'auth.mfa_required' } as const;

/** emulates requestTx: a throwing handler rolls back every write it made through ctx.tx */
async function call(op: string, req: Row, ctx = mkCtx()): Promise<any> {
  try { return await (manifest.handlers as any)[op]({ params: {}, query: {}, headers: {}, body: {}, ...req }, ctx); } catch (e) {
    for (const u of [...ctx.tx.undo].reverse()) u();
    throw e;
  }
}
const rejects = async (p: Promise<unknown>): Promise<any> => p.then(() => { throw new Error('expected rejection'); }, (e: unknown) => e);
const ifm = (v: number) => ({ 'if-match': `"${v}"` });
const stored = () => JSON.stringify([...S.rows].sort(([a], [b]) => (a < b ? -1 : 1)));
const clone = <X>(x: X): X => JSON.parse(JSON.stringify(x));
const hasNoNulls = (x: unknown): boolean => x === null ? false : Array.isArray(x) ? x.every(hasNoNulls) : x && typeof x === 'object' ? Object.values(x).every(hasNoNulls) : true;
const keysDeep = (x: unknown): string[] => Array.isArray(x) ? x.flatMap(keysDeep) : x && typeof x === 'object' ? Object.entries(x).flatMap(([k, v]) => [k, ...keysDeep(v)]) : [];
const validationFailed = (e: any, path?: string) => {
  expect(isLimsError(e, 'common.validation_failed'), `got ${e?.code ?? e}`).toBe(true);
  if (path) expect((e as LimsError).errors?.some((f) => f.path === path), `errors[] has ${path}: ${JSON.stringify((e as LimsError).errors)}`).toBe(true);
};
const templateInvalid = (e: any, path: string) => {
  expect(isLimsError(e, 'anatomic.template_invalid'), `got ${e?.code ?? e}`).toBe(true); expect(e.statusCode).toBe(422);
  expect((e as LimsError).errors?.some((f) => f.path === path), `errors[] has ${path}: ${JSON.stringify((e as LimsError).errors)}`).toBe(true);
};
const published = (key: string, tenant = T) => [...S.rows.values()].filter((r) => r['tenant_id'] === tenant && r['template_key'] === key && r['status'] === 'published');

// ---- synthetic definition: 2 sections, 5 fields (AC-08.1); no third-party protocol text ----
const GOOD: Row = {
  schema_version: 1, title: 'Synthetic mass template', applies_to_case_kinds: ['histology'],
  sections: [
    { key: 'tumour', heading: 'Tumour', fields: [
      { key: 'site', label: 'Site', type: 'text', required: true },
      { key: 'grade', label: 'Grade', type: 'single_select', required: true, options: [{ code: 'g1', display: 'Grade 1' }, { code: 'g2', display: 'Grade 2' }] },
      { key: 'size_mm', label: 'Size', type: 'decimal', required: false, unit_text: 'mm', decimals: 1 },
    ] },
    { key: 'margins', heading: 'Margins', fields: [
      { key: 'margin_status', label: 'Margin status', type: 'single_select', required: true, options: [{ code: 'clear', display: 'Clear' }, { code: 'involved', display: 'Involved' }] },
      { key: 'margin_note', label: 'Margin note', type: 'long_text', required: false, show_if: { field_key: 'margin_status', equals: 'involved' } },
    ] },
  ],
};
const goodV2 = (): Row => { const d = clone(GOOD); d.title = 'Synthetic mass template v2'; d.sections[0].fields.push({ key: 'laterality', label: 'Laterality', type: 'text', required: false }); return d; };

const tplRow = (id: string, key: string, version_no: number, status: 'draft' | 'published' | 'retired', over: Row = {}): Row => {
  const definition = over['definition'] ?? clone(GOOD);
  return {
    id, tenant_id: T, template_key: key, version_no, status, title: definition.title, applies_to_case_kinds: definition.applies_to_case_kinds, definition, version: 1, is_active: true,
    published_at: status === 'draft' ? null : '2026-11-01T00:00:00.000Z', published_by: status === 'draft' ? null : ACTOR, retired_at: status === 'retired' ? '2026-11-05T00:00:00.000Z' : null,
    created_by: ACTOR, updated_by: ACTOR, created_at: '2026-11-01T00:00:00.000Z', updated_at: '2026-11-01T00:00:00.000Z', ...over,
  };
};
const put = (r: Row) => { S.rows.set(r['id'], r); return r; };
function seed() {
  put(tplRow(ID.D1, 'syn_draft', 1, 'draft', { version: 3 }));                         // a draft, key syn_draft
  put(tplRow(ID.P1, 'syn_mass', 1, 'published', { version: 2 }));                      // published v1 of syn_mass
  put(tplRow(ID.R1, 'syn_old', 1, 'retired', { version: 3 }));                         // retired v1 of syn_old
  put(tplRow(ID.OTHER, 'syn_mass', 1, 'published', { tenant_id: T_OTHER, definition: { ...clone(GOOD), title: 'Other tenant template' } })); // tenant B, same key
  put(tplRow(ID.OTHER_KEY, 'syn_cyto', 1, 'published', { definition: { ...clone(GOOD), title: 'Cyto', applies_to_case_kinds: ['cytology'] } })); // other key, tenant A
}
beforeEach(() => { S.rows.clear(); S.writes = 0; S.order.length = 0; S.guardHits = 0; S.yieldOnList = false; calls.assertRole.length = 0; calls.logs.length = 0; });

const WRITES: [string, string, () => Row][] = [
  ['K14', 'createAnatomicSynopticTemplate', () => ({ body: { template_key: 'syn_new', definition: clone(GOOD) } })],
  ['K16', 'updateAnatomicSynopticTemplate', () => ({ params: { template_id: ID.D1 }, headers: ifm(3), body: { definition: goodV2() } })],
  ['K17', 'publishAnatomicSynopticTemplate', () => ({ params: { template_id: ID.D1 }, headers: ifm(3) })],
  ['K18', 'retireAnatomicSynopticTemplate', () => ({ params: { template_id: ID.P1 }, headers: ifm(2) })],
  ['K19', 'createAnatomicSynopticTemplateVersion', () => ({ params: { template_id: ID.P1 } })],
];
const READS: [string, string, () => Row][] = [
  ['K13', 'listAnatomicSynopticTemplates', () => ({})], ['K15', 'getAnatomicSynopticTemplate', () => ({ params: { template_id: ID.P1 } })],
];

// ========================================================================================================= privileged checks (AC-14.4, 07-SECURITY)
describe('AC-14.4 technologist: template writes → 403 auth.forbidden before anything is touched; reads need anatomic.case.read only', () => {
  it.each(WRITES)('%s %s as lab_technologist → auth.forbidden; assertRole(anatomic.config.manage) is first; nothing read or written', async (_k, op, req) => {
    seed(); const before = stored(); S.order.length = 0;
    const e = await rejects(call(op, req(), mkCtx({ deny: TECH })));
    expect(isLimsError(e, 'auth.forbidden')).toBe(true);
    expect(calls.assertRole[0]).toMatchObject({ permission: 'anatomic.config.manage' });
    expect(S.order[0]).toBe('assertRole'); expect(S.order.filter((x) => x !== 'assertRole')).toEqual([]); expect(S.writes).toBe(0); expect(stored()).toBe(before);
  });
  it.each(WRITES)('%s %s at aal1 → auth.mfa_required propagated unchanged, no change', async (_k, op, req) => {
    seed(); const before = stored();
    const e = await rejects(call(op, req(), mkCtx({ deny: AAL1 })));
    expect(isLimsError(e, 'auth.mfa_required')).toBe(true); expect(S.writes).toBe(0); expect(stored()).toBe(before);
  });
  it.each(READS)('%s %s as lab_technologist → 200; assertRole asked for anatomic.case.read and never for config.manage', async (_k, op, req) => {
    seed();
    const r = await call(op, req(), mkCtx({ deny: TECH }));
    expect(r.status).toBe(200); expect(calls.assertRole.map((c) => c['permission'])).toEqual(['anatomic.case.read']); expect(S.writes).toBe(0);
  });
  it.each(READS)('%s %s without anatomic.case.read → auth.forbidden, repository untouched', async (_k, op, req) => {
    seed(); S.order.length = 0;
    const e = await rejects(call(op, req(), mkCtx({ deny: { 'anatomic.case.read': 'auth.forbidden' } })));
    expect(isLimsError(e, 'auth.forbidden')).toBe(true); expect(S.order.filter((x) => x !== 'assertRole')).toEqual([]);
  });
  it('a permitted writer reaches the repository (guard against a handler that always denies)', async () => {
    seed();
    const r = await call('createAnatomicSynopticTemplate', { body: { template_key: 'syn_new', definition: clone(GOOD) } });
    expect(r.status).toBe(201); expect(calls.assertRole[0]).toMatchObject({ permission: 'anatomic.config.manage' });
  });
});

// ========================================================================================================= K14 create draft — AC-08.1, AC-08.2
describe('K14 createAnatomicSynopticTemplate — AC-08.1', () => {
  it('AC-08.1: 2 sections / 5 fields → 201 draft, version_no 1; row stores title + applies_to_case_kinds copies, tenant + actor stamped; closed shape, no nulls', async () => {
    seed();
    const r = await call('createAnatomicSynopticTemplate', { body: { template_key: 'syn_new', definition: clone(GOOD) } });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ template_key: 'syn_new', version_no: 1, status: 'draft', title: GOOD['title'], applies_to_case_kinds: ['histology'], definition: GOOD, version: 1 });
    expect(r.body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(Object.keys(r.body).sort()).toEqual(['applies_to_case_kinds', 'definition', 'id', 'status', 'template_key', 'title', 'version', 'version_no']); // no published_at on a draft
    expect(hasNoNulls(r.body)).toBe(true); expect(keysDeep(r.body).filter((k) => FORBIDDEN_KEYS.includes(k))).toEqual([]);
    expect(S.rows.get(r.body.id)).toMatchObject({ tenant_id: T, status: 'draft', version_no: 1, title: GOOD['title'], applies_to_case_kinds: ['histology'], created_by: ACTOR, updated_by: ACTOR, published_at: null });
    expect(S.rows.get(r.body.id)!['definition']).toEqual(GOOD);
  });
  it('the same key in another tenant is fine (RLS/tenant scope): tenant B already has a published "syn_mass"', async () => {
    seed();
    const r = await call('createAnatomicSynopticTemplate', { body: { template_key: 'syn_mass_b', definition: clone(GOOD) } }, mkCtx({ tenant: T_OTHER }));
    expect(r.status).toBe(201); expect(S.rows.get(r.body.id)!['tenant_id']).toBe(T_OTHER);
  });
  it('duplicate template_key within the tenant → 400 common.validation_failed with errors[] at /template_key (not 409/500); nothing stored', async () => {
    seed(); const before = stored();
    validationFailed(await rejects(call('createAnatomicSynopticTemplate', { body: { template_key: 'syn_mass', definition: clone(GOOD) } })), '/template_key'); expect(stored()).toBe(before);
  });
  it.each([['upper case', 'Syn_New'], ['leading digit', '1syn'], ['hyphen', 'syn-new'], ['space', 'syn new'], ['41 chars', 'a'.repeat(41)], ['empty', ''], ['non-string', 7]])(
    'template_key %s → 400 at /template_key, nothing stored', async (_n, key) => {
      seed(); const before = stored();
      validationFailed(await rejects(call('createAnatomicSynopticTemplate', { body: { template_key: key, definition: clone(GOOD) } })), '/template_key'); expect(stored()).toBe(before);
    });
  it('template_key at the 40-char limit is accepted', async () => {
    seed(); expect((await call('createAnatomicSynopticTemplate', { body: { template_key: `a${'b'.repeat(39)}`, definition: clone(GOOD) } })).status).toBe(201);
  });
  it('missing template_key / unknown or server-owned fields (status, version_no, tenant_id, id, published_at) → 400 (AB-5: closed body), nothing stored', async () => {
    seed(); const before = stored();
    for (const b of [{ definition: clone(GOOD) }, { template_key: 'syn_x', definition: clone(GOOD), status: 'published' }, { template_key: 'syn_x', definition: clone(GOOD), version_no: 9 },
      { template_key: 'syn_x', definition: clone(GOOD), tenant_id: T_OTHER }, { template_key: 'syn_x', definition: clone(GOOD), id: uid(77) }, { template_key: 'syn_x', definition: clone(GOOD), published_at: NOW }]) {
      validationFailed(await rejects(call('createAnatomicSynopticTemplate', { body: b })));
    }
    expect(stored()).toBe(before);
  });
});

describe('AC-08.2 K14 / K16 invalid definitions → 422 anatomic.template_invalid with errors[] JSON Pointers; nothing stored or changed', () => {
  const dupKey = () => { const d = clone(GOOD); d.sections[1].fields.push({ key: 'site', label: 'Site again', type: 'text', required: false }); return d; };
  const noOptions = () => { const d = clone(GOOD); d.sections[0].fields.push({ key: 'extra', label: 'Extra', type: 'single_select', required: false }); return d; };
  const badShowIf = () => { const d = clone(GOOD); d.sections[0].fields.push({ key: 'dep', label: 'Dependent', type: 'text', required: false, show_if: { field_key: 'nope', equals: 'x' } }); return d; };
  const CASES: [string, () => Row, string][] = [
    ['duplicate field keys (pointer of the 2nd occurrence)', dupKey, '/definition/sections/1/fields/2/key'],
    ['single_select without options', noOptions, '/definition/sections/0/fields/3/options'],
    ['show_if pointing to an unknown field', badShowIf, '/definition/sections/0/fields/3/show_if/field_key'],
    ['empty title', () => ({ ...clone(GOOD), title: '' }), '/definition/title'],
    ['no sections', () => ({ ...clone(GOOD), sections: [] }), '/definition/sections'],
    ['unknown case kind', () => ({ ...clone(GOOD), applies_to_case_kinds: ['histology', 'dentistry'] }), '/definition/applies_to_case_kinds/1'],
  ];
  it.each(CASES)('K14 %s', async (_n, mk, path) => {
    seed(); const before = stored();
    templateInvalid(await rejects(call('createAnatomicSynopticTemplate', { body: { template_key: 'syn_bad', definition: mk() } })), path); expect(stored()).toBe(before); expect(S.writes).toBe(0);
  });
  it.each(CASES)('K16 (draft) %s', async (_n, mk, path) => {
    seed(); const before = stored();
    templateInvalid(await rejects(call('updateAnatomicSynopticTemplate', { params: { template_id: ID.D1 }, headers: ifm(3), body: { definition: mk() } })), path); expect(stored()).toBe(before); expect(S.writes).toBe(0);
  });
  it('all violations of one definition are reported together (collect, do not stop at the first)', async () => {
    seed(); const d = dupKey(); d.sections[0].fields.push({ key: 'extra', label: 'Extra', type: 'single_select', required: false }); d.title = '';
    const e = await rejects(call('createAnatomicSynopticTemplate', { body: { template_key: 'syn_bad', definition: d } }));
    expect(isLimsError(e, 'anatomic.template_invalid')).toBe(true);
    const paths = (e as LimsError).errors!.map((f) => f.path); expect(paths).toEqual(expect.arrayContaining(['/definition/title', '/definition/sections/1/fields/2/key', '/definition/sections/0/fields/3/options']));
  });
  it('a non-object definition → 422 template_invalid at /definition', async () => {
    seed(); templateInvalid(await rejects(call('createAnatomicSynopticTemplate', { body: { template_key: 'syn_bad', definition: 'x' } })), '/definition');
  });
  it('errors never echo submitted values (REQ-SEC-098): option display / label markers appear nowhere in the error', async () => {
    seed(); const d = noOptions(); d.sections[0].fields[0].label = 'SYNTHETIC-LABEL-MARKER';
    const e = await rejects(call('createAnatomicSynopticTemplate', { body: { template_key: 'syn_bad', definition: d } }));
    expect(isLimsError(e, 'anatomic.template_invalid')).toBe(true); expect(e.errors?.length).toBeGreaterThan(0); // vacuous otherwise: a stub error has no marker either
    expect(JSON.stringify({ d: e.detail, e: e.errors, m: e.message })).not.toContain('SYNTHETIC-LABEL-MARKER');
  });
  // Review item 1: wire-level 422 must carry errors[] paths (AC-08.2, TRD §5.6, contracts/errors.yaml:212). core/errors.ts:56 (C0-owned) only emits errors[]
  // for common.validation_failed today. it.fails = expected-red until C0 lands the CR (.orchestra/cr/C11.T-12.md); remove `.fails` once C0 changes toProblem.
  it.fails('wire Problem for K14 invalid definition carries errors[].path (needs C0 change to toProblem; see CR C11.T-12)', async () => {
    seed();
    const e = await rejects(call('createAnatomicSynopticTemplate', { body: { template_key: 'syn_bad', definition: noOptions() } }));
    const p = toProblem(e, '/v1/anatomic/synoptic-templates', '00000000-0000-7000-8000-000000000000');
    expect(p.status).toBe(422); expect(p.code).toBe('anatomic.template_invalid');
    expect(p.errors?.some((f) => f.path === '/definition/sections/0/fields/3/options')).toBe(true);
  });
});

// ========================================================================================================= K15 / K13 reads
describe('K15 getAnatomicSynopticTemplate', () => {
  it('returns SynopticTemplate for a published row: Summary + definition + version, published_at as ISO string, closed keys, no nulls, no audit/tenant columns', async () => {
    seed();
    const r = await call('getAnatomicSynopticTemplate', { params: { template_id: ID.P1 } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: ID.P1, template_key: 'syn_mass', version_no: 1, status: 'published', title: GOOD['title'], applies_to_case_kinds: ['histology'], definition: GOOD, version: 2 });
    expect(Object.keys(r.body).sort()).toEqual(['applies_to_case_kinds', 'definition', 'id', 'published_at', 'status', 'template_key', 'title', 'version', 'version_no']);
    expect(new Date(r.body.published_at).toISOString()).toBe('2026-11-01T00:00:00.000Z'); expect(hasNoNulls(r.body)).toBe(true); expect(keysDeep(r.body).filter((k) => FORBIDDEN_KEYS.includes(k))).toEqual([]);
  });
  it('a retired template is still readable (reports that used it keep resolving it)', async () => {
    seed(); const r = await call('getAnatomicSynopticTemplate', { params: { template_id: ID.R1 } }); expect(r.body).toMatchObject({ status: 'retired', version_no: 1, definition: GOOD });
  });
  it('unknown id and the OTHER tenant\'s id → 404 common.not_found (not 403), no leak', async () => {
    seed();
    expect(isLimsError(await rejects(call('getAnatomicSynopticTemplate', { params: { template_id: uid(999) } })), 'common.not_found')).toBe(true);
    expect(isLimsError(await rejects(call('getAnatomicSynopticTemplate', { params: { template_id: ID.OTHER } })), 'common.not_found')).toBe(true);
  });
});

describe('K13 listAnatomicSynopticTemplates', () => {
  it('summaries only (no definition), closed keys, ordered by template_key then version_no DESC; tenant B rows never appear', async () => {
    seed(); put(tplRow(uid(20), 'syn_mass', 2, 'draft'));
    const r = await call('listAnatomicSynopticTemplates', {});
    expect(r.status).toBe(200);
    expect(r.body.data.map((t: Row) => `${t['template_key']}:${t['version_no']}`)).toEqual(['syn_cyto:1', 'syn_draft:1', 'syn_mass:2', 'syn_mass:1', 'syn_old:1']);
    for (const t of r.body.data) {
      expect(Object.keys(t).every((k) => ['id', 'template_key', 'version_no', 'status', 'title', 'applies_to_case_kinds', 'published_at'].includes(k))).toBe(true);
      expect(t).not.toHaveProperty('definition'); expect(hasNoNulls(t)).toBe(true);
    }
    expect(r.body.data.some((t: Row) => t['id'] === ID.OTHER)).toBe(false);
  });
  it('status filter (csv): published; draft,retired; unknown status → 400', async () => {
    seed();
    expect((await call('listAnatomicSynopticTemplates', { query: { status: 'published' } })).body.data.map((t: Row) => t['template_key'])).toEqual(['syn_cyto', 'syn_mass']);
    expect((await call('listAnatomicSynopticTemplates', { query: { status: 'draft,retired' } })).body.data.map((t: Row) => t['template_key'])).toEqual(['syn_draft', 'syn_old']);
    validationFailed(await rejects(call('listAnatomicSynopticTemplates', { query: { status: 'published,bogus' } })));
  });
  it('case_kind filter keeps templates applying to that kind; invalid kind → 400', async () => {
    seed();
    expect((await call('listAnatomicSynopticTemplates', { query: { case_kind: 'cytology' } })).body.data.map((t: Row) => t['template_key'])).toEqual(['syn_cyto']);
    expect((await call('listAnatomicSynopticTemplates', { query: { case_kind: 'histology', status: 'published' } })).body.data.map((t: Row) => t['template_key'])).toEqual(['syn_mass']);
    validationFailed(await rejects(call('listAnatomicSynopticTemplates', { query: { case_kind: 'dentistry' } })));
  });
  it('returns at most 500 rows (TRD K13 bound) even when the tenant holds more', async () => {
    for (let i = 0; i < 505; i++) put(tplRow(uid(1000 + i), `syn_k${String(i).padStart(4, '0')}`, 1, 'published'));
    expect((await call('listAnatomicSynopticTemplates', {})).body.data).toHaveLength(500);
  });
});

// ========================================================================================================= K16 update draft
describe('K16 updateAnatomicSynopticTemplate — draft only', () => {
  it('replaces the definition of a draft: version +1, title + applies_to_case_kinds re-copied from the new definition, status stays draft, key / version_no unchanged', async () => {
    seed(); const d = goodV2(); d['applies_to_case_kinds'] = ['histology', 'cytology'];
    const r = await call('updateAnatomicSynopticTemplate', { params: { template_id: ID.D1 }, headers: ifm(3), body: { definition: d } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: ID.D1, template_key: 'syn_draft', version_no: 1, status: 'draft', title: 'Synthetic mass template v2', applies_to_case_kinds: ['histology', 'cytology'], definition: d, version: 4 });
    expect(S.rows.get(ID.D1)).toMatchObject({ title: 'Synthetic mass template v2', updated_by: ACTOR, version: 4, status: 'draft' }); expect(S.rows.get(ID.D1)!['definition']).toEqual(d);
  });
  it('If-Match: missing → common.precondition_required; stale → common.version_conflict; row unchanged', async () => {
    seed(); const before = stored();
    expect(isLimsError(await rejects(call('updateAnatomicSynopticTemplate', { params: { template_id: ID.D1 }, body: { definition: goodV2() } })), 'common.precondition_required')).toBe(true);
    expect(isLimsError(await rejects(call('updateAnatomicSynopticTemplate', { params: { template_id: ID.D1 }, headers: ifm(2), body: { definition: goodV2() } })), 'common.version_conflict')).toBe(true);
    expect(stored()).toBe(before);
  });
  it('body is closed: {definition} only — status / template_key / version_no / title are rejected (AB-5); a missing definition → 400', async () => {
    seed(); const before = stored();
    for (const b of [{ definition: goodV2(), status: 'published' }, { definition: goodV2(), template_key: 'other' }, { definition: goodV2(), version_no: 5 }, { definition: goodV2(), title: 'x' }, {}]) {
      validationFailed(await rejects(call('updateAnatomicSynopticTemplate', { params: { template_id: ID.D1 }, headers: ifm(3), body: b })));
    }
    expect(stored()).toBe(before);
  });
  it('two writers with the same If-Match: exactly one wins, the other common.version_conflict (no lost update)', async () => {
    seed();
    const a = goodV2(); a['title'] = 'Writer A'; const b = goodV2(); b['title'] = 'Writer B';
    const rs = await Promise.allSettled([call('updateAnatomicSynopticTemplate', { params: { template_id: ID.D1 }, headers: ifm(3), body: { definition: a } }), call('updateAnatomicSynopticTemplate', { params: { template_id: ID.D1 }, headers: ifm(3), body: { definition: b } })]);
    expect(rs.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(isLimsError((rs.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason, 'common.version_conflict')).toBe(true); expect(S.rows.get(ID.D1)!['version']).toBe(4);
  });
  it('unknown id / other tenant\'s id → 404 common.not_found, nothing changes', async () => {
    seed(); const before = stored();
    for (const id of [uid(999), ID.OTHER]) expect(isLimsError(await rejects(call('updateAnatomicSynopticTemplate', { params: { template_id: id }, headers: ifm(1), body: { definition: goodV2() } })), 'common.not_found')).toBe(true);
    expect(stored()).toBe(before);
  });
});

// ========================================================================================================= immutability after publish — AC-08.3 + DB guard trigger honoured
describe('AC-08.3 / guard trigger: a published or retired template cannot be edited', () => {
  it.each([['published', ID.P1, 2], ['retired', ID.R1, 3]] as const)('K16 on a %s template → 409 common.immutable_record (LimsError from the service, not a raw pg error); row byte-identical', async (_s, id, v) => {
    seed(); const before = stored();
    const e = await rejects(call('updateAnatomicSynopticTemplate', { params: { template_id: id }, headers: ifm(v), body: { definition: goodV2() } }));
    expect(isLimsError(e, 'common.immutable_record'), `got ${e?.code ?? e?.message}`).toBe(true); expect(e.statusCode).toBe(409); expect(stored()).toBe(before);
  });
  it('the immutability answer is not masked by a stale If-Match on a published row: still a 4xx LimsError, row unchanged', async () => {
    seed(); const before = stored();
    const e = await rejects(call('updateAnatomicSynopticTemplate', { params: { template_id: ID.P1 }, headers: ifm(1), body: { definition: goodV2() } }));
    expect(isLimsError(e)).toBe(true); expect(['common.immutable_record', 'common.version_conflict']).toContain(e.code); expect(stored()).toBe(before);
  });
  it('after publishing a draft, editing it is refused (publish → edit round trip) and the stored definition is unchanged', async () => {
    seed();
    const p = await call('publishAnatomicSynopticTemplate', { params: { template_id: ID.D1 }, headers: ifm(3) });
    const after = clone(S.rows.get(ID.D1)!['definition']);
    const e = await rejects(call('updateAnatomicSynopticTemplate', { params: { template_id: ID.D1 }, headers: ifm(p.body.version), body: { definition: goodV2() } }));
    expect(isLimsError(e, 'common.immutable_record')).toBe(true); expect(S.rows.get(ID.D1)!['definition']).toEqual(after);
  });
  it('no code path hands the guard trigger a forbidden change: across every lifecycle call the mock trigger never fires', async () => {
    seed();
    await call('publishAnatomicSynopticTemplate', { params: { template_id: ID.D1 }, headers: ifm(3) });
    const v2 = await call('createAnatomicSynopticTemplateVersion', { params: { template_id: ID.P1 } });
    await call('publishAnatomicSynopticTemplate', { params: { template_id: v2.body.id }, headers: ifm(1) });
    await call('retireAnatomicSynopticTemplate', { params: { template_id: ID.OTHER_KEY }, headers: ifm(1) });
    expect(S.guardHits).toBe(0);
  });
});

// ========================================================================================================= K17 publish — one published per key
describe('K17 publishAnatomicSynopticTemplate — one published version per key', () => {
  it('publishing a draft with no earlier version: 200 published, published_at = now, published_by set, version +1, definition unchanged, no other row touched', async () => {
    seed(); const others = JSON.stringify([...S.rows].filter(([id]) => id !== ID.D1));
    const r = await call('publishAnatomicSynopticTemplate', { params: { template_id: ID.D1 }, headers: ifm(3) });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: ID.D1, status: 'published', version_no: 1, version: 4, definition: GOOD }); expect(new Date(r.body.published_at).toISOString()).toBe(NOW);
    expect([ACTOR, MEMBERSHIP]).toContain(S.rows.get(ID.D1)!['published_by']); expect(S.rows.get(ID.D1)).toMatchObject({ status: 'published', updated_by: ACTOR });
    expect(JSON.stringify([...S.rows].filter(([id]) => id !== ID.D1))).toBe(others);
  });
  it('publishing v2 while v1 is published: v1 → retired (retired_at = now), v2 → published; exactly one published row for the key; other keys and tenant B untouched', async () => {
    seed(); const v2 = await call('createAnatomicSynopticTemplateVersion', { params: { template_id: ID.P1 } });
    const otherKey = JSON.stringify(S.rows.get(ID.OTHER_KEY)), otherTenant = JSON.stringify(S.rows.get(ID.OTHER));
    const r = await call('publishAnatomicSynopticTemplate', { params: { template_id: v2.body.id }, headers: ifm(1) });
    expect(r.body).toMatchObject({ id: v2.body.id, status: 'published', version_no: 2 });
    expect(S.rows.get(ID.P1)).toMatchObject({ status: 'retired', version_no: 1 }); expect(new Date(S.rows.get(ID.P1)!['retired_at']).toISOString()).toBe(NOW);
    expect(published('syn_mass').map((x) => x['id'])).toEqual([v2.body.id]);
    expect(JSON.stringify(S.rows.get(ID.OTHER_KEY))).toBe(otherKey); expect(JSON.stringify(S.rows.get(ID.OTHER))).toBe(otherTenant);
  });
  it('the retired previous version keeps its definition byte-for-byte (the guard allows only status/retired_at/bookkeeping to change)', async () => {
    seed(); const def = clone(S.rows.get(ID.P1)!['definition']); const title = S.rows.get(ID.P1)!['title'];
    const v2 = await call('createAnatomicSynopticTemplateVersion', { params: { template_id: ID.P1 } });
    await call('publishAnatomicSynopticTemplate', { params: { template_id: v2.body.id }, headers: ifm(1) });
    expect(S.rows.get(ID.P1)!['definition']).toEqual(def); expect(S.rows.get(ID.P1)!['title']).toBe(title); expect(S.rows.get(ID.P1)!['published_at']).toBe('2026-11-01T00:00:00.000Z');
  });
  it('a failed publish (stale If-Match) leaves the previous version published: nothing is retired', async () => {
    seed(); const v2 = await call('createAnatomicSynopticTemplateVersion', { params: { template_id: ID.P1 } }); const before = stored();
    const e = await rejects(call('publishAnatomicSynopticTemplate', { params: { template_id: v2.body.id }, headers: ifm(7) }));
    expect(isLimsError(e, 'common.version_conflict')).toBe(true); expect(stored()).toBe(before); expect(published('syn_mass').map((x) => x['id'])).toEqual([ID.P1]);
  });
  it('If-Match missing → common.precondition_required, nothing changes', async () => {
    seed(); const before = stored();
    expect(isLimsError(await rejects(call('publishAnatomicSynopticTemplate', { params: { template_id: ID.D1 } })), 'common.precondition_required')).toBe(true); expect(stored()).toBe(before);
  });
  it.each([['published', ID.P1, 2], ['retired', ID.R1, 3]] as const)('publishing a %s template → 409 common.immutable_record, nothing changes', async (_s, id, v) => {
    seed(); const before = stored();
    expect(isLimsError(await rejects(call('publishAnatomicSynopticTemplate', { params: { template_id: id }, headers: ifm(v) })), 'common.immutable_record')).toBe(true); expect(stored()).toBe(before);
  });
  it('two parallel publishes of the same draft with the same If-Match: exactly one wins; the key never has two published rows', async () => {
    seed(); S.yieldOnList = true;
    const rs = await Promise.allSettled([1, 2].map(() => call('publishAnatomicSynopticTemplate', { params: { template_id: ID.D1 }, headers: ifm(3) })));
    expect(rs.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = (rs.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason; expect(isLimsError(lost)).toBe(true); expect(['common.version_conflict', 'common.immutable_record']).toContain(lost.code);
    expect(published('syn_draft')).toHaveLength(1);
  });
  it('unknown id / other tenant\'s id → 404 common.not_found; tenant B template stays published', async () => {
    seed(); const before = stored();
    for (const id of [uid(999), ID.OTHER]) expect(isLimsError(await rejects(call('publishAnatomicSynopticTemplate', { params: { template_id: id }, headers: ifm(1) })), 'common.not_found')).toBe(true);
    expect(stored()).toBe(before);
  });
});

// ========================================================================================================= K18 retire — AC-08.6 (status side)
describe('K18 retireAnatomicSynopticTemplate — AC-08.6', () => {
  it('retires a published template: 200 retired, retired_at = now, version +1, definition and published_at unchanged; no published row left for the key', async () => {
    seed();
    const r = await call('retireAnatomicSynopticTemplate', { params: { template_id: ID.P1 }, headers: ifm(2) });
    expect(r.status).toBe(200); expect(r.body).toMatchObject({ id: ID.P1, status: 'retired', version: 3, version_no: 1, definition: GOOD });
    expect(S.rows.get(ID.P1)).toMatchObject({ status: 'retired', updated_by: ACTOR }); expect(new Date(S.rows.get(ID.P1)!['retired_at']).toISOString()).toBe(NOW); expect(published('syn_mass')).toHaveLength(0);
  });
  it('the retired template is still returned by K15 and K13 (status retired), so existing reports keep resolving it', async () => {
    seed(); await call('retireAnatomicSynopticTemplate', { params: { template_id: ID.P1 }, headers: ifm(2) });
    expect((await call('getAnatomicSynopticTemplate', { params: { template_id: ID.P1 } })).body).toMatchObject({ status: 'retired', definition: GOOD });
    expect((await call('listAnatomicSynopticTemplates', { query: { status: 'retired' } })).body.data.map((t: Row) => t['id'])).toEqual(expect.arrayContaining([ID.P1, ID.R1]));
  });
  it.each([['draft', ID.D1, 3], ['retired', ID.R1, 3]] as const)('retiring a %s template → 409 anatomic.template_not_published, nothing changes', async (_s, id, v) => {
    seed(); const before = stored();
    const e = await rejects(call('retireAnatomicSynopticTemplate', { params: { template_id: id }, headers: ifm(v) }));
    expect(isLimsError(e, 'anatomic.template_not_published')).toBe(true); expect(e.statusCode).toBe(409); expect(stored()).toBe(before);
  });
  it('If-Match: missing → common.precondition_required; stale → common.version_conflict; nothing changes', async () => {
    seed(); const before = stored();
    expect(isLimsError(await rejects(call('retireAnatomicSynopticTemplate', { params: { template_id: ID.P1 } })), 'common.precondition_required')).toBe(true);
    expect(isLimsError(await rejects(call('retireAnatomicSynopticTemplate', { params: { template_id: ID.P1 }, headers: ifm(1) })), 'common.version_conflict')).toBe(true);
    expect(stored()).toBe(before);
  });
  it('unknown id / other tenant\'s id → 404 common.not_found, tenant B template stays published', async () => {
    seed(); const before = stored();
    for (const id of [uid(999), ID.OTHER]) expect(isLimsError(await rejects(call('retireAnatomicSynopticTemplate', { params: { template_id: id }, headers: ifm(1) })), 'common.not_found')).toBe(true);
    expect(stored()).toBe(before);
  });
  it('a just-retired row cannot be re-published (retired → published is blocked by the guard); the key stays without a published version', async () => {
    seed(); await call('retireAnatomicSynopticTemplate', { params: { template_id: ID.P1 }, headers: ifm(2) });
    expect(isLimsError(await rejects(call('publishAnatomicSynopticTemplate', { params: { template_id: ID.P1 }, headers: ifm(3) })), 'common.immutable_record')).toBe(true);
    expect(published('syn_mass')).toHaveLength(0);
  });
});

// ========================================================================================================= K19 new version — AC-08.3, AC-08.4
describe('K19 createAnatomicSynopticTemplateVersion — AC-08.3 / AC-08.4', () => {
  it('AC-08.3: from published v1 → 201 draft v2 of the same key with the definition copied (deep copy), no published_at; the source row is untouched', async () => {
    seed(); const src = JSON.stringify(S.rows.get(ID.P1));
    const r = await call('createAnatomicSynopticTemplateVersion', { params: { template_id: ID.P1 } });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ template_key: 'syn_mass', version_no: 2, status: 'draft', title: GOOD['title'], applies_to_case_kinds: ['histology'], definition: GOOD, version: 1 });
    expect(r.body.id).not.toBe(ID.P1); expect(r.body).not.toHaveProperty('published_at'); expect(hasNoNulls(r.body)).toBe(true);
    expect(S.rows.get(r.body.id)).toMatchObject({ tenant_id: T, created_by: ACTOR, updated_by: ACTOR, published_at: null }); expect(JSON.stringify(S.rows.get(ID.P1))).toBe(src);
    S.rows.get(r.body.id)!['definition'].title = 'mutated draft copy'; expect(S.rows.get(ID.P1)!['definition'].title).toBe(GOOD['title']); // not aliased to the source
  });
  it('the new draft is editable (K16) while v1 stays published; publishing it retires v1 (AC-08.3 + one published per key)', async () => {
    seed(); const v2 = await call('createAnatomicSynopticTemplateVersion', { params: { template_id: ID.P1 } });
    const u = await call('updateAnatomicSynopticTemplate', { params: { template_id: v2.body.id }, headers: ifm(1), body: { definition: goodV2() } });
    expect(u.body).toMatchObject({ version_no: 2, status: 'draft', title: 'Synthetic mass template v2' }); expect(S.rows.get(ID.P1)!['status']).toBe('published');
    await call('publishAnatomicSynopticTemplate', { params: { template_id: v2.body.id }, headers: ifm(u.body.version) });
    expect(S.rows.get(ID.P1)!['status']).toBe('retired'); expect(published('syn_mass')).toHaveLength(1);
  });
  it('does not need If-Match (TRD K19: "—")', async () => {
    seed(); expect((await call('createAnatomicSynopticTemplateVersion', { params: { template_id: ID.P1 }, headers: {} })).status).toBe(201);
  });
  it('unknown id / other tenant\'s id → 404 common.not_found, nothing created', async () => {
    seed(); const before = stored();
    for (const id of [uid(999), ID.OTHER]) expect(isLimsError(await rejects(call('createAnatomicSynopticTemplateVersion', { params: { template_id: id } })), 'common.not_found')).toBe(true);
    expect(stored()).toBe(before);
  });
  it('two parallel new-version calls on the same source: at most one v2 row exists (unique key+version_no); the loser is a clean 4xx LimsError, never a raw pg error', async () => {
    seed(); S.yieldOnList = true;
    const rs = await Promise.allSettled([1, 2].map(() => call('createAnatomicSynopticTemplateVersion', { params: { template_id: ID.P1 } })));
    expect(rs.filter((r) => r.status === 'fulfilled').length).toBeLessThanOrEqual(1);
    for (const r of rs) if (r.status === 'rejected') { expect(isLimsError(r.reason)).toBe(true); expect(r.reason.statusCode).toBeLessThan(500); }
    expect([...S.rows.values()].filter((x) => x['tenant_id'] === T && x['template_key'] === 'syn_mass' && x['version_no'] === 2)).toHaveLength(1);
  });
});

describe('AC-08.4 the version a report used stays resolvable after v2 is published', () => {
  it('v1 (retired by the publish of v2) is still returned by K15 with its original definition, version_no and published_at — nothing a stored report needs has changed', async () => {
    seed(); const v1 = (await call('getAnatomicSynopticTemplate', { params: { template_id: ID.P1 } })).body;
    const v2 = await call('createAnatomicSynopticTemplateVersion', { params: { template_id: ID.P1 } });
    const u = await call('updateAnatomicSynopticTemplate', { params: { template_id: v2.body.id }, headers: ifm(1), body: { definition: goodV2() } });
    await call('publishAnatomicSynopticTemplate', { params: { template_id: v2.body.id }, headers: ifm(u.body.version) });
    const again = (await call('getAnatomicSynopticTemplate', { params: { template_id: ID.P1 } })).body;
    expect(again).toMatchObject({ id: ID.P1, version_no: 1, status: 'retired', template_key: v1.template_key, definition: v1.definition, title: v1.title, published_at: v1.published_at });
    expect((await call('getAnatomicSynopticTemplate', { params: { template_id: v2.body.id } })).body).toMatchObject({ version_no: 2, status: 'published', definition: goodV2() });
  });
});

// ========================================================================================================= security
describe('security: plain-text definitions, no payload in logs, tenant isolation (07-SECURITY AB-8, REQ-SEC-088/098, BOLA)', () => {
  const XSS = '"><img src=x onerror=alert(1)>';
  it('AB-8: markup in labels / option displays is stored and returned verbatim as text (never rewritten, never executed); K15 returns the same bytes', async () => {
    seed(); const d = clone(GOOD); d.sections[0].fields[1].options[0].display = XSS; d.sections[0].fields[0].label = XSS;
    const c = await call('createAnatomicSynopticTemplate', { body: { template_key: 'syn_xss', definition: d } });
    expect(c.status).toBe(201); expect(c.body.definition.sections[0].fields[1].options[0].display).toBe(XSS);
    expect((await call('getAnatomicSynopticTemplate', { params: { template_id: c.body.id } })).body.definition).toEqual(d);
  });
  it('no definition content (labels, option text, help text) reaches the logs on any lifecycle call (ids only)', async () => {
    seed(); const d = clone(GOOD); d.sections[0].fields[0].label = 'SYNTHETIC-LOG-MARKER'; d.sections[0].fields[0].help_text = 'SYNTHETIC-LOG-MARKER';
    const c = await call('createAnatomicSynopticTemplate', { body: { template_key: 'syn_log', definition: d } });
    await call('updateAnatomicSynopticTemplate', { params: { template_id: c.body.id }, headers: ifm(1), body: { definition: d } });
    await call('publishAnatomicSynopticTemplate', { params: { template_id: c.body.id }, headers: ifm(2) });
    await call('retireAnatomicSynopticTemplate', { params: { template_id: c.body.id }, headers: ifm(3) });
    expect(calls.logs.join('\n')).not.toContain('SYNTHETIC-LOG-MARKER');
  });
  it('tenant B cannot see tenant A templates through the list, and tenant A\'s list never contains tenant B\'s', async () => {
    seed();
    const b = (await call('listAnatomicSynopticTemplates', {}, mkCtx({ tenant: T_OTHER }))).body.data; expect(b.map((t: Row) => t['id'])).toEqual([ID.OTHER]);
    expect((await call('listAnatomicSynopticTemplates', {})).body.data.some((t: Row) => t['id'] === ID.OTHER)).toBe(false);
  });
  it('every repository write names the caller\'s tenant only: a lifecycle run as tenant B leaves every tenant A row byte-identical', async () => {
    seed(); const a = JSON.stringify([...S.rows].filter(([, r]) => r['tenant_id'] === T));
    const ctx = () => mkCtx({ tenant: T_OTHER });
    const c = await call('createAnatomicSynopticTemplate', { body: { template_key: 'syn_b_only', definition: clone(GOOD) } }, ctx());
    await call('publishAnatomicSynopticTemplate', { params: { template_id: c.body.id }, headers: ifm(1) }, ctx());
    const v2 = await call('createAnatomicSynopticTemplateVersion', { params: { template_id: ID.OTHER } }, ctx());
    await call('publishAnatomicSynopticTemplate', { params: { template_id: v2.body.id }, headers: ifm(1) }, ctx());
    expect(JSON.stringify([...S.rows].filter(([, r]) => r['tenant_id'] === T))).toBe(a);
  });
});
