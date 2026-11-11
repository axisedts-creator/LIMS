// AN-T07 service/labels.service.ts (02-TRD §3 "labels.service.ts", §5.1 InterfacesReport/ReportRunDto, §6 department SQL; PRD US-04.2, US-05.2, US-08.2, US-14.1;
// 03-APP-FLOW X11; 08 A17 D-47/P-17, R12d; 07-SECURITY REQ-SEC-013/081, P1). Integration level: real service + repo over a fixture-backed fake `tx`
// (rows of the four published directory views) and an in-test `ctx.core` with the CoreRepo shapes (tenant-filtered, honours activeOnly like the real repo).
// ASSUMED API (spec fixes the sources, not the signatures; the writer may dispute via the reviewer). All take the request ctx first and return a
// `Map<id, entry>`; an id with no row is ABSENT from the map (the caller shows a short id / omits - US-14.1). Entries expose the inactive FLAG;
// the "(inactive)" suffix is presentation (InterfacesReport carries `label` and `is_active` as separate fields).
//   departmentLabels(ctx)              -> { name, isActive }                              catalog.v_pub_department
//   testLabels(ctx, ids)               -> { code, name, departmentId, isActive }          catalog.v_pub_test_directory
//   referrerLabels(ctx, ids)           -> { displayName, isActive, canonicalId }          catalog.v_pub_referrer_directory
//        SEAM: canonicalId = canonical_referrer_id, or the referrer's own id when that is null (a root is its own canonical).
//   instrumentLabels(ctx, ids)         -> { instrumentCode, label, isActive, centreId }   instruments.v_pub_instrument_directory
//        label = `${display_name} (${instrument_code})` (PRD US-14.1).
//   centreLabels(ctx) / branchLabels(ctx) -> { name, isActive, ... }  via ctx.core.centres/branches(ctx, { activeOnly: false })
//   staffLabels(ctx, membershipIds)    -> { displayName, isActive }  via ctx.core.memberships.list(ctx, { membershipIds, activeOnly: false }) (P-17),
//        ids de-duplicated, chunks of <= 200 (core limit), no core call for [], memoised per request (08 A17 D-47 text for 02-CV §8).
// ctx subset: { tenantId, actor, tx, core: { branches, centres, memberships: { list } } }.
import { describe, expect, it } from 'vitest';
import { LimsError, isLimsError } from '../../../../core/errors.js';
import { branchLabels, centreLabels, departmentLabels, instrumentLabels, referrerLabels, staffLabels, testLabels } from '../labels.service.js';

const TA = '01900000-0000-7000-8000-00000000000a', TB = '01900000-0000-7000-8000-00000000000b';
const u = (n: number) => `0190c407-0000-7000-8000-${String(n).padStart(12, '0')}`;
const D_HAEM = u(1), D_BIO = u(2), D_OLD = u(3), D_B = u(4);
const T_CBC = u(11), T_OLD = u(12), T_B = u(13), T_NONE = u(14);
const R_D1 = u(21), R_D2 = u(22), R_D3 = u(23), R_B = u(24);
const I_A = u(31), I_OFF = u(32), I_B = u(33), I_NONE = u(34);
const BR_A = u(41), BR_OLD = u(42), BR_B = u(43);
const C_A = u(51), C_OLD = u(52), C_B = u(53);
const M_ACTIVE = u(61), M_GONE = u(62), M_B = u(63), M_NONE = u(64);

const VIEWS: Record<string, { idCol: string; rows: Record<string, unknown>[] }> = {
  'catalog.v_pub_department': { idCol: 'department_id', rows: [
    { tenant_id: TA, department_id: D_HAEM, code: 'HAEM', name: 'Haematology', is_active: true },
    { tenant_id: TA, department_id: D_BIO, code: 'BIO', name: 'Biochemistry', is_active: true },
    { tenant_id: TA, department_id: D_OLD, code: 'OLD', name: 'Retired Dept', is_active: false },
    { tenant_id: TB, department_id: D_B, code: 'B', name: 'Other Tenant Dept', is_active: true }] },
  'catalog.v_pub_test_directory': { idCol: 'test_id', rows: [
    { tenant_id: TA, test_id: T_CBC, code: 'CBC', name: 'Complete Blood Count', department_id: D_HAEM, workflow_type: 'x', is_active: true },
    { tenant_id: TA, test_id: T_OLD, code: 'OLDT', name: 'Retired Test', department_id: D_OLD, workflow_type: 'x', is_active: false },
    { tenant_id: TB, test_id: T_B, code: 'BT', name: 'Other Tenant Test', department_id: D_B, workflow_type: 'x', is_active: true }] },
  'catalog.v_pub_referrer_directory': { idCol: 'referrer_id', rows: [
    { tenant_id: TA, referrer_id: R_D1, display_name: 'Dr Test One', is_active: true, canonical_referrer_id: null },
    { tenant_id: TA, referrer_id: R_D2, display_name: 'Dr Test Two', is_active: true, canonical_referrer_id: null },
    { tenant_id: TA, referrer_id: R_D3, display_name: 'Dr Test Three', is_active: false, canonical_referrer_id: R_D1 },
    { tenant_id: TB, referrer_id: R_B, display_name: 'Dr Other Tenant', is_active: true, canonical_referrer_id: null }] },
  'instruments.v_pub_instrument_directory': { idCol: 'instrument_id', rows: [
    { tenant_id: TA, instrument_id: I_A, centre_id: C_A, instrument_code: 'HM-01', display_name: 'Hematology Analyzer', vendor: 'v', model: 'm', state: 'online', is_active: true },
    { tenant_id: TA, instrument_id: I_OFF, centre_id: C_A, instrument_code: 'CH-09', display_name: 'Old Chemistry', vendor: 'v', model: 'm', state: 'retired', is_active: false },
    { tenant_id: TB, instrument_id: I_B, centre_id: C_B, instrument_code: 'XX-01', display_name: 'Other Tenant Analyzer', vendor: 'v', model: 'm', state: 'online', is_active: true }] },
};

const BRANCHES = [
  { tenant: TA, id: BR_A, branchCode: 'BA', name: 'Main Branch', isProcessingLab: true, isActive: true },
  { tenant: TA, id: BR_OLD, branchCode: 'BO', name: 'Closed Branch', isProcessingLab: false, isActive: false },
  { tenant: TB, id: BR_B, branchCode: 'BB', name: 'Other Tenant Branch', isProcessingLab: false, isActive: true }];
const CENTRES = [
  { tenant: TA, id: C_A, branchId: BR_A, centreCode: 'CA', name: 'Test Centre One', centreKind: 'own', isActive: true },
  { tenant: TA, id: C_OLD, branchId: BR_OLD, centreCode: 'CO', name: 'Closed Centre', centreKind: 'franchise', isActive: false },
  { tenant: TB, id: C_B, branchId: BR_B, centreCode: 'CB', name: 'Other Tenant Centre', centreKind: 'own', isActive: true }];
const MEMBERS = [
  { tenant: TA, membershipId: M_ACTIVE, displayName: 'Test Staff Active', roleCodes: ['cashier'], allCentres: false, isActive: true },
  { tenant: TA, membershipId: M_GONE, displayName: 'Test Staff Left', roleCodes: ['cashier'], allCentres: true, isActive: false },
  { tenant: TB, membershipId: M_B, displayName: 'Other Tenant Staff', roleCodes: ['admin'], allCentres: true, isActive: true }];

function world(opts: { dbFail?: unknown; coreFail?: string } = {}) {
  const sql: { text: string; values: unknown[] }[] = [];
  const coreCalls: { fn: string; input: any }[] = [];
  const tx = { async query(text: string, values: unknown[] = []) {
    sql.push({ text, values });
    if (opts.dbFail) throw opts.dbFail;
    const m = /\bFROM\s+((?:catalog|instruments)\.v_pub_\w+)/i.exec(text);
    const view = m && VIEWS[m[1]!.toLowerCase()];
    if (!view) return { rows: [] };
    const ids = values.find(Array.isArray) as unknown[] | undefined;
    return { rows: view.rows.filter((r) => r['tenant_id'] === values[0] && (ids === undefined || ids.includes(r[view.idCol]))).map((r) => ({ ...r })) };
  } };
  const guard = (fn: string, input: any) => { coreCalls.push({ fn, input }); if (opts.coreFail) throw new LimsError(opts.coreFail); };
  const strip = ({ tenant: _t, ...row }: any) => row;
  const core = {
    async branches(ctx: any, input: { activeOnly?: boolean } = {}) {
      guard('branches', input);
      return BRANCHES.filter((b) => b.tenant === ctx.tenantId && (input.activeOnly === false || b.isActive)).map(strip);
    },
    async centres(ctx: any, input: { branchId?: string; activeOnly?: boolean } = {}) {
      guard('centres', input);
      return CENTRES.filter((c) => c.tenant === ctx.tenantId && (input.activeOnly === false || c.isActive) && (!input.branchId || c.branchId === input.branchId)).map(strip);
    },
    memberships: { async list(ctx: any, input: { membershipIds?: string[]; activeOnly?: boolean; limit?: number } = {}) {
      guard('memberships.list', input);
      if (input.membershipIds && input.membershipIds.length > 200) throw new LimsError('common.validation_failed');
      return MEMBERS.filter((m) => m.tenant === ctx.tenantId && (input.activeOnly !== false ? m.isActive : true)
        && (!input.membershipIds || input.membershipIds.includes(m.membershipId))).map(strip);
    } },
  };
  /** A fresh ctx = a fresh request (own tx, own memo). */
  const ctx = (tenantId = TA): any => ({ tenantId, actor: { type: 'user', id: u(900) }, tx, core });
  return { ctx, sql, coreCalls };
}

async function rejection(p: Promise<unknown>): Promise<unknown> { try { await p; } catch (e) { return e; } throw new Error('expected the call to reject, it resolved'); }
const plain = (m: ReadonlyMap<string, unknown>) => Object.fromEntries(m);

// ================================================================ departments
describe('US-04.2 departmentLabels (catalog.v_pub_department)', () => {
  it('maps department_id -> name with the inactive flag; the deactivated department keeps its name', async () => {
    const w = world();
    const m = await departmentLabels(w.ctx());
    expect(m.get(D_HAEM)).toMatchObject({ name: 'Haematology', isActive: true });
    expect(m.get(D_BIO)).toMatchObject({ name: 'Biochemistry', isActive: true });
    expect(m.get(D_OLD)).toMatchObject({ name: 'Retired Dept', isActive: false });
    expect(m.size).toBe(3);
  });
  it('reads only the published view, with the caller tenant bound (the TRD SQL)', async () => {
    const w = world();
    await departmentLabels(w.ctx());
    expect(w.sql).toHaveLength(1);
    expect(w.sql[0]!.text.toLowerCase()).toContain('from catalog.v_pub_department');
    expect(w.sql[0]!.values[0]).toBe(TA);
  });
  it('NULL / unknown department id is simply absent ("Multiple departments" is the caller\'s row, not a label)', async () => {
    const m = await departmentLabels(world().ctx());
    expect(m.has(D_B)).toBe(false);          // tenant B department
    expect(m.has(undefined as never)).toBe(false);
    expect(m.has(null as never)).toBe(false);
  });
  it('07 P1: tenant comes from ctx only - tenant B ctx gets its own rows, never tenant A\'s', async () => {
    const m = await departmentLabels(world().ctx(TB));
    expect([...m.keys()]).toEqual([D_B]);
    expect(JSON.stringify(plain(m))).not.toMatch(/Haematology|Biochemistry|Retired/);
  });
});

// ================================================================ tests
describe('testLabels (catalog.v_pub_test_directory; US-09.2 / pending list labels)', () => {
  it('returns code, name, department and the inactive flag for the requested ids; unknown ids are absent', async () => {
    const w = world();
    const m = await testLabels(w.ctx(), [T_CBC, T_OLD, T_NONE]);
    expect(m.get(T_CBC)).toMatchObject({ code: 'CBC', name: 'Complete Blood Count', departmentId: D_HAEM, isActive: true });
    expect(m.get(T_OLD)).toMatchObject({ code: 'OLDT', name: 'Retired Test', isActive: false });
    expect(m.has(T_NONE)).toBe(false);
    expect(w.sql[0]!.text.toLowerCase()).toContain('from catalog.v_pub_test_directory');
  });
  it('another tenant\'s test id yields no label (07 P1)', async () => {
    expect((await testLabels(world().ctx(), [T_B])).size).toBe(0);
  });
  it('empty id list -> empty map without any query', async () => {
    const w = world();
    expect((await testLabels(w.ctx(), [])).size).toBe(0);
    expect(w.sql).toHaveLength(0);
  });
  it('duplicate ids collapse', async () => {
    const m = await testLabels(world().ctx(), [T_CBC, T_CBC, T_CBC]);
    expect([...m.keys()]).toEqual([T_CBC]);
  });
});

// ================================================================ referrers
describe('US-05.2 / US-08.2 referrerLabels incl. canonical id (catalog.v_pub_referrer_directory, CR-C3-004)', () => {
  it('a merged doctor carries its canonical id; an unmerged one is its own canonical', async () => {
    const m = await referrerLabels(world().ctx(), [R_D1, R_D2, R_D3]);
    expect(m.get(R_D3)).toMatchObject({ displayName: 'Dr Test Three', isActive: false, canonicalId: R_D1 });
    expect(m.get(R_D1)).toMatchObject({ displayName: 'Dr Test One', isActive: true, canonicalId: R_D1 });
    expect(m.get(R_D2)).toMatchObject({ displayName: 'Dr Test Two', canonicalId: R_D2 });
  });
  it('reads catalog.v_pub_referrer_directory only; ids are bound', async () => {
    const w = world();
    await referrerLabels(w.ctx(), [R_D1]);
    expect(w.sql).toHaveLength(1);
    expect(w.sql[0]!.text.toLowerCase()).toContain('from catalog.v_pub_referrer_directory');
    expect(w.sql[0]!.text).not.toContain(R_D1);
    expect(w.sql[0]!.values.some((v) => Array.isArray(v) && v.includes(R_D1))).toBe(true);
  });
  it('another tenant\'s referrer is absent; no "SELF" label is invented here (SELF is the report row for NULL referrer)', async () => {
    const m = await referrerLabels(world().ctx(), [R_B]);
    expect(m.size).toBe(0);
    expect((await referrerLabels(world().ctx(), [R_D1])).has('SELF')).toBe(false);
  });
  it('entries expose only the allowlisted fields (REQ-SEC-081)', async () => {
    const e = (await referrerLabels(world().ctx(), [R_D3])).get(R_D3)!;
    expect(Object.keys(e).sort()).toEqual(['canonicalId', 'displayName', 'isActive']);
  });
});

// ================================================================ instruments
describe('US-14.1 instrumentLabels (instruments.v_pub_instrument_directory, 08 R12d)', () => {
  it('label is "display_name (instrument_code)"; carries centre and active flag', async () => {
    const w = world();
    const m = await instrumentLabels(w.ctx(), [I_A, I_OFF]);
    expect(m.get(I_A)).toMatchObject({ label: 'Hematology Analyzer (HM-01)', instrumentCode: 'HM-01', isActive: true, centreId: C_A });
    expect(w.sql[0]!.text.toLowerCase()).toContain('from instruments.v_pub_instrument_directory');
  });
  it('an inactive instrument keeps its label and is flagged inactive', async () => {
    const e = (await instrumentLabels(world().ctx(), [I_OFF])).get(I_OFF)!;
    expect(e.isActive).toBe(false);
    expect(e.label).toContain('Old Chemistry (CH-09)');
  });
  it('an instrument with no directory row is ABSENT (caller falls back to the short id; label/code/is_active omitted)', async () => {
    const m = await instrumentLabels(world().ctx(), [I_NONE, I_A]);
    expect(m.has(I_NONE)).toBe(false);
    expect(m.has(I_A)).toBe(true);
  });
  it('another tenant\'s instrument id yields no label (07 P1)', async () => {
    expect((await instrumentLabels(world().ctx(), [I_B])).size).toBe(0);
  });
  it('only published-view columns reach the entry (vendor / model / state are not exposed)', async () => {
    const e = (await instrumentLabels(world().ctx(), [I_A])).get(I_A)!;
    expect(Object.keys(e).sort()).toEqual(['centreId', 'instrumentCode', 'isActive', 'label']);
  });
});

// ================================================================ centres / branches (ctx.core)
describe('centreLabels / branchLabels via ctx.core (X11: deactivated still resolved)', () => {
  it('centres: asks ctx.core.centres with activeOnly:false; the closed centre keeps its name and is flagged inactive', async () => {
    const w = world();
    const m = await centreLabels(w.ctx());
    expect(m.get(C_A)).toMatchObject({ name: 'Test Centre One', isActive: true, branchId: BR_A });
    expect(m.get(C_OLD)).toMatchObject({ name: 'Closed Centre', isActive: false });
    expect(w.coreCalls.find((c) => c.fn === 'centres')!.input).toMatchObject({ activeOnly: false });
    expect(w.sql).toHaveLength(0);                       // never a direct core.* read
  });
  it('branches: same - activeOnly:false, inactive branch labelled', async () => {
    const w = world();
    const m = await branchLabels(w.ctx());
    expect(m.get(BR_A)).toMatchObject({ name: 'Main Branch', isActive: true });
    expect(m.get(BR_OLD)).toMatchObject({ name: 'Closed Branch', isActive: false });
    expect(w.coreCalls.find((c) => c.fn === 'branches')!.input).toMatchObject({ activeOnly: false });
    expect(w.sql).toHaveLength(0);
  });
  it('tenant-bound by ctx: tenant B never sees tenant A centres/branches', async () => {
    const w = world();
    expect([...(await centreLabels(w.ctx(TB))).keys()]).toEqual([C_B]);
    expect([...(await branchLabels(w.ctx(TB))).keys()]).toEqual([BR_B]);
  });
});

// ================================================================ staff (P-17)
describe('US-08.2 staffLabels via ctx.core.memberships.list({ membershipIds, activeOnly:false }) (P-17)', () => {
  it('names come from core; an inactive membership keeps its name with isActive=false', async () => {
    const w = world();
    const m = await staffLabels(w.ctx(), [M_ACTIVE, M_GONE]);
    expect(m.get(M_ACTIVE)).toMatchObject({ displayName: 'Test Staff Active', isActive: true });
    expect(m.get(M_GONE)).toMatchObject({ displayName: 'Test Staff Left', isActive: false });
    expect(w.coreCalls).toHaveLength(1);
    expect(w.coreCalls[0]!.fn).toBe('memberships.list');
    expect(w.coreCalls[0]!.input).toMatchObject({ membershipIds: expect.arrayContaining([M_ACTIVE, M_GONE]), activeOnly: false });
    expect(w.sql).toHaveLength(0);                       // "Modules never read core.memberships directly"
  });
  it('unknown and other-tenant ids are omitted - no oracle, no foreign name', async () => {
    const m = await staffLabels(world().ctx(), [M_ACTIVE, M_NONE, M_B]);
    expect([...m.keys()]).toEqual([M_ACTIVE]);
  });
  it('allowlist: roleCodes / allCentres from the core row never reach the label (REQ-SEC-081)', async () => {
    const e = (await staffLabels(world().ctx(), [M_ACTIVE])).get(M_ACTIVE)!;
    expect(Object.keys(e).sort()).toEqual(['displayName', 'isActive']);
  });
  it('no ids -> empty map and NO core call', async () => {
    const w = world();
    expect((await staffLabels(w.ctx(), [])).size).toBe(0);
    expect(w.coreCalls).toHaveLength(0);
  });
  it('duplicate ids are sent once', async () => {
    const w = world();
    await staffLabels(w.ctx(), [M_ACTIVE, M_ACTIVE, M_ACTIVE]);
    expect(w.coreCalls[0]!.input.membershipIds).toEqual([M_ACTIVE]);
  });
  it('more than 200 distinct ids are split into calls of <= 200 and merged (core rejects > 200)', async () => {
    const w = world();
    const many = Array.from({ length: 450 }, (_, i) => u(10_000 + i));
    const m = await staffLabels(w.ctx(), [M_ACTIVE, ...many, M_GONE]);
    expect(w.coreCalls.length).toBeGreaterThanOrEqual(3);
    for (const c of w.coreCalls) expect(c.input.membershipIds.length).toBeLessThanOrEqual(200);
    expect(w.coreCalls.flatMap((c) => c.input.membershipIds)).toHaveLength(452);
    expect([...m.keys()].sort()).toEqual([M_ACTIVE, M_GONE].sort());
  });
  it('memoised per request: the same ids twice on one ctx hit core once; a new ctx (new request) asks again', async () => {
    const w = world();
    const ctx = w.ctx();
    await staffLabels(ctx, [M_ACTIVE]);
    await staffLabels(ctx, [M_ACTIVE]);
    expect(w.coreCalls).toHaveLength(1);
    await staffLabels(w.ctx(), [M_ACTIVE]);
    expect(w.coreCalls).toHaveLength(2);
  });
  it('tenant B ctx cannot resolve tenant A staff', async () => {
    expect((await staffLabels(world().ctx(TB), [M_ACTIVE, M_GONE])).size).toBe(0);
  });
});

// ================================================================ failure handling
describe('dependency failure is surfaced, never hidden behind blank labels', () => {
  it('a core error (LimsError) passes through unchanged', async () => {
    const e = await rejection(staffLabels(world({ coreFail: 'auth.forbidden' }).ctx(), [M_ACTIVE]));
    expect(isLimsError(e, 'auth.forbidden')).toBe(true);
    expect(isLimsError(await rejection(centreLabels(world({ coreFail: 'common.internal' }).ctx())), 'common.internal')).toBe(true);
    expect(isLimsError(await rejection(branchLabels(world({ coreFail: 'common.internal' }).ctx())), 'common.internal')).toBe(true);
  });
  it('a database error propagates from every view-backed lookup', async () => {
    const boom = Object.assign(new Error('connection terminated'), { code: '08006' });
    const w = () => world({ dbFail: boom }).ctx();
    await expect(departmentLabels(w())).rejects.toBe(boom);
    await expect(testLabels(w(), [T_CBC])).rejects.toBe(boom);
    await expect(referrerLabels(w(), [R_D1])).rejects.toBe(boom);
    await expect(instrumentLabels(w(), [I_A])).rejects.toBe(boom);
  });
  it('a failing lookup is not cached as an empty result for the request', async () => {
    const w = world({ coreFail: 'common.internal' });
    const ctx = w.ctx();
    await rejection(staffLabels(ctx, [M_ACTIVE]));
    await rejection(staffLabels(ctx, [M_ACTIVE]));
    expect(w.coreCalls).toHaveLength(2);
  });
});
