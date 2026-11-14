// T-10 (C3) — #51 previewReferenceRange (POST /v1/catalog/reference-ranges/preview): read-only E3 POST, permission catalog.test.read, no Idempotency-Key, no If-Match.
// Spec: 06-PLAN T-10 ("returns match/none", integration, AC-05.*), 02-TRD §5.2 row 51 + §7.3 (steps 1–7, 08 A17.1), PRD AC-05.1–AC-05.11, 07-SECURITY S-4 / S-5 / REQ-SEC-080 (strict bodies),
//       CR-C3-008 (previewReferenceRange leaves probes/pending.json), contracts/openapi/catalog.yaml (ReferenceRangePreviewRequest / ReferenceRangePreview).
// Driven through handlers.previewReferenceRange with a request-shaped object and the same HandlerContext subset the services get (conventions of ranges.handlers.test.ts); responses are validated against the OpenAPI schema.
// Mapping the handler must apply: domain resolveReferenceRange / resolveCriticalLimits camelCase -> snake_case DTO (referenceRangeId -> reference_range_id, unitCode -> unit_code, normalCodes, criticalLimitId, abnormalCodes).
// ASSUMPTIONS (spec silent; see .orchestra/notes/C3.T-10-tests.md): handler validates its own body (defence in depth, like the T-08 service); `age_days` absent -> age unknown (TRD §7.3 step 3) although the
// OpenAPI request requires it; unknown specimen_type_code -> 404 common.not_found OR the unspecific band (never a specimen-specific band); `at` defaults to ctx.now().
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isLimsError } from '../../../../core/errors.js';
import { REPO_ROOT, loadSpec } from '../../../../core/module.js';
import { handlers } from '../../handlers/index.js';
import { manifest } from '../../index.js';
import { makeIdentity } from '../helpers/identity.js';
import { errPaths, lims, rejection } from '../helpers/t6.js';
import { HB, HB_B, ID, K, M1, M2, MENTZER, NIT, NOW, T, T0, T1, TENANT_A, URINE, cband, cset, draftSet, ownerRev, rband, rset, setup8, type Env8, type Row } from '../helpers/t8.js';

const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/catalog.yaml'));
const requireAjv = createRequire(createRequire(import.meta.url).resolve('@fastify/ajv-compiler'));
const Ajv2020 = requireAjv('ajv/dist/2020.js').default as new (o: object) => any;
const ajv = new Ajv2020({ strict: false, allErrors: true });
const validatorFor = (name: string) => {
  const v = ajv.compile({ $ref: `#/components/schemas/${name}`, components: spec.components });
  return (x: unknown) => { const ok = v(x); return ok ? [] : (v.errors as any[]).map((e) => `${e.instancePath} ${e.message}`); };
};
const opOf = (id: string): any => { for (const p of Object.values<any>(spec.paths)) for (const m of Object.values<any>(p)) if (m?.operationId === id) return m; };

const OP = 'previewReferenceRange', READ = 'catalog.test.read', PUBLISH = 'catalog.reference_range.publish', MANAGE = 'catalog.test.manage';
const H = handlers as Record<string, (req: any, ctx: any) => Promise<{ status: number; body?: any }>>;
const req = (body?: unknown, o: { headers?: object } = {}) => ({ params: {}, query: {}, headers: {}, body, ...o });
const valid = (o: Record<string, unknown> = {}) => ({ analyte_id: HB.id, sex: 'male', age_days: 9000, ...o });

/** Runs the handler in one tx with an IdentityPort holding `grants` at `aal` (default: read only, aal1 — the preview needs nothing privileged). */
const call = (e: Env8, body: unknown, grants: readonly string[] = [READ], aal: 1 | 2 = 1) => {
  const identity = makeIdentity(grants, aal);
  return { identity, done: e.db.run((ctx) => H[OP]!(req(body), { ...ctx, ports: { IdentityPort: identity } })) };
};
const preview = async (e: Env8, body: unknown) => { const r = await call(e, body).done; expect(r.status).toBe(200); expect(validatorFor('ReferenceRangePreview')(r.body)).toEqual([]); return r.body; };

// ---- fixtures: HB (unit g_dl, method M1) --------------------------------------------------------------------------------------------------------------------------------------------------------
const Y = (n: number) => ({ age_low_value: n, age_low_unit: 'year' }), YH = (n: number) => ({ age_high_value: n, age_high_unit: 'year' });
const R = (n: number, o: Row = {}) => rset(n, TENANT_A, HB.id, { method_id: M1.id, ...o });
const C = (n: number, o: Row = {}) => cset(n, TENANT_A, HB.id, { method_id: M1.id, ...o });
const R1 = R(1), C1 = C(1);
const B_M = rband(1, TENANT_A, R1.id as string, { sex: 'male', ...Y(18), low: '13.0', high: '17.0', sort_order: 0 });          // AC-05.1 (SYNTHETIC values)
const B_F = rband(2, TENANT_A, R1.id as string, { sex: 'female', ...Y(18), low: '12.0', high: '15.0', sort_order: 1 });
const B_C = rband(3, TENANT_A, R1.id as string, { sex: 'any', ...YH(18), low: '11.0', high: '16.0', sort_order: 2 });
const CB = cband(1, TENANT_A, C1.id as string, { sex: 'any', low: '7.0', high: '20.0' });
const MAIN = { reference_range_sets: [R1], reference_ranges: [B_M, B_F, B_C], critical_limit_sets: [C1], critical_limits: [CB] };
const worldOf = (t6: Record<string, Row[]>) => setup8({ t6: t6 as never });
const main = () => worldOf(MAIN);

const BAND_M = { reference_range_id: B_M.id, version: 1, low: '13.0', high: '17.0', text: '13.0 - 17.0', unit_code: 'g_dl', kind: 'numeric' };

describe('contract and wiring (CR-C3-008, S-4, S-5)', () => {
  it('#51 is a read-only POST: catalog.test.read, no idempotency, no If-Match / Idempotency-Key parameter, strict request body without server-owned fields', () => {
    const op = opOf(OP);
    expect(op['x-permission']).toBe(READ); expect(op['x-idempotency']).toBe('none');
    expect(JSON.stringify(op.parameters ?? [])).not.toMatch(/IfMatch|IdempotencyKey/);
    const s = spec.components.schemas['ReferenceRangePreviewRequest'];
    expect(s.additionalProperties).toBe(false);
    expect(s.required).toEqual(expect.arrayContaining(['analyte_id', 'sex', 'age_days']));
    for (const k of ['id', 'tenant_id', 'set_id', 'status', 'version', 'revision', 'created_by', 'unit_code', 'method_id']) expect(Object.keys(s.properties), k).not.toContain(k);
  });

  it('previewReferenceRange left probes/pending.json and is wired to a real handler (not the 503 stub)', { timeout: T }, async () => {
    const pending: string[] = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'probes', 'pending.json'), 'utf8'));
    expect(pending).not.toContain(OP);
    expect((manifest.handlers as any)[OP]).toBe(H[OP]);
    const x = await call(main(), valid()).done.then(() => undefined, (r) => r);
    expect(x?.code).not.toBe('common.service_unavailable'); expect(x?.detail).not.toBe('not_implemented');
  });

  it('a context without tenantId / actor / tx / events fails closed with auth.unauthenticated', { timeout: T }, async () => {
    const x = await rejection(H[OP]!(req(valid()), { ports: { IdentityPort: makeIdentity([READ]) } }));
    expect(isLimsError(x, 'auth.unauthenticated')).toBe(true);
  });
});

describe('AC-05.1 / match shape: 200 {reference_range, critical_limits, no_reference_range:false} exactly the contract schema', () => {
  it('male, 9000 days -> the male adult band (13.0–17.0, version 1, unit g_dl) and the critical limits; DTO is snake_case and carries no internal columns', { timeout: T }, async () => {
    const b = await preview(main(), valid());
    expect(b.no_reference_range).toBe(false);
    expect(b.reference_range).toEqual(BAND_M);
    expect(b.critical_limits).toEqual({ critical_limit_id: CB.id, version: 1, low: '7.0', high: '20.0' });
  });

  it('scale of low / high is preserved as stored text ("13.0" not "13")', { timeout: T }, async () => {
    const b = await preview(main(), valid());
    expect(typeof b.reference_range.low).toBe('string'); expect(b.reference_range.low).toBe('13.0');
  });

  it('no match -> 200 {no_reference_range:true} with neither reference_range nor critical_limits keys (not 404)', { timeout: T }, async () => {
    const b = await preview(worldOf({}), valid());
    expect(b).toEqual({ no_reference_range: true });
  });
});

describe('AC-05.2 boundaries: lower inclusive, upper exclusive; birth_on supersedes the day-count approximation', () => {
  it('age_days 6575 (18.0013 y) -> adult band, 6574 (17.9986 y) -> the 0 d–18 y band (male)', { timeout: T }, async () => {
    const adult = await preview(main(), valid({ age_days: 6575 })); expect(adult.reference_range.reference_range_id).toBe(B_M.id);
    const child = await preview(main(), valid({ age_days: 6574 })); expect(child.reference_range.reference_range_id).toBe(B_C.id);
  });

  it('age 0 days -> the 0 d band (inclusive lower bound)', { timeout: T }, async () => {
    const b = await preview(main(), valid({ sex: 'female', age_days: 0 }));
    expect(b.reference_range).toMatchObject({ reference_range_id: B_C.id, low: '11.0', high: '16.0' });
  });

  it('birth_on (Asia/Kathmandu calendar date of `at`): exactly 18 completed years -> adult although age_days says 6570; one day short -> child although age_days says 6575', { timeout: T }, async () => {
    const at = '2026-11-07T12:00:00.000Z';
    const adult = await preview(main(), valid({ age_days: 6570, birth_on: '2008-11-07', at })); expect(adult.reference_range.reference_range_id).toBe(B_M.id);
    const child = await preview(main(), valid({ age_days: 6575, birth_on: '2008-11-08', at })); expect(child.reference_range.reference_range_id).toBe(B_C.id);
  });
});

describe('AC-05.3 specificity: specimen match (2) beats sex match (1); a query without a specimen matches only bands without one', () => {
  const RS = R(1);
  const sb = (n: number, o: Row) => rband(n, TENANT_A, RS.id as string, { low: '10.0', high: '20.0', ...o });
  const A = sb(1, { sex: 'any', sort_order: 0 }), F = sb(2, { sex: 'female', low: '12.0', high: '15.0', sort_order: 1 });
  const U = sb(3, { sex: 'any', specimen_type_id: URINE.id, low: '8.0', high: '9.0', sort_order: 2 }), UF = sb(4, { sex: 'female', specimen_type_id: URINE.id, low: '6.0', high: '7.0', sort_order: 3 });
  const world = () => worldOf({ reference_range_sets: [RS], reference_ranges: [A, F, U, UF] });
  const pick = async (o: Record<string, unknown>) => (await preview(world(), valid({ age_days: 9000, ...o }))).reference_range.reference_range_id;

  it.each([
    ['female, no specimen -> the female band over the any band', { sex: 'female' }, F],
    ['male, no specimen -> the any band', { sex: 'male' }, A],
    ['female + URINE -> the female URINE band', { sex: 'female', specimen_type_code: 'URINE' }, UF],
    ['male + URINE -> the specimen-specific any band over the unspecific any band', { sex: 'male', specimen_type_code: 'URINE' }, U],
    ['female + SERUM (no SERUM band) -> the unspecific female band', { sex: 'female', specimen_type_code: 'SERUM' }, F],
  ] as const)('%s', { timeout: T }, async (_n, o, band) => { expect(await pick(o)).toBe(band.id); });

  it('an unknown (well-formed) specimen_type_code never yields a specimen-specific band: 404 common.not_found or the unspecific band', { timeout: T }, async () => {
    const r = await call(world(), valid({ sex: 'female', specimen_type_code: 'NOPE_X' })).done.then((x) => x, (x) => x);
    if (r?.status === 200) expect(r.body.reference_range.reference_range_id).toBe(F.id);
    else lims(r, 'common.not_found', 404);
  });
});

describe('AC-05.4: sex other / unknown matches only `any` bands', () => {
  it('other, adult -> no sex-specific band (no_reference_range:true) while the critical limits (any) still answer', { timeout: T }, async () => {
    const b = await preview(main(), valid({ sex: 'other' }));
    expect(b.no_reference_range).toBe(true); expect(b).not.toHaveProperty('reference_range');
    expect(b.critical_limits).toMatchObject({ critical_limit_id: CB.id });
  });

  it('unknown, child -> the any band', { timeout: T }, async () => {
    const b = await preview(main(), valid({ sex: 'unknown', age_days: 3000 }));
    expect(b.reference_range.reference_range_id).toBe(B_C.id);
  });
});

describe('AC-05.5 / AC-05.6: text and ordinal bands carry display text only', () => {
  const NIT_SET = rset(3, TENANT_A, NIT.id, { unit_code: null, method_id: null }), MZ_SET = rset(2, TENANT_A, MENTZER.id, { unit_code: null, method_id: null });
  const TXT = '<13.0 - Thalassemia trait / >13.0 - Iron deficiency';
  const MZ = rband(10, TENANT_A, MZ_SET.id as string, { sex: 'any', kind: 'text', display_text: TXT });
  const NB = rband(11, TENANT_A, NIT_SET.id as string, { sex: 'any', kind: 'ordinal', normal_codes: ['NEG'], display_text: 'Negative' });
  const NC_SET = cset(2, TENANT_A, NIT.id, { unit_code: null, method_id: null }), NC = cband(11, TENANT_A, NC_SET.id as string, { sex: 'any', abnormal_codes: ['POS_1'] });
  const world = () => worldOf({ reference_range_sets: [NIT_SET, MZ_SET], reference_ranges: [MZ, NB], critical_limit_sets: [NC_SET], critical_limits: [NC] });

  it('MENTZER text band -> kind text, the display text, no low / high / unit_code', { timeout: T }, async () => {
    const b = await preview(world(), valid({ analyte_id: MENTZER.id, sex: 'female' }));
    expect(b.reference_range).toEqual({ reference_range_id: MZ.id, version: 1, kind: 'text', text: TXT });
  });

  it('urine nitrite ordinal band -> text "Negative", normal_codes ["NEG"], kind ordinal; critical limits carry abnormal_codes only', { timeout: T }, async () => {
    const b = await preview(world(), valid({ analyte_id: NIT.id, sex: 'male', age_days: 12000 }));
    expect(b.reference_range).toEqual({ reference_range_id: NB.id, version: 1, kind: 'ordinal', text: 'Negative', normal_codes: ['NEG'] });
    expect(b.critical_limits).toEqual({ critical_limit_id: NC.id, version: 1, abnormal_codes: ['POS_1'] });
  });
});

describe('AC-05.8: effective-dated sets; draft sets never answer; the preview never changes a band', () => {
  const V1 = R(1, { status: 'superseded', effective_from: new Date(T0), effective_to: new Date('2026-06-01T00:00:00.000Z') });
  const V2 = R(2, { version_no: 2, status: 'published', effective_from: new Date('2026-06-01T00:00:00.000Z'), effective_to: null });
  const V3 = draftSet(rset, 3, HB.id, { version_no: 3, method_id: M1.id });
  const any = (n: number, setId: unknown, low: string, high: string) => rband(n, TENANT_A, setId as string, { sex: 'any', low, high });
  const world = () => worldOf({ reference_range_sets: [V1, V2, V3], reference_ranges: [any(1, V1.id, '13.0', '17.0'), any(2, V2.id, '14.0', '18.0'), any(3, V3.id, '1.0', '2.0')] });
  const at = async (iso?: string) => (await preview(world(), valid({ ...(iso ? { at: iso } : {}) })));

  it.each([
    ['2026-03-01T00:00:00.000Z', 1, '13.0'], ['2026-05-31T23:59:59.999Z', 1, '13.0'], ['2026-06-01T00:00:00.000Z', 2, '14.0'], ['2026-07-01T00:00:00.000Z', 2, '14.0'],
  ] as const)('at %s -> set version %i (low %s)', { timeout: T }, async (iso, version, low) => {
    const b = await at(iso); expect(b.reference_range).toMatchObject({ version, low });
  });

  it('before the first set (and before the analyte version) -> no_reference_range; `at` omitted -> ctx.now() (the v2 set); the draft is never returned', { timeout: T }, async () => {
    expect((await at('2025-12-31T23:59:59.999Z')).no_reference_range).toBe(true);
    const now = await at(); expect(NOW).toBe('2026-11-07T12:00:00.000Z'); expect(now.reference_range).toMatchObject({ version: 2, low: '14.0' });
    for (const iso of ['2026-03-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z', undefined]) expect((await at(iso)).reference_range.low).not.toBe('1.0');
  });

  it('a set whose effective_from is still in the future does not answer at ctx.now(), and does at a later `at`; a retired set answers only inside its window', { timeout: T }, async () => {
    const F = R(1, { effective_from: new Date(T1) });
    const w = () => worldOf({ reference_range_sets: [F], reference_ranges: [rband(1, TENANT_A, F.id as string, { sex: 'any', low: '5.0', high: '6.0' })] });
    expect((await preview(w(), valid())).no_reference_range).toBe(true);
    expect((await preview(w(), valid({ at: '2026-12-02T00:00:00.000Z' }))).reference_range).toMatchObject({ low: '5.0' });
    const RT = R(1, { status: 'retired', effective_to: new Date('2026-09-01T00:00:00.000Z') });
    const wr = () => worldOf({ reference_range_sets: [RT], reference_ranges: [rband(1, TENANT_A, RT.id as string, { sex: 'any', low: '5.0', high: '6.0' })] });
    expect((await preview(wr(), valid({ at: '2026-03-01T00:00:00.000Z' }))).reference_range).toMatchObject({ low: '5.0' });
    expect((await preview(wr(), valid({ at: '2026-10-01T00:00:00.000Z' }))).no_reference_range).toBe(true);
  });
});

describe('AC-05.10: no published set, or a unit / method snapshot that differs from the analyte version effective at `at` -> no_reference_range (200)', () => {
  const one = (set: Row, crit?: Row) => worldOf({ reference_range_sets: [set], reference_ranges: [rband(1, TENANT_A, set.id as string, { sex: 'any', low: '13.0', high: '17.0' })],
    ...(crit ? { critical_limit_sets: [crit], critical_limits: [cband(1, TENANT_A, crit.id as string, { sex: 'any', low: '7.0', high: '20.0' })] } : {}) });

  it('matching snapshot -> match (control)', { timeout: T }, async () => { expect((await preview(one(R(1)), valid())).reference_range).toMatchObject({ low: '13.0' }); });

  it.each([['unit differs', { unit_code: 'mmol_l' }], ['method differs', { method_id: M2.id }], ['set has no method, analyte version has M1 (null != M1)', { method_id: null }]] as const)('%s -> none', { timeout: T }, async (_n, o) => {
    expect(await preview(one(R(1, o)), valid())).toEqual({ no_reference_range: true });
  });

  it('only a draft set exists -> none', { timeout: T }, async () => {
    const D = draftSet(rset, 1, HB.id, { version_no: 1, method_id: M1.id });
    expect(await preview(one(D), valid())).toEqual({ no_reference_range: true });
  });

  it('the critical set is judged on its own snapshot: a mismatching critical set is simply absent while the reference range still answers', { timeout: T }, async () => {
    const b = await preview(one(R(1), C(1, { unit_code: 'mmol_l' })), valid());
    expect(b.no_reference_range).toBe(false); expect(b.reference_range).toMatchObject({ low: '13.0' }); expect(b).not.toHaveProperty('critical_limits');
  });

  it('null = null: an analyte version without unit / method matches a set without unit / method', { timeout: T }, async () => {
    const KS = rset(4, TENANT_A, K.id, { unit_code: 'mmol_l', method_id: null });
    const b = await preview(worldOf({ reference_range_sets: [KS], reference_ranges: [rband(1, TENANT_A, KS.id as string, { sex: 'any', low: '3.5', high: '5.1' })] }), valid({ analyte_id: K.id }));
    expect(b.reference_range).toMatchObject({ low: '3.5', unit_code: 'mmol_l' });
  });
});

describe('AC-05.11 / 08 A17.1: age unknown (age_days absent) matches only bands with no age bound; birth_on is then ignored', () => {
  const B_U = rband(4, TENANT_A, R1.id as string, { sex: 'any', low: '11.0', high: '17.0', sort_order: 3 });
  const noAge = (o: Record<string, unknown> = {}) => { const { age_days: _a, ...rest } = valid(o); return rest; };

  it('with an age-unrestricted band -> that band (even for a male whose age-bound bands are skipped); with birth_on -> the same', { timeout: T }, async () => {
    const w = () => worldOf({ ...MAIN, reference_ranges: [B_M, B_F, B_C, B_U] });
    expect((await preview(w(), noAge())).reference_range).toMatchObject({ reference_range_id: B_U.id, low: '11.0', high: '17.0' });
    expect((await preview(w(), noAge({ birth_on: '1990-01-15' }))).reference_range.reference_range_id).toBe(B_U.id);
  });

  it('the AC-05.1 set alone (every band has an age bound, even the open-ended 18 y–∞) -> no_reference_range', { timeout: T }, async () => {
    expect((await preview(main(), noAge())).no_reference_range).toBe(true);
    expect((await preview(main(), noAge({ birth_on: '1990-01-15' }))).no_reference_range).toBe(true);
  });
});

describe('input validation (REQ-SEC-080, S-5, injection): 400 common.validation_failed with the field path, before any data access', () => {
  const bad: ReadonlyArray<readonly [string, unknown, string?]> = [
    ['sex outside the enum', valid({ sex: 'M' }), '/sex'], ['sex missing', valid({ sex: undefined }), '/sex'], ['analyte_id not a uuid', valid({ analyte_id: 'not-a-uuid' }), '/analyte_id'],
    ["analyte_id SQL payload", valid({ analyte_id: "x' OR 1=1--" }), '/analyte_id'], ['analyte_id missing', valid({ analyte_id: undefined }), '/analyte_id'],
    ['age_days -1', valid({ age_days: -1 }), '/age_days'], ['age_days 73001', valid({ age_days: 73_001 }), '/age_days'], ['age_days 1.5', valid({ age_days: 1.5 }), '/age_days'],
    ['age_days as string', valid({ age_days: '9000' }), '/age_days'], ['birth_on impossible date', valid({ birth_on: '2026-13-45' }), '/birth_on'], ['birth_on wrong format', valid({ birth_on: '15/01/1990' }), '/birth_on'],
    ['specimen_type_code lower case', valid({ specimen_type_code: 'urine' }), '/specimen_type_code'], ['specimen_type_code SQL payload', valid({ specimen_type_code: "URINE' OR '1'='1" }), '/specimen_type_code'],
    ['specimen_type_code empty', valid({ specimen_type_code: '' }), '/specimen_type_code'], ['specimen_type_code 33 chars', valid({ specimen_type_code: 'A'.repeat(33) }), '/specimen_type_code'],
    ['at a date only', valid({ at: '2026-11-05' }), '/at'], ['at with an offset instead of Z', valid({ at: '2026-11-05T04:15:00+05:45' }), '/at'],
    ['mass assignment tenant_id', valid({ tenant_id: ID(0xb) }), undefined], ['mass assignment set_id', valid({ set_id: ID(1) }), undefined], ['mass assignment unit_code', valid({ unit_code: 'g_dl' }), undefined],
    ['body missing', undefined, undefined], ['body null', null, undefined], ['body an array', [valid()], undefined],
  ];
  it.each(bad)('%s', { timeout: T }, async (_n, body, path) => {
    const e = main(); const before = e.db.t6Stmts().length;
    const x = await rejection(call(e, body).done);
    lims(x, 'common.validation_failed', 400);
    if (path) expect(errPaths(x)).toContain(path);
    expect(e.db.t6Stmts()).toHaveLength(before); expect(e.db.events).toHaveLength(0);
  });
});

describe('tenant isolation and information hiding (S-4)', () => {
  it('another tenant\'s analyte and an unknown analyte answer the same 404 common.not_found; nothing of tenant B leaks', { timeout: T }, async () => {
    const e = main();
    const b = await rejection(call(e, valid({ analyte_id: HB_B.id })).done); const u = await rejection(call(e, valid({ analyte_id: ID(0xdead) })).done);
    lims(b, 'common.not_found', 404); lims(u, 'common.not_found', 404);
    expect(b.code).toBe(u.code); expect(b.statusCode).toBe(u.statusCode);
    expect(JSON.stringify([b.message, b.detail, b.errors])).not.toContain(HB_B.id as string);
  });
});

describe('read-only, least privilege, repeatable', () => {
  const tables = ['reference_range_sets', 'reference_ranges', 'critical_limit_sets', 'critical_limits', 'analyte_versions', 'orderables'] as const;
  const snap = (e: Env8) => JSON.stringify([tables.map((t) => e.db.rows(t)), e.db.events.length]);

  it('writes nothing: no INSERT / UPDATE / DELETE statement, no event, no revision bump, rows unchanged', { timeout: T }, async () => {
    const e = main(); const before = snap(e); const rev = ownerRev(e.db);
    await preview(e, valid()); await preview(e, valid({ sex: 'other' })); await preview(worldOf({}), valid());
    expect(e.db.t6Stmts().filter((s) => /^\s*(insert|update|delete)\b/i.test(s.text))).toHaveLength(0);
    expect(snap(e)).toBe(before); expect(ownerRev(e.db)).toBe(rev); expect(e.db.events).toHaveLength(0);
  });

  it('needs only catalog.test.read: works at aal1 without catalog.test.manage / catalog.reference_range.publish, and never asks for the privileged permission', { timeout: T }, async () => {
    const { identity, done } = call(main(), valid(), [READ], 1);
    expect((await done).status).toBe(200);
    expect(identity.calls.map((c) => c.permission)).not.toContain(PUBLISH); expect(identity.calls.map((c) => c.permission)).not.toContain(MANAGE);
  });

  it('works when the context carries no IdentityPort (the x-permission floor is the core pipeline\'s)', { timeout: T }, async () => {
    const e = main(); const r = await e.db.run((ctx) => H[OP]!(req(valid()), ctx));
    expect(r.status).toBe(200); expect(r.body.reference_range).toEqual(BAND_M);
  });

  it('user input only reaches the SQL as parameters: no statement text contains the analyte id or the specimen code', { timeout: T }, async () => {
    const e = main(); await preview(e, valid({ specimen_type_code: 'URINE' }));
    for (const s of e.db.t6Stmts()) { expect(s.text).not.toContain(HB.id as string); expect(s.text).not.toContain('URINE'); }
  });

  it('deterministic and safe under concurrency: 20 simultaneous previews return the identical body', { timeout: T }, async () => {
    const e = main();
    const out = await Promise.all(Array.from({ length: 20 }, () => call(e, valid(), [READ], 1).done));
    for (const r of out) { expect(r.status).toBe(200); expect(r.body).toEqual(out[0]!.body); }
    expect(out[0]!.body.reference_range).toEqual(BAND_M);
  });
});
