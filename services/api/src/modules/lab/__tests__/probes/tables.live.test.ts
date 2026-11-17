// C5 T-32 / 07-SECURITY §5.1 P-T (table probes for every lab tenant table) + §5.2 S-03, S-05, S-07, S-23, on a real PG17 as role lims_api (RLS on).
//  P-T : A claims see 0 B rows; INSERT of a B-tenant row under A claims fails; UPDATE of B rows affects 0; DELETE privilege is absent (permission denied) on every table.
//  S-03: UPDATE of an approved lab.results row / of lab.result_versions value columns -> `immutable_row`.
//  S-05: UPDATE / DELETE on lab.critical_notifications -> permission denied.
//  S-07: result attachment whose object_path carries a foreign tenant prefix -> the CHECK constraint rejects the direct insert.
//  S-23: claims with actor_type partner / portal / patient see 0 rows of every tenant-scoped lab table (app.is_staff_or_system(); centre-scoped tables fail closed via app.has_all_centres(), 08 R3/R10).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LAB_TENANT_TABLES, MEM, T, TENANT_A, TENANT_B, api, asOwner, claimsOf, closePools, ins, live, objs, owner, requireDb, uid, withClaims, type Objs } from './kit.js';

let A: Objs; let B: Objs; let approvedResultId: string;
const asA = <R>(fn: Parameters<typeof withClaims<R>>[2]) => withClaims(api(), claimsOf(TENANT_A), fn);
const rejects = async (p: Promise<unknown>): Promise<{ message: string; code?: string }> => { try { await p; } catch (e: any) { return { message: String(e?.message ?? e), code: e?.code }; } throw new Error('expected the statement to be rejected'); };

beforeAll(async () => {
  if (!live) return;
  A = await objs('a'); B = await objs('b');
  approvedResultId = uid();
  await asOwner(TENANT_A, async (c) => {
    const analyte = uid();
    await ins(c, 'lab.results', { id: approvedResultId, tenant_id: TENANT_A, centre_id: A.centre, processing_centre_id: A.centre, order_id: A.orderId, order_item_id: A.itemId, order_test_id: A.orderTestId, specimen_id: A.specimenId,
      patient_id: A.patientId, test_id: A.testId, analyte_id: analyte, analyte_code: 'T32X', department_id: uid(), is_reportable: true, result_type: 'numeric', status: 'approved', origin: 'manual', value_numeric: 5,
      unit_code: 'g/L', approved_at: '2026-06-15T04:50:00.000Z', approved_by_membership_id: MEM.a, resulted_at: '2026-06-15T04:40:00.000Z' });
    await ins(c, 'lab.result_versions', { id: uid(), tenant_id: TENANT_A, centre_id: A.centre, processing_centre_id: A.centre, result_id: approvedResultId, version_no: 1, origin: 'manual', value_numeric: 5, unit_code: 'g/L',
      is_critical: false, approved_at: '2026-06-15T04:50:00.000Z', approved_by_membership_id: MEM.a });
    await ins(c, 'lab.critical_notifications', { id: uid(), tenant_id: TENANT_A, centre_id: A.centre, critical_event_id: A.criticalId, notified_party_kind: 'clinician', notified_party_name: 'Dr Synthetic', contact_method: 'phone',
      notified_at: '2026-06-15T04:55:00.000Z', outcome: 'reached', read_back_confirmed: false, notified_by_membership_id: MEM.a });
  });
}, T);
afterAll(async () => { await closePools(); });
describe('harness', () => { it('the migrated database is provided (fails, never skips, under LIMS_T03_REQUIRE_DB=1)', () => { if (requireDb) expect(live).toBe(true); }); });

describe.skipIf(!live)('P-T every lab tenant table (LAB_TENANT_TABLES)', () => {
  it('the table list is the schema (28 tenant tables; the 4 g_cs_* global tables are not tenant-scoped)', () => { expect(LAB_TENANT_TABLES).toHaveLength(28); });

  it.each([...LAB_TENANT_TABLES].map((t) => [t] as const))('%s: A claims see 0 tenant-B rows, and UPDATE of B rows affects 0', { timeout: T }, async (t) => {
    const ownerB = Number((await owner(`SELECT count(*)::int AS n FROM lab.${t} WHERE tenant_id = $1`, [TENANT_B]))[0].n);
    const ownerA = Number((await owner(`SELECT count(*)::int AS n FROM lab.${t} WHERE tenant_id = $1`, [TENANT_A]))[0].n);
    const seenB = await asA(async (c) => Number((await c.query(`SELECT count(*)::int AS n FROM lab.${t} WHERE tenant_id = $1`, [TENANT_B])).rows[0].n));
    expect(seenB, `${t}: ${ownerB} B rows exist, A must see none`).toBe(0);
    const seenA = await asA(async (c) => Number((await c.query(`SELECT count(*)::int AS n FROM lab.${t} WHERE tenant_id = $1`, [TENANT_A])).rows[0].n));
    if (ownerA > 0) expect(seenA, `${t}: control, A sees its own rows`).toBeGreaterThanOrEqual(ownerA);   // >=: parallel probe files keep inserting
    try {
      const upd = await asA(async (c) => (await c.query(`UPDATE lab.${t} SET tenant_id = tenant_id WHERE tenant_id = $1`, [TENANT_B])).rowCount);
      expect(upd, `${t}: UPDATE of B rows`).toBe(0);
    } catch (e: any) { expect(e?.code, `${t}: only "permission denied" is an acceptable alternative`).toBe('42501'); }
  });

  it.each([...LAB_TENANT_TABLES].map((t) => [t] as const))('%s: DELETE privilege is absent (permission denied, even on tenant-A rows)', { timeout: T }, async (t) => {
    const e = await rejects(asA((c) => c.query(`DELETE FROM lab.${t} WHERE tenant_id = $1`, [TENANT_A])));
    expect(e.code, `${t}: ${e.message}`).toBe('42501');
    expect(e.message).toMatch(/permission denied/);
  });

  it('INSERT of a row carrying tenant B under tenant-A claims fails the RLS WITH CHECK (every table that holds a tenant-A row to copy)', { timeout: T }, async () => {
    // Ruling C3: order-independent. These tables are seeded by THIS file's beforeAll (objs('a') + approved result / version / notification), so each one MUST be probed whatever the other files did;
    // any further table another file happened to fill is probed too, but is not counted on.
    const SEEDED_HERE = ['orders', 'specimens', 'order_tests', 'results', 'result_versions', 'critical_value_log', 'critical_notifications', 'ingest_exceptions', 'worksheets', 'worksheet_items', 'qc_holds',
      'delta_check_rules', 'cs_rejection_reasons'];
    const probed = new Set<string>();
    for (const t of LAB_TENANT_TABLES) {
      if (Number((await owner(`SELECT count(*)::int AS n FROM lab.${t} WHERE tenant_id = $1`, [TENANT_A]))[0].n) === 0) continue;
      const e = await rejects(asA((c) => c.query(
        `INSERT INTO lab.${t} SELECT (jsonb_populate_record(NULL::lab.${t}, to_jsonb(x) || jsonb_build_object('tenant_id', $2::text))).* FROM lab.${t} x WHERE x.tenant_id = $1 LIMIT 1`, [TENANT_A, TENANT_B])));
      expect(e.message, `${t}`).toMatch(/row-level security|permission denied/);
      probed.add(t);
    }
    for (const t of SEEDED_HERE) expect(probed.has(t), `lab.${t} holds a tenant-A row seeded by this file, so it must have been probed`).toBe(true);
    expect(Number((await owner('SELECT count(*)::int AS n FROM lab.specimens WHERE tenant_id = $1 AND id = $2', [TENANT_B, A.specimenId]))[0].n)).toBe(0);
  });
});

describe.skipIf(!live)('S-03 immutable rows (as lims_api)', () => {
  it('UPDATE lab.results SET value_numeric ... WHERE status = approved => immutable_row, value unchanged', { timeout: T }, async () => {
    const e = await rejects(asA((c) => c.query("UPDATE lab.results SET value_numeric = 6 WHERE id = $1 AND status = 'approved'", [approvedResultId])));
    expect(e.message).toBe('immutable_row');
    expect(Number((await owner('SELECT value_numeric FROM lab.results WHERE id = $1', [approvedResultId]))[0].value_numeric)).toBe(5);
  });
  it('control: a pending result row of the same tenant IS editable (the lock is status-based, not a blanket block)', { timeout: T }, async () => {
    const n = await asA(async (c) => (await c.query("UPDATE lab.results SET value_text = 'probe' WHERE id = $1 AND status = 'pending'", [A.resultId])).rowCount);
    expect(n).toBe(1);
  });
  it('UPDATE lab.result_versions SET value_numeric => immutable_row', { timeout: T }, async () => {
    const e = await rejects(asA((c) => c.query('UPDATE lab.result_versions SET value_numeric = 6 WHERE result_id = $1', [approvedResultId])));
    expect(e.message).toBe('immutable_row');
  });
  it('an approved result cannot be moved back to another status (verified / pending / cancelled)', { timeout: T }, async () => {
    for (const s of ['pending', 'verified', 'cancelled']) {
      const e = await rejects(asA((c) => c.query('UPDATE lab.results SET status = $2 WHERE id = $1', [approvedResultId, s])));
      expect(e.message, s).toBe('immutable_row');
    }
  });
  it('UPDATE of a cancelled result is frozen too', { timeout: T }, async () => {
    const id = uid();
    await asOwner(TENANT_A, (c) => ins(c, 'lab.results', { id, tenant_id: TENANT_A, centre_id: A.centre, order_id: A.orderId, order_item_id: A.itemId, order_test_id: A.orderTestId, specimen_id: A.specimenId, patient_id: A.patientId,
      test_id: A.testId, analyte_id: uid(), analyte_code: 'T32C', department_id: uid(), is_reportable: true, result_type: 'numeric', status: 'cancelled', cancelled_at: '2026-06-15T04:50:00.000Z', cancel_reason: 'specimen_rejected' }));
    expect((await rejects(asA((c) => c.query("UPDATE lab.results SET value_text = 'x' WHERE id = $1", [id])))).message).toBe('immutable_row');
  });
});

describe.skipIf(!live)('S-05 critical notifications are append-only', () => {
  it('UPDATE and DELETE on lab.critical_notifications => permission denied', { timeout: T }, async () => {
    expect((await rejects(asA((c) => c.query("UPDATE lab.critical_notifications SET comment = 'edited' WHERE tenant_id = $1", [TENANT_A])))).code).toBe('42501');
    expect((await rejects(asA((c) => c.query('DELETE FROM lab.critical_notifications WHERE tenant_id = $1', [TENANT_A])))).code).toBe('42501');
    expect(Number((await owner('SELECT count(*)::int AS n FROM lab.critical_notifications WHERE tenant_id = $1', [TENANT_A]))[0].n)).toBeGreaterThanOrEqual(1);
  });
});

describe.skipIf(!live)('S-07 attachment with a foreign tenant prefix', () => {
  const row = (path: string) => ({ id: uid(), tenant_id: TENANT_A, centre_id: A.centre, result_id: A.resultId, bucket: 'lab-results', object_path: path, sha256: 'a'.repeat(64), mime_type: 'application/pdf' });
  it('direct insert: object_path under tenant B\'s prefix => CHECK result_attachments__path_tenant__ck rejects (even for the superuser)', { timeout: T }, async () => {
    const e = await rejects(asOwner(TENANT_A, (c) => ins(c, 'lab.result_attachments', row(`${TENANT_B}/results/${uid()}.pdf`))));
    expect(e.message).toMatch(/result_attachments__path_tenant__ck/);
    const mine = await asOwner(TENANT_A, (c) => ins(c, 'lab.result_attachments', row(`${TENANT_A}/results/${uid()}.pdf`)).then(() => 'ok'));   // control
    expect(mine).toBe('ok');
  });
  it('as lims_api the same insert is rejected too', { timeout: T }, async () => {
    const e = await rejects(asA((c) => ins(c, 'lab.result_attachments', row(`${TENANT_B}/x/${uid()}.pdf`))));
    expect(e.message).toMatch(/result_attachments__path_tenant__ck|row-level security|permission denied/);
  });
});

describe.skipIf(!live)('S-23 non-staff actor types see nothing', () => {
  it.each(['partner', 'portal', 'patient'])('actor_type %s: 0 rows of every tenant-scoped lab table (tenant A has rows)', { timeout: T }, async (actorType) => {
    const claims = claimsOf(TENANT_A, { actor_type: actorType });
    for (const t of LAB_TENANT_TABLES) {
      const n = await withClaims(api(), claims, async (c) => Number((await c.query(`SELECT count(*)::int AS n FROM lab.${t}`)).rows[0].n)).catch((e: any) => { expect(e?.code, `${t}`).toBe('42501'); return 0; });
      expect(n, `${actorType} sees ${n} rows of lab.${t}`).toBe(0);
    }
    expect(Number((await owner('SELECT count(*)::int AS n FROM lab.specimens WHERE tenant_id = $1', [TENANT_A]))[0].n)).toBeGreaterThan(0);
  });
  it('a device actor has no all-centres reach: a device of a centre with no objects sees 0 specimens', { timeout: T }, async () => {
    const n = await withClaims(api(), claimsOf(TENANT_A, { actor_type: 'device', centre_id: uid() }), async (c) => Number((await c.query('SELECT count(*)::int AS n FROM lab.specimens')).rows[0].n));
    expect(n).toBe(0);
  });
});
