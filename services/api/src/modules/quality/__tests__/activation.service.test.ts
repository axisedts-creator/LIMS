// C9 T-17 — #43 activate (four-eyes), #42 simulation report, #46 list decisions, #47 decision detail, access-log rows (02-TRD §5.5, §8.6; AC-11.2, 11.3, 12.1-12.3, 13.7; 07-SECURITY S-08/S-12/S-13; 08 A17 D-53).
// Fails now: "Cannot find module ../service/activation.service.js" (seams: activation.helpers.ts header). Fakes stand in for Postgres; SQL is pinned in simulation.repo.sql.test.ts.
import { describe, expect, it } from 'vitest';
import { createAutoverifyService } from '../service/autoverify.service.js';
import { createActivationService } from '../service/activation.service.js';
import { ACTIONS, ACTIVATE_BODY, DAY, DEC, DEC_B, OTHER_USER, PLANTED, SEC, SIM_START, TENANT_A, TENANT_B, USER, VER, activateInput, at, code, fullSeed, reportRows, rejection, sampleRow, setup, type Row } from './activation.helpers.js';
import { RETIRE_BODY } from './autoverify.helpers.js';

const svc = (s: ReturnType<typeof setup>) => createActivationService(s.deps);
const act = (s: ReturnType<typeof setup>, o: Row = {}) => svc(s).activateAutoverifyVersion(s.ctx, activateInput(o) as any);
const entry = (action: string, entityType: string, entityId: string) => ({ action, entityType, entityId, outcome: 'allowed' });
const noWrites = (s: ReturnType<typeof setup>) => { expect(s.fake.mutations()).toEqual([]); expect(s.audits).toEqual([]); };

describe('#43 activateAutoverifyVersion — AC-12.2 happy path (AV5)', () => {
  it('a different aal2 manager activates a complete simulation: 200, status active, activated_at/by, new ETag version', async () => {
    const s = setup(); const r = await act(s);
    expect(r.status).toBe(200); expect(r.body.status).toBe('active'); expect(r.version).toBe(2);
    expect(s.fake.ver(2)).toMatchObject({ status: 'active', activated_at: s.ctx.now(), activated_by: OTHER_USER });
  });
  it('the previous active version becomes retired in the same call (retired_at, retired_by); exactly one version is active afterwards (the fake enforces the unique index: retire BEFORE activate)', async () => {
    const s = setup(); await act(s);
    expect(s.fake.ver(4)).toMatchObject({ status: 'retired', retired_at: s.ctx.now(), retired_by: OTHER_USER });
    expect(s.fake.versions.filter((v) => v['tenant_id'] === s.ctx.tenantId && v['status'] === 'active').map((v) => v['id'])).toEqual([VER(2)]);
  });
  it('rule-set pointers are swapped: active_version_id = this version, simulating_version_id cleared', async () => {
    const s = setup(); await act(s); expect(s.fake.set()).toMatchObject({ active_version_id: VER(2), simulating_version_id: null });
  });
  it('no previous active version: activates, retires nothing', async () => {
    const seed = fullSeed(); seed.sets![0] = { ...seed.sets![0]!, active_version_id: null }; seed.versions = seed.versions!.filter((v) => v['id'] !== VER(4) || v['tenant_id'] !== TENANT_A);
    const s = setup({ seed }); const r = await act(s);
    expect(r.body.status).toBe('active'); expect(s.fake.set()).toMatchObject({ active_version_id: VER(2), simulating_version_id: null });
  });
  it('the response is the version DTO allow-list: no internal columns', async () => {
    const s = setup(); const r = await act(s); expect(JSON.stringify(r.body)).not.toContain(PLANTED);
  });
});

describe('#43 access log (AC-12.2, AC-13.7 family; 02-TRD §5.5 table)', () => {
  it('writes exactly one row { autoverify.activate, autoverify_version, <version id>, outcome allowed } through ctx.audit.access, no extra keys', async () => {
    const s = setup(); await act(s);
    expect(s.audits).toEqual([entry('autoverify.activate', 'autoverify_version', VER(2))]);
  });
  it('a failing access-log write fails the whole call (fail closed; the request tx rolls the activation back)', async () => {
    const s = setup({ auditFails: true }); expect(code(await rejection(act(s)))).toBe('common.internal');
  });
});

describe('#43 AC-12.3 / S-08: privileged — aal1 -> auth.mfa_required, nothing read or written', () => {
  it('aal1 -> 403 auth.mfa_required; the permission is asserted FIRST', async () => {
    const s = setup({ aal: 'aal1' }); const e = await rejection(act(s));
    expect(code(e)).toBe('auth.mfa_required'); expect(s.asserted).toEqual([{ permission: 'quality.autoverify.manage' }]);
    expect(s.fake.calls).toEqual([]); expect(s.sim.calls).toEqual([]); noWrites(s);
  });
  it('a read-only holder -> auth.forbidden; nothing read or written', async () => {
    const s = setup({ held: ['quality.autoverify.read'] }); expect(code(await rejection(act(s)))).toBe('auth.forbidden');
    expect(s.fake.calls).toEqual([]); expect(s.sim.calls).toEqual([]); noWrites(s);
  });
});

describe('#43 AC-12.1 / S-12: four-eyes — the version author cannot activate', () => {
  it('actor = created_by -> 403 quality.self_activation_forbidden, no write, no access-log row', async () => {
    const s = setup({ actor: USER }); expect(code(await rejection(act(s)))).toBe('quality.self_activation_forbidden'); noWrites(s);
  });
  it('the author is created_by, not whoever started the simulation: the creator is blocked, someone who only started it is not', async () => {
    const mk = () => { const seed = fullSeed(); const v2 = seed.versions!.find((v) => v['id'] === VER(2) && v['tenant_id'] === TENANT_A)!; v2['created_by'] = OTHER_USER; v2['simulation_started_by'] = USER; return seed; };
    const a = setup({ seed: mk(), actor: OTHER_USER }); expect(code(await rejection(act(a)))).toBe('quality.self_activation_forbidden'); noWrites(a);
    const b = setup({ seed: mk(), actor: USER }); expect((await act(b)).body.status).toBe('active');           // started it, did not author it: allowed
  });
});

describe('#43 AC-11.2 / S-13: simulation minimums (sim_min_days 7, sim_min_decisions 100 [CONV])', () => {
  it.each([
    ['exactly 7 days and exactly 100 decisions', 7 * DAY, 100, true],
    ['7 days minus 1 ms', 7 * DAY - 1, 500, false],
    ['99 decisions', 30 * DAY, 99, false],
    ['both short', DAY, 3, false],
    ['plenty of both', 30 * DAY, 5000, true],
  ])('%s', async (_n, ms, count, ok) => {
    const s = setup({ now: at(ms), sim: { shadowCount: count } });
    if (ok) expect((await act(s)).body.status).toBe('active');
    else { expect(code(await rejection(act(s)))).toBe('quality.simulation_incomplete'); noWrites(s); }
  });
  it('days are counted from simulation_started_at, not from creation', async () => {
    const seed = fullSeed(); const v = seed.versions!.find((x) => x['id'] === VER(2) && x['tenant_id'] === TENANT_A)!; v['created_at'] = '2026-01-01T00:00:00.000Z'; v['simulation_started_at'] = at(6 * DAY);
    const s = setup({ seed, now: at(7 * DAY) }); expect(code(await rejection(act(s)))).toBe('quality.simulation_incomplete');
  });
  it('decisions are counted for THIS version, mode shadow, since simulation_started_at (the repo receives version id and start), once, with the tenant from ctx', async () => {
    const s = setup(); await act(s);
    expect(s.sim.callsOf('countShadowDecisions')).toEqual([{ op: 'countShadowDecisions', tenantId: s.ctx.tenantId, args: [VER(2), SIM_START] }]);
  });
  it('the minimums come from the tenant settings: 30 days required -> 8 days is incomplete; 3 days / 10 decisions -> 3 days and 10 decisions complete', async () => {
    const a = setup({ now: at(8 * DAY), sim: { minimums: { sim_min_days: 30, sim_min_decisions: 100 } } }); expect(code(await rejection(act(a)))).toBe('quality.simulation_incomplete');
    const b = setup({ now: at(3 * DAY), sim: { minimums: { sim_min_days: 3, sim_min_decisions: 10 }, shadowCount: 10 } }); expect((await act(b)).body.status).toBe('active');
  });
  it('no settings row -> the [CONV] defaults 7 / 100 apply', async () => {
    const a = setup({ now: at(7 * DAY), sim: { minimums: null, shadowCount: 99 } }); expect(code(await rejection(act(a)))).toBe('quality.simulation_incomplete');
    const b = setup({ now: at(7 * DAY), sim: { minimums: null, shadowCount: 100 } }); expect((await act(b)).body.status).toBe('active');
  });
  it('a failing decision count fails closed: nothing written', async () => {
    const s = setup({ sim: { failOn: 'countShadowDecisions' } }); expect(code(await rejection(act(s)))).toBe('common.dependency_unavailable'); noWrites(s);
  });
});

describe('#43 request validation, preconditions, state machine (AV5)', () => {
  it.each([[{}], [{ confirmation_text: 'activate' }], [{ confirmation_text: 'ACTIVATE ' }], [{ confirmation_text: '' }], [{ confirmation_text: 5 }], [{ confirmation_text: 'ACTIVATE', tenant_id: TENANT_B }], ['ACTIVATE'], [null]])(
    'body %j -> 400 common.validation_failed, nothing written', async (body) => {
      const s = setup(); const e = await rejection(act(s, { body })); expect(code(e)).toBe('common.validation_failed'); expect(e.errors?.length ?? 0).toBeGreaterThan(0); noWrites(s);
    });
  it('a wrong confirmation names /confirmation_text and echoes no input', async () => {
    const e = await rejection(act(setup(), { body: { confirmation_text: SEC } })); expect(e.errors).toEqual([expect.objectContaining({ path: '/confirmation_text' })]); expect(JSON.stringify(e)).not.toContain(SEC);
  });
  it('absent If-Match -> 428 common.precondition_required; stale -> 409 common.version_conflict', async () => {
    const a = setup(); expect(code(await rejection(act(a, { expectedVersion: undefined })))).toBe('common.precondition_required'); noWrites(a);
    const b = setup(); expect(code(await rejection(act(b, { expectedVersion: 9 })))).toBe('common.version_conflict'); noWrites(b);
  });
  it('a concurrent writer wins between read and write -> 409 common.version_conflict', async () => {
    const s = setup(); const real = s.deps.repo.updateVersion.bind(s.deps.repo); s.deps.repo.updateVersion = async (...a: any[]) => (a[2] === VER(2) ? undefined : (real as any)(...a));
    expect(code(await rejection(act(s)))).toBe('common.version_conflict');
  });
  it.each([[1, 'draft'], [3, 'stopped'], [4, 'active'], [5, 'retired'], [6, 'discarded']])('VER(%i) is %s, only `simulating` can activate -> 409 quality.rule_set_invalid_transition', async (n) => {
    const s = setup(); expect(code(await rejection(act(s, { versionId: VER(n) })))).toBe('quality.rule_set_invalid_transition'); noWrites(s);
  });
  it('unknown, malformed and other-tenant version ids -> 404 common.not_found', async () => {
    for (const versionId of [VER(99), 'not-a-uuid', 42, undefined]) { const s = setup(); expect(code(await rejection(act(s, { versionId })))).toBe('common.not_found'); noWrites(s); }
    const b = setup({ tenantId: TENANT_B }); expect(code(await rejection(act(b)))).toBe('common.not_found');
  });
  it('tenant comes from ctx only: every repo call carries ctx.tenantId', async () => {
    const s = setup(); await act(s, { body: ACTIVATE_BODY });
    for (const c of [...s.fake.calls, ...s.sim.calls]) expect(c.tenantId).toBe(s.ctx.tenantId);
  });
});

describe('#44 retireAutoverifyVersion — access log autoverify.retire (T-15 service, T-17 addition)', () => {
  const retire = (s: ReturnType<typeof setup>, o: Row = {}) => createAutoverifyService({ repo: s.fake.repo }).retireAutoverifyVersion(s.ctx, { versionId: VER(4), expectedVersion: 1, body: RETIRE_BODY, ...o } as any);
  it('writes exactly one row { autoverify.retire, autoverify_version, <version id>, allowed }', async () => {
    const s = setup(); await retire(s); expect(s.audits).toEqual([entry('autoverify.retire', 'autoverify_version', VER(4))]);
  });
  it.each([
    ['aal1', { aal: 'aal1' as const }, {}], ['read-only holder', { held: ['quality.autoverify.read'] }, {}], ['stale version', {}, { expectedVersion: 7 }], ['absent If-Match', {}, { expectedVersion: undefined }],
    ['not retire-able (draft)', {}, { versionId: VER(1) }], ['unknown', {}, { versionId: VER(99) }], ['bad reason', {}, { body: { reason: '' } }],
  ])('no access-log row when the call fails: %s', async (_n, o, input) => { const s = setup(o); await rejection(retire(s, input)); expect(s.audits).toEqual([]); });
  it('a failing access-log write fails the call', async () => { expect(code(await rejection(retire(setup({ auditFails: true }))))).toBe('common.internal'); });
});

describe('#42 getAutoverifySimulationReport — AC-11.3 (TRD §8.6)', () => {
  const report = (s: ReturnType<typeof setup>, o: Row = {}) => svc(s).getAutoverifySimulationReport(s.ctx, { versionId: VER(2), ...o } as any);
  it('maps the aggregates: version_id, started_at, days_running (floor), decisions, would_allow/deny, deny_by_reason, later-verified / not-yet, live_comparison', async () => {
    const s = setup({ now: at(7 * DAY + 3600_000) }); const r = await report(s);
    expect(r.status).toBe(200); expect(r.version).toBeUndefined();
    expect(r.body).toMatchObject({
      version_id: VER(2), started_at: SIM_START, days_running: 7, decisions: 120, would_allow: 90, would_deny: 30, deny_by_reason: { outside_autoverify_limits: 20, instrument_flag: 10 },
      allow_later_manually_verified: 80, allow_not_verified_yet: 10, live_comparison: { both_allow: 70, live_only_allow: 5, shadow_only_allow: 20 },
    });
  });
  it('days_running floors: 6 d 23 h 59 m -> 6; 0 elapsed -> 0', async () => {
    expect((await report(setup({ now: at(7 * DAY - 60_000) }))).body.days_running).toBe(6);
    expect((await report(setup({ now: SIM_START }))).body.days_running).toBe(0);
  });
  it('the sample carries live_decision (D-AV-4) and omits order_id / manually_verified_at / live_decision when absent', async () => {
    const r = await report(setup()); const [a, b, c] = r.body.sample;
    expect(a).toEqual({ decision_id: DEC(1), result_id: expect.any(String), order_id: expect.any(String), analyte_id: expect.any(String), decided_at: expect.any(String), shadow_decision: 'allow', shadow_reasons: [], live_decision: 'allow', manually_verified_at: expect.any(String) });
    expect(b.live_decision).toBe('deny'); expect('order_id' in b).toBe(false); expect('manually_verified_at' in b).toBe(false);
    expect('live_decision' in c).toBe(false);
  });
  it('live_comparison is absent when the repo has none', async () => {
    const r = await report(setup({ sim: { report: reportRows({ live_comparison: undefined }) } })); expect('live_comparison' in r.body).toBe(false);
  });
  it('allow-list only: no internal columns, no P3 inputs, no patient text in the report or its sample', async () => {
    const t = JSON.stringify((await report(setup())).body); for (const x of [PLANTED, SEC, 'inputs', 'internal_note', 'tenant_id']) expect(t, x).not.toContain(x);
  });
  it('the repo is asked once: this version, since simulation_started_at, sample_limit default 50; tenant from ctx; no write', async () => {
    const s = setup(); await report(s);
    expect(s.sim.callsOf('simulationReport')).toEqual([{ op: 'simulationReport', tenantId: s.ctx.tenantId, args: [{ versionId: VER(2), since: SIM_START, sampleLimit: 50 }] }]); expect(s.fake.mutations()).toEqual([]);
  });
  it.each([[0], [1], [200]])('sample_limit %i is accepted and passed through; the sample never exceeds it', async (n) => {
    const s = setup({ sim: { report: reportRows({ sample: Array.from({ length: 205 }, (_x, i) => sampleRow(i + 1)) }) } }); const r = await report(s, { sampleLimit: n });
    expect(s.sim.callsOf('simulationReport')[0]!.args[0]).toMatchObject({ sampleLimit: n }); expect(r.body.sample.length).toBeLessThanOrEqual(n);
  });
  it.each([[-1], [201], [1.5], ['10'], [Number.NaN], [null]])('sample_limit %j -> 400 common.validation_failed at /sample_limit; repo not asked; no access-log row', async (n) => {
    const s = setup(); const e = await rejection(report(s, { sampleLimit: n }));
    expect(code(e)).toBe('common.validation_failed'); expect(e.errors).toEqual([expect.objectContaining({ path: '/sample_limit' })]); expect(s.sim.calls).toEqual([]); expect(s.audits).toEqual([]);
  });
  it('a version that exists in another tenant, or does not exist -> 404, no access-log row', async () => {
    for (const versionId of [VER(99), 'not-a-uuid']) { const s = setup(); expect(code(await rejection(report(s, { versionId })))).toBe('common.not_found'); expect(s.audits).toEqual([]); }
    const b = setup({ tenantId: TENANT_B }); expect(code(await rejection(report(b)))).toBe('common.not_found'); expect(b.audits).toEqual([]);
  });
  it('read permission asserted first; a holder without it -> auth.forbidden, nothing read, no access-log row', async () => {
    const s = setup({ held: ['quality.autoverify.manage'] }); expect(code(await rejection(report(s)))).toBe('auth.forbidden');
    expect(s.asserted).toEqual([{ permission: 'quality.autoverify.read' }]); expect(s.fake.calls).toEqual([]); expect(s.sim.calls).toEqual([]); expect(s.audits).toEqual([]);
  });
  it('a read holder at aal1 may read (read is not privileged)', async () => { expect((await report(setup({ aal: 'aal1' }))).status).toBe(200); });
});

describe('#42 AC-13.7: one access-log row per report view', () => {
  it('writes exactly one row { autoverify_simulation.view, autoverify_version, <version id>, allowed } after a successful read', async () => {
    const s = setup(); await svc(s).getAutoverifySimulationReport(s.ctx, { versionId: VER(2) } as any); expect(s.audits).toEqual([entry('autoverify_simulation.view', 'autoverify_version', VER(2))]);
  });
  it('two views write two rows (no de-duplication)', async () => {
    const s = setup(); await svc(s).getAutoverifySimulationReport(s.ctx, { versionId: VER(2) } as any); await svc(s).getAutoverifySimulationReport(s.ctx, { versionId: VER(2) } as any); expect(s.audits).toHaveLength(2);
  });
  it('a failing access-log write fails the read (no unlogged P3-derived report leaves)', async () => {
    const s = setup({ auditFails: true }); expect(code(await rejection(svc(s).getAutoverifySimulationReport(s.ctx, { versionId: VER(2) } as any)))).toBe('common.internal');
  });
});

describe('#47 getAutoverifyDecision — AC-13.7, P3 inputs', () => {
  const one = (s: ReturnType<typeof setup>, decisionId: unknown = DEC(1)) => svc(s).getAutoverifyDecision(s.ctx, { decisionId } as any);
  it('returns the decision with its inputs (allow-listed keys only) and optional ids; 200, no ETag version', async () => {
    const r = await one(setup());
    expect(r.status).toBe(200); expect(r.version).toBeUndefined();
    expect(r.body).toMatchObject({ id: DEC(1), mode: 'live', decision: 'allow', reasons: [], matched_rule_key: 'K_ANY', qc_status: 'in_control', inputs: { value_numeric: '4.2', range_flag: 'N', delta_check_failed: false, is_critical: false, instrument_flags: ['SYN_FLAG'] } });
    const t = JSON.stringify(r.body); for (const x of [PLANTED, SEC, 'tenant_id', 'created_by', 'internal_note']) expect(t, x).not.toContain(x);
  });
  it('null optional columns are omitted (instrument_id, matched_rule_key, qc_run_id)', async () => {
    const r = await one(setup(), DEC(2)); for (const k of ['instrument_id', 'matched_rule_key', 'qc_run_id']) expect(k in r.body, k).toBe(false);
    expect(r.body.reasons).toEqual(['outside_autoverify_limits']);
  });
  it('writes exactly one row { autoverify_decision.view, autoverify_decision, <decision id>, allowed } (08 A17 D-53)', async () => {
    const s = setup(); await one(s); expect(s.audits).toEqual([entry('autoverify_decision.view', 'autoverify_decision', DEC(1))]);
  });
  it('unknown / malformed / other-tenant decision -> 404 and NO access-log row', async () => {
    for (const id of [DEC(99), 'nope', DEC_B, undefined]) { const s = setup(); expect(code(await rejection(svc(s).getAutoverifyDecision(s.ctx, { decisionId: id } as any)))).toBe('common.not_found'); expect(s.audits).toEqual([]); }
  });
  it('read permission first; forbidden -> nothing read, no row; failing access-log write fails the read', async () => {
    const s = setup({ held: [] }); expect(code(await rejection(one(s)))).toBe('auth.forbidden'); expect(s.sim.calls).toEqual([]); expect(s.audits).toEqual([]);
    expect(code(await rejection(one(setup({ auditFails: true }))))).toBe('common.internal');
  });
  it('tenant from ctx only', async () => { const s = setup(); await one(s); expect(s.sim.callsOf('findDecision')).toEqual([{ op: 'findDecision', tenantId: s.ctx.tenantId, args: [DEC(1)] }]); });
});

describe('#46 listAutoverifyDecisions — filters, window <= 31 d, no inputs, no access-log row', () => {
  const FROM = '2026-11-01T00:00:00.000Z', TO31 = new Date(Date.parse(FROM) + 31 * DAY).toISOString();
  const list = (s: ReturnType<typeof setup>, o: Row = {}) => svc(s).listAutoverifyDecisions(s.ctx, { decidedAtFrom: FROM, decidedAtTo: TO31, ...o } as any);
  const q = (s: ReturnType<typeof setup>) => s.sim.callsOf('listDecisions')[0]!.args[0] as Row;
  it('200 { data, page { limit, next_cursor } }, tenant rows only, DTO without inputs or internal columns', async () => {
    const s = setup(); const r = await list(s);
    expect(r.status).toBe(200); expect(r.body.page).toEqual({ limit: 50, next_cursor: 'CURSOR-NEXT' }); expect(r.body.data.map((d: Row) => d['id'])).toEqual([DEC(1), DEC(2)]);
    const t = JSON.stringify(r.body); for (const x of [PLANTED, SEC, 'inputs', 'tenant_id', 'created_by']) expect(t, x).not.toContain(x);
  });
  it('filters, window, cursor and limit reach the repo; defaults limit 50; tenant from ctx', async () => {
    const s = setup(); await list(s, { resultId: DEC(1), analyteId: DEC(2), instrumentId: DEC(3), versionId: VER(4), mode: 'shadow', decision: 'deny', reason: 'qc_warning', cursor: 'abc', limit: 25 });
    expect(q(s)).toMatchObject({ resultId: DEC(1), analyteId: DEC(2), instrumentId: DEC(3), versionId: VER(4), mode: 'shadow', decision: 'deny', reason: 'qc_warning', from: FROM, to: TO31, cursor: 'abc', limit: 25 });
    expect(s.sim.callsOf('listDecisions')[0]!.tenantId).toBe(s.ctx.tenantId);
    const d = setup(); await list(d); expect(q(d)).toMatchObject({ from: FROM, to: TO31, limit: 50 });
  });
  it('a span of exactly 31 days is accepted; 31 days + 1 ms, an inverted window, missing or malformed bounds -> 400 common.validation_failed, repo not asked', async () => {
    expect((await list(setup())).status).toBe(200);
    for (const o of [{ decidedAtTo: new Date(Date.parse(TO31) + 1).toISOString() }, { decidedAtTo: '2026-10-01T00:00:00.000Z' }, { decidedAtFrom: undefined }, { decidedAtTo: undefined }, { decidedAtFrom: 'yesterday' }, { decidedAtTo: 20261201 }]) {
      const s = setup(); expect(code(await rejection(list(s, o))), JSON.stringify(o)).toBe('common.validation_failed'); expect(s.sim.calls).toEqual([]);
    }
  });
  it.each([[{ mode: 'both' }], [{ decision: 'maybe' }], [{ reason: 'because' }], [{ versionId: 'x' }], [{ resultId: 'x' }], [{ analyteId: 'x' }], [{ instrumentId: 'x' }], [{ limit: 0 }], [{ limit: 201 }], [{ sort: 'decided_at' }], [{ cursor: '' }]])(
    'invalid %j -> 400 common.validation_failed, repo not asked', async (o) => { const s = setup(); expect(code(await rejection(list(s, o)))).toBe('common.validation_failed'); expect(s.sim.calls).toEqual([]); });
  it('read permission first; no access-log row on success (the four C9 actions are the only ones used)', async () => {
    const f = setup({ held: [] }); expect(code(await rejection(list(f)))).toBe('auth.forbidden'); expect(f.sim.calls).toEqual([]);
    const s = setup(); await list(s); expect(s.audits).toEqual([]);
  });
});

describe('access log — exactly autoverify.activate, autoverify.retire, autoverify_decision.view, autoverify_simulation.view (PRD AC-13.7, REQ-SEC-096)', () => {
  it('running every T-15/T-17 operation writes only those four actions', async () => {
    const s = setup({ actor: OTHER_USER }); const act2 = svc(s); const av = createAutoverifyService({ repo: s.fake.repo });
    await av.getAutoverifyRuleSet(s.ctx, {}); await av.getAutoverifyVersion(s.ctx, { versionId: VER(1) } as any); await av.discardAutoverifyDraft(s.ctx, { versionId: VER(7), expectedVersion: 1, body: {} } as any);
    await act2.listAutoverifyDecisions(s.ctx, { decidedAtFrom: '2026-11-01T00:00:00.000Z', decidedAtTo: '2026-11-02T00:00:00.000Z' } as any);
    await act2.getAutoverifyDecision(s.ctx, { decisionId: DEC(1) } as any); await act2.getAutoverifySimulationReport(s.ctx, { versionId: VER(2) } as any);
    await act2.activateAutoverifyVersion(s.ctx, activateInput() as any);
    await av.retireAutoverifyVersion(s.ctx, { versionId: VER(2), expectedVersion: 2, body: RETIRE_BODY } as any);
    expect(s.audits.map((a) => a['action']).sort()).toEqual([...ACTIONS].sort());
    for (const a of s.audits) expect(Object.keys(a).sort()).toEqual(['action', 'entityId', 'entityType', 'outcome']);
  });
});
