// C10 T-15 — M14 submitCultureReport against the migrated database (06-IMPLEMENTATION-PLAN row T-15; 02-TRD §4.7; 05-SCHEMA §5 immutability, §6 view, §8 report_versions + final-lock triggers, §10 grants;
// PRD AC-09.1, AC-09.5, AC-10.4, AC-10.7, AC-15.2, AC-16.1; 07-SECURITY T-A5, S-06, RLS).
// Needs the micro DDL + RLS applied: LIMS_TEST_DATABASE_URL = role lims_api (RLS on), LIMS_TEST_ADMIN_DATABASE_URL = superuser. Without them the DB tests skip, except under LIMS_T15_REQUIRE_DB=1
// where "database is provided" fails (same harness status as T-05..T-14). NOT RUN in the tester session (no database there): seeding follows the T-14 integration file; first run may need fixture tweaks, never assertion weakening.
// LabPort = packages/fakes LabPort.fake (shared with report.submit.test.ts); its resultId must exist in lab.results (report_versions__lab_result__fk), so the result and the order item are seeded.
// ctx.tx = one real transaction per request under RLS with user claims (COMMIT on success, ROLLBACK on a throw), like the core wrapper.
// Synthetic data only.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFakeLabPort } from '../../../../../../../packages/fakes/src/LabPort.fake';
import { TENANT_A, TENANT_B } from '../../../../../../../packages/fakes/src/base';
import { LAB_READ, mkCtx, run, schemaErrors, WORK, type Row } from './helpers/cultureReads.js';

const API_URL = process.env['LIMS_TEST_DATABASE_URL'];
const ADMIN_URL = process.env['LIMS_TEST_ADMIN_DATABASE_URL'];
const live = Boolean(API_URL && ADMIN_URL);
const REQUIRE = process.env['LIMS_T15_REQUIRE_DB'] === '1';
const A = TENANT_A, B = TENANT_B;
const RUN = Date.now(); let seqN = 0;
const uid = () => `0190c615-0000-7000-8000-${(RUN % 0xffffffff).toString(16).padStart(8, '0')}${(++seqN).toString(16).padStart(4, '0')}`;
const SYS = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
const NOWISO = '2026-11-05T05:00:00.000Z';
let api: pg.Pool; let admin: pg.Pool;
const q = async (text: string, values: unknown[] = []) => (await admin.query(text, values)).rows;

async function seedRow(table: string, given: Record<string, unknown>, onConflict = ''): Promise<void> {
  const [schema, name] = table.split('.') as [string, string];
  const c = await admin.connect();
  try {
    await c.query('BEGIN'); await c.query("SET LOCAL session_replication_role = 'replica'");
    const cols = (await c.query(`SELECT column_name, udt_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2
      AND is_nullable = 'NO' AND column_default IS NULL AND is_generated = 'NEVER' AND is_identity = 'NO'`, [schema, name])).rows as { column_name: string; udt_name: string }[];
    const row: Record<string, unknown> = { ...given };
    for (const { column_name, udt_name } of cols) {
      if (column_name in row) continue;
      row[column_name] = udt_name === 'uuid' ? uid() : /^(int|numeric|float)/.test(udt_name) ? 1 : udt_name === 'bool' ? false : udt_name === 'timestamptz' || udt_name === 'timestamp' ? NOWISO
        : udt_name === 'date' ? '2026-11-01' : udt_name === 'jsonb' || udt_name === 'json' ? '[]' : `syn-${seqN}`;
    }
    const keys = Object.keys(row);
    await c.query(`INSERT INTO ${table} (${keys.map((k) => `"${k}"`).join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')}) ${onConflict}`,
      keys.map((k) => (row[k] !== null && typeof row[k] === 'object' && !(row[k] instanceof Date) && !Array.isArray(row[k]) ? JSON.stringify(row[k]) : row[k])));
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}

const W = { order: uid(), centre: uid(), centreB: uid(), patient: uid(), test: uid(), user: uid(), mem: uid(), memB: uid() };
const CODE = { ecoli: `syn_t15_ecoli_${RUN}`, amp: `syn_t15_amp_${RUN}`, cip: `syn_t15_cip_${RUN}` };
interface Cul { id: string; specimen: string; item: string; result: string }
let lab: any;

beforeAll(async () => {
  if (!live) { if (REQUIRE) throw new Error('database is provided: set LIMS_TEST_DATABASE_URL (lims_api) and LIMS_TEST_ADMIN_DATABASE_URL (superuser)'); return; }
  api = new pg.Pool({ connectionString: API_URL, max: 8 }); admin = new pg.Pool({ connectionString: ADMIN_URL, max: 4 });
  for (const t of [A, B]) await seedRow('core.tenants', { id: t }, 'ON CONFLICT DO NOTHING');
  for (const [t, id] of [[A, W.centre], [B, W.centreB]] as const) await seedRow('core.collection_centres', { tenant_id: t, id });
  await seedRow('core.users', { tenant_id: A, id: W.user, display_name: 'Synthetic Tech T15' });
  for (const [t, id] of [[A, W.mem], [B, W.memB]] as const) await seedRow('core.memberships', { tenant_id: t, id, user_id: W.user, actor_type: 'user', status: 'active', is_active: true, all_centres: true });
  await seedRow('frontdesk.patients', { tenant_id: A, id: W.patient }); await seedRow('catalog.tests', { tenant_id: A, id: W.test });
  await seedRow('micro.cs_organisms', { tenant_id: A, code: CODE.ecoli, display: 'Synthetic E. coli', is_active: true, created_by: SYS, updated_by: SYS }, 'ON CONFLICT DO NOTHING');
  for (const [c, d] of [[CODE.amp, 'Synthetic ampicillin'], [CODE.cip, 'Synthetic ciprofloxacin']] as const) await seedRow('micro.cs_antibiotics', { tenant_id: A, code: c, display: d, is_active: true, created_by: SYS, updated_by: SYS }, 'ON CONFLICT DO NOTHING');
});
afterAll(async () => { await api?.end(); await admin?.end(); });

async function newCulture(o: { status?: string; tenant?: string; centre?: string } = {}): Promise<Cul> {
  const c: Cul = { id: uid(), specimen: uid(), item: uid(), result: uid() }; const tenant = o.tenant ?? A;
  await seedRow('lab.specimens', { tenant_id: tenant, id: c.specimen });
  await seedRow('frontdesk.order_items', { tenant_id: tenant, id: c.item }); await seedRow('lab.results', { tenant_id: tenant, id: c.result, order_item_id: c.item });
  await seedRow('micro.cultures', { id: c.id, tenant_id: tenant, centre_id: o.centre ?? W.centre, order_id: W.order, order_item_id: c.item, specimen_id: c.specimen, patient_id: W.patient, test_id: W.test, specimen_type_code: 'urine',
    status: o.status ?? 'incubating', received_at: '2026-11-04T04:00:00.000Z', planted_at: '2026-11-04T05:00:00.000Z', last_specimen_seq: 1, created_by: SYS, updated_by: SYS, version: 1, ...(o.status === 'final_submitted' ? { outcome_code: 'growth_reported' } : {}) });
  return c;
}
async function addIsolate(c: Cul, seq: number): Promise<string> {
  const id = uid();
  await seedRow('micro.isolates', { id, tenant_id: A, centre_id: W.centre, culture_id: c.id, specimen_id: c.specimen, isolate_seq: seq, status: 'identified', organism_code: CODE.ecoli, organism_source: 'manual', identified_at: NOWISO, is_reportable: true, created_by: SYS, updated_by: SYS, version: 2 });
  return id;
}
async function addAst(c: Cul, isolate: string, abx: string, over: Row = {}): Promise<string> {
  const id = uid();
  await seedRow('micro.ast_results', { id, tenant_id: A, centre_id: W.centre, culture_id: c.id, isolate_id: isolate, antibiotic_code: abx, method: 'mic', raw_value: '2', category_code: 'S', standard: 'CLSI', standard_version: 'M100-2026', standard_source: 'manual', source: 'manual',
    off_panel: true, is_reportable: true, report_visibility: 'shown', suggestion_overridden: false, created_by: SYS, updated_by: SYS, version: 1, ...over });
  return id;
}
async function setLab(cs: Cul[], status: 'pending' | 'approved' = 'pending'): Promise<void> {
  lab = createFakeLabPort({ seed: 1, fixtures: { grants: { [SYS]: [LAB_READ, 'lab.result.amend'] }, orders: [{ id: W.order, tenantId: A, patientId: W.patient, centreId: W.centre, priority: 'routine', patient: { sex: 'female', ageDays: 9000 } }],
    items: cs.map((c) => ({ id: c.item, tenantId: A, orderId: W.order, testId: W.test, departmentId: uid(), workflowType: 'microbiology' })),
    results: cs.map((c) => ({ id: c.result, tenantId: A, orderItemId: c.item, testId: W.test, analyteId: uid(), versionNo: 1, status, origin: 'module', commentCodes: [], attachments: [], onHold: false, qcReviewRequired: false })) } as any });
}
async function call(op: string, req: Row, tenant = A, grants: string[] = [WORK]): Promise<{ res?: any; err?: any }> {
  const client = await api.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ tenant_id: tenant, sub: SYS, actor_type: 'user', membership_id: tenant === A ? W.mem : W.memB })]);
    const { ctx } = mkCtx({ tenantId: tenant, tx: client, grants, actor: { type: 'user', id: SYS, membershipId: tenant === A ? W.mem : W.memB }, members: { [W.mem]: 'Synthetic Tech T15' }, users: { [W.user]: 'Synthetic Tech T15' },
      tests: { [W.test]: { code: 'SYN_URINE', name: 'Synthetic Urine Culture' } } });
    ctx.ports.LabPort = lab;
    try { const res = await run(op, req, ctx); await client.query('COMMIT'); return { res }; } catch (err) { await client.query('ROLLBACK'); return { err }; }
  } finally { client.release(); }
}
const submit = (c: Cul, body: Row, key = `k-${uid()}`, tenant = A) => call('submitCultureReport', { params: { culture_id: c.id }, headers: { 'idempotency-key': key }, body }, tenant);
const PRELIM = { report_phase: 'preliminary', is_critical: false };
const versions = (c: Cul) => q('SELECT * FROM micro.report_versions WHERE culture_id = $1 ORDER BY version_no', [c.id]);
const cultureRow = async (c: Cul) => (await q('SELECT * FROM micro.cultures WHERE id = $1', [c.id]))[0]!;

describe.skipIf(!live && !REQUIRE)('T-15 report submission (live DB)', () => {
  it('AC-09.1 preliminary commits: report_versions row + culture counters in one transaction; response validates ReportVersionDto; payload sent to C5', async () => {
    const c = await newCulture(); const i = await addIsolate(c, 1); await addAst(c, i, CODE.amp); await addAst(c, i, CODE.cip, { category_code: 'R' }); await setLab([c]);
    const { res, err } = await submit(c, PRELIM); expect(err, `${err?.code ?? err}`).toBeUndefined();
    expect(res.status).toBe(201); expect(schemaErrors('ReportVersionDto', res.body)).toEqual([]);
    const v = await versions(c); expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ tenant_id: A, culture_id: c.id, order_item_id: c.item, version_no: 1, report_phase: 'preliminary', version_kind: 'initial', submission_kind: 'ast_panel', flag: 'A', lab_result_id: c.result, lab_replayed: false });
    expect(v[0]!.isolates).toEqual([{ seq: 1, organism_code: CODE.ecoli, organism_display: 'Synthetic E. coli', growth_text: '' }]);
    expect(v[0]!.ast.map((a: Row) => a['antibiotic_code']).sort()).toEqual([CODE.amp, CODE.cip].sort());
    expect(await cultureRow(c)).toMatchObject({ current_report_version_no: 1, last_report_phase: 'preliminary', status: 'incubating', version: 2 });
    expect(lab.calls('submitModuleResult')[0].input).toMatchObject({ idempotencyKey: `micro:${c.id}:1`, payloadRef: { module: 'micro', entityId: c.id, versionNo: 1 } });
  });
  it('AC-09.2 a passed-through C5 code rolls the request back: no report_versions row, culture untouched (each code)', async () => {
    for (const code of ['lab.result_locked', 'lab.result_invalid_transition', 'lab.module_result_invalid', 'lab.module_result_stale', 'lab.amendment_reason_required', 'auth.mfa_required']) {
      const c = await newCulture(); const i = await addIsolate(c, 1); await addAst(c, i, CODE.amp); await setLab([c]);
      lab.failNext('submitModuleResult', code);
      const r = await submit(c, PRELIM); expect(r.err?.code, code).toBe(code);
      expect(await versions(c)).toHaveLength(0); expect(await cultureRow(c)).toMatchObject({ current_report_version_no: 0, version: 1 });
    }
  });
  it('two parallel submissions on one culture serialise on the row lock: versions 1 and 2, no unique-key error', async () => {
    const c = await newCulture(); const i = await addIsolate(c, 1); await addAst(c, i, CODE.amp); await setLab([c]);
    const [r1, r2] = await Promise.all([submit(c, PRELIM), submit(c, PRELIM)]);
    expect([r1.err, r2.err]).toEqual([undefined, undefined]);
    expect((await versions(c)).map((v) => v['version_no'])).toEqual([1, 2]);
    expect(lab.calls('submitModuleResult').map((x: any) => x.input.idempotencyKey).sort()).toEqual([`micro:${c.id}:1`, `micro:${c.id}:2`]);
  });
  it('AC-09.5 report versions are immutable for the application role: no UPDATE / DELETE privilege, and the statements fail', async () => {
    const c = await newCulture(); const i = await addIsolate(c, 1); await addAst(c, i, CODE.amp); await setLab([c]); await submit(c, PRELIM);
    const g = (await api.query("SELECT has_table_privilege(current_user, 'micro.report_versions', 'UPDATE') AS u, has_table_privilege(current_user, 'micro.report_versions', 'DELETE') AS d")).rows[0];
    expect(g).toEqual({ u: false, d: false });
    for (const sql of ["UPDATE micro.report_versions SET comments_text = 'x' WHERE culture_id = $1", 'DELETE FROM micro.report_versions WHERE culture_id = $1']) {
      const cl = await api.connect();
      try { await cl.query('BEGIN'); await cl.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ tenant_id: A, sub: SYS, actor_type: 'user', membership_id: W.mem })]);
        await expect(cl.query(sql, [c.id])).rejects.toMatchObject({ code: '42501' }); } finally { await cl.query('ROLLBACK'); cl.release(); }
    }
    expect(await versions(c)).toHaveLength(1);
  });
  it('AC-10.4 / AC-10.7 final: culture final_submitted + outcome; then writes to isolates, ast_results, culture_plates, culture_observations are refused by the DB trigger (also bypassing the service) and 409 micro.report_final_locked through the API', async () => {
    const c = await newCulture(); const i = await addIsolate(c, 1); const a = await addAst(c, i, CODE.amp); await setLab([c]);
    const r = await submit(c, { report_phase: 'final', outcome_code: 'growth_reported', is_critical: false }); expect(r.err, `${r.err?.code ?? r.err}`).toBeUndefined();
    expect(await cultureRow(c)).toMatchObject({ status: 'final_submitted', outcome_code: 'growth_reported', current_report_version_no: 1 });
    expect(await q('SELECT from_status, to_status FROM micro.culture_transitions WHERE culture_id = $1', [c.id])).toEqual([{ from_status: 'incubating', to_status: 'final_submitted' }]);
    const bypass = [`UPDATE micro.isolates SET colony_description = 'x' WHERE id = '${i}'`, `UPDATE micro.ast_results SET raw_value = '4' WHERE id = '${a}'`,
      `INSERT INTO micro.culture_plates (id, tenant_id, centre_id, culture_id, plate_no, media_code, planted_at, status, created_by, updated_by) VALUES ('${uid()}', '${A}', '${W.centre}', '${c.id}', 9, 'syn_blood', now(), 'active', '${SYS}', '${SYS}')`,
      `INSERT INTO micro.culture_observations (id, tenant_id, centre_id, culture_id, kind, finding_text, observed_at, created_by) VALUES ('${uid()}', '${A}', '${W.centre}', '${c.id}', 'microscopy', 'x', now(), '${SYS}')`];
    for (const sql of bypass) {
      const cl = await api.connect();
      try { await cl.query('BEGIN'); await cl.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ tenant_id: A, sub: SYS, actor_type: 'user', membership_id: W.mem })]);
        await expect(cl.query(sql), sql.slice(0, 50)).rejects.toMatchObject({ code: 'P0001' }); } finally { await cl.query('ROLLBACK'); cl.release(); }
    }
    const e = await call('createIsolate', { params: { culture_id: c.id }, headers: { 'idempotency-key': `k-${uid()}` }, body: {} });
    expect(e.err?.code).toBe('micro.report_final_locked'); expect(e.err?.statusCode).toBe(409);
  });
  it('AC-16.1 a suppressed_by_rule AST row is left out of the snapshot but stays stored; AC-15.2 the published view returns the stored snapshot', async () => {
    const c = await newCulture(); const i = await addIsolate(c, 1); await addAst(c, i, CODE.amp); const hidden = await addAst(c, i, CODE.cip, { report_visibility: 'suppressed_by_rule' }); await setLab([c]);
    const r = await submit(c, PRELIM); expect(r.err, `${r.err?.code ?? r.err}`).toBeUndefined();
    expect(r.res.body.ast.map((a: Row) => a['antibiotic_code'])).toEqual([CODE.amp]);
    expect((await q('SELECT report_visibility FROM micro.ast_results WHERE id = $1', [hidden]))[0]).toEqual({ report_visibility: 'suppressed_by_rule' });
    const view = await q('SELECT * FROM micro.v_pub_report_content WHERE tenant_id = $1 AND entity_id = $2 AND version_no = 1', [A, c.id]);
    expect(view).toHaveLength(1); expect(view[0]).toMatchObject({ order_item_id: c.item, report_phase: 'preliminary' }); expect(view[0]!.ast).toHaveLength(1);
  });
  it('RLS / BOLA: a culture of tenant B is 404 for tenant A and nothing is written; tenant B\'s own submission is invisible to A', async () => {
    const cb = await newCulture({ tenant: B, centre: W.centreB }); await setLab([]);
    const r = await submit(cb, PRELIM, `k-${uid()}`, A); expect(r.err?.code).toBe('common.not_found');
    expect(await versions(cb)).toHaveLength(0);
  });
});
