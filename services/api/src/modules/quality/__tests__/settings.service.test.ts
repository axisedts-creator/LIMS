// C9 T-20 — service behaviour of #51-#54 (02-TRD §5.8, §12.1; PRD settings; 07-SECURITY REQ-SEC-024/040/080/081, S-01). Repo = in-memory fake (settings.helpers.ts), ports faked.
// Seams: see the header of settings.helpers.ts. Fails now: createSettingsService() has only `ensure` ("svc.getQualitySettings is not a function").
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toProblem } from '../../../core/errors.js';
import { ACTIVATED, CODE_KEYS, DEFAULTS, LATER, MUTABLE, NOW, PLANTED, REQ_ID, SETS, SETTINGS_KEYS, TENANT_A, TENANT_B, UUID7, USER, body, code, forbidden, makeSettingsCtx, noRights, readOnly, rejection, store, type Row } from './settings.helpers.js';

vi.mock('../repository/settings.repo.js', async () => (await import('./settings.helpers.js')).fakeRepoModule());
const { createSettingsService } = await import('../service/settings.service.js');
const svc: any = createSettingsService();
beforeEach(() => { store.reset(); });

const paths = (e: any): string[] => (e?.errors ?? []).map((x: Row) => x['path']);
const bad = async (p: Promise<unknown>, path?: string, errCode?: string) => {
  const e = await rejection(p); expect(code(e)).toBe('common.validation_failed'); expect(toProblem(e, '/x', REQ_ID).status).toBe(400);
  if (path) expect(e.errors).toEqual(expect.arrayContaining([expect.objectContaining({ path, ...(errCode ? { code: errCode } : {}) })]));
  return e;
};
// No default parameter: an explicit `undefined` must reach the service (missing If-Match); omitting the arg means version 1.
const put = (t: ReturnType<typeof makeSettingsCtx>, b: unknown, ...rest: [number?]) => svc.updateQualitySettings(t.ctx, { expectedVersion: rest.length ? rest[0] : 1, body: b });

describe('#51 getQualitySettings', () => {
  it('first use ensures the row (defaults, activated_at = now, sync_state) and answers the allowlisted DTO; version 1; C2 values appended read-only', async () => {
    const t = makeSettingsCtx({ c2: { westgardMode: 'modern', autoVerificationEnabled: true } });
    const r = await svc.getQualitySettings(t.ctx, {});
    expect(r.status).toBe(200); expect(r.version).toBe(1);
    expect(r.body).toMatchObject({ version: 1, ...DEFAULTS, default_plan_params: {}, activated_at: NOW, westgard_mode: 'modern', auto_verification_enabled: true });
    expect(store.settings.get(TENANT_A)).toBeTruthy(); expect(store.syncState.has(TENANT_A)).toBe(true);
    expect(t.asked.length).toBeGreaterThan(0);
  });
  it('is exactly the DTO: only QualitySettingsDto keys, no id / tenant_id / created_by / updated_by / is_active, no planted internal column; required keys all present; no null on the wire', async () => {
    store.seedSettings(TENANT_A, { internal_note: PLANTED, created_by: PLANTED, updated_by: PLANTED, is_active: true });
    const { body: b } = await svc.getQualitySettings(makeSettingsCtx().ctx, {});
    for (const k of Object.keys(b)) expect(SETTINGS_KEYS, k).toContain(k);
    for (const k of SETTINGS_KEYS.filter((x) => !['updated_at', 'updated_by_display'].includes(x))) expect(b, k).toHaveProperty(k);
    expect(JSON.stringify(b)).not.toMatch(/tenant_id|created_by|updated_by"|"id"|is_active|PLANTED/);
    expect(Object.values(b)).not.toContain(null); expect(b.updated_by_display === undefined || typeof b.updated_by_display === 'string').toBe(true);
  });
  it('timestamps leave as ISO-UTC with ms whether the driver gave a Date or text', async () => {
    store.seedSettings(TENANT_A, { activated_at: new Date(ACTIVATED), updated_at: new Date(LATER) });
    const { body: b } = await svc.getQualitySettings(makeSettingsCtx().ctx, {});
    expect(b.activated_at).toBe(ACTIVATED); expect(b.updated_at).toBe(LATER);
  });
  it('C2 has nothing stored -> westgard_mode "classic", auto_verification_enabled false (§12.1 defaults)', async () => {
    const { body: b } = await svc.getQualitySettings(makeSettingsCtx({ c2: {} }).ctx, {});
    expect(b.westgard_mode).toBe('classic'); expect(b.auto_verification_enabled).toBe(false);
  });
  it('a pre-existing row is returned as is: ensure does not rewrite it (activated_at keeps its first value; no second sync_state value)', async () => {
    store.seedSettings(TENANT_A, { tat_warn_pct: 77 }); const { body: b } = await svc.getQualitySettings(makeSettingsCtx().ctx, {});
    expect(b.activated_at).toBe(ACTIVATED); expect(b.tat_warn_pct).toBe(77); expect(store.settings.get(TENANT_A)).toMatchObject({ version: 1, activated_at: ACTIVATED });
  });
  it('concurrent first reads create ONE row and one sync_state (race-safe ensure)', async () => {
    const t = makeSettingsCtx(); const out = await Promise.all([1, 2, 3, 4, 5].map(() => svc.getQualitySettings(t.ctx, {})));
    expect(new Set(out.map((o: any) => o.body.activated_at)).size).toBe(1); expect(store.settings.size).toBe(1); expect(store.syncState.size).toBe(1);
  });
  it('quality.qc_run.read is asserted FIRST: a principal without it gets auth.forbidden and NOTHING is read or created (not even by ensure)', async () => {
    const t = makeSettingsCtx({ roles: noRights }); const e = await rejection(svc.getQualitySettings(t.ctx, {}));
    expect(code(e)).toBe('auth.forbidden'); expect(store.calls).toEqual([]); expect(store.settings.size).toBe(0); expect(t.asserted[0]).toMatchObject({ permission: 'quality.qc_run.read' });
  });
  it('read-only principal (lab_technologist) may read', async () => {
    expect((await svc.getQualitySettings(makeSettingsCtx({ roles: readOnly }).ctx, {})).status).toBe(200);
  });
  it('tenant isolation: tenant B\'s row (planted values) never reaches tenant A; A\'s ensure creates A\'s own row, B\'s is untouched', async () => {
    store.seedSettings(TENANT_B, { tat_warn_pct: 55, default_plan_params: { run_window_minutes: 99 } });
    const { body: b } = await svc.getQualitySettings(makeSettingsCtx().ctx, {});
    expect(b.tat_warn_pct).toBe(80); expect(JSON.stringify(b)).not.toContain('99');
    expect(store.settings.get(TENANT_B)).toMatchObject({ tat_warn_pct: 55, version: 1 });
    for (const c of store.calls) expect(c.tenantId, c.op).toBe(TENANT_A);
  });
  it('a missing row after ensure is an internal error, never fabricated defaults (RLS / FK problem)', async () => {
    const m: any = await import('../repository/settings.repo.js');
    const spy = vi.spyOn(m, 'getSettings').mockResolvedValue(undefined as never);
    try { const e = await rejection(svc.getQualitySettings(makeSettingsCtx().ctx, {})); expect(e).toBeInstanceOf(Error); expect(JSON.stringify({ c: e?.code, m: e?.message })).not.toMatch(/SELECT|quality\./i); }
    finally { spy.mockRestore(); }
  });
});

describe('#52 updateQualitySettings: happy path', () => {
  it('replaces the mutable subset, bumps version 1 -> 2, answers the new DTO (+ ETag source `version`), updated_by = ctx.actor, activated_at / tenant untouched', async () => {
    const t = makeSettingsCtx(); const r = await put(t, body());
    expect(r.status).toBe(200); expect(r.version).toBe(2);
    expect(r.body).toMatchObject({ version: 2, tat_warn_pct: 85, tat_escalate_pct: 200, updated_at: LATER, activated_at: NOW, westgard_mode: 'classic', auto_verification_enabled: false });
    expect(r.body.default_plan_params).toEqual(body().default_plan_params);
    const [u] = store.of('updateSettings'); expect(u!.tenantId).toBe(TENANT_A); expect(u!.args[0]).toBe(1); expect(u!.args[2]).toBe(USER);
    expect(Object.keys(u!.args[1] as object).sort()).toEqual([...MUTABLE].sort());
  });
  it('a GET afterwards shows the stored values and version 2; a second PUT with the old version is a conflict', async () => {
    const t = makeSettingsCtx(); await put(t, body());
    expect((await svc.getQualitySettings(t.ctx, {})).body).toMatchObject({ version: 2, tat_warn_pct: 85 });
    expect(code(await rejection(put(t, body({ tat_warn_pct: 60 }), 1)))).toBe('common.version_conflict');
    expect((await put(t, body({ tat_warn_pct: 60 }), 2)).body.version).toBe(3);
  });
  it('the PUT is a full replacement of the subset: an omitted mutable field is a 400, never "keep the old value"', async () => {
    for (const k of MUTABLE) { const b = body(); delete b[k]; await bad(put(makeSettingsCtx(), b), `/${k}`, 'common.field_required'); }
  });
  it('default_plan_params may be empty or hold any subset of QcPlanParamsDefaults', async () => {
    for (const p of [{}, { mean_rule: '6x' }, { run_window_minutes: 5, qc_validity_hours: 168, hold_lookback_hours: 1 }, { two_two_s_across_runs: false, count_rules_across_materials: false, exclude_rejected_runs_from_history: false }]) {
      store.reset(); expect((await put(makeSettingsCtx(), body({ default_plan_params: p }))).body.default_plan_params).toEqual(p);
    }
  });
});

describe('#52 ranges are validated (02-TRD §12.1; DB check settings__ranges__ck) — before any write', () => {
  const R: Array<[string, number, number]> = [['tat_warn_pct', 50, 99], ['tat_escalate_pct', 101, 1000], ['tat_orphan_close_hours', 1, 720], ['target_min_points', 2, 500], ['sim_min_days', 1, 90], ['sim_min_decisions', 10, 100000], ['reprocess_window_days', 1, 30]];
  for (const [k, lo, hi] of R) {
    it(`${k}: ${lo} and ${hi} accepted; ${lo - 1} and ${hi + 1} rejected with path /${k}`, async () => {
      for (const ok of [lo, hi]) { store.reset(); const r = await put(makeSettingsCtx(), body({ [k]: ok })); expect(r.body[k]).toBe(ok); }
      for (const no of [lo - 1, hi + 1]) { store.reset(); const t = makeSettingsCtx(); await bad(put(t, body({ [k]: no })), `/${k}`, 'common.field_invalid'); expect(store.writes()).toEqual([]); }
    });
  }
  it('wrong types are field_invalid: float 80.5, string "80", null, boolean, array, NaN-like, huge, negative zero string', async () => {
    for (const v of [80.5, '80', null, true, [80], {}, 1e21, Number.MAX_SAFE_INTEGER + 2]) { store.reset(); await bad(put(makeSettingsCtx(), body({ tat_warn_pct: v })), '/tat_warn_pct', 'common.field_invalid'); }
    for (const v of ['true', 1, 0, null, 'yes']) { store.reset(); await bad(put(makeSettingsCtx(), body({ tat_alerts_enabled: v })), '/tat_alerts_enabled', 'common.field_invalid'); }
  });
  it('several wrong fields are all reported in one 400 (errors[] has each path)', async () => {
    const e = await bad(put(makeSettingsCtx(), body({ tat_warn_pct: 10, sim_min_days: 0, reprocess_window_days: 31 })));
    expect(paths(e)).toEqual(expect.arrayContaining(['/tat_warn_pct', '/sim_min_days', '/reprocess_window_days']));
  });
  const P: Array<[string, unknown]> = [['mean_rule', '7x'], ['mean_rule', 10], ['two_two_s_across_runs', 'true'], ['run_window_minutes', 4], ['run_window_minutes', 241], ['qc_validity_hours', 0], ['qc_validity_hours', 169],
    ['hold_lookback_hours', 0], ['hold_lookback_hours', 169], ['run_window_minutes', 30.5], ['count_rules_across_materials', null]];
  for (const [k, v] of P) {
    it(`default_plan_params.${k} = ${JSON.stringify(v)} -> 400 /default_plan_params/${k}`, async () => {
      await bad(put(makeSettingsCtx(), body({ default_plan_params: { [k]: v } })), `/default_plan_params/${k}`, 'common.field_invalid');
    });
  }
  it('default_plan_params: unknown key (incl. required-by-plan controls_per_run / composition) -> unknown_field; not an object -> field_invalid', async () => {
    for (const k of ['controls_per_run', 'composition', 'tenant_id', 'x']) { store.reset(); await bad(put(makeSettingsCtx(), body({ default_plan_params: { [k]: 1 } })), `/default_plan_params/${k}`, 'common.unknown_field'); }
    for (const v of [[], null, 'x', 5]) { store.reset(); await bad(put(makeSettingsCtx(), body({ default_plan_params: v })), '/default_plan_params', 'common.field_invalid'); }
  });
  it('mean_rule accepts exactly 8x 10x 12x 6x 9x', async () => {
    for (const m of ['8x', '10x', '12x', '6x', '9x']) { store.reset(); expect((await put(makeSettingsCtx(), body({ default_plan_params: { mean_rule: m } }))).status).toBe(200); }
  });
});

describe('#52 mass assignment and non-mutable fields (REQ-SEC-080/081)', () => {
  const NOT_MUTABLE = ['version', 'activated_at', 'updated_at', 'updated_by_display', 'westgard_mode', 'auto_verification_enabled', 'tenant_id', 'id', 'is_active', 'created_by', 'updated_by', 'created_at'];
  for (const k of NOT_MUTABLE) {
    it(`body field ${k} -> 400 common.unknown_field, nothing written`, async () => {
      const t = makeSettingsCtx(); await bad(put(t, body({ [k]: k === 'tenant_id' ? TENANT_B : 'modern' })), `/${k}`, 'common.unknown_field'); expect(store.writes().filter((c) => c.op === 'updateSettings')).toEqual([]);
    });
  }
  it('a prototype-pollution body (__proto__ / constructor) is refused and pollutes nothing', async () => {
    const b = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"x":1}}'); const e = await rejection(put(makeSettingsCtx(), { ...body(), ...b }));
    expect(code(e)).toBe('common.validation_failed'); expect(({} as any).polluted).toBeUndefined();
  });
  it('body that is not an object (null, array, string) -> 400', async () => { for (const b of [null, [], 'x', 5, undefined]) { store.reset(); await bad(put(makeSettingsCtx(), b)); } });
});

describe('#52 concurrency, authorisation, order of checks', () => {
  it('no If-Match -> 428 common.precondition_required; nothing written', async () => {
    const e = await rejection(put(makeSettingsCtx(), body(), undefined)); expect(code(e)).toBe('common.precondition_required'); expect(toProblem(e, '/x', REQ_ID).status).toBe(428); expect(store.of('updateSettings')).toEqual([]);
  });
  it('stale version -> 409 common.version_conflict; the stored row is unchanged', async () => {
    const t = makeSettingsCtx(); await svc.getQualitySettings(t.ctx, {});
    const e = await rejection(put(t, body({ tat_warn_pct: 60 }), 7)); expect(code(e)).toBe('common.version_conflict'); expect(toProblem(e, '/x', REQ_ID).status).toBe(409);
    expect(store.settings.get(TENANT_A)).toMatchObject({ tat_warn_pct: 80, version: 1 });
  });
  it('PUT before any GET still works (ensure runs on the write path): row created at version 1, If-Match "1" matches', async () => {
    const r = await put(makeSettingsCtx(), body()); expect(r.body.version).toBe(2); expect(store.settings.size).toBe(1);
  });
  it('two concurrent PUTs with the same version: exactly one 200, the other 409; the winner\'s values are stored (no lost update)', async () => {
    const t = makeSettingsCtx(); await svc.getQualitySettings(t.ctx, {});
    const out = await Promise.allSettled([put(t, body({ tat_warn_pct: 60 })), put(t, body({ tat_warn_pct: 70 }))]);
    const ok = out.filter((o) => o.status === 'fulfilled'), no = out.filter((o) => o.status === 'rejected');
    expect(ok).toHaveLength(1); expect(no).toHaveLength(1); expect(code((no[0] as PromiseRejectedResult).reason)).toBe('common.version_conflict');
    expect(store.settings.get(TENANT_A)!['tat_warn_pct']).toBe((ok[0] as PromiseFulfilledResult<any>).value.body.tat_warn_pct); expect(store.settings.get(TENANT_A)!['version']).toBe(2);
  });
  it('quality.config.manage is asserted FIRST: the read-only role gets auth.forbidden even for an invalid body or a missing If-Match; no repo call at all', async () => {
    for (const [b, v] of [[body(), 1], [{ tat_warn_pct: 1 }, 1], [body(), undefined]] as Array<[unknown, number | undefined]>) {
      store.reset(); const t = makeSettingsCtx({ roles: readOnly }); const e = await rejection(put(t, b, v));
      expect(code(e)).toBe('auth.forbidden'); expect(store.calls).toEqual([]); expect(t.asserted.at(-1)).toMatchObject({ permission: 'quality.config.manage' });
    }
  });
  it('validation outranks the missing If-Match (400 before 428) once authorised', async () => { await bad(put(makeSettingsCtx(), { ...body(), x: 1 }, undefined), '/x', 'common.unknown_field'); });
  it('tenant A can never change tenant B\'s row: the update carries ctx.tenantId only; B stays at version 1 with its values', async () => {
    store.seedSettings(TENANT_B, { tat_warn_pct: 55 }); await put(makeSettingsCtx(), body());
    expect(store.of('updateSettings').every((c) => c.tenantId === TENANT_A)).toBe(true); expect(store.settings.get(TENANT_B)).toMatchObject({ tat_warn_pct: 55, version: 1 });
  });
  it('a DB failure is common.internal-shaped without SQL text (non-Lims errors do not leak)', async () => {
    const m: any = await import('../repository/settings.repo.js'); const spy = vi.spyOn(m, 'updateSettings').mockRejectedValue(new Error(`select * from quality.settings ${PLANTED}`));
    try { const e = await rejection(put(makeSettingsCtx(), body())); expect(JSON.stringify({ c: e?.code, m: e?.message, d: e?.detail })).not.toMatch(/select|PLANTED|quality\./i); } finally { spy.mockRestore(); }
  });
});

describe('#53 listQualityCodedSet', () => {
  it('both sets: the global rows, source "global", sorted by (sort_order, code); DTO keys exactly code/display/sort_order/is_active/source', async () => {
    for (const s of SETS) {
      const r = await svc.listQualityCodedSet(makeSettingsCtx().ctx, { setName: s });
      expect(r.status).toBe(200); expect(Object.keys(r.body)).toEqual(['data']); expect(r.body.data.map((x: Row) => x['code'])).toEqual(store.globals[s]!.map((x) => x['code']));
      for (const row of r.body.data) { expect(Object.keys(row).sort()).toEqual(CODE_KEYS); expect(row.source).toBe('global'); }
    }
  });
  it('a tenant code is added (source "tenant"); a tenant code with a global\'s code SHADOWS it (05-SCHEMA §2); order stays (sort_order, code)', async () => {
    store.addTenantCode(TENANT_A, 'corrective_actions', { code: 'other', display: 'Synthetic other', sort_order: 5, is_active: true });
    store.addTenantCode(TENANT_A, 'corrective_actions', { code: 'lab_specific', display: 'Synthetic lab step', sort_order: 15, is_active: true });
    const { body: b } = await svc.listQualityCodedSet(makeSettingsCtx().ctx, { setName: 'corrective_actions' });
    expect(b.data.map((x: Row) => x['code'])).toEqual(['other', 'recalibration', 'lab_specific', 'new_control_vial']);
    expect(b.data.find((x: Row) => x['code'] === 'other')).toEqual({ code: 'other', display: 'Synthetic other', sort_order: 5, is_active: true, source: 'tenant' });
    expect(b.data.filter((x: Row) => x['code'] === 'other')).toHaveLength(1);
  });
  it('an inactive tenant override is still listed (is_active false) and still shadows the global row', async () => {
    store.addTenantCode(TENANT_A, 'exclusion_reasons', { code: 'handling_error', display: 'Handling error', sort_order: 20, is_active: false });
    const row = (await svc.listQualityCodedSet(makeSettingsCtx().ctx, { setName: 'exclusion_reasons' })).body.data.find((x: Row) => x['code'] === 'handling_error');
    expect(row).toMatchObject({ is_active: false, source: 'tenant' });
  });
  it('the two sets never mix: a tenant code of exclusion_reasons is not in corrective_actions', async () => {
    store.addTenantCode(TENANT_A, 'exclusion_reasons', { code: 'only_exclusion', display: 'x', sort_order: 1 });
    expect((await svc.listQualityCodedSet(makeSettingsCtx().ctx, { setName: 'corrective_actions' })).body.data.map((x: Row) => x['code'])).not.toContain('only_exclusion');
  });
  it('tenant isolation: tenant B\'s codes never appear for tenant A (and B\'s shadow does not hide A\'s global view)', async () => {
    store.addTenantCode(TENANT_B, 'corrective_actions', { code: 'b_only', display: 'B secret', sort_order: 1 }); store.addTenantCode(TENANT_B, 'corrective_actions', { code: 'other', display: 'B other', sort_order: 1 });
    const d = (await svc.listQualityCodedSet(makeSettingsCtx().ctx, { setName: 'corrective_actions' })).body.data;
    expect(JSON.stringify(d)).not.toMatch(/b_only|B secret|B other/); expect(d.find((x: Row) => x['code'] === 'other').source).toBe('global');
    for (const c of store.calls.filter((x) => x.tenantId !== undefined)) expect(c.tenantId).toBe(TENANT_A);
  });
  it('unknown / hostile set_name -> 400 /set_name, no repo call (the table name is never built from input)', async () => {
    for (const s of ['nope', '', 'corrective_actions; DROP TABLE quality.settings', '../settings', 'CORRECTIVE_ACTIONS', undefined, 5, 'exclusion_reasons ']) {
      store.reset(); await bad(svc.listQualityCodedSet(makeSettingsCtx().ctx, { setName: s }), '/set_name'); expect(store.calls).toEqual([]);
    }
  });
  it('quality.qc_run.read asserted first (no rights -> auth.forbidden, no repo call); read-only role allowed', async () => {
    const t = makeSettingsCtx({ roles: noRights }); expect(code(await rejection(svc.listQualityCodedSet(t.ctx, { setName: 'corrective_actions' })))).toBe('auth.forbidden'); expect(store.calls).toEqual([]); expect(t.asserted[0]).toMatchObject({ permission: 'quality.qc_run.read' });
    expect((await svc.listQualityCodedSet(makeSettingsCtx({ roles: readOnly }).ctx, { setName: 'exclusion_reasons' })).status).toBe(200);
  });
  it('is a pure read: no insert/update (the settings row is not created by listing codes)', async () => {
    await svc.listQualityCodedSet(makeSettingsCtx().ctx, { setName: 'corrective_actions' }); expect(store.writes()).toEqual([]); expect(store.settings.size).toBe(0);
  });
  it('at most 500 rows (contract maxItems)', async () => {
    for (let i = 0; i < 520; i++) store.addTenantCode(TENANT_A, 'corrective_actions', { code: `c${String(i).padStart(4, '0')}`, display: 'x', sort_order: 500 });
    expect((await svc.listQualityCodedSet(makeSettingsCtx().ctx, { setName: 'corrective_actions' })).body.data.length).toBeLessThanOrEqual(500);
  });
});

describe('#54 upsertQualityCode', () => {
  const up = (t: ReturnType<typeof makeSettingsCtx>, setName: unknown, codeV: unknown, b: unknown) => svc.upsertQualityCode(t.ctx, { setName, code: codeV, body: b });
  const B = { display: 'Synthetic recalibration', sort_order: 10, is_active: true };
  it('creates a tenant code: 200 + QualityCode with source "tenant"; the row is stored for ctx.tenantId with a uuid v7 id and ctx.actor', async () => {
    const r = await up(makeSettingsCtx(), 'corrective_actions', 'recalibrated', B);
    expect(r.status).toBe(200); expect(r.body).toEqual({ code: 'recalibrated', display: 'Synthetic recalibration', sort_order: 10, is_active: true, source: 'tenant' });
    const [c] = store.of('upsertTenantCode'); expect(c!.tenantId).toBe(TENANT_A); expect(c!.args[0]).toBe('corrective_actions');
    expect(c!.args[1]).toMatchObject({ code: 'recalibrated', display: 'Synthetic recalibration', sortOrder: 10, isActive: true, actorId: USER }); expect((c!.args[1] as any).id).toMatch(UUID7);
  });
  it('is idempotent and updates in place: the same PUT twice leaves one row; a changed body changes display/sort/active', async () => {
    const t = makeSettingsCtx(); await up(t, 'exclusion_reasons', 'dup_entry', B); await up(t, 'exclusion_reasons', 'dup_entry', B);
    const r = await up(t, 'exclusion_reasons', 'dup_entry', { display: 'Renamed', sort_order: 999, is_active: false });
    expect(store.tenant.filter((x) => x['code'] === 'dup_entry')).toHaveLength(1); expect(r.body).toMatchObject({ display: 'Renamed', sort_order: 999, is_active: false, source: 'tenant' });
  });
  it('overriding a GLOBAL code creates a tenant row that then shadows it in #53; the global table is never written', async () => {
    const t = makeSettingsCtx(); await up(t, 'corrective_actions', 'recalibration', { display: 'Our wording', sort_order: 1, is_active: true });
    expect((await svc.listQualityCodedSet(t.ctx, { setName: 'corrective_actions' })).body.data[0]).toMatchObject({ code: 'recalibration', display: 'Our wording', source: 'tenant' });
    expect(store.globals['corrective_actions']!.find((x) => x['code'] === 'recalibration')!['display']).toBe('Recalibrated');
  });
  it('code boundaries (DB check ^[a-z][a-z0-9_]{1,63}$): 2 and 64 chars accepted; 1 / 65 chars, upper case, leading digit/underscore, dash, dot, space, unicode, empty -> 400 /code, no write', async () => {
    for (const c of ['ab', 'a' + 'b'.repeat(63), 'a_1', 'x9']) { store.reset(); expect((await up(makeSettingsCtx(), 'corrective_actions', c, B)).status).toBe(200); }
    for (const c of ['a', 'a' + 'b'.repeat(64), 'Abc', '1ab', '_ab', 'a-b', 'a.b', 'a b', 'abé', '', 'ab\n', "a'; DROP TABLE x;--", undefined, 7]) {
      store.reset(); await bad(up(makeSettingsCtx(), 'corrective_actions', c, B), '/code'); expect(store.writes()).toEqual([]);
    }
  });
  it('body boundaries: display 1..120 (121 and "" rejected), sort_order 0..999 (-1, 1000, 1.5, "5" rejected), is_active boolean only', async () => {
    const t = () => makeSettingsCtx();
    for (const [k, v] of [['display', 'x'], ['display', 'x'.repeat(120)], ['sort_order', 0], ['sort_order', 999], ['is_active', false]] as Array<[string, unknown]>) { store.reset(); expect((await up(t(), 'corrective_actions', 'okcode', { ...B, [k]: v })).status).toBe(200); }
    for (const [k, v] of [['display', ''], ['display', 'x'.repeat(121)], ['display', 5], ['display', null], ['sort_order', -1], ['sort_order', 1000], ['sort_order', 1.5], ['sort_order', '5'], ['is_active', 'true'], ['is_active', 1], ['is_active', null]] as Array<[string, unknown]>) {
      store.reset(); await bad(up(t(), 'corrective_actions', 'okcode', { ...B, [k]: v }), `/${k}`, 'common.field_invalid'); expect(store.writes()).toEqual([]);
    }
  });
  it('missing fields -> field_required; extra fields (tenant_id, source, code, id, version, system) -> unknown_field; non-object body -> 400', async () => {
    for (const k of ['display', 'sort_order', 'is_active']) { const b: Row = { ...B }; delete b[k]; store.reset(); await bad(up(makeSettingsCtx(), 'corrective_actions', 'okcode', b), `/${k}`, 'common.field_required'); }
    for (const k of ['tenant_id', 'source', 'code', 'id', 'version', 'system', 'created_by']) { store.reset(); await bad(up(makeSettingsCtx(), 'corrective_actions', 'okcode', { ...B, [k]: TENANT_B }), `/${k}`, 'common.unknown_field'); expect(store.writes()).toEqual([]); }
    for (const b of [null, [], 'x', undefined]) { store.reset(); await bad(up(makeSettingsCtx(), 'corrective_actions', 'okcode', b)); }
  });
  it('unknown / hostile set_name -> 400 /set_name before any repo call', async () => {
    for (const s of ['nope', '', 'corrective_actions"; --', 'g_cs_corrective_actions', 'settings', undefined]) { store.reset(); await bad(up(makeSettingsCtx(), s, 'okcode', B), '/set_name'); expect(store.calls).toEqual([]); }
  });
  it('quality.config.manage asserted FIRST: read-only role -> auth.forbidden (even for a bad code / body), no repo call; no rights -> auth.forbidden', async () => {
    for (const roles of [readOnly, noRights]) for (const [c, b] of [['okcode', B], ['BAD', B], ['okcode', null]] as Array<[string, unknown]>) {
      store.reset(); const t = makeSettingsCtx({ roles }); const e = await rejection(up(t, 'corrective_actions', c, b)); expect(code(e)).toBe('auth.forbidden'); expect(store.calls).toEqual([]); expect(t.asserted.at(-1)).toMatchObject({ permission: 'quality.config.manage' });
    }
  });
  it('tenant isolation: A\'s upsert never touches B\'s rows (same code in both tenants stays separate); a body tenant_id cannot redirect it', async () => {
    store.addTenantCode(TENANT_B, 'corrective_actions', { code: 'shared_code', display: 'B original', sort_order: 1 });
    await up(makeSettingsCtx(), 'corrective_actions', 'shared_code', { display: 'A version', sort_order: 2, is_active: true });
    expect(store.tenant.find((r) => r.tenant_id === TENANT_B && r['code'] === 'shared_code')).toMatchObject({ display: 'B original', sort_order: 1 });
    expect(store.tenant.find((r) => r.tenant_id === TENANT_A && r['code'] === 'shared_code')).toMatchObject({ display: 'A version' });
    expect(store.of('upsertTenantCode').every((c) => c.tenantId === TENANT_A)).toBe(true);
  });
  it('concurrent upserts of one code end with ONE row (the last writer\'s values), no error', async () => {
    const t = makeSettingsCtx(); const out = await Promise.all([1, 2, 3, 4].map((i) => up(t, 'corrective_actions', 'racy_code', { display: `v${i}`, sort_order: i, is_active: true })));
    expect(out.every((o: any) => o.status === 200)).toBe(true); expect(store.tenant.filter((r) => r['code'] === 'racy_code')).toHaveLength(1);
  });
  it('stored display is returned as sent (no HTML interpretation, no trimming surprises): "<b>x</b>" round-trips as text', async () => {
    expect((await up(makeSettingsCtx(), 'corrective_actions', 'okcode', { ...B, display: '<b>x</b> & "y"' })).body.display).toBe('<b>x</b> & "y"');
  });
});
