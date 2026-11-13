// C10 T-16 — M17 reopenCulture / M18 cancelCulture and the amendment chain against the migrated database (06-IMPLEMENTATION-PLAN row T-16; 02-TRD §4.7, §5 M17/M18; 03-APP-FLOW C6, C8, C9;
// 05-SCHEMA §8 cultures__amend__ck, cultures__cancel__ck, cultures_guard, tg_child_final_lock, §5 immutability; PRD AC-11.1–11.6, AC-01.6; 07-SECURITY S-01, S-30).
// Needs the micro DDL + RLS applied: LIMS_TEST_DATABASE_URL = role lims_api (RLS on), LIMS_TEST_ADMIN_DATABASE_URL = superuser. Without them the DB tests skip, except under LIMS_T16_REQUIRE_DB=1
// where "database is provided" fails (same harness status as T-05..T-15). NOT RUN in the tester session (no database there): seeding follows the T-15 integration file; first run may need fixture
// tweaks, never assertion weakening. Offline equivalents of everything except the DB rules live in culture.reopen-cancel.test.ts.
// ctx.tx = one real transaction per request under RLS with user claims (COMMIT on success, ROLLBACK on a throw), like the core wrapper.
// Synthetic data only.
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFakeLabPort } from '../../../../../../../packages/fakes/src/LabPort.fake';
import { TENANT_A, TENANT_B } from '../../../../../../../packages/fakes/src/base';
import { onSpecimenStatusChanged } from '../../service/culture.service.js';
import { LAB_AMEND, LAB_READ, mkCtx, READ, responseErrors, run, WORK, type Row } from './helpers/cultureReads.js';

const API_URL = process.env['LIMS_TEST_DATABASE_URL'];
const ADMIN_URL = process.env['LIMS_TEST_ADMIN_DATABASE_URL'];
const live = Boolean(API_URL && ADMIN_URL);
const REQUIRE = process.env['LIMS_T16_REQUIRE_DB'] === '1';
const A = TENANT_A, B = TENANT_B;
const RUN = Date.now(); let seqN = 0;
const uid = () => `0190c616-0000-7000-8000-${(RUN % 0xffffffff).toString(16).padStart(8, '0')}${(++seqN).toString(16).padStart(4, '0')}`;
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
const CODE = { ecoli: `syn_t16_ecoli_${RUN}`, amp: `syn_t16_amp_${RUN}` };
interface Cul { id: string; specimen: string; item: string; result: string }
let lab: any;

beforeAll(async () => {
  if (!live) { if (REQUIRE) throw new Error('database is provided: set LIMS_TEST_DATABASE_URL (lims_api) and LIMS_TEST_ADMIN_DATABASE_URL (superuser)'); return; }
  api = new pg.Pool({ connectionString: API_URL, max: 8 }); admin = new pg.Pool({ connectionString: ADMIN_URL, max: 4 });
  for (const t of [A, B]) await seedRow('core.tenants', { id: t }, 'ON CONFLICT DO NOTHING');
  for (const [t, id] of [[A, W.centre], [B, W.centreB]] as const) await seedRow('core.collection_centres', { tenant_id: t, id });
  await seedRow('core.users', { tenant_id: A, id: W.user, display_name: 'Synthetic Tech T16' });
  for (const [t, id] of [[A, W.mem], [B, W.memB]] as const) await seedRow('core.memberships', { tenant_id: t, id, user_id: W.user, actor_type: 'user', status: 'active', is_active: true, all_centres: true });
  await seedRow('frontdesk.patients', { tenant_id: A, id: W.patient }); await seedRow('catalog.tests', { tenant_id: A, id: W.test });
  await seedRow('micro.cs_organisms', { tenant_id: A, code: CODE.ecoli, display: 'Synthetic E. coli', is_active: true, created_by: SYS, updated_by: SYS }, 'ON CONFLICT DO NOTHING');
  await seedRow('micro.cs_antibiotics', { tenant_id: A, code: CODE.amp, display: 'Synthetic ampicillin', is_active: true, created_by: SYS, updated_by: SYS }, 'ON CONFLICT DO NOTHING');
});
afterAll(async () => { await api?.end(); await admin?.end(); });

async function newCulture(o: { status?: string; tenant?: string; centre?: string; extra?: Row } = {}): Promise<Cul> {
  const c: Cul = { id: uid(), specimen: uid(), item: uid(), result: uid() }; const tenant = o.tenant ?? A; const status = o.status ?? 'incubating';
  await seedRow('lab.specimens', { tenant_id: tenant, id: c.specimen });
  await seedRow('frontdesk.order_items', { tenant_id: tenant, id: c.item }); await seedRow('lab.results', { tenant_id: tenant, id: c.result, order_item_id: c.item });
  await seedRow('micro.cultures', { id: c.id, tenant_id: tenant, centre_id: o.centre ?? W.centre, order_id: W.order, order_item_id: c.item, specimen_id: c.specimen, patient_id: W.patient, test_id: W.test, specimen_type_code: 'urine',
    status, received_at: '2026-11-04T04:00:00.000Z', planted_at: status === 'awaiting_setup' ? null : '2026-11-04T05:00:00.000Z', last_specimen_seq: 1, created_by: SYS, updated_by: SYS, version: 1,
    ...(status === 'final_submitted' ? { outcome_code: 'growth_reported', current_report_version_no: 1, last_report_phase: 'final' } : {}),
    ...(status === 'cancelled' ? { cancel_reason_code: 'entered_in_error', cancelled_at: NOWISO } : {}), ...(o.extra ?? {}) });
  return c;
}
async function addIsolate(c: Cul, seq: number): Promise<string> {
  const id = uid();
  await seedRow('micro.isolates', { id, tenant_id: A, centre_id: W.centre, culture_id: c.id, specimen_id: c.specimen, isolate_seq: seq, status: 'identified', organism_code: CODE.ecoli, organism_source: 'manual', identified_at: NOWISO, is_reportable: true, created_by: SYS, updated_by: SYS, version: 2 });
  return id;
}
async function addAst(c: Cul, isolate: string): Promise<void> {
  await seedRow('micro.ast_results', { id: uid(), tenant_id: A, centre_id: W.centre, culture_id: c.id, isolate_id: isolate, antibiotic_code: CODE.amp, method: 'mic', raw_value: '2', category_code: 'S', standard: 'CLSI', standard_version: 'M100-2026',
    standard_source: 'manual', source: 'manual', off_panel: true, is_reportable: true, report_visibility: 'shown', suggestion_overridden: false, created_by: SYS, updated_by: SYS, version: 1 });
}
/** a submitted FINAL version 1 (as M14 would have stored it) so the culture is reportable and listable */
async function addFinalVersion(c: Cul): Promise<void> {
  await seedRow('micro.report_versions', { id: uid(), tenant_id: A, centre_id: W.centre, culture_id: c.id, order_item_id: c.item, version_no: 1, report_phase: 'final', version_kind: 'initial', submission_kind: 'organism', outcome_code: 'growth_reported',
    culture_summary_text: 'Synthetic earlier summary', isolates: [{ seq: 1, organism_code: CODE.ecoli, organism_display: 'Synthetic E. coli', growth_text: '' }], ast: [], is_critical: false, flag: 'A', signed_by_membership_id: W.mem, signed_at: NOWISO,
    lab_result_id: c.result, lab_result_version_no: 1, lab_status_at_submit: 'approved', lab_replayed: false, created_by: SYS });
}
async function addRecord(c: Cul, status: string, over: Row = {}): Promise<string> {
  const id = uid();
  await seedRow('micro.instrument_records', { id, tenant_id: A, centre_id: W.centre, culture_id: c.id, specimen_id: c.specimen, record_kind: 'organism_id', organism_code_raw: 'SYN_ORG', sample_barcode: 'SYN001', instrument_analyte_code: 'ORG:1', match_status: status,
    match_reason: status === 'pending_match' ? 'no_culture' : null, ignore_reason_code: status === 'ignored' ? 'duplicate' : null, expires_at: status === 'applied' || status === 'ignored' ? '2026-12-01T00:00:00.000Z' : null, created_by: SYS, updated_by: SYS, ...over });
  return id;
}
async function setLab(cs: Cul[], status = 'approved', lastPhase = 'final'): Promise<void> {
  lab = createFakeLabPort({ seed: 1, fixtures: { grants: { [SYS]: [LAB_READ, LAB_AMEND] }, orders: [{ id: W.order, tenantId: A, patientId: W.patient, centreId: W.centre, priority: 'routine', patient: { sex: 'female', ageDays: 9000 } }],
    items: cs.map((c) => ({ id: c.item, tenantId: A, orderId: W.order, testId: W.test, departmentId: uid(), workflowType: 'microbiology' })),
    results: cs.map((c) => ({ id: c.result, tenantId: A, orderItemId: c.item, testId: W.test, analyteId: uid(), versionNo: 1, status, origin: 'module', commentCodes: [], attachments: [], onHold: false, qcReviewRequired: false,
      ...(status === 'pending' ? {} : { moduleRef: { module: 'micro', entityId: c.id, versionNo: 1 }, lastPhase, lastPayloadVersion: 1 }) })) } as any });
}
async function call(op: string, req: Row, tenant = A, grants: string[] = [WORK, READ]): Promise<{ res?: any; err?: any }> {
  const client = await api.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ tenant_id: tenant, sub: SYS, actor_type: 'user', membership_id: tenant === A ? W.mem : W.memB })]);
    const { ctx } = mkCtx({ tenantId: tenant, tx: client, grants, actor: { type: 'user', id: SYS, membershipId: tenant === A ? W.mem : W.memB }, members: { [W.mem]: 'Synthetic Tech T16' }, users: { [W.user]: 'Synthetic Tech T16' },
      tests: { [W.test]: { code: 'SYN_URINE', name: 'Synthetic Urine Culture' } } });
    ctx.ports.LabPort = lab;
    try { const res = await run(op, req, ctx); await client.query('COMMIT'); return { res }; } catch (err) { await client.query('ROLLBACK'); return { err }; }
  } finally { client.release(); }
}
const ifm = (v: number) => ({ 'if-match': `"${v}"` });
const reopen = (c: Cul, body: Row = { amendment_reason_code: 'correction', amendment_reason_text: 'Synthetic fix' }, version = 1, tenant = A) => call('reopenCulture', { params: { culture_id: c.id }, headers: ifm(version), body }, tenant);
const cancel = (c: Cul, body: Row = { reason_code: 'entered_in_error', comment: 'Synthetic comment' }, version = 1, tenant = A) => call('cancelCulture', { params: { culture_id: c.id }, headers: ifm(version), body }, tenant);
const submit = (c: Cul, body: Row) => call('submitCultureReport', { params: { culture_id: c.id }, headers: { 'idempotency-key': `k-${uid()}` }, body });
const FINAL = { report_phase: 'final', outcome_code: 'growth_reported', is_critical: false };
const cultureRow = async (c: Cul) => (await q('SELECT * FROM micro.cultures WHERE id = $1', [c.id]))[0]!;
const transitions = (c: Cul) => q('SELECT from_status, to_status, reason_code FROM micro.culture_transitions WHERE culture_id = $1 ORDER BY occurred_at, created_at', [c.id]);

describe.skipIf(!live && !REQUIRE)('T-16 reopen / amend / cancel (live DB)', () => {
  it('AC-11.1 reopen commits under RLS: culture amending with the reason (cultures__amend__ck), version + 1, transition row, CultureDetailDto; the submitted version is untouched and still listed (AC-11.5, M15)', async () => {
    const c = await newCulture({ status: 'final_submitted' }); await addFinalVersion(c); await setLab([c]);
    const { res, err } = await reopen(c); expect(err, `${err?.code ?? err}`).toBeUndefined();
    expect(res.status).toBe(200); expect(responseErrors('reopenCulture', res.body)).toEqual([]);
    expect(await cultureRow(c)).toMatchObject({ status: 'amending', amendment_reason_code: 'correction', amendment_reason_text: 'Synthetic fix', version: 2, current_report_version_no: 1 });
    expect(await transitions(c)).toEqual([{ from_status: 'final_submitted', to_status: 'amending', reason_code: 'correction' }]);
    const list = await call('listCultureReportVersions', { params: { culture_id: c.id } }); expect(list.err, `${list.err?.code ?? list.err}`).toBeUndefined();
    expect(list.res.body.data.map((v: Row) => v['version_no'])).toEqual([1]);
    expect((await q('SELECT version_no FROM micro.v_pub_report_content WHERE tenant_id = $1 AND entity_id = $2 ORDER BY version_no', [A, c.id])).map((r) => r['version_no'])).toEqual([1]);
  });
  it('AC-11.1 the DB final lock lifts on reopen: a plate / observation insert is refused while final (P0001) and accepted once amending (through the API)', async () => {
    const c = await newCulture({ status: 'final_submitted' }); await addFinalVersion(c); await setLab([c]);
    const note = { params: { culture_id: c.id }, headers: { 'idempotency-key': `k-${uid()}` }, body: { kind: 'microscopy', finding_text: 'Synthetic finding' } };
    expect((await call('recordCultureObservation', note)).err?.code).toBe('micro.report_final_locked');
    expect((await reopen(c)).err).toBeUndefined();
    const r = await call('recordCultureObservation', { ...note, headers: { 'idempotency-key': `k-${uid()}` } }); expect(r.err, `${r.err?.code ?? r.err}`).toBeUndefined();
    expect(await q('SELECT 1 FROM micro.culture_observations WHERE culture_id = $1', [c.id])).toHaveLength(1);
  });
  it('AC-11.4 no reason -> 422 micro.amendment_reason_required and the row is unchanged; a wrong state -> 409 micro.culture_invalid_transition (incubating, cancelled)', async () => {
    const c = await newCulture({ status: 'final_submitted' });
    expect((await reopen(c, {})).err?.code).toBe('micro.amendment_reason_required'); expect((await reopen(c, { amendment_reason_code: '' })).err?.code).toBe('micro.amendment_reason_required');
    expect(await cultureRow(c)).toMatchObject({ status: 'final_submitted', version: 1, amendment_reason_code: null });
    for (const status of ['incubating', 'cancelled']) { const x = await newCulture({ status }); const r = await reopen(x); expect(r.err?.code, status).toBe('micro.culture_invalid_transition'); expect(r.err?.statusCode).toBe(409); }
  });
  it('two parallel reopens of one culture serialise on the row lock: exactly one wins (200), the other is 409 (version_conflict or invalid transition); one transition row', async () => {
    const c = await newCulture({ status: 'final_submitted' }); await setLab([c]);
    const rs = await Promise.all([reopen(c), reopen(c, { amendment_reason_code: 'syn_other' })]);
    expect(rs.filter((r) => r.res).length).toBe(1); const lost = rs.find((r) => r.err)!.err;
    expect(['common.version_conflict', 'micro.culture_invalid_transition']).toContain(lost.code); expect(lost.statusCode).toBe(409);
    expect(await transitions(c)).toHaveLength(1);
  });
  it('AC-11.2 reopen -> submit final on an approved C5 line: version 2 kind amendment with the reason, culture final_submitted; version 1 byte-for-byte unchanged (immutability grants, AC-11.5)', async () => {
    const c = await newCulture({ status: 'final_submitted' }); const i = await addIsolate(c, 1); await addAst(c, i); await addFinalVersion(c); await setLab([c]);
    const v1 = (await q('SELECT * FROM micro.report_versions WHERE culture_id = $1 AND version_no = 1', [c.id]))[0];
    expect((await reopen(c)).err).toBeUndefined();
    const r = await submit(c, FINAL); expect(r.err, `${r.err?.code ?? r.err}`).toBeUndefined();
    expect(lab.calls('submitModuleResult')[0].input.amendment).toEqual({ reasonCode: 'correction', reasonText: 'Synthetic fix' });
    const vs = await q('SELECT * FROM micro.report_versions WHERE culture_id = $1 ORDER BY version_no', [c.id]);
    expect(vs.map((v) => v['version_no'])).toEqual([1, 2]); expect(vs[0]).toEqual(v1);
    expect(vs[1]).toMatchObject({ version_kind: 'amendment', amendment_reason_code: 'correction', amendment_reason_text: 'Synthetic fix', report_phase: 'final' });
    expect(await cultureRow(c)).toMatchObject({ status: 'final_submitted', current_report_version_no: 2 });
    expect((await transitions(c)).map((t) => t['to_status'])).toEqual(['amending', 'final_submitted']);
  });
  it('AC-11.6 / S-30 a reason C5 rejects (a system code on a final) -> 422 lab.module_result_invalid; rollback: no version 2, the culture stays amending', async () => {
    for (const code of ['module_phase_progression', 'module_preliminary_update', 'supplementary_report']) {
      const c = await newCulture({ status: 'final_submitted' }); const i = await addIsolate(c, 1); await addAst(c, i); await addFinalVersion(c); await setLab([c]);
      expect((await reopen(c, { amendment_reason_code: code })).err, code).toBeUndefined();
      const r = await submit(c, FINAL); expect(r.err?.code, code).toBe('lab.module_result_invalid');
      expect(await q('SELECT 1 FROM micro.report_versions WHERE culture_id = $1', [c.id])).toHaveLength(1);
      expect(await cultureRow(c)).toMatchObject({ status: 'amending', amendment_reason_code: code, current_report_version_no: 1 });
    }
  });
  it('AC-11.3 amending while the C5 line is only resulted: ordinary re-submission, culture final_submitted again', async () => {
    const c = await newCulture({ status: 'final_submitted' }); const i = await addIsolate(c, 1); await addAst(c, i); await addFinalVersion(c); await setLab([c], 'resulted');
    expect((await reopen(c)).err).toBeUndefined();
    const r = await submit(c, FINAL); expect(r.err, `${r.err?.code ?? r.err}`).toBeUndefined();
    expect(await cultureRow(c)).toMatchObject({ status: 'final_submitted', current_report_version_no: 2 });
  });

  it('M18 cancel commits (cultures__cancel__ck): cancelled + reason + comment + cancelled_at, version + 1, transition row; OPEN instrument records -> pending_match / culture_cancelled, applied / ignored / other cultures\' untouched', async () => {
    const c = await newCulture({ status: 'incubating' }); const other = await newCulture({ status: 'incubating' }); await setLab([c, other], 'pending');
    const open = [await addRecord(c, 'pending_match', { match_reason: 'unknown_barcode' }), await addRecord(c, 'needs_mapping'), await addRecord(c, 'conflict')];
    const applied = await addRecord(c, 'applied'); const ignored = await addRecord(c, 'ignored'); const foreign = await addRecord(other, 'pending_match');
    const { res, err } = await cancel(c); expect(err, `${err?.code ?? err}`).toBeUndefined();
    expect(res.status).toBe(200); expect(responseErrors('cancelCulture', res.body)).toEqual([]);
    expect(await cultureRow(c)).toMatchObject({ status: 'cancelled', cancel_reason_code: 'entered_in_error', cancel_comment: 'Synthetic comment', version: 2 });
    expect((await cultureRow(c))['cancelled_at']).toBeTruthy();
    expect(await transitions(c)).toEqual([{ from_status: 'incubating', to_status: 'cancelled', reason_code: 'entered_in_error' }]);
    for (const id of open) expect((await q('SELECT match_status, match_reason FROM micro.instrument_records WHERE id = $1', [id]))[0], id).toEqual({ match_status: 'pending_match', match_reason: 'culture_cancelled' });
    expect((await q('SELECT match_status FROM micro.instrument_records WHERE id = ANY($1)', [[applied, ignored]])).map((r) => r['match_status']).sort()).toEqual(['applied', 'ignored']);
    expect((await q('SELECT match_status, match_reason FROM micro.instrument_records WHERE id = $1', [foreign]))[0]).toEqual({ match_status: 'pending_match', match_reason: 'no_culture' });
    expect((await cultureRow(other))['status']).toBe('incubating');
  });
  it('M18 with a submitted version: C5 approved / resulted -> 409 micro.culture_invalid_transition (row unchanged); C5 cancelled -> allowed', async () => {
    for (const [status, ok] of [['approved', false], ['resulted', false], ['cancelled', true]] as const) {
      const c = await newCulture({ status: 'incubating', extra: { current_report_version_no: 1, last_report_phase: 'preliminary' } }); await setLab([c], status, 'preliminary');
      const r = await cancel(c);
      if (ok) { expect(r.err, `${r.err?.code ?? r.err}`).toBeUndefined(); expect(await cultureRow(c)).toMatchObject({ status: 'cancelled' }); }
      else { expect(r.err?.code, status).toBe('micro.culture_invalid_transition'); expect(await cultureRow(c)).toMatchObject({ status: 'incubating', version: 1 }); }
    }
  });
  it('M18 refuses the system codes and unknown codes with 400 against the real coded-set view; a final / amending / cancelled culture is 409', async () => {
    const c = await newCulture({ status: 'incubating' }); await setLab([c], 'pending');
    for (const code of ['specimen_rejected', 'order_item_cancelled', 'syn_nonexistent']) { const r = await cancel(c, { reason_code: code }); expect(r.err?.code, code).toBe('common.validation_failed'); expect(r.err?.statusCode).toBe(400); }
    expect(await cultureRow(c)).toMatchObject({ status: 'incubating', version: 1 });
    for (const status of ['final_submitted', 'amending', 'cancelled']) { const x = await newCulture({ status: status === 'amending' ? 'final_submitted' : status }); if (status === 'amending') await reopen(x); expect((await cancel(x, undefined, status === 'amending' ? 2 : 1)).err?.code, status).toBe('micro.culture_invalid_transition'); }
  });

  it('AC-01.6 consumer parity: a rejected event cancels an awaiting_setup culture with specimen_rejected AND closes its open instrument records (pending_match / culture_cancelled); a culture with a submitted version is NOT cancelled (AC-01.7)', async () => {
    const c = await newCulture({ status: 'awaiting_setup' }); const rec = await addRecord(c, 'needs_mapping'); const applied = await addRecord(c, 'applied');
    const reported = await newCulture({ status: 'incubating', extra: { current_report_version_no: 1, last_report_phase: 'preliminary' } });
    await seedRow('micro.report_versions', { id: uid(), tenant_id: A, centre_id: W.centre, culture_id: reported.id, order_item_id: reported.item, version_no: 1, report_phase: 'preliminary', version_kind: 'initial', submission_kind: 'structured', flag: 'N', is_critical: false,
      culture_summary_text: 'Synthetic', isolates: [], ast: [], signed_by_membership_id: W.mem, signed_at: NOWISO, lab_result_id: reported.result, lab_result_version_no: 1, lab_status_at_submit: 'resulted', lab_replayed: false, created_by: SYS });
    for (const cul of [c, reported]) {
      const client = await api.connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ tenant_id: A, sub: SYS, actor_type: 'system' })]);
        await onSpecimenStatusChanged({ tenantId: A, actor: { id: SYS }, tx: client, metrics: { inc() {} }, ports: { LabPort: lab, CatalogPort: {} }, isNewer: (last, seq) => last === undefined || seq > last } as any,
          { tenant_id: A, aggregate: { seq: 5 }, payload: { specimen_id: cul.specimen, to_status: 'rejected', from_status: 'received', changed_at: NOWISO } });
        await client.query('COMMIT');
      } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    }
    expect(await cultureRow(c)).toMatchObject({ status: 'cancelled', cancel_reason_code: 'specimen_rejected' });
    expect((await q('SELECT match_status, match_reason FROM micro.instrument_records WHERE id = $1', [rec]))[0]).toEqual({ match_status: 'pending_match', match_reason: 'culture_cancelled' });
    expect((await q('SELECT match_status FROM micro.instrument_records WHERE id = $1', [applied]))[0]).toEqual({ match_status: 'applied' });
    expect((await cultureRow(reported))['status']).toBe('incubating');
  });

  it('RLS / BOLA: tenant B cannot reopen or cancel a tenant A culture (404 common.not_found, row unchanged); a read-only user is 403', async () => {
    const f = await newCulture({ status: 'final_submitted' }); const i = await newCulture({ status: 'incubating' }); await setLab([f, i], 'pending');
    expect((await reopen(f, undefined, 1, B)).err?.code).toBe('common.not_found'); expect((await cancel(i, undefined, 1, B)).err?.code).toBe('common.not_found');
    expect((await call('reopenCulture', { params: { culture_id: f.id }, headers: ifm(1), body: { amendment_reason_code: 'correction' } }, A, [READ])).err?.code).toBe('auth.forbidden');
    expect((await call('cancelCulture', { params: { culture_id: i.id }, headers: ifm(1), body: { reason_code: 'entered_in_error' } }, A, [READ])).err?.code).toBe('auth.forbidden');
    expect(await cultureRow(f)).toMatchObject({ status: 'final_submitted', version: 1 }); expect(await cultureRow(i)).toMatchObject({ status: 'incubating', version: 1 });
  });
});
