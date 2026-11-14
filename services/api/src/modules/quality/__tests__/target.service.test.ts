// C9 T-08 — QC targets + establish-from-data service #20-#25 (02-TRD §5.3 / §7.6; 03-APP-FLOW §2.5; AC-04.1–04.6; 07-SECURITY S-01/S-03/S-07/S-09/AB-01).
// Fake repo (emulates the 05-SCHEMA constraints, the active-per-key unique index and the immutability trigger) + fake CatalogPort; SEAMS in target.helpers.ts header.
import { describe, expect, it } from 'vitest';
import { createTargetService } from '../service/target.service.js';
import {
  ANA, CATALOG, DTO_KEYS, FROM, FUTURE, LOT, LVL, MUTABLE, NOISE, NOW, OBS, OPS, PAST, PLANTED, PLN, TENANT_A, TENANT_B, TGT, TO, TST, USER, UUID7, baseSeed, cleanObs, code, createBody,
  emptyTargets, estBody, immutableRow, lotRow, makeCatalog, makePlanCtx, makeTargetRepo, noRights, obsRow, pgErr, readOnly, rejection, type Row, type Seed,
} from './target.helpers.js';

const setup = (o: Parameters<typeof makePlanCtx>[0] = {}, seed: Seed = baseSeed()) => {
  const fake = makeTargetRepo(seed); const c = makePlanCtx(o); const svc: any = createTargetService({ repo: fake.repo });
  return { svc, fake, ...c };
};
/** Seed = base + the 25 clean observations + `extra`. */
const withObs = (extra: Row[] = [], o: Parameters<typeof makePlanCtx>[0] = {}, seedO: Partial<Seed> = {}) => setup(o, { ...baseSeed(), observations: [...cleanObs(), ...extra], ...seedO });
const errors = (e: any): Array<{ path: string; code: string }> => (e?.errors ?? e?.details ?? []).map((x: any) => ({ path: x.path, code: x.code }));
const invalid = async (p: Promise<unknown>, path: string, c = 'common.field_invalid') => {
  const e = await rejection(p); expect(code(e)).toBe('common.validation_failed'); expect(errors(e)).toContainEqual({ path, code: c }); return e;
};
const digest = (r: any): string => r.body.basis.observation_ids_sha256;
const act = (s: any, id: string, v = 1, body: Row = {}) => s.svc.activateQcTarget(s.ctx, { targetId: id, expectedVersion: v, body });
const ret = (s: any, id: string, v = 1, body: Row = { reason: 'Superseded by new lot' }) => s.svc.retireQcTarget(s.ctx, { targetId: id, expectedVersion: v, body });
const dis = (s: any, id: string, v = 1, body: Row = {}) => s.svc.discardQcTarget(s.ctx, { targetId: id, expectedVersion: v, body });
const create = (s: any, o: Row = {}) => s.svc.createQcTarget(s.ctx, { body: createBody(o) });
const establish = (s: any, o: Row = {}) => s.svc.establishQcTarget(s.ctx, { body: estBody(o) });

// ================================================================================================================ AC-04.1 — manual create (#21)
describe('createQcTarget (#21): manufacturer values -> a draft target (AC-04.1)', () => {
  it('AC-04.1 mean 100.0, SD 2.0, source manufacturer for (K plan, LOT-SYN-01) -> 201 draft, version 1; level comes from the lot', async () => {
    const s = setup(); const r = await create(s);
    expect(r.status).toBe(201); expect(r.version).toBe(1);
    expect(r.body).toMatchObject({ plan_id: PLN(1), lot_id: LOT(1), level_id: LVL(1), unit_code: 'mmol_l', source: 'manufacturer', status: 'draft', version: 1, created_by_display: 'Synthetic Lab Manager' });
    expect(r.body.id).toMatch(UUID7); expect(Number(r.body.mean)).toBe(100); expect(Number(r.body.sd)).toBe(2); expect(Number(r.body.cv_pct)).toBeCloseTo(2, 2);
    for (const k of ['effective_from', 'effective_to', 'basis', 'activated_by_display']) expect(r.body, k).not.toHaveProperty(k);
  });
  it('writes exactly one qc_targets row: draft, source manufacturer, decimal STRINGS, tenant + actor from the context, no basis columns, no activation columns', async () => {
    const s = setup(); await create(s, { note: 'Synthetic manufacturer insert values' });
    expect(s.fake.mutations().map((m) => m.op)).toEqual(['insertTarget']);
    const [c] = s.fake.callsOf('insertTarget'); const row = c!.args[0] as Row;
    expect(c!.tenantId).toBe(TENANT_A); expect(row).toMatchObject({ plan_id: PLN(1), lot_id: LOT(1), level_id: LVL(1), unit_code: 'mmol_l', source: 'manufacturer', note: 'Synthetic manufacturer insert values', created_by: USER, updated_by: USER });
    expect(row['id']).toMatch(UUID7); expect(typeof row['mean']).toBe('string'); expect(typeof row['sd']).toBe('string'); expect(Number(row['mean'])).toBe(100); expect(Number(row['sd'])).toBe(2);
    expect([undefined, 'draft']).toContain(row['status']);
    for (const k of ['basis_n', 'basis_from', 'basis_to', 'basis_observation_ids_sha256', 'effective_from', 'effective_to', 'activated_at', 'activated_by']) expect(row[k] ?? null, k).toBeNull();
    expect(s.fake.byId(row['id'])).toMatchObject({ status: 'draft', tenant_id: TENANT_A });
  });
  it('creating a draft for a key that already has an ACTIVE target is allowed (it is superseded only on activation); the active one is untouched', async () => {
    const s = setup(); const r = await create(s, { mean: '103.5', sd: '2.2' });
    expect(r.status).toBe(201); expect(s.fake.byId(TGT(1))).toMatchObject({ status: 'active', version: 1, mean: '100.000000' }); expect(s.fake.activeOf(PLN(1), LOT(1))).toHaveLength(1);
  });
  it('nothing is enqueued and no other table is touched by a create', async () => {
    const s = setup(); await create(s); expect(s.enqueues()).toEqual([]); expect(s.queries).toEqual([]);
  });
  it('AC-04.1 end to end: create -> activate -> active from effective_from (default now), activated_by recorded, reprocess enqueued for the plan', async () => {
    const s = setup({}, emptyTargets()); const c = await create(s); const a = await act(s, c.body.id, c.version);
    expect(a.status).toBe(200); expect(a.version).toBe(2);
    expect(a.body).toMatchObject({ id: c.body.id, status: 'active', effective_from: NOW, version: 2, activated_by_display: 'Synthetic Lab Manager' }); expect(a.body).not.toHaveProperty('effective_to');
    expect(s.fake.byId(c.body.id)).toMatchObject({ status: 'active', effective_from: NOW, activated_at: NOW, activated_by: USER, updated_by: USER });
    expect(s.enqueues()).toEqual([{ task: 'quality.reprocess_pending_observations', payload: { tenant_id: TENANT_A, plan_id: PLN(1) }, key: `reproc:${PLN(1)}` }]);
  });
  it('activation with a future effective_from: active from that instant', async () => {
    const s = setup({}, emptyTargets()); const c = await create(s); const a = await act(s, c.body.id, c.version, { effective_from: FUTURE });
    expect(a.body).toMatchObject({ status: 'active', effective_from: FUTURE });
  });
});

describe('createQcTarget: source is manufacturer ONLY (done_when; AC-04.1)', () => {
  it.each(['established', 'Manufacturer', 'MANUFACTURER', 'external', '', ' manufacturer', 'manufacturer ', 5, null, true, ['manufacturer']])('source %j -> 400 common.validation_failed at /source, nothing written', async (src) => {
    const s = setup(); await invalid(create(s, { source: src }), '/source'); expect(s.fake.mutations()).toHaveLength(0);
  });
  it('source missing -> 400 /source common.field_required', async () => {
    const s = setup(); const b = createBody(); delete b['source']; await invalid(s.svc.createQcTarget(s.ctx, { body: b }), '/source', 'common.field_required'); expect(s.fake.mutations()).toHaveLength(0);
  });
  it('established values supplied by hand are refused with their basis fields as unknown_field: basis_n, basis_from, basis_to, basis_observation_ids_sha256 can only come from #22', async () => {
    const s = setup();
    for (const k of ['basis_n', 'basis_from', 'basis_to', 'basis_observation_ids_sha256', 'basis']) await invalid(create(s, { source: 'manufacturer', [k]: k === 'basis_n' ? 25 : 'x' }), `/${k}`, 'common.unknown_field');
    expect(s.fake.mutations()).toHaveLength(0);
  });
  it('unknown / server-owned fields are common.unknown_field (S-03): tenant_id, id, level_id, status, version, effective_from, effective_to, created_by, is_active', async () => {
    const s = setup();
    for (const k of ['tenant_id', 'id', 'level_id', 'status', 'version', 'effective_from', 'effective_to', 'created_by', 'is_active', 'activated_by']) await invalid(create(s, { [k]: k === 'version' ? 1 : TENANT_B }), `/${k}`, 'common.unknown_field');
    expect(s.fake.mutations()).toHaveLength(0);
  });
});

// ================================================================================================================ AC-04.4 — SD <= 0 and field validation
describe('createQcTarget: field validation (AC-04.4)', () => {
  it.each(['0', '0.0', '0.000000', '-1', '-0.5', '-0'])('AC-04.4 sd %j (<= 0) -> 400 common.validation_failed at /sd, nothing written', async (sd) => {
    const s = setup(); await invalid(create(s, { sd }), '/sd'); expect(s.fake.mutations()).toHaveLength(0);
  });
  it.each(['abc', '', '1e3', '1,5', ' 2', '2 ', '.5', '5.', 'NaN', 'Infinity', 2, null, true])('sd %j is not a DecimalString -> 400 at /sd', async (sd) => { const s = setup(); await invalid(create(s, { sd }), '/sd'); expect(s.fake.mutations()).toHaveLength(0); });
  it.each(['abc', '', '1e3', '1,5', ' 2', '.5', 'NaN', 100, null, false])('mean %j is not a DecimalString -> 400 at /mean', async (mean) => { const s = setup(); await invalid(create(s, { mean }), '/mean'); expect(s.fake.mutations()).toHaveLength(0); });
  it('a tiny positive sd (0.000001) is accepted; a negative mean is accepted (decimal strings, not floats)', async () => {
    const s = setup(); expect((await create(s, { sd: '0.000001', mean: '-3.5' })).status).toBe(201);
    expect(s.fake.callsOf('insertTarget')[0]!.args[0]).toMatchObject({ sd: expect.stringMatching(/^0\.000001/), mean: expect.stringMatching(/^-3\.5/) });
  });
  it.each(['plan_id', 'lot_id', 'mean', 'sd', 'unit_code'])('%s missing -> 400 common.field_required', async (k) => {
    const s = setup(); const b = createBody(); delete b[k]; await invalid(s.svc.createQcTarget(s.ctx, { body: b }), `/${k}`, 'common.field_required'); expect(s.fake.mutations()).toHaveLength(0);
  });
  it.each([[['plan_id', 'not-a-uuid']], [['lot_id', '123']], [['unit_code', '']], [['unit_code', 'a b']], [['unit_code', 7]], [['plan_id', null]]])('%j -> 400 on that field', async ([k, v]) => {
    const s = setup(); await invalid(create(s, { [k as string]: v }), `/${k}`); expect(s.fake.mutations()).toHaveLength(0);
  });
  it('note is optional and 0..500 characters', async () => {
    const s = setup(); await invalid(create(s, { note: 'x'.repeat(501) }), '/note'); await invalid(create(s, { note: 5 }), '/note'); expect(s.fake.mutations()).toHaveLength(0);
    expect((await create(s, { note: 'x'.repeat(500) })).status).toBe(201); expect((await create(s)).status).toBe(201);
  });
  it('a non-object body (null, array, string) is 400 common.validation_failed, never a crash', async () => {
    const s = setup(); for (const b of [null, undefined, [], 'x', 5]) expect(code(await rejection(s.svc.createQcTarget(s.ctx, { body: b }))), String(b)).toBe('common.validation_failed'); expect(s.fake.mutations()).toHaveLength(0);
  });
  it('ALL field errors are reported together, each with its pointer (no value echoed)', async () => {
    const s = setup(); const e = await rejection(s.svc.createQcTarget(s.ctx, { body: createBody({ sd: '0', source: 'established', mean: PLANTED }) }));
    expect(errors(e)).toEqual(expect.arrayContaining([{ path: '/sd', code: 'common.field_invalid' }, { path: '/source', code: 'common.field_invalid' }, { path: '/mean', code: 'common.field_invalid' }]));
    expect(JSON.stringify({ c: e?.code, m: e?.message, d: e?.detail, e: e?.errors })).not.toContain(PLANTED);
  });
});

describe('createQcTarget: references (plan, lot, level in composition, lot expiry)', () => {
  it('lot whose level is NOT in the plan\'s current composition -> 400 common.validation_failed at /lot_id (LOT(3) is level L3)', async () => {
    const s = setup(); await invalid(create(s, { lot_id: LOT(3) }), '/lot_id'); expect(s.fake.mutations()).toHaveLength(0);
  });
  it('the composition checked is the plan\'s CURRENT version: the service asks the repo for it, in this tenant', async () => {
    const s = setup(); await create(s); const [c] = s.fake.callsOf('currentComposition'); expect(c!.tenantId).toBe(TENANT_A); expect(c!.args).toEqual([PLN(1)]);
  });
  it('an expired lot (expires_on 2026-11-13, tenant day 2026-11-14 in Asia/Kathmandu) -> 422 quality.lot_expired, nothing written', async () => {
    const s = setup(); expect(code(await rejection(create(s, { lot_id: LOT(4) })))).toBe('quality.lot_expired'); expect(s.fake.mutations()).toHaveLength(0);
  });
  it('a lot that expires TODAY (tenant day) is still valid (expires_on < today is the test)', async () => {
    const s = setup({}, { ...baseSeed(), lots: [...baseSeed().lots!, lotRow(5, 1, { expires_on: '2026-11-14' })] }); expect((await create(s, { lot_id: LOT(5) })).status).toBe(201);
  });
  it('plan or lot of another tenant / missing -> 404 common.not_found, nothing written in any tenant (S-01)', async () => {
    for (const o of [{ plan_id: PLN(9) }, { plan_id: PLN(7) }, { lot_id: LOT(9) }, { lot_id: LOT(7) }]) {
      const s = setup(); expect(code(await rejection(create(s, o))), JSON.stringify(o)).toBe('common.not_found'); expect(s.fake.mutations()).toHaveLength(0); expect(s.fake.targets.filter((t) => t['tenant_id'] === TENANT_B)).toHaveLength(1);
    }
  });
  it('the 404 / 422 carry no id, value or tenant from the request in message/detail', async () => {
    const s = setup(); const e = await rejection(create(s, { plan_id: PLN(9), unit_code: PLANTED.toLowerCase() })); expect(JSON.stringify({ m: e?.message, d: e?.detail })).not.toMatch(new RegExp(`${PLN(9)}|${TENANT_B}|${PLANTED}`, 'i'));
  });
});

// ================================================================================================================ AC-04.5 — supersede on activate, one transaction
describe('activateQcTarget (#23): supersede on activate (AC-04.5; done_when)', () => {
  it('AC-04.5 T2 activated with effective_from = X: T1 -> superseded with effective_to = X, T2 -> active from X; 200 + new ETag', async () => {
    const s = setup(); const r = await act(s, TGT(2), 1, { effective_from: FUTURE });
    expect(r.status).toBe(200); expect(r.version).toBe(2); expect(r.body).toMatchObject({ id: TGT(2), status: 'active', effective_from: FUTURE, version: 2 });
    expect(s.fake.byId(TGT(1))).toMatchObject({ status: 'superseded', effective_to: FUTURE, effective_from: '2026-11-01T00:00:00.000Z', version: 2 });
    expect(s.fake.byId(TGT(2))).toMatchObject({ status: 'active', effective_from: FUTURE, activated_at: NOW, activated_by: USER });
    expect(s.fake.activeOf(PLN(1), LOT(1)).map((t) => t['id'])).toEqual([TGT(2)]);
  });
  it('AC-04.5 T1 keeps its mean/SD: nothing but lifecycle columns is written to T1, so observations before X stay evaluated against T1', async () => {
    const s = setup(); await act(s, TGT(2), 1, { effective_from: FUTURE });
    expect(s.fake.byId(TGT(1))).toMatchObject({ mean: '100.000000', sd: '2.000000', plan_id: PLN(1), lot_id: LOT(1), level_id: LVL(1), source: 'manufacturer', unit_code: 'mmol_l' });
    for (const c of s.fake.callsOf('updateTarget')) for (const k of Object.keys(c.args[2] as Row)) expect(MUTABLE, `column ${k}`).toContain(k);
  });
  it('the old target is superseded FIRST, then the new one activated (the partial unique index allows one active per key); T1 is version-checked with the version just read', async () => {
    const s = setup(); await act(s, TGT(2), 1, { effective_from: FUTURE });
    const u = s.fake.callsOf('updateTarget'); expect(u.map((c) => c.args[0])).toEqual([TGT(1), TGT(2)]); expect(u[0]!.args[1]).toBe(1); expect(u[0]!.args[2]).toMatchObject({ status: 'superseded', effective_to: FUTURE }); expect(u[1]!.args[1]).toBe(1);
    expect(s.fake.callsOf('findActiveTarget')[0]!.args).toEqual([PLN(1), LOT(1)]);
  });
  it('default effective_from = now; the superseded target ends exactly there', async () => {
    const s = setup(); await act(s, TGT(2)); expect(s.fake.byId(TGT(2))).toMatchObject({ status: 'active', effective_from: NOW }); expect(s.fake.byId(TGT(1))).toMatchObject({ status: 'superseded', effective_to: NOW });
  });
  it('effective_from = now exactly is accepted (>= now)', async () => { const s = setup(); expect((await act(s, TGT(2), 1, { effective_from: NOW })).status).toBe(200); });
  it.each([['one ms before now', '2026-11-13T18:59:59.999Z'], ['the past', PAST], ['not an IsoUtc (date only)', '2026-11-20'], ['not an IsoUtc (offset)', '2026-11-20T00:00:00.000+05:45'], ['a number', 1], ['empty', '']])('effective_from %s -> 400 at /effective_from, nothing written', async (_n, v) => {
    const s = setup(); await invalid(act(s, TGT(2), 1, { effective_from: v }), '/effective_from'); expect(s.fake.mutations()).toHaveLength(0); expect(s.enqueues()).toEqual([]);
  });
  it('a target for a key with NO active target just activates (no supersede write); other keys and old history are untouched', async () => {
    const s = setup(); const t4 = structuredClone(s.fake.byId(TGT(4))); const t5 = structuredClone(s.fake.byId(TGT(5)));
    await act(s, TGT(3)); expect(s.fake.callsOf('updateTarget').map((c) => c.args[0])).toEqual([TGT(3)]); expect(s.fake.byId(TGT(3))).toMatchObject({ status: 'active' });
    await act(s, TGT(2)); expect(s.fake.byId(TGT(4))).toEqual(t4); expect(s.fake.byId(TGT(5))).toEqual(t5); expect(s.fake.byId(TGT(3))).toMatchObject({ status: 'active' });
  });
  it('one transaction: every repo call uses ctx.tx; the service issues no BEGIN/COMMIT/ROLLBACK/SAVEPOINT and no SQL of its own besides the enqueue; no observation table is written', async () => {
    const s = setup(); await act(s, TGT(2), 1, { effective_from: FUTURE });
    expect(s.fake.calls.length).toBeGreaterThan(3); for (const c of s.fake.calls) expect(c.tx, c.op).toBe(s.ctx.tx);
    expect(s.queries.filter((q) => !/app\.enqueue_job/i.test(q.text))).toEqual([]); expect(s.fake.mutations().every((m) => m.op === 'updateTarget')).toBe(true);
  });
  it('enqueues quality.reprocess_pending_observations for the plan once, in the same tx, AFTER both updates', async () => {
    const s = setup(); await act(s, TGT(2), 1, { effective_from: FUTURE });
    expect(s.enqueues()).toEqual([{ task: 'quality.reprocess_pending_observations', payload: { tenant_id: TENANT_A, plan_id: PLN(1) }, key: `reproc:${PLN(1)}` }]);
  });
  it('a failing enqueue fails the request (the core rolls the tx back; no silent half-activation)', async () => {
    const s = setup({ enqueueFails: true }); await rejection(act(s, TGT(2), 1, { effective_from: FUTURE }));
  });
  it('if the SECOND write fails (activating the new target) the error propagates and nothing is enqueued — the supersede write dies with the tx, never committed alone', async () => {
    const s = setup(); const orig = s.fake.repo.updateTarget; s.fake.repo.updateTarget = async (tx, t, id, v, p) => { if (id === TGT(2)) throw new Error('boom'); return orig(tx, t, id, v, p); };
    expect((await rejection(act(s, TGT(2), 1, { effective_from: FUTURE }))).message).toBeTruthy(); expect(s.enqueues()).toEqual([]);
  });
  it('lost update on the superseded target (someone else changed T1) -> 409 common.version_conflict, T2 is NOT activated, nothing enqueued', async () => {
    const s = setup(); const orig = s.fake.repo.updateTarget; s.fake.repo.updateTarget = async (tx, t, id, v, p) => (id === TGT(1) ? undefined : orig(tx, t, id, v, p));
    expect(code(await rejection(act(s, TGT(2), 1, { effective_from: FUTURE })))).toBe('common.version_conflict'); expect(s.fake.byId(TGT(2))).toMatchObject({ status: 'draft', version: 1 }); expect(s.enqueues()).toEqual([]);
  });
  it('lost update on T2 itself -> 409 common.version_conflict', async () => {
    const s = setup(); const orig = s.fake.repo.updateTarget; s.fake.repo.updateTarget = async (tx, t, id, v, p) => (id === TGT(2) ? undefined : orig(tx, t, id, v, p));
    expect(code(await rejection(act(s, TGT(2), 1, { effective_from: FUTURE })))).toBe('common.version_conflict'); expect(s.enqueues()).toEqual([]);
  });
  it('the partial unique index (one active target per plan x lot) violated at activation (a concurrent activation won) -> 409 common.version_conflict, not a 500', async () => {
    const s = setup(); const orig = s.fake.repo.updateTarget; s.fake.repo.updateTarget = async (tx, t, id, v, p) => { if (id === TGT(2)) throw pgErr('23505', 'qc_targets__tenant_plan_lot_active__p_uq'); return orig(tx, t, id, v, p); };
    expect(code(await rejection(act(s, TGT(2), 1, { effective_from: FUTURE })))).toBe('common.version_conflict');
  });
  it('race: two drafts of the same key activated at once -> never two active targets; every loser is 409 common.version_conflict', async () => {
    const seed = baseSeed(); seed.targets!.push({ ...seed.targets![1]!, id: TGT(7), mean: '102.000000' }); const s = setup({}, seed);
    const res = await Promise.allSettled([act(s, TGT(2), 1, { effective_from: FUTURE }), act(s, TGT(7), 1, { effective_from: FUTURE })]);
    expect(res.filter((r) => r.status === 'fulfilled').length).toBeGreaterThanOrEqual(1); for (const r of res) if (r.status === 'rejected') expect(code(r.reason)).toBe('common.version_conflict');
    expect(s.fake.activeOf(PLN(1), LOT(1))).toHaveLength(1);
  });
  it('If-Match absent -> 428 common.precondition_required; stale -> 409 common.version_conflict; nothing written either way', async () => {
    const s = setup(); expect(code(await rejection(s.svc.activateQcTarget(s.ctx, { targetId: TGT(2), body: {} })))).toBe('common.precondition_required');
    expect(code(await rejection(act(s, TGT(2), 5)))).toBe('common.version_conflict'); expect(s.fake.mutations()).toHaveLength(0);
  });
  it('a body field other than effective_from (mean, sd, status, tenant_id, plan_id, lot_id) is common.unknown_field — a mean/SD can never ride along an activation', async () => {
    const s = setup(); for (const k of ['mean', 'sd', 'status', 'tenant_id', 'plan_id', 'lot_id', 'source', 'version']) await invalid(act(s, TGT(2), 1, { [k]: '1' }), `/${k}`, 'common.unknown_field'); expect(s.fake.mutations()).toHaveLength(0);
  });
  it.each([[TGT(9)], [TGT(77)], ['not-a-uuid']])('target %j (tenant B\'s / missing / malformed) -> 404 common.not_found; tenant B target stays active (S-01)', async (id) => {
    const s = setup(); expect(code(await rejection(act(s, id)))).toBe('common.not_found'); expect(s.fake.mutations()).toHaveLength(0); expect(s.fake.byId(TGT(9))).toMatchObject({ status: 'active', version: 1 });
  });
});

// ================================================================================================================ AC-04.6 — immutability
describe('immutability of mean/SD and of non-draft targets (AC-04.6; S-09; AB-01)', () => {
  it.each([['active', 1], ['superseded', 4], ['retired', 5], ['discarded', 6]])('activate a %s target -> 409 common.immutable_record, nothing changes', async (_st, n) => {
    const s = setup(); const before = structuredClone(s.fake.byId(TGT(n))); expect(code(await rejection(act(s, TGT(n))))).toBe('common.immutable_record'); expect(s.fake.mutations()).toHaveLength(0); expect(s.fake.byId(TGT(n))).toEqual(before); expect(s.enqueues()).toEqual([]);
  });
  it.each([['draft', 2], ['superseded', 4], ['retired', 5], ['discarded', 6]])('retire a %s target (not active) -> 409 common.immutable_record', async (_st, n) => {
    const s = setup(); expect(code(await rejection(ret(s, TGT(n))))).toBe('common.immutable_record'); expect(s.fake.mutations()).toHaveLength(0);
  });
  it.each([['active', 1], ['superseded', 4], ['retired', 5], ['discarded', 6]])('discard a %s target (not draft) -> 409 common.immutable_record', async (_st, n) => {
    const s = setup(); expect(code(await rejection(dis(s, TGT(n))))).toBe('common.immutable_record'); expect(s.fake.mutations()).toHaveLength(0);
  });
  it('AC-04.6 an ACTIVE target\'s mean/SD cannot be changed through any operation: a mean or sd in an activate/retire/discard body is refused (400 unknown_field) and TGT(1) is unchanged', async () => {
    const s = setup(); const before = structuredClone(s.fake.byId(TGT(1)));
    for (const k of ['mean', 'sd']) { await invalid(act(s, TGT(1), 1, { [k]: '5' }), `/${k}`, 'common.unknown_field'); await invalid(ret(s, TGT(1), 1, { reason: 'r', [k]: '5' }), `/${k}`, 'common.unknown_field'); await invalid(dis(s, TGT(1), 1, { [k]: '5' }), `/${k}`, 'common.unknown_field'); }
    expect(s.fake.byId(TGT(1))).toEqual(before);
  });
  it('the service exposes no operation that edits a target\'s values (no update/patch/edit/replace method)', () => {
    const svc = createTargetService({ repo: makeTargetRepo().repo }) as any; expect(Object.keys(svc).filter((k) => /^(update|patch|edit|replace|set|put)/i.test(k))).toEqual([]); expect(Object.keys(svc).sort()).toEqual([...OPS].sort());
  });
  it('the version check comes BEFORE the state check: a stale call on an active target is 409 version_conflict, a current call is 409 immutable_record', async () => {
    const s = setup(); expect(code(await rejection(act(s, TGT(1), 9)))).toBe('common.version_conflict'); expect(code(await rejection(act(s, TGT(1), 1)))).toBe('common.immutable_record');
  });
  it('the immutability TRIGGER (P0001 immutable_row) is mapped to 409 common.immutable_record on every lifecycle write — activate, retire, discard (done_when)', async () => {
    for (const [name, call] of [['activate', (s: any) => act(s, TGT(3))], ['retire', (s: any) => ret(s, TGT(1))], ['discard', (s: any) => dis(s, TGT(2))]] as const) {
      const s = setup(); s.fake.repo.updateTarget = async () => { throw immutableRow(); };
      expect(code(await rejection(call(s))), name).toBe('common.immutable_record'); expect(s.enqueues(), name).toEqual([]);
    }
  });
  it('the trigger error is recognised by what Postgres raises (code P0001 + message immutable_row) — a different P0001 or an unrelated error is NOT reported as immutable_record, and no internal text leaks', async () => {
    for (const err of [pgErr('P0001', undefined, `other raise ${PLANTED}`), new Error(`immutable_row ${PLANTED}`), pgErr('23514', 'qc_targets__sd__ck', PLANTED)]) {
      const s = setup(); s.fake.repo.updateTarget = async () => { throw err; }; const e = await rejection(act(s, TGT(3)));
      expect(code(e)).not.toBe('common.immutable_record'); expect(JSON.stringify({ c: e?.code, m: e?.message, d: e?.detail, e: e?.errors })).not.toContain(PLANTED);
    }
  });
  it('every UPDATE the service issues (activate, retire, discard) only sets the trigger\'s allowed lifecycle columns — the in-memory trigger would otherwise raise immutable_row', async () => {
    const s = setup(); await act(s, TGT(2), 1, { effective_from: FUTURE }); await ret(s, TGT(2), 2); await dis(s, TGT(3));
    expect(s.fake.callsOf('updateTarget').length).toBeGreaterThanOrEqual(4); for (const c of s.fake.callsOf('updateTarget')) for (const k of Object.keys(c.args[2] as Row)) expect(MUTABLE, k).toContain(k);
    expect(s.fake.byId(TGT(2))).toMatchObject({ mean: '101.000000', sd: '2.500000' });
  });
});

// ================================================================================================================ #24 retire, #25 discard
describe('retireQcTarget (#24) and discardQcTarget (#25)', () => {
  it('retire: active -> retired with reason, retired_at = now, retired_by = actor; 200 + new ETag; mean/SD untouched', async () => {
    const s = setup(); const r = await ret(s, TGT(1), 1, { reason: 'Lot withdrawn' });
    expect(r.status).toBe(200); expect(r.version).toBe(2); expect(r.body).toMatchObject({ id: TGT(1), status: 'retired', version: 2 });
    expect(s.fake.byId(TGT(1))).toMatchObject({ status: 'retired', retired_at: NOW, retired_by: USER, retire_reason: 'Lot withdrawn', updated_by: USER, mean: '100.000000', sd: '2.000000' }); expect(s.fake.activeOf(PLN(1), LOT(1))).toHaveLength(0);
    expect(JSON.stringify(r.body)).not.toContain('Lot withdrawn');
  });
  it('retire: reason is required, 1..500 characters, a string; unknown fields refused', async () => {
    const s = setup(); const b: Row = {}; await invalid(s.svc.retireQcTarget(s.ctx, { targetId: TGT(1), expectedVersion: 1, body: b }), '/reason', 'common.field_required');
    for (const reason of ['', 'x'.repeat(501), 5, null]) await invalid(ret(s, TGT(1), 1, { reason }), '/reason');
    await invalid(ret(s, TGT(1), 1, { reason: 'r', status: 'active' }), '/status', 'common.unknown_field'); expect(s.fake.mutations()).toHaveLength(0);
    expect((await ret(s, TGT(1), 1, { reason: 'x'.repeat(500) })).status).toBe(200);
  });
  it('discard: draft -> discarded; 200 + new ETag; the target is no longer a candidate for activation', async () => {
    const s = setup(); const r = await dis(s, TGT(2)); expect(r.status).toBe(200); expect(r.version).toBe(2); expect(r.body).toMatchObject({ id: TGT(2), status: 'discarded' }); expect(s.fake.byId(TGT(2))).toMatchObject({ status: 'discarded', mean: '101.000000', sd: '2.500000' });
    expect(code(await rejection(act(s, TGT(2), 2)))).toBe('common.immutable_record'); expect(s.fake.byId(TGT(1))).toMatchObject({ status: 'active', version: 1 }); expect(s.enqueues()).toEqual([]);
  });
  it('discard body must be {}: any field -> 400 unknown_field', async () => {
    const s = setup(); await invalid(dis(s, TGT(2), 1, { reason: 'x' }), '/reason', 'common.unknown_field'); expect(s.fake.mutations()).toHaveLength(0);
  });
  it.each([['retire', (s: any, id: string, v?: number) => (v === undefined ? s.svc.retireQcTarget(s.ctx, { targetId: id, body: { reason: 'r' } }) : ret(s, id, v))], ['discard', (s: any, id: string, v?: number) => (v === undefined ? s.svc.discardQcTarget(s.ctx, { targetId: id, body: {} }) : dis(s, id, v))]])('%s: If-Match absent -> 428; stale -> 409 version_conflict; lost update -> 409; other tenant -> 404', async (_n, call) => {
    const id = _n === 'retire' ? TGT(1) : TGT(2); const s = setup();
    expect(code(await rejection(call(s, id)))).toBe('common.precondition_required'); expect(code(await rejection(call(s, id, 4)))).toBe('common.version_conflict'); expect(s.fake.mutations()).toHaveLength(0);
    expect(code(await rejection(call(s, TGT(9), 1)))).toBe('common.not_found'); expect(s.fake.byId(TGT(9))).toMatchObject({ status: 'active' });
    s.fake.repo.updateTarget = async () => undefined; expect(code(await rejection(call(s, id, 1)))).toBe('common.version_conflict');
  });
});

// ================================================================================================================ AC-04.2 / AC-04.3 / AC-04.4 — establish from data (#22)
describe('establishQcTarget (#22): AC-04.2 statistics over the population', () => {
  it('AC-04.2 25 accepted observations -> 201 draft, source established, basis_n 25, mean = arithmetic mean, SD = SAMPLE SD (n-1), stored to decimals+2 places (K: 1 dp -> 3)', async () => {
    const s = withObs(); const r = await establish(s);
    expect(r.status).toBe(201); expect(r.version).toBe(1);
    expect(r.body).toMatchObject({ plan_id: PLN(1), lot_id: LOT(1), level_id: LVL(1), unit_code: 'mmol/L', source: 'established', status: 'draft', version: 1, basis: { n: 25, from: FROM, to: TO }, created_by_display: 'Synthetic Lab Manager' });
    expect(r.body.id).toMatch(UUID7); expect(Number(r.body.mean)).toBe(100); expect(Number(r.body.sd)).toBe(1.443);   // population SD would be 1.414
    expect(Number(r.body.cv_pct)).toBeCloseTo(1.443, 2); for (const k of ['effective_from', 'effective_to', 'activated_by_display']) expect(r.body, k).not.toHaveProperty(k);
  });
  it('writes ONE draft row: decimal strings, basis columns filled, level from the lot, unit from the analyte, actor + tenant from the context; no update, no enqueue (a draft is not in force)', async () => {
    const s = withObs(); const r = await establish(s);
    expect(s.fake.mutations().map((m) => m.op)).toEqual(['insertTarget']); const row = s.fake.callsOf('insertTarget')[0]!.args[0] as Row;
    expect(row).toMatchObject({ plan_id: PLN(1), lot_id: LOT(1), level_id: LVL(1), unit_code: 'mmol/L', source: 'established', basis_n: 25, basis_from: FROM, basis_to: TO, created_by: USER, updated_by: USER });
    expect([undefined, 'draft']).toContain(row['status']); expect(typeof row['mean']).toBe('string'); expect(typeof row['sd']).toBe('string'); expect(Number(row['sd'])).toBe(1.443); expect(row['basis_observation_ids_sha256']).toMatch(/^[0-9a-f]{64}$/);
    expect(row['effective_from'] ?? null).toBeNull(); expect(s.enqueues()).toEqual([]); expect(s.fake.byId(r.body.id)).toMatchObject({ source: 'established', status: 'draft' });
  });
  it('the analyte decimals come from the CatalogPort: GLU (2 dp) stores 4 places (SD 1.4434), K stores 3; the catalog is asked once for the plan\'s test', async () => {
    const g = withObs(); const gl = setup({}, { ...baseSeed(), observations: cleanObs().map((o) => ({ ...o, plan_id: PLN(2) })) });
    const r = await establish(gl, { plan_id: PLN(2) }); expect(Number(r.body.sd)).toBe(1.4434); expect(Number(r.body.mean)).toBe(100); expect(r.body.unit_code).toBe('mmol/L');
    expect(gl.catalog.getTestCalls).toEqual([{ testId: TST(1) }]); expect(Number((await establish(g)).body.sd)).toBe(1.443);
  });
  it('rounding is half-UP on exact decimals: ten 1.0000 + ten 1.0010 -> mean 1.0005 stored 1.001 (a float or half-even implementation gives 1.000)', async () => {
    const vals = [...Array(10).fill('1.0000'), ...Array(10).fill('1.0010')]; const s = setup({}, { ...baseSeed(), observations: vals.map((v, i) => obsRow(i + 1, { value: v })) });
    const r = await establish(s); expect(r.body.basis.n).toBe(20); expect(Number(r.body.mean)).toBe(1.001); expect(Number(r.body.sd)).toBe(0.001);
  });
  it('values arrive and leave as decimal strings: a value that is not exactly representable as a double (0.1 steps) still gives the exact mean', async () => {
    const vals = Array.from({ length: 20 }, (_, i) => (i % 2 ? '0.3' : '0.1')); const s = setup({}, { ...baseSeed(), observations: vals.map((v, i) => obsRow(i + 1, { value: v })) });
    const r = await establish(s); expect(r.body.mean).toMatch(/^0\.200(0*)$/); expect(Number(r.body.sd)).toBe(0.103);
  });
  it('the target\'s observation range is the REQUEST range (basis.from / basis.to), and the repo is asked for exactly this plan x lot x range in this tenant', async () => {
    const s = withObs(); await establish(s, { observed_at_from: FROM, observed_at_to: TO }); const [c] = s.fake.callsOf('listEstablishCandidates');
    expect(c!.tenantId).toBe(TENANT_A); expect(c!.args[0]).toEqual({ planId: PLN(1), lotId: LOT(1), from: FROM, to: TO });
  });
});

describe('establishQcTarget: the population (done_when "establish population rules")', () => {
  it.each(NOISE)('NOT in the population (%s): n stays 25 and the digest of the basis is unchanged', async (_name, row) => {
    const base = digest(await establish(withObs())); const r = await establish(withObs([row]));
    expect(r.body.basis.n).toBe(25); expect(digest(r)).toBe(base); expect(Number(r.body.mean)).toBe(100); expect(Number(r.body.sd)).toBe(1.443);
  });
  it('all noise together: still exactly the 25 clean observations', async () => {
    const base = digest(await establish(withObs())); const r = await establish(withObs(NOISE.map(([, o]) => o))); expect(r.body.basis.n).toBe(25); expect(digest(r)).toBe(base);
  });
  it('status assigned in a run with outcome accepted_warning IS in the population (all 25 warning-run observations -> n 25)', async () => {
    const s = setup({}, { ...baseSeed(), observations: cleanObs().map((o) => ({ ...o, run_outcome: 'accepted_warning' })) }); const r = await establish(s);
    expect(r.body.basis.n).toBe(25); expect(digest(r)).toBe(digest(await establish(withObs())));
  });
  it('no_target observations (baseline before any target exists) ARE in the population: +3 -> n 28, new digest, SD over all 28 (1.361)', async () => {
    const extra = [90, 91, 92].map((n) => obsRow(n, { value: '100', status: 'no_target', run_outcome: null }));
    const base = digest(await establish(withObs())); const r = await establish(withObs(extra)); expect(r.body.basis.n).toBe(28); expect(digest(r)).not.toBe(base); expect(Number(r.body.mean)).toBe(100); expect(Number(r.body.sd)).toBe(1.361);
  });
  it('exclude_observation_ids removes observations from the population (n 23, mean 100.130), changes the digest, and unknown ids in the list are ignored', async () => {
    const base = digest(await establish(withObs())); const r = await establish(withObs(), { exclude_observation_ids: [OBS(1), OBS(2)] });
    expect(r.body.basis.n).toBe(23); expect(Number(r.body.mean)).toBe(100.13); expect(digest(r)).not.toBe(base);
    const r2 = await establish(withObs(), { exclude_observation_ids: [OBS(99), OBS(40)] }); expect(r2.body.basis.n).toBe(25); expect(digest(r2)).toBe(base);
  });
  it('include_observation_ids re-admits an observation of THIS plan x lot x range the rule left out (rejected-run OBS(30), value 110): n 26, mean 100.385', async () => {
    const r = await establish(withObs([NOISE[0]![1]]), { include_observation_ids: [OBS(30)] }); expect(r.body.basis.n).toBe(26); expect(Number(r.body.mean)).toBe(100.385);
  });
  it('include_observation_ids can only name observations of this plan x lot x range: other lot, other plan, other tenant, out of range or unknown -> 400 at /include_observation_ids/<i>, nothing written', async () => {
    for (const id of [OBS(38), OBS(39), OBS(40), OBS(36), OBS(37), OBS(98), OBS(41)]) {   // OBS(41): value null, can never be a basis value
      const s = withObs(NOISE.map(([, o]) => o)); await invalid(establish(s, { include_observation_ids: [id] }), '/include_observation_ids/0'); expect(s.fake.mutations(), id).toHaveLength(0);
    }
  });
  it('including an observation that is already in the population changes nothing', async () => {
    const base = digest(await establish(withObs())); const r = await establish(withObs(), { include_observation_ids: [OBS(3)] }); expect(r.body.basis.n).toBe(25); expect(digest(r)).toBe(base);
  });
  it('a null (non-numeric) observation in the range never enters the statistics (no NaN, no crash)', async () => {
    const s = withObs([NOISE[11]![1]]); const r = await establish(s); expect(r.body.basis.n).toBe(25); expect(Number(r.body.sd)).toBe(1.443); expect(JSON.stringify(s.fake.targets)).not.toMatch(/NaN|Infinity/);
  });
});

describe('establishQcTarget: basis_observation_ids_sha256 (done_when)', () => {
  it('is 64 lowercase hex characters, identical in the DTO and the stored row (the row would fail qc_targets__basis_sha__ck otherwise)', async () => {
    const s = withObs(); const r = await establish(s); const d = digest(r);
    expect(d).toMatch(/^[0-9a-f]{64}$/); expect(d).toBe(s.fake.byId(r.body.id)!['basis_observation_ids_sha256']); expect(d).not.toMatch(/[A-F]/);
  });
  it('depends on the SET of observations only: independent of the order the repo returns them in and of the order of the exclude list', async () => {
    const a = digest(await establish(withObs())); const rev = setup({}, { ...baseSeed(), observations: cleanObs().reverse() });
    expect(digest(await establish(rev))).toBe(a); const e1 = digest(await establish(withObs(), { exclude_observation_ids: [OBS(1), OBS(2)] })); const e2 = digest(await establish(withObs(), { exclude_observation_ids: [OBS(2), OBS(1)] })); expect(e1).toBe(e2);
  });
  it('changes when the set changes (one observation fewer / one more) and is not a digest of the empty set', async () => {
    const a = digest(await establish(withObs())); const less = digest(await establish(withObs(), { exclude_observation_ids: [OBS(1)] })); const more = digest(await establish(withObs([obsRow(90, { status: 'no_target', run_outcome: null })])));
    expect(new Set([a, less, more]).size).toBe(3); expect(a).not.toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
  it('two identical establish requests give two drafts with the same digest and different ids (no dedupe at this layer; the Idempotency-Key is the core\'s)', async () => {
    const s = withObs(); const a = await establish(s); const b = await establish(s); expect(a.body.id).not.toBe(b.body.id); expect(digest(a)).toBe(digest(b));
  });
});

describe('establishQcTarget: AC-04.3 insufficient data, AC-04.4 SD <= 0, input validation', () => {
  const only = (n: number) => cleanObs().slice(0, n);
  it('AC-04.3 fewer observations than target_min_points (default 20): 19 -> 422 quality.insufficient_qc_data, nothing written; 20 -> 201', async () => {
    const s = setup({}, { ...baseSeed(), observations: only(19) }); expect(code(await rejection(establish(s)))).toBe('quality.insufficient_qc_data'); expect(s.fake.mutations()).toHaveLength(0);
    expect((await establish(setup({}, { ...baseSeed(), observations: only(20) }))).body.basis.n).toBe(20);
  });
  it('the minimum is the TENANT setting target_min_points: 30 -> 25 observations are not enough; 25 -> enough; 2 -> a single observation is still too few (n < 2 always fails)', async () => {
    const st = (n: number) => ({ id: 'x', tenant_id: TENANT_A, target_min_points: n });
    expect(code(await rejection(establish(setup({}, { ...baseSeed(), observations: cleanObs(), settings: st(30) }))))).toBe('quality.insufficient_qc_data');
    expect((await establish(setup({}, { ...baseSeed(), observations: cleanObs(), settings: st(25) }))).status).toBe(201);
    expect(code(await rejection(establish(setup({}, { ...baseSeed(), observations: only(1), settings: st(2) }))))).toBe('quality.insufficient_qc_data');
    expect((await establish(setup({}, { ...baseSeed(), observations: only(2), settings: st(2) }))).body.basis.n).toBe(2);
  });
  it('n is counted AFTER exclusions and inclusions: 25 - 6 excluded = 19 -> 422', async () => {
    const s = withObs(); expect(code(await rejection(establish(s, { exclude_observation_ids: [1, 2, 3, 4, 5, 6].map(OBS) })))).toBe('quality.insufficient_qc_data'); expect(s.fake.mutations()).toHaveLength(0);
  });
  it('no observations at all -> 422 quality.insufficient_qc_data (not a crash, not a 500)', async () => { const s = setup(); expect(code(await rejection(establish(s)))).toBe('quality.insufficient_qc_data'); });
  it('the 422 reveals only the code (no counts of other tenants\' data, no ids)', async () => {
    const s = setup({}, { ...baseSeed(), observations: [...only(5), ...NOISE.map(([, o]) => o)] }); const e = await rejection(establish(s)); expect(JSON.stringify({ m: e?.message, d: e?.detail })).not.toMatch(new RegExp(`${TENANT_B}|${OBS(40)}`));
  });
  it('AC-04.4 SD 0 (20 identical observations) -> 400 common.validation_failed, nothing written (qc_targets__sd__ck would refuse it)', async () => {
    const s = setup({}, { ...baseSeed(), observations: Array.from({ length: 20 }, (_, i) => obsRow(i + 1, { value: '100.0' })) }); expect(code(await rejection(establish(s)))).toBe('common.validation_failed'); expect(s.fake.mutations()).toHaveLength(0);
  });
  it('required fields, formats, order of the range and list limits -> 400 with pointers; nothing written', async () => {
    const s = withObs(); const b = (o: Row, drop?: string) => { const x = estBody(o); if (drop) delete x[drop]; return s.svc.establishQcTarget(s.ctx, { body: x }); };
    for (const k of ['plan_id', 'lot_id', 'observed_at_from', 'observed_at_to']) await invalid(b({}, k), `/${k}`, 'common.field_required');
    await invalid(b({ observed_at_from: '2026-11-01' }), '/observed_at_from'); await invalid(b({ observed_at_to: 'yesterday' }), '/observed_at_to'); await invalid(b({ plan_id: 'x' }), '/plan_id'); await invalid(b({ lot_id: 5 }), '/lot_id');
    await invalid(b({ observed_at_from: TO, observed_at_to: FROM }), '/observed_at_to'); await invalid(b({ observed_at_from: FROM, observed_at_to: FROM }), '/observed_at_to');
    for (const k of ['include_observation_ids', 'exclude_observation_ids']) {
      await invalid(b({ [k]: 'x' }), `/${k}`); await invalid(b({ [k]: ['not-a-uuid'] }), `/${k}/0`); await invalid(b({ [k]: [OBS(1), OBS(1)] }), `/${k}`); await invalid(b({ [k]: Array.from({ length: 501 }, (_, i) => OBS(i + 1)) }), `/${k}`);
    }
    for (const k of ['tenant_id', 'status', 'mean', 'sd', 'source', 'level_id', 'basis_n', 'min_points']) await invalid(b({ [k]: '1' }), `/${k}`, 'common.unknown_field');
    expect(s.fake.mutations()).toHaveLength(0);
  });
  it('500 ids per list are accepted (limit is inclusive)', async () => {
    const s = withObs(); expect((await establish(s, { exclude_observation_ids: Array.from({ length: 500 }, (_, i) => OBS(1000 + i)) })).status).toBe(201);
  });
  it('lot whose level is not in the plan\'s composition -> 400 /lot_id; foreign / missing plan or lot -> 404; catalog failure propagates; nothing written in any case', async () => {
    const s = withObs(); await invalid(establish(s, { lot_id: LOT(3) }), '/lot_id');
    for (const o of [{ plan_id: PLN(9) }, { plan_id: PLN(7) }, { lot_id: LOT(9) }, { lot_id: LOT(7) }]) expect(code(await rejection(establish(s, o))), JSON.stringify(o)).toBe('common.not_found');
    const f = withObs([], { catalog: makeCatalog({ getTestFails: Object.assign(new Error('catalog down'), { code: 'common.dependency_unavailable' }) }) }); expect(code(await rejection(establish(f)))).toBe('common.dependency_unavailable');
    expect(s.fake.mutations()).toHaveLength(0); expect(f.fake.mutations()).toHaveLength(0); expect(CATALOG[TST(1)]).toBeTruthy();
  });
  it('tenant B\'s observations never contribute even when they match plan and lot ids (the repo is only ever asked with the context tenant)', async () => {
    const s = withObs(NOISE.map(([, o]) => o).concat([obsRow(60, { tenant_id: TENANT_B, value: '500' })])); const r = await establish(s); expect(r.body.basis.n).toBe(25);
    for (const c of s.fake.calls) expect(c.tenantId, c.op).toBe(TENANT_A);
  });
});

// ================================================================================================================ #20 list
describe('listQcTargets (#20)', () => {
  it('lists this tenant\'s targets as { data, page:{limit} }; tenant B\'s TGT(9) never appears', async () => {
    const s = setup(); const r = await s.svc.listQcTargets(s.ctx, {}); const ids = r.body.data.map((t: Row) => t['id']);
    expect(r.status).toBe(200); expect(ids).toEqual(expect.arrayContaining([TGT(1), TGT(2), TGT(3), TGT(4), TGT(5), TGT(6)])); expect(ids).not.toContain(TGT(9)); expect(r.body.page).toMatchObject({ limit: expect.any(Number) });
  });
  it('filters: plan_id, lot_id, status csv (draft,active -> a status list); the csv is split and bound by the service', async () => {
    const s = setup(); const r = await s.svc.listQcTargets(s.ctx, { planId: PLN(1), lotId: LOT(1), status: 'draft,active' });
    expect(r.body.data.map((t: Row) => t['id']).sort()).toEqual([TGT(1), TGT(2)].sort()); const [c] = s.fake.callsOf('listTargets'); expect(c!.args[0]).toMatchObject({ planId: PLN(1), lotId: LOT(1), statuses: ['draft', 'active'] });
  });
  it.each(['bogus', 'draft,bogus', 'draft,', ',draft', 'ACTIVE', 'draft active'])('status %j -> 400 common.validation_failed at /status, repo not asked', async (status) => {
    const s = setup(); await invalid(s.svc.listQcTargets(s.ctx, { status }), '/status'); expect(s.fake.callsOf('listTargets')).toHaveLength(0);
  });
  it('plan_id / lot_id that are not UUIDs -> 400 (never reach SQL); the limit is passed to the repo as a number', async () => {
    const s = setup(); await invalid(s.svc.listQcTargets(s.ctx, { planId: 'x' }), '/plan_id'); await invalid(s.svc.listQcTargets(s.ctx, { lotId: "x'; DROP TABLE quality.qc_targets; --" }), '/lot_id');
    await s.svc.listQcTargets(s.ctx, { limit: 25 }); expect(s.fake.callsOf('listTargets')[0]!.args[0]).toMatchObject({ limit: 25 });
  });
  it('every item carries level, lot and the DTO fields of QcTargetDto: mean, sd, cv_pct, unit_code, source, status, effective window, created_by_display; basis only on established ones', async () => {
    const s = setup(); const r = await s.svc.listQcTargets(s.ctx, { planId: PLN(1) }); const t1 = r.body.data.find((t: Row) => t['id'] === TGT(1));
    expect(t1).toMatchObject({ plan_id: PLN(1), lot_id: LOT(1), level_id: LVL(1), source: 'manufacturer', status: 'active', effective_from: '2026-11-01T00:00:00.000Z', version: 1, created_by_display: 'Synthetic Lab Manager', activated_by_display: 'Synthetic Lab Manager' });
    expect(Number(t1.mean)).toBe(100); expect(Number(t1.sd)).toBe(2); expect(Number(t1.cv_pct)).toBeCloseTo(2, 2); expect(t1).not.toHaveProperty('basis');
    expect(r.body.data.find((t: Row) => t['id'] === TGT(4))).toMatchObject({ status: 'superseded', effective_to: '2026-11-01T00:00:00.000Z' });
  });
  it('a malformed cursor reaches the repo untouched (the repo owns common.invalid_cursor); the next page token is returned as page.next_cursor', async () => {
    const s = setup(); s.fake.repo.listTargets = async () => ({ rows: [], nextCursor: 'NEXT' }); const r = await s.svc.listQcTargets(s.ctx, { cursor: 'C1', limit: 1 }); expect(r.body.page).toEqual({ limit: 1, next_cursor: 'NEXT' });
  });
});

// ================================================================================================================ authorisation + wire hygiene (S-07, S-09, REQ-SEC-081)
describe('authorisation: reads need quality.qc_run.read, writes quality.qc.manage; checked FIRST (S-07)', () => {
  const calls: Array<[string, (s: any) => Promise<unknown>, string]> = [
    ['listQcTargets', (s) => s.svc.listQcTargets(s.ctx, {}), 'quality.qc_run.read'],
    ['createQcTarget', (s) => create(s), 'quality.qc.manage'],
    ['establishQcTarget', (s) => establish(s), 'quality.qc.manage'],
    ['activateQcTarget', (s) => act(s, TGT(2)), 'quality.qc.manage'],
    ['retireQcTarget', (s) => ret(s, TGT(1)), 'quality.qc.manage'],
    ['discardQcTarget', (s) => dis(s, TGT(2)), 'quality.qc.manage'],
  ];
  const T = calls.map(([op, call, perm]) => ({ op, call, perm }));
  const mk = (o: Parameters<typeof makePlanCtx>[0] = {}) => withObs([], o);
  it('the table covers exactly #20-#25', () => { expect(calls.map((c) => c[0]).sort()).toEqual([...OPS].sort()); });
  it.each(T)('$op asks assertRole for $perm', async ({ call, perm }) => { const s = mk(); await call(s); expect(s.asserted[0]).toMatchObject({ permission: perm }); });
  it.each(T.filter((t) => t.perm === 'quality.qc.manage'))('$op: a read-only principal (lab_technologist) -> auth.forbidden before ANY repo or catalog call; nothing enqueued', async ({ call }) => {
    const s = mk({ roles: readOnly }); expect(code(await rejection(call(s)))).toBe('auth.forbidden'); expect(s.fake.calls).toHaveLength(0); expect(s.catalog.getTestCalls).toHaveLength(0); expect(s.enqueues()).toEqual([]);
  });
  it.each(T)('$op: a principal with no quality rights -> auth.forbidden before ANY repo or catalog call', async ({ call }) => {
    const s = mk({ roles: noRights }); expect(code(await rejection(call(s)))).toBe('auth.forbidden'); expect(s.fake.calls).toHaveLength(0); expect(s.catalog.getTestCalls).toHaveLength(0);
  });
  it.each(T.filter((t) => t.perm === 'quality.qc_run.read'))('$op: a read-only principal may read', async ({ call }) => { const s = mk({ roles: readOnly }); await expect(call(s)).resolves.toBeTruthy(); });
  it('an invalid body from a principal without rights is auth.forbidden, never validation_failed (403 wins, no information leak)', async () => {
    const s = mk({ roles: noRights }); for (const op of ['createQcTarget', 'establishQcTarget']) expect(code(await rejection(s.svc[op](s.ctx, { body: null }))), op).toBe('auth.forbidden');
  });
});

describe('tenancy and wire hygiene (REQ-SEC-081, S-01)', () => {
  it('every repo call of every operation carries the ctx tenant', async () => {
    const s = withObs(); await s.svc.listQcTargets(s.ctx, {}); await create(s); await establish(s); await act(s, TGT(2), 1, { effective_from: FUTURE }); await ret(s, TGT(2), 2); await dis(s, TGT(3));
    expect(s.fake.calls.length).toBeGreaterThan(12); for (const c of s.fake.calls) expect(c.tenantId, c.op).toBe(TENANT_A);
  });
  it('a tenant-B principal sees and changes only tenant B: TGT(1) is a 404 for tenant B and TGT(9) is one for tenant A', async () => {
    const b = setup({ tenantId: TENANT_B }); expect(code(await rejection(act(b, TGT(2))))).toBe('common.not_found'); expect(code(await rejection(ret(b, TGT(1))))).toBe('common.not_found'); expect((await b.svc.listQcTargets(b.ctx, {})).body.data.map((t: Row) => t['id'])).toEqual([TGT(9)]);
    expect(b.fake.byId(TGT(1))).toMatchObject({ status: 'active' });
  });
  it('every response body is on the QcTargetDto allowlist: no tenant_id, created_by, updated_*, is_active, internal columns, raw basis_* columns, retire_reason; no null; ids and timestamps are strings', async () => {
    const s = withObs(); const rs = [
      await create(s), await establish(s), await act(s, TGT(2), 1, { effective_from: FUTURE }), await ret(s, TGT(2), 2), await dis(s, TGT(3)), ...(await s.svc.listQcTargets(s.ctx, {})).body.data.map((body: Row) => ({ body })),
    ];
    for (const r of rs) {
      const j = JSON.stringify(r.body); expect(j).not.toMatch(/tenant_id|created_by"|updated_by|updated_at|is_active|internal_note|PLANTED|retire_reason|basis_n|basis_from|basis_to|retired_by|activated_by"/); expect(j).not.toContain('null'); expect(j).not.toContain(TENANT_A);
      expect(Object.keys(r.body).every((k) => DTO_KEYS.includes(k)), JSON.stringify(Object.keys(r.body))).toBe(true);
    }
  });
  it('an author without a directory label still gets a non-empty created_by_display placeholder, never the raw user id', async () => {
    const s = setup({}, { ...baseSeed(), users: [] }); const d = (await create(s)).body.created_by_display; expect(typeof d).toBe('string'); expect(d.length).toBeGreaterThan(0); expect(d.length).toBeLessThanOrEqual(200); expect(d).not.toContain(USER);
  });
  it('the service never takes tenant_id from input: a tenant in the list input is never forwarded', async () => {
    const s = setup(); await s.svc.listQcTargets(s.ctx, { planId: PLN(1), tenant_id: TENANT_B } as any).catch(() => undefined); for (const c of s.fake.calls) expect(c.tenantId).toBe(TENANT_A);
  });
  it('SQL-looking input is only ever data: a note with quotes/semicolons is stored verbatim, never executed (the fake repo cannot run it; the repo SQL test proves it is bound)', async () => {
    const s = setup(); const note = `x'; DROP TABLE quality.qc_targets; --`; const r = await create(s, { note }); expect(r.body.note).toBe(note); expect(s.fake.targets.length).toBe(baseSeed().targets!.length + 1);
  });
  it('AB-01: SD can only change through a NEW target: after the manager "widens" SD via a new draft + activation, T1\'s SD is still the original and T1 is superseded, not edited', async () => {
    const s = setup(); const c = await create(s, { sd: '9.0' }); await act(s, c.body.id, c.version, { effective_from: FUTURE });
    expect(s.fake.byId(TGT(1))).toMatchObject({ sd: '2.000000', status: 'superseded', effective_to: FUTURE }); expect(s.fake.byId(c.body.id)).toMatchObject({ status: 'active' }); expect(s.fake.mutations().filter((m) => m.op === 'updateTarget').every((m) => !('sd' in (m.args[2] as Row)))).toBe(true);
  });
});
