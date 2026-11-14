// C9 T-15 — auto-verify rule-set service #36-#41, #44, #45. AC-10.1-10.3, AC-11.4, AC-12.3; 07-SECURITY S-01/S-03/S-07/S-08/S-09; 03-APP-FLOW §2.3; 08 A17 D-55.
// FakeRepo emulates RLS + the partial unique indexes (one simulating, one active); seams: autoverify.helpers.ts header. Activation (#43) and the access-log rows are T-17.
import { describe, expect, it } from 'vitest';
import { toProblem } from '../../../core/errors.js';
import { createAutoverifyService } from '../service/autoverify.service.js';
import {
  ANALYTE, DEF1, INSTR, MANAGE_OPS, NOW, OPS, OTHER_USER, PLANTED, RETIRE_BODY, RULE_SET, RULE_SET_B, TENANT_A, TENANT_B, TEST, USER, UUID7, VER, VER_B,
  code, def, emptySeed, fullSeed, makeCtx, makeRepo, rejection, rule, setRow, validInput, verRow, type FakeSeed, type Row,
} from './autoverify.helpers.js';

const w = (seed: FakeSeed = fullSeed(), over: Parameters<typeof makeCtx>[0] = {}) => {
  const f = makeRepo(seed), c = makeCtx(over), svc: any = createAutoverifyService({ repo: f.repo });
  return { f, svc, ...c, call: (op: string, input: Row = {}) => svc[op](c.ctx, input) };
};
const keys = (o: object) => Object.keys(o).sort();
const DTO_KEYS = ['created_at', 'created_by_display', 'definition', 'id', 'rule_count', 'rule_set_id', 'status', 'version', 'version_no'];
const noLeak = (o: unknown) => { const s = JSON.stringify(o); for (const bad of ['tenant_id', 'created_by"', 'updated_by', 'updated_at', 'internal_note', PLANTED, 'simulation_started_by', 'retired_by', 'retire_reason', 'is_active', 'null']) expect(s, bad).not.toContain(bad); };
const body = (d: Row = DEF1) => ({ definition: d });
const only = (seed: Row[]): FakeSeed => ({ ...fullSeed(), versions: [...seed, verRow(1, 'draft', { id: VER_B, tenant_id: TENANT_B })], sets: [setRow({ simulating_version_id: null }), setRow({ id: RULE_SET_B, tenant_id: TENANT_B })] });

describe('AC-10.1 #37 createAutoverifyVersion from a definition', () => {
  it('first call creates the tenant rule set and version 1 `draft`; 201, ETag version 1, DTO allowlist only', async () => {
    const t = w(emptySeed());
    const r = await t.call('createAutoverifyVersion', { body: body() });
    expect(r.status).toBe(201); expect(r.version).toBe(1);
    expect(keys(r.body)).toEqual(DTO_KEYS);
    expect(r.body).toMatchObject({ version_no: 1, version: 1, status: 'draft', rule_count: 1, definition: DEF1, created_by_display: 'Synthetic Pathologist' });
    expect(r.body.id).toMatch(UUID7); expect(r.body.rule_set_id).toMatch(UUID7);
    expect(t.f.callsOf('insertRuleSet')).toHaveLength(1);
    expect(t.f.versions).toHaveLength(1);
    expect(t.f.versions[0]).toMatchObject({ tenant_id: TENANT_A, status: 'draft', version_no: 1, rule_count: 1, created_by: USER, updated_by: USER, definition: DEF1 });
    noLeak(r.body);
  });
  it('a later call reuses the rule set (one per tenant) and numbers the version max+1', async () => {
    const t = w();
    const r = await t.call('createAutoverifyVersion', { body: body() });
    expect(r.body.version_no).toBe(8); expect(t.f.callsOf('insertRuleSet')).toHaveLength(0); expect(r.body.rule_set_id).toBe(RULE_SET);
  });
  it('every query carries the tenant from the context (never from the body)', async () => {
    const t = w(emptySeed());
    await t.call('createAutoverifyVersion', { body: body() });
    expect(t.f.calls.length).toBeGreaterThan(0);
    for (const c of t.f.calls) expect(c.tenantId).toBe(TENANT_A);
  });
  it('stores exactly what was validated; rule_count = rules.length (empty definition -> 0)', async () => {
    const t = w(emptySeed());
    const r = await t.call('createAutoverifyVersion', { body: body(def()) });
    expect(r.body).toMatchObject({ rule_count: 0, definition: { schema_version: 1, rules: [] } });
  });
  it('validates against the catalog: one getTest per distinct test_id', async () => {
    const t = w(emptySeed());
    await t.call('createAutoverifyVersion', { body: body(def(rule(1), rule(2), rule(4, { test_id: TEST(2), key: 'K_4' }))) });
    expect([...t.getTestCalls].sort()).toEqual([TEST(1), TEST(2)].sort());
  });
});

describe('AC-10.2 422 quality.rule_set_invalid with errors[] pointers (#37 and #39); nothing is written', () => {
  const bad: Array<[string, Row, string]> = [
    ['duplicate key', def(rule(1, { key: 'D' }), rule(2, { key: 'D' })), '/definition/rules/1/key'],
    ['duplicate (analyte, instrument)', def(rule(1, { key: 'A' }), rule(1, { key: 'B' })), '/definition/rules/1/analyte_id'],
    ['low > high', def(rule(1, { limits: { low: '9', high: '1' } })), '/definition/rules/0/limits'],
    ['flag LL', def(rule(1, { allowed_range_flags: ['LL'] })), '/definition/rules/0/allowed_range_flags/0'],
    ['analyte of another test', def(rule(1, { analyte_id: ANALYTE(4) })), '/definition/rules/0/analyte_id'],
    ['non-numeric analyte', def(rule(3)), '/definition/rules/0/analyte_id'],
    ['unknown test (CatalogPort not_found)', def(rule(1, { test_id: TEST(9) })), '/definition/rules/0/test_id'],
    ['unknown field in a rule', def(rule(1, { status: 'active' })), '/definition/rules/0/status'],
  ];
  it.each(bad)('create: %s -> 422 at %s', async (_n, d, ptr) => {
    const t = w(emptySeed());
    const e = await rejection(t.call('createAutoverifyVersion', { body: body(d) }));
    expect(e.code).toBe('quality.rule_set_invalid');
    const p = toProblem(e, '/x', '0190a000-0000-7000-8000-0000000000e1');
    expect(p.status).toBe(422); expect(p.errors?.map((x) => x.path)).toContain(ptr);
    expect(t.f.mutations()).toEqual([]);
  });
  it.each(bad)('replace draft: %s -> 422 at %s; draft unchanged', async (_n, d, ptr) => {
    const t = w();
    const before = structuredClone(t.f.ver(1));
    const e = await rejection(t.call('replaceAutoverifyDraft', { versionId: VER(1), expectedVersion: 1, body: body(d) }));
    expect(e.code).toBe('quality.rule_set_invalid'); expect(e.errors.map((x: any) => x.path)).toContain(ptr);
    expect(t.f.ver(1)).toEqual(before); expect(t.f.mutations()).toEqual([]);
  });
  it('every error entry has path + code and no echo of submitted values', async () => {
    const t = w(emptySeed());
    const e = await rejection(t.call('createAutoverifyVersion', { body: body(def(rule(1, { note: PLANTED, key: 'bad key', limits: { low: '9', high: '1' } }))) }));
    expect(e.errors.length).toBeGreaterThanOrEqual(2);
    for (const x of e.errors) { expect(typeof x.path).toBe('string'); expect(typeof x.code).toBe('string'); }
    expect(JSON.stringify({ m: e.message, d: e.detail, e: e.errors })).not.toContain(PLANTED);
  });
  it('catalog outage is not "invalid rules": the dependency error propagates and nothing is written', async () => {
    const t = w(emptySeed(), { catalogDown: true });
    const e = await rejection(t.call('createAutoverifyVersion', { body: body() }));
    expect(e.code).toBe('common.dependency_unavailable'); expect(t.f.mutations()).toEqual([]);
  });
});

describe('#37 body shape: exactly one of copy_from_version_id / definition; mass assignment (S-03)', () => {
  it.each([
    ['both', { copy_from_version_id: VER(1), definition: DEF1 }], ['neither', {}], ['tenant_id', { definition: DEF1, tenant_id: TENANT_B }],
    ['status', { definition: DEF1, status: 'active' }], ['version_no', { definition: DEF1, version_no: 99 }], ['created_by', { definition: DEF1, created_by: OTHER_USER }],
    ['copy id not a uuid', { copy_from_version_id: 'nope' }], ['non-object body', 'x'], ['array body', []], ['null body', null],
  ])('%s -> 400 common.validation_failed, nothing written', async (_n, b) => {
    const t = w();
    const e = await rejection(t.call('createAutoverifyVersion', { body: b }));
    expect(e.code).toBe('common.validation_failed'); expect(t.f.mutations()).toEqual([]);
  });
  it('unknown body field is reported as common.unknown_field at its pointer', async () => {
    const e = await rejection(w().call('createAutoverifyVersion', { body: { definition: DEF1, tenant_id: TENANT_B } }));
    expect(e.errors).toEqual(expect.arrayContaining([expect.objectContaining({ path: '/tenant_id', code: 'common.unknown_field' })]));
  });
});

describe('AC-11.4 #37 copy_from_version_id: a new draft from any version, incl. `stopped`', () => {
  it('copy of the stopped version: new draft, same rules, next version_no, source untouched', async () => {
    const seed = fullSeed(); seed.versions!.find((v) => v['id'] === VER(3))!['definition'] = def(rule(1), rule(2)); seed.versions!.find((v) => v['id'] === VER(3))!['rule_count'] = 2;
    const t = w(seed);
    const src = structuredClone(t.f.ver(3));
    const r = await t.call('createAutoverifyVersion', { body: { copy_from_version_id: VER(3) } });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: 'draft', version_no: 8, rule_count: 2, definition: def(rule(1), rule(2)), version: 1 });
    expect(r.body.id).not.toBe(VER(3));
    expect(t.f.ver(3)).toEqual(src);
  });
  it('copy of an unknown or other tenant\'s version -> 404 common.not_found (same as missing), nothing written', async () => {
    for (const id of [VER_B, VER(99)]) {
      const t = w();
      expect((await rejection(t.call('createAutoverifyVersion', { body: { copy_from_version_id: id } }))).code).toBe('common.not_found');
      expect(t.f.mutations()).toEqual([]);
    }
  });
});

describe('#39 replaceAutoverifyDraft (AV2) and AC-10.3 trigger immutability at service level', () => {
  it('draft: definition replaced, rule_count recomputed, version bumped (ETag), status stays draft', async () => {
    const t = w();
    const r = await t.call('replaceAutoverifyDraft', { versionId: VER(1), expectedVersion: 1, body: body(def(rule(1), rule(2))) });
    expect(r.status).toBe(200); expect(r.version).toBe(2);
    expect(r.body).toMatchObject({ id: VER(1), status: 'draft', version: 2, rule_count: 2, definition: def(rule(1), rule(2)) });
    expect(t.f.ver(1)).toMatchObject({ version: 2, rule_count: 2, updated_by: USER });
    noLeak(r.body);
  });
  it.each(['simulating', 'stopped', 'active', 'retired', 'discarded'])('AC-10.3 %s version cannot be edited -> 409 quality.rule_set_invalid_transition; row untouched', async (status) => {
    const t = w(only([verRow(1, status)]));
    const before = structuredClone(t.f.ver(1));
    const e = await rejection(t.call('replaceAutoverifyDraft', { versionId: VER(1), expectedVersion: 1, body: body(def(rule(2))) }));
    expect(e.code).toBe('quality.rule_set_invalid_transition'); expect(toProblem(e, '/x', '0190a000-0000-7000-8000-0000000000e1').status).toBe(409);
    expect(t.f.ver(1)).toEqual(before); expect(t.f.callsOf('updateVersion')).toEqual([]);
  });
  it('missing If-Match -> 428 common.precondition_required; stale -> 409 common.version_conflict; neither writes', async () => {
    const t = w();
    expect((await rejection(t.call('replaceAutoverifyDraft', { versionId: VER(1), body: body() }))).code).toBe('common.precondition_required');
    expect((await rejection(t.call('replaceAutoverifyDraft', { versionId: VER(1), expectedVersion: 7, body: body() }))).code).toBe('common.version_conflict');
    expect(t.f.ver(1)['version']).toBe(1);
  });
  it('body with anything but `definition` -> 400 (status, version_no, tenant_id are never settable)', async () => {
    for (const extra of [{ status: 'active' }, { tenant_id: TENANT_B }, { version_no: 3 }]) {
      const e = await rejection(w().call('replaceAutoverifyDraft', { versionId: VER(1), expectedVersion: 1, body: { definition: DEF1, ...extra } }));
      expect(e.code).toBe('common.validation_failed');
    }
    expect((await rejection(w().call('replaceAutoverifyDraft', { versionId: VER(1), expectedVersion: 1, body: {} }))).code).toBe('common.validation_failed');
  });
});

describe('AV3 #40 startAutoverifySimulation — one simulating version per tenant', () => {
  it('draft -> simulating: simulation_started_at/by set, rule-set simulating pointer set; 200 + ETag', async () => {
    const t = w(only([verRow(1, 'draft')]));
    const r = await t.call('startAutoverifySimulation', { versionId: VER(1), expectedVersion: 1, body: {} });
    expect(r.status).toBe(200); expect(r.version).toBe(2);
    expect(r.body).toMatchObject({ status: 'simulating', version: 2, simulation_started_at: NOW });
    expect(t.f.ver(1)).toMatchObject({ status: 'simulating', simulation_started_at: NOW, simulation_started_by: USER });
    expect(t.f.set()['simulating_version_id']).toBe(VER(1));
    noLeak(r.body);
  });
  it('another version already simulating -> 409 quality.rule_set_invalid_transition; no change', async () => {
    const t = w();   // fullSeed: v2 simulating, v1 + v7 drafts
    const e = await rejection(t.call('startAutoverifySimulation', { versionId: VER(1), expectedVersion: 1, body: {} }));
    expect(e.code).toBe('quality.rule_set_invalid_transition');
    expect(t.f.ver(1)['status']).toBe('draft'); expect(t.f.set()['simulating_version_id']).toBe(VER(2));
  });
  it.each(['simulating', 'stopped', 'active', 'retired', 'discarded'])('starting a %s version -> 409', async (status) => {
    const t = w(only([verRow(1, status)]));
    expect((await rejection(t.call('startAutoverifySimulation', { versionId: VER(1), expectedVersion: 1, body: {} }))).code).toBe('quality.rule_set_invalid_transition');
    expect(t.f.mutations()).toEqual([]);
  });
  it('two concurrent starts of two drafts: exactly one wins, the other gets 409 (partial unique index race -> mapped, not a 500)', async () => {
    const t = w(only([verRow(1, 'draft'), verRow(7, 'draft')]));
    const res = await Promise.allSettled([
      t.call('startAutoverifySimulation', { versionId: VER(1), expectedVersion: 1, body: {} }),
      t.call('startAutoverifySimulation', { versionId: VER(7), expectedVersion: 1, body: {} }),
    ]);
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = res.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason.code).toBe('quality.rule_set_invalid_transition');
    expect(t.f.versions.filter((v) => v['tenant_id'] === TENANT_A && v['status'] === 'simulating')).toHaveLength(1);
  });
  it('a unique-violation from the DB on the simulating index maps to 409 even if the pre-check passed', async () => {
    const t = w(only([verRow(1, 'draft')]));
    t.f.repo.updateVersion = async () => { throw Object.assign(new Error('dup'), { code: '23505', constraint: 'autoverify_versions__tenant_simulating__p_uq' }); };
    expect((await rejection(createAutoverifyService({ repo: t.f.repo }).startAutoverifySimulation(t.ctx, { versionId: VER(1), expectedVersion: 1, body: {} }))).code).toBe('quality.rule_set_invalid_transition');
  });
});

describe('AC-11.4 #41 stopAutoverifySimulation: simulating -> stopped (terminal, D-55)', () => {
  it('status stopped, simulation_stopped_at = now, rule-set simulating pointer cleared, definition + start fields kept; 200 + ETag', async () => {
    const t = w();
    const defBefore = structuredClone(t.f.ver(2)['definition']);
    const r = await t.call('stopAutoverifySimulation', { versionId: VER(2), expectedVersion: 1, body: {} });
    expect(r.status).toBe(200); expect(r.version).toBe(2);
    expect(r.body).toMatchObject({ id: VER(2), status: 'stopped', simulation_stopped_at: NOW, simulation_started_at: '2026-11-02T08:00:00.000Z', definition: defBefore });
    expect(t.f.ver(2)).toMatchObject({ status: 'stopped', simulation_stopped_at: NOW });
    expect(t.f.set()['simulating_version_id']).toBeNull();
    expect(t.f.set()['active_version_id']).toBe(VER(4));
    noLeak(r.body);
  });
  it('shadow rows are kept: the service never deletes anything (no DELETE statement, no delete* repo call)', async () => {
    const t = w();
    await t.call('stopAutoverifySimulation', { versionId: VER(2), expectedVersion: 1, body: {} });
    expect(t.queries.filter((q) => /delete|truncate/i.test(q.text))).toEqual([]);
    expect(t.f.calls.filter((c) => /^(delete|remove|purge)/i.test(c.op))).toEqual([]);
    expect(t.f.callsOf('updateVersion')).toHaveLength(1);
  });
  it('stopped is terminal: stop again, start, replace, discard, retire — every later transition -> 409 quality.rule_set_invalid_transition, row unchanged', async () => {
    const t = w();
    await t.call('stopAutoverifySimulation', { versionId: VER(2), expectedVersion: 1, body: {} });
    const after = structuredClone(t.f.ver(2));
    const tries: Array<[string, Row]> = [
      ['stopAutoverifySimulation', { versionId: VER(2), expectedVersion: 2, body: {} }], ['startAutoverifySimulation', { versionId: VER(2), expectedVersion: 2, body: {} }],
      ['replaceAutoverifyDraft', { versionId: VER(2), expectedVersion: 2, body: body() }], ['discardAutoverifyDraft', { versionId: VER(2), expectedVersion: 2, body: {} }],
      ['retireAutoverifyVersion', { versionId: VER(2), expectedVersion: 2, body: RETIRE_BODY }],
    ];
    for (const [op, input] of tries) expect(code(await rejection(t.call(op, input))), op).toBe('quality.rule_set_invalid_transition');
    expect(t.f.ver(2)).toEqual(after);
  });
  it.each(['draft', 'stopped', 'active', 'retired', 'discarded'])('stopping a %s version -> 409 (only `simulating` can be stopped)', async (status) => {
    const t = w(only([verRow(1, status)]));
    expect((await rejection(t.call('stopAutoverifySimulation', { versionId: VER(1), expectedVersion: 1, body: {} }))).code).toBe('quality.rule_set_invalid_transition');
    expect(t.f.mutations()).toEqual([]);
  });
  it('after a stop a new simulation can start from a new draft (copy), the pointer follows the new one', async () => {
    const t = w();
    await t.call('stopAutoverifySimulation', { versionId: VER(2), expectedVersion: 1, body: {} });
    const c = await t.call('createAutoverifyVersion', { body: { copy_from_version_id: VER(2) } });
    await t.call('startAutoverifySimulation', { versionId: c.body.id, expectedVersion: 1, body: {} });
    expect(t.f.set()['simulating_version_id']).toBe(c.body.id);
  });
  it('stale If-Match -> 409 version_conflict; missing -> 428', async () => {
    const t = w();
    expect((await rejection(t.call('stopAutoverifySimulation', { versionId: VER(2), expectedVersion: 5, body: {} }))).code).toBe('common.version_conflict');
    expect((await rejection(t.call('stopAutoverifySimulation', { versionId: VER(2), body: {} }))).code).toBe('common.precondition_required');
    expect(t.f.ver(2)['status']).toBe('simulating');
  });
});

describe('AV6 #44 retireAutoverifyVersion; AV7 #45 discardAutoverifyDraft', () => {
  it('retire active: status retired, retired_at/by + reason stored, active pointer cleared (all live decisions then rule_missing)', async () => {
    const t = w();
    const r = await t.call('retireAutoverifyVersion', { versionId: VER(4), expectedVersion: 1, body: RETIRE_BODY });
    expect(r.status).toBe(200); expect(r.version).toBe(2);
    expect(r.body).toMatchObject({ status: 'retired', retired_at: NOW });
    expect(t.f.ver(4)).toMatchObject({ status: 'retired', retired_at: NOW, retired_by: USER, retire_reason: RETIRE_BODY.reason });
    expect(t.f.set()['active_version_id']).toBeNull();
    expect(t.f.set()['simulating_version_id']).toBe(VER(2));
    noLeak(r.body);
  });
  it.each([[''], ['x'.repeat(501)], [undefined], [7], [null]])('retire reason %j -> 400 common.validation_failed at /reason', async (reason) => {
    const t = w();
    const e = await rejection(t.call('retireAutoverifyVersion', { versionId: VER(4), expectedVersion: 1, body: reason === undefined ? {} : { reason } }));
    expect(e.code).toBe('common.validation_failed'); expect(e.errors.map((x: any) => x.path)).toContain('/reason'); expect(t.f.mutations()).toEqual([]);
  });
  it('retire reason of 1 and 500 characters is accepted', async () => {
    for (const reason of ['x', 'x'.repeat(500)]) expect((await w().call('retireAutoverifyVersion', { versionId: VER(4), expectedVersion: 1, body: { reason } })).status).toBe(200);
  });
  it.each(['draft', 'simulating', 'stopped', 'retired', 'discarded'])('retire a %s version -> 409 quality.rule_set_invalid_transition', async (status) => {
    const t = w(only([verRow(1, status)]));
    expect((await rejection(t.call('retireAutoverifyVersion', { versionId: VER(1), expectedVersion: 1, body: RETIRE_BODY }))).code).toBe('quality.rule_set_invalid_transition');
    expect(t.f.mutations()).toEqual([]);
  });
  it('discard draft -> discarded; no pointer touched', async () => {
    const t = w();
    const r = await t.call('discardAutoverifyDraft', { versionId: VER(1), expectedVersion: 1, body: {} });
    expect(r.status).toBe(200); expect(r.body).toMatchObject({ id: VER(1), status: 'discarded', version: 2 }); expect(r.version).toBe(2);
    expect(t.f.set()).toMatchObject({ active_version_id: VER(4), simulating_version_id: VER(2) });
  });
  it.each(['simulating', 'stopped', 'active', 'retired', 'discarded'])('discard a %s version -> 409', async (status) => {
    const t = w(only([verRow(1, status)]));
    expect((await rejection(t.call('discardAutoverifyDraft', { versionId: VER(1), expectedVersion: 1, body: {} }))).code).toBe('quality.rule_set_invalid_transition');
    expect(t.f.mutations()).toEqual([]);
  });
  it('body must be {} for start/stop/discard: unknown field -> 400', async () => {
    for (const [op, vid] of [['startAutoverifySimulation', VER(1)], ['stopAutoverifySimulation', VER(2)], ['discardAutoverifyDraft', VER(1)]] as const) {
      const t = w();
      expect((await rejection(t.call(op, { versionId: vid, expectedVersion: 1, body: { status: 'active' } }))).code, op).toBe('common.validation_failed');
      expect(t.f.mutations()).toEqual([]);
    }
  });
});

describe('#36 getAutoverifyRuleSet and #38 getAutoverifyVersion', () => {
  it('#36: pointers + versions newest first, summary rows only (no definition), counts; ≤ 200 versions', async () => {
    const r = await w().call('getAutoverifyRuleSet');
    expect(r.status).toBe(200);
    expect(keys(r.body)).toEqual(['active_version_id', 'id', 'simulating_version_id', 'version', 'versions']);
    expect(r.body).toMatchObject({ id: RULE_SET, active_version_id: VER(4), simulating_version_id: VER(2) });
    expect(r.body.versions.map((v: Row) => v['version_no'])).toEqual([7, 6, 5, 4, 3, 2, 1]);
    expect(r.body.versions[0]).toMatchObject({ id: VER(7), version_no: 7, status: 'draft', rule_count: 1, created_by_display: 'Synthetic Pathologist' });
    for (const v of r.body.versions) { expect(v).not.toHaveProperty('definition'); expect(Object.keys(v).sort().every((k) => ['id', 'version_no', 'status', 'rule_count', 'created_at', 'created_by_display', 'simulation_started_at', 'simulation_stopped_at', 'activated_at', 'activated_by_display', 'retired_at'].includes(k))).toBe(true); }
    expect(r.body.versions.find((v: Row) => v['id'] === VER(4))).toMatchObject({ activated_by_display: 'Synthetic Lab Manager' });
    noLeak(r.body);
  });
  it('#36: more than 200 versions -> the 200 newest', async () => {
    const seed = fullSeed(); for (let n = 8; n <= 260; n++) seed.versions!.push(verRow(n, 'discarded'));
    const r = await w(seed).call('getAutoverifyRuleSet');
    expect(r.body.versions).toHaveLength(200); expect(r.body.versions[0].version_no).toBe(260);
  });
  it('#36: no rule set yet -> 404 common.not_found', async () => { expect((await rejection(w(emptySeed()).call('getAutoverifyRuleSet'))).code).toBe('common.not_found'); });
  it('#36: tenant B has a set, tenant A none -> A sees 404, never B\'s data', async () => {
    const seed: FakeSeed = { ...emptySeed(), sets: [setRow({ id: RULE_SET_B, tenant_id: TENANT_B })], versions: [] };
    expect((await rejection(w(seed).call('getAutoverifyRuleSet'))).code).toBe('common.not_found');
  });
  it('#38: full DTO with definition + ETag version; status and timestamps', async () => {
    const r = await w().call('getAutoverifyVersion', { versionId: VER(3) });
    expect(r.status).toBe(200); expect(r.version).toBe(1);
    expect(keys(r.body)).toEqual([...DTO_KEYS, 'simulation_started_at', 'simulation_stopped_at'].sort());
    expect(r.body).toMatchObject({ id: VER(3), status: 'stopped', simulation_stopped_at: '2026-11-03T08:00:00.000Z', definition: DEF1 });
    noLeak(r.body);
  });
  it('#38: unknown / other tenant\'s version -> 404 (identical to missing)', async () => {
    for (const id of [VER(99), VER_B]) expect((await rejection(w().call('getAutoverifyVersion', { versionId: id }))).code).toBe('common.not_found');
  });
});

describe('S-01 cross-tenant: tenant B ids on every version operation -> 404 common.not_found, no side effect', () => {
  it.each([
    ['replaceAutoverifyDraft', { versionId: VER_B, expectedVersion: 1, body: body() }], ['startAutoverifySimulation', { versionId: VER_B, expectedVersion: 1, body: {} }],
    ['stopAutoverifySimulation', { versionId: VER_B, expectedVersion: 1, body: {} }], ['retireAutoverifyVersion', { versionId: VER_B, expectedVersion: 1, body: RETIRE_BODY }],
    ['discardAutoverifyDraft', { versionId: VER_B, expectedVersion: 1, body: {} }],
  ])('%s', async (op, input) => {
    const t = w();
    expect((await rejection(t.call(op, input))).code).toBe('common.not_found');
    expect(t.f.mutations()).toEqual([]);
    expect(t.f.versions.find((v) => v['id'] === VER_B)).toMatchObject({ status: 'draft', version: 1 });
  });
  it('a tenant-B actor cannot touch tenant A\'s version either', async () => {
    const t = w(fullSeed(), { tenantId: TENANT_B });
    expect((await rejection(t.call('discardAutoverifyDraft', { versionId: VER(1), expectedVersion: 1, body: {} }))).code).toBe('common.not_found');
    expect(t.f.ver(1)['status']).toBe('draft');
  });
});

describe('AC-12.3 / S-07 / S-08 aal2 and permission on every quality.autoverify.manage operation', () => {
  it.each(MANAGE_OPS)('%s at aal1 -> auth.mfa_required (403) BEFORE any read, write or catalog call', async (op) => {
    const t = w(fullSeed(), { aal: 'aal1' });
    const e = await rejection(t.call(op, validInput(op)));
    expect(e.code).toBe('auth.mfa_required'); expect(toProblem(e, '/x', '0190a000-0000-7000-8000-0000000000e1').status).toBe(403);
    expect(t.asserted).toEqual([{ permission: 'quality.autoverify.manage' }]);
    expect(t.f.calls).toEqual([]); expect(t.getTestCalls).toEqual([]);
  });
  it.each(MANAGE_OPS)('%s at aal2 asserts quality.autoverify.manage exactly once', async (op) => {
    const t = w(fullSeed(), { aal: 'aal2' });
    await t.call(op, validInput(op)).catch(() => undefined);   // outcome depends on the seed; the permission check must have happened
    expect(t.asserted.filter((a) => a.permission === 'quality.autoverify.manage')).toHaveLength(1);
  });
  it.each(MANAGE_OPS)('%s with only the read permission -> auth.forbidden, nothing touched', async (op) => {
    const t = w(fullSeed(), { held: ['quality.autoverify.read'] });
    expect((await rejection(t.call(op, validInput(op)))).code).toBe('auth.forbidden'); expect(t.f.calls).toEqual([]);
  });
  it.each(OPS)('%s with no quality rights -> auth.forbidden, nothing touched', async (op) => {
    const t = w(fullSeed(), { held: [] });
    expect((await rejection(t.call(op, validInput(op)))).code).toBe('auth.forbidden'); expect(t.f.calls).toEqual([]);
  });
  it.each(['getAutoverifyRuleSet', 'getAutoverifyVersion'] as const)('%s needs quality.autoverify.read only (no aal2 demanded for reads)', async (op) => {
    const t = w(fullSeed(), { held: ['quality.autoverify.read'], aal: 'aal1' });
    expect((await t.call(op, validInput(op))).status).toBe(200);
    expect(t.asserted).toEqual([{ permission: 'quality.autoverify.read' }]);
  });
  it('a manage-only principal cannot read (read permission is asserted separately)', async () => {
    const t = w(fullSeed(), { held: ['quality.autoverify.manage'] });
    expect((await rejection(t.call('getAutoverifyVersion', { versionId: VER(1) }))).code).toBe('auth.forbidden');
  });
});

describe('error rendering and input hygiene', () => {
  it('rule_set_invalid -> 422 and rule_set_invalid_transition -> 409 with Problem codes from contracts/errors.yaml', async () => {
    const rid = '0190a000-0000-7000-8000-0000000000e1';
    const a = toProblem(await rejection(w(emptySeed()).call('createAutoverifyVersion', { body: body(def(rule(1, { limits: { low: '9', high: '1' } }))) })), '/x', rid);
    expect(a).toMatchObject({ status: 422, code: 'quality.rule_set_invalid' });
    const b = toProblem(await rejection(w().call('replaceAutoverifyDraft', { versionId: VER(3), expectedVersion: 1, body: body() })), '/x', rid);
    expect(b).toMatchObject({ status: 409, code: 'quality.rule_set_invalid_transition' });
  });
  it('a version_id that is not a uuid never reaches SQL: 404/400, no repo mutation', async () => {
    for (const versionId of ["' OR 1=1 --", '', undefined, 7]) {
      const t = w();
      const e = await rejection(t.call('discardAutoverifyDraft', { versionId, expectedVersion: 1, body: {} }));
      expect(['common.not_found', 'common.validation_failed']).toContain(e.code); expect(t.f.mutations()).toEqual([]);
    }
  });
  it('the actor id is the only identity written (a body created_by is rejected, not honoured)', async () => {
    const t = w(emptySeed());
    await rejection(t.call('createAutoverifyVersion', { body: { definition: DEF1, created_by: OTHER_USER } }));
    expect(t.f.versions).toHaveLength(0);
    await t.call('createAutoverifyVersion', { body: body() });
    expect(t.f.versions[0]).toMatchObject({ created_by: USER });
  });
  it('INSTR is only used for instrument-specific rules: instrument_id passes through to storage unchanged', async () => {
    const t = w(emptySeed());
    const d = def(rule(1, { instrument_id: INSTR(1) }));
    await t.call('createAutoverifyVersion', { body: body(d) });
    expect(t.f.versions[0]!['definition']).toEqual(d);
  });
});
