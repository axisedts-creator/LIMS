// T0B-SYNC-4 review item 2 (done_when 2, 3, 6): the PRODUCTION stores of core/sync/offlineSignoffs.ts (syncAlerts, syncSignoffs, pendingMarkers) and the DDL of migration
// 20261118100000 (core.sync_alert, core.sync_print_marker, core.sync_signoff_outcome, trigger core.sync_print_marker__state_move) on the throwaway PG17, as the app role (lims_app) under RLS.
// Every other live adapter test injects the sync2_test doubles for alerts / sign offs / markers; this file injects NONE of them. Only the lab service layer (verifyResult, the policy owner)
// is the vi.mock recording double, and the two READ seams that would need a full lab / reporting fixture (readResult, resultsOfReport) stay the in memory doubles of doubles4.ts.
// Cross tenant: tenant B sees none of tenant A's rows, cannot write with tenant A's id, cannot move a marker of tenant A. Recall must persist: the state moves only forward.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../../../modules/lab/service/result.service.js', async (orig) => (await import('./doubles4.js')).resultMock(orig as never));
vi.mock('../../../../modules/billing/service/cash.service.js', async (orig) => (await import('./doubles4.js')).cashMock(orig as never));
import { A1, B1, TENANT_A, TENANT_B, devicePush, engine, iso, newDevice, NOW, okBody, op, ownerRows, superTx, uid, withCtx } from '../helpers2.js';
import { behave, clearAll, ensure4, markerPayload, readResult, refuse, reports, reset, resultsOfReport, results } from './doubles4.js';
import { createResultVerifyAdapter } from '../../../../modules/lab/sync/resultVerify.adapter.js';
import { createReportPrintMarkerAdapter } from '../../../../modules/reporting/sync/printMarker.adapter.js';
import { pendingMarkers } from '../../offlineSignoffs.js';

const T = 120_000;
// production alerts + sign off store: no `alerts`, no `signoffs` seam
const H = engine({}, [createResultVerifyAdapter({ readResult }), createReportPrintMarkerAdapter({ readResult, resultsOfReport })]);
const one = (o: any): any => okBody(o).results[0];
const at = (hoursAgo: number): string => iso(new Date(NOW.getTime() - hoursAgo * 3_600_000));
const marker = (rep: string): any => op('report.print_marker', { entity_id: rep, payload: markerPayload(), device_created_at: at(2) });
const verify = (id: string, v: number): any => op('result.verify', { entity_id: id, base_version: v, payload: {}, device_created_at: at(1) });
const fixture = (): { rid: string; rep: string } => { const rid = uid(); const rep = uid(); results.set(rid, { status: 'entered', version: 3 }); reports.set(rep, [rid]); return { rid, rep }; };
const pending = (tenant: string, who: typeof A1, rep: string) => withCtx(who, (ctx) => pendingMarkers.isPending(ctx.tx, tenant, rep));
const markerRow = async (opId: string) => (await ownerRows('SELECT * FROM core.sync_print_marker WHERE op_id = $1', [opId]))[0];
const msg = (o: { error?: any }): string => String(o.error?.message ?? '');
beforeAll(ensure4, T);
beforeEach(async () => { reset(); await clearAll(); });
afterAll(clearAll, T);

describe('production stores: a rejected sign off recalls the pending offline print (done_when 2, 3)', () => {
  it('print marker stored pending; the rejected verify writes ONE alert row (ids and codes only), ONE rejected sign off row, and moves the marker to recall_required; isPending flips true -> false', async () => {
    const dev = await newDevice(A1); const { rid, rep } = fixture(); const m = marker(rep), v = verify(rid, 3);
    expect(one(await devicePush(H, A1, dev, [m]))).toMatchObject({ status: 'accepted', entity_id: rep });
    expect(await markerRow(m.op_id)).toMatchObject({ tenant_id: TENANT_A, report_version_id: rep, device_id: dev, state: 'pending', result_ids: [rid] });
    expect((await pending(TENANT_A, A1, rep)).reply).toBe(true);
    behave.verify = refuse('lab.enterer_cannot_verify');
    expect(one(await devicePush(H, A1, dev, [v]))).toMatchObject({ status: 'rejected', error_code: 'sync.verification_policy_failed' });
    const alerts = await ownerRows('SELECT * FROM core.sync_alert WHERE op_id = $1', [v.op_id]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ tenant_id: TENANT_A, kind: 'verification_policy_failed', result_id: rid, code: 'lab.enterer_cannot_verify', report_version_ids: [rep] });
    const outcomes = await ownerRows('SELECT * FROM core.sync_signoff_outcome WHERE op_id = $1', [v.op_id]);
    expect(outcomes).toHaveLength(1); expect(outcomes[0]).toMatchObject({ tenant_id: TENANT_A, device_id: dev, result_id: rid, outcome: 'rejected' });
    expect((await markerRow(m.op_id)).state).toBe('recall_required');    // the writes of a rejected operation persist (engine outcome 'rejected' keeps adapter writes)
    expect((await pending(TENANT_A, A1, rep)).reply).toBe(false);
    expect(Object.keys(alerts[0]).sort()).toEqual(['code', 'created_at', 'id', 'kind', 'op_id', 'report_version_ids', 'result_id', 'tenant_id']);   // ids and codes only: no value, no name column
  }, T);
  it('an accepted sign off is recorded accepted, raises no alert, and a later marker for a fully final report is confirmed (isPending false)', async () => {
    const dev = await newDevice(A1); const { rid, rep } = fixture(); const v = verify(rid, 3);
    behave.verify = async (_ctx: any, i: any) => { results.set(i.resultId, { status: 'verified', version: i.version + 1 }); return { id: i.resultId, status: 'verified' }; };
    expect(one(await devicePush(H, A1, dev, [v])).status).toBe('accepted');
    expect((await ownerRows('SELECT outcome FROM core.sync_signoff_outcome WHERE op_id = $1', [v.op_id])).map((r) => r.outcome)).toEqual(['accepted']);
    const m = marker(rep);
    expect(one(await devicePush(H, A1, dev, [m])).status).toBe('accepted');
    expect((await markerRow(m.op_id)).state).toBe('confirmed');
    expect(await ownerRows('SELECT 1 FROM core.sync_alert WHERE op_id = ANY($1::uuid[])', [[v.op_id, m.op_id]])).toHaveLength(0);
    expect((await pending(TENANT_A, A1, rep)).reply).toBe(false);
  }, T);
});

describe('production stores: cross tenant under RLS (done_when 6)', () => {
  it('tenant B reads none of the rows of tenant A, in any of the three tables, and isPending never answers true across tenants (not even when asked with tenant A id)', async () => {
    const dev = await newDevice(A1); const { rid, rep } = fixture(); const m = marker(rep), v = verify(rid, 3);
    await devicePush(H, A1, dev, [m]); behave.verify = refuse('lab.verifier_not_distinct'); await devicePush(H, A1, dev, [v]);
    for (const t of ['core.sync_alert', 'core.sync_print_marker', 'core.sync_signoff_outcome']) {
      expect((await ownerRows(`SELECT 1 FROM ${t} WHERE op_id = ANY($1::uuid[])`, [[m.op_id, v.op_id]])).length).toBeGreaterThan(0);                       // the rows exist ...
      const seen = await withCtx(B1, (ctx) => ctx.tx.query(`SELECT 1 FROM ${t} WHERE op_id = ANY($1::uuid[])`, [[m.op_id, v.op_id]]));
      expect(seen.error).toBeUndefined(); expect(seen.reply!.rows).toHaveLength(0);                                                                       // ... and B sees none
      const sees = await withCtx(A1, (ctx) => ctx.tx.query(`SELECT 1 FROM ${t} WHERE op_id = ANY($1::uuid[])`, [[m.op_id, v.op_id]]));
      expect(sees.reply!.rows.length).toBeGreaterThan(0);                                                                                                  // A sees its own
    }
    expect((await pending(TENANT_A, B1, rep)).reply).toBe(false); expect((await pending(TENANT_B, B1, rep)).reply).toBe(false);
  }, T);
  it('tenant B INSERT with tenant A id is refused by RLS in all three tables (the ledger row of tenant A exists, so only the policy can be the refusal)', async () => {
    const dev = await newDevice(A1); const { rid, rep } = fixture(); const m = marker(rep);
    await devicePush(H, A1, dev, [m]);
    const ins = (sql: string, values: unknown[]) => withCtx(B1, (ctx) => ctx.tx.query(sql, values));
    expect(msg(await ins(`INSERT INTO core.sync_alert (id, tenant_id, kind, op_id) VALUES ($1, $2, 'result_locked', $3)`, [uid(), TENANT_A, m.op_id]))).toMatch(/row-level security/);
    expect(msg(await ins(`INSERT INTO core.sync_signoff_outcome (tenant_id, op_id, device_id, result_id, outcome, device_created_at) VALUES ($1, $2, $3, $4, 'accepted', now())`, [TENANT_A, m.op_id, dev, rid]))).toMatch(/row-level security/);
    expect(msg(await ins(`INSERT INTO core.sync_print_marker (tenant_id, op_id, report_version_id, result_ids, device_id, device_created_at) VALUES ($1, $2, $3, $4::uuid[], $5, now())`, [TENANT_A, uid(), rep, [rid], dev]))).toMatch(/row-level security/);
    expect(await ownerRows('SELECT 1 FROM core.sync_alert WHERE tenant_id = $1 AND op_id = $2', [TENANT_A, m.op_id])).toHaveLength(0);
  }, T);
  it('tenant B cannot move a marker of tenant A (the UPDATE matches no row) and the marker stays pending', async () => {
    const dev = await newDevice(A1); const { rep } = fixture(); const m = marker(rep);
    await devicePush(H, A1, dev, [m]);
    const upd = await withCtx(B1, (ctx) => ctx.tx.query(`UPDATE core.sync_print_marker SET state = 'confirmed', updated_at = now() WHERE op_id = $1`, [m.op_id]));
    expect(upd.error).toBeUndefined(); expect(upd.reply!.rowCount).toBe(0);
    expect((await markerRow(m.op_id)).state).toBe('pending');
  }, T);
});

describe('production DDL: the marker state only moves forward (recall persists)', () => {
  const recalled = async (): Promise<{ m: any; rid: string; rep: string }> => {
    const dev = await newDevice(A1); const { rid, rep } = fixture(); const m = marker(rep);
    await devicePush(H, A1, dev, [m]); behave.verify = refuse('lab.enterer_cannot_verify'); await devicePush(H, A1, dev, [verify(rid, 3)]);
    expect((await markerRow(m.op_id)).state).toBe('recall_required');
    return { m, rid, rep };
  };
  it('recall_required -> pending (and -> confirmed) is refused with immutable_row as the app role; the row is unchanged', async () => {
    const { m } = await recalled();
    for (const to of ['pending', 'confirmed']) {
      const r = await withCtx(A1, (ctx) => ctx.tx.query(`UPDATE core.sync_print_marker SET state = $2, updated_at = now() WHERE op_id = $1`, [m.op_id, to]));
      expect(msg(r)).toMatch(/immutable_row/);
    }
    expect((await markerRow(m.op_id)).state).toBe('recall_required');
  }, T);
  it('recall_required -> pending is refused with immutable_row for the table owner too (the trigger, not only the grants)', async () => {
    const { m } = await recalled();
    await expect(superTx((tx) => tx.query(`UPDATE core.sync_print_marker SET state = 'pending' WHERE op_id = $1`, [m.op_id]))).rejects.toThrow(/immutable_row/);
    expect((await markerRow(m.op_id)).state).toBe('recall_required');
  }, T);
  it('UPDATE of result_ids is refused: immutable_row for the table owner (trigger); the app role has no UPDATE grant on the column (permission denied)', async () => {
    const { m, rid } = await recalled();
    await expect(superTx((tx) => tx.query(`UPDATE core.sync_print_marker SET result_ids = '{}'::uuid[] WHERE op_id = $1`, [m.op_id]))).rejects.toThrow(/immutable_row/);
    const app = await withCtx(A1, (ctx) => ctx.tx.query(`UPDATE core.sync_print_marker SET result_ids = '{}'::uuid[] WHERE op_id = $1`, [m.op_id]));
    expect(msg(app)).toMatch(/permission denied|immutable_row/);
    expect((await markerRow(m.op_id)).result_ids).toEqual([rid]);
  }, T);
  it('a marker, a sign off and an alert row are never deleted or rewritten by the app role (no DELETE grant, no UPDATE grant on sign offs and alerts)', async () => {
    const { m } = await recalled();
    for (const sql of ['DELETE FROM core.sync_print_marker WHERE op_id = $1', 'DELETE FROM core.sync_alert WHERE op_id = $1', 'DELETE FROM core.sync_signoff_outcome WHERE op_id = $1',
      `UPDATE core.sync_alert SET kind = 'result_locked' WHERE op_id = $1`, `UPDATE core.sync_signoff_outcome SET outcome = 'accepted' WHERE op_id = $1`]) {
      expect(msg(await withCtx(A1, (ctx) => ctx.tx.query(sql, [m.op_id])))).toMatch(/permission denied/);
    }
    expect(await ownerRows('SELECT 1 FROM core.sync_print_marker WHERE op_id = $1', [m.op_id])).toHaveLength(1);
  }, T);
});
