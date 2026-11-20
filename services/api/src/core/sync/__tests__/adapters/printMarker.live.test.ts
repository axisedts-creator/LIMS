// T0B-SYNC-4 done_when (3), (6): report.print_marker through the real engine + the real adapters on a real PG17 (RLS on). The marker records that a report was printed offline (watermark issued
// offline, pending sync). It is stored PENDING; CONFIRMED when no sign off it relied on was rejected and every result of the report is verified / approved on the server; RECALL_REQUIRED (+ an alert
// to the lab manager with the report ids) when a relied on sign off was rejected. Seams and the pinned rule: ./doubles4.ts header. The print path that adds the issued offline marker while pending
// is tested in modules/reporting/__tests__/printOffline.test.ts.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../../../modules/lab/service/result.service.js', async (orig) => (await import('./doubles4.js')).resultMock(orig as never));
vi.mock('../../../../modules/billing/service/cash.service.js', async (orig) => (await import('./doubles4.js')).cashMock(orig as never));
import { A1, B1, TENANT_A, USER, devicePush, engine, iso, ledger, newDevice, NOW, okBody, op, uid } from '../helpers2.js';
import { alertRows, behave, calls, clearAll, effect, ensure4, markerPayload, markerRows, refuse, reports, reset, results, seams } from './doubles4.js';
import { createResultVerifyAdapter } from '../../../../modules/lab/sync/resultVerify.adapter.js';
import { createReportPrintMarkerAdapter, reportPrintMarkerAdapter } from '../../../../modules/reporting/sync/printMarker.adapter.js';

const T = 120_000;
const S = seams();
const H = engine({}, [createReportPrintMarkerAdapter(S), createResultVerifyAdapter(S)]);
const HD = engine({}, [reportPrintMarkerAdapter]);   // default seams
const one = (o: any): any => okBody(o).results[0];
const at = (hoursAgo: number): string => iso(new Date(NOW.getTime() - hoursAgo * 3_600_000));
const marker = (rep: string, o: Record<string, unknown> = {}): any => op('report.print_marker', { entity_id: rep, payload: markerPayload(), device_created_at: at(1), ...o });
const verify = (id: string, v: number, o: Record<string, unknown> = {}): any => op('result.verify', { entity_id: id, base_version: v, payload: {}, device_created_at: at(3), ...o });
const res = (status = 'entered', version = 3): string => { const id = uid(); results.set(id, { status, version }); return id; };
const report = (...resultIds: string[]): string => { const id = uid(); reports.set(id, resultIds); return id; };
const finalising = (): void => { behave.verify = async (ctx: any, i: any) => { await effect(ctx, `verify:${i.resultId}`, i.resultId); results.set(i.resultId, { status: 'verified', version: i.version + 1 }); return { id: i.resultId, status: 'verified' }; }; };
const stateOf = async (m: any): Promise<string | undefined> => (await markerRows([m.op_id]))[0]?.state;
beforeAll(ensure4, T);
beforeEach(async () => { reset(); await clearAll(); });
afterAll(clearAll, T);

describe('report.print_marker: pending, confirmed or recall (done_when 3)', () => {
  it('stored: accepted with the report version id; the marker row names the report, the device and the results it shows', async () => {
    const dev = await newDevice(A1);
    const rid = res('entered'); const rep = report(rid); const m = marker(rep);
    expect(one(await devicePush(H, A1, dev, [m]))).toMatchObject({ op_id: m.op_id, status: 'accepted', entity_id: rep });
    const [row] = await markerRows([m.op_id]);
    expect(row).toMatchObject({ report_version_id: rep, state: 'pending' });
  }, T);
  it('every sign off it relied on is accepted, and the results are verified on the server: CONFIRMED at once, no alert', async () => {
    const dev = await newDevice(A1); finalising();
    const [a, b] = [res(), res()]; const rep = report(a, b);
    const m = marker(rep);
    okBody(await devicePush(H, A1, dev, [verify(a, 3), verify(b, 3, { device_created_at: at(2) }), m]));
    expect(await stateOf(m)).toBe('confirmed'); expect(await alertRows(TENANT_A)).toHaveLength(0);
  }, T);
  it('results verified online beforehand (no offline sign off to wait for): confirmed at once', async () => {
    const dev = await newDevice(A1);
    const m = marker(report(res('verified', 4), res('approved', 6)));
    expect(one(await devicePush(H, A1, dev, [m])).status).toBe('accepted'); expect(await stateOf(m)).toBe('confirmed');
  }, T);
  it('a result still without a final sign off on the server: the marker STAYS pending, no alert yet; a LATER accepted sign off of the last one confirms it', async () => {
    const dev = await newDevice(A1); finalising();
    const [a, b] = [res('verified', 4), res('entered', 3)]; const m = marker(report(a, b));
    await devicePush(H, A1, dev, [m]);
    expect(await stateOf(m)).toBe('pending'); expect(await alertRows(TENANT_A)).toHaveLength(0);
    expect(one(await devicePush(H, A1, dev, [verify(b, 3, { device_created_at: at(0.5) })])).status).toBe('accepted');
    expect(await stateOf(m)).toBe('confirmed');
  }, T);
  it('a relied on sign off was REJECTED earlier in the same batch: the marker is recorded as recall_required, the alert goes to the lab manager with the report id (the operation itself is accepted: it is a record)', async () => {
    const dev = await newDevice(A1);
    behave.verify = refuse('lab.enterer_cannot_verify');
    const id = res(); const rep = report(id); const v = verify(id, 3), m = marker(rep);
    const rs = okBody(await devicePush(H, A1, dev, [v, m])).results;
    expect(rs[0]).toMatchObject({ status: 'rejected', error_code: 'sync.verification_policy_failed' }); expect(rs[1]).toMatchObject({ status: 'accepted', entity_id: rep });
    expect(await stateOf(m)).toBe('recall_required');
    const al = (await alertRows(TENANT_A)).filter((x) => x.op_id === m.op_id || x.op_id === v.op_id);
    expect(al.length).toBeGreaterThan(0); expect(al.flatMap((x) => x.report_ids ?? [])).toContain(rep);
  }, T);
  it('a relied on sign off rejected LATER (pending marker): the marker becomes recall_required and the alert lists the report id', async () => {
    const dev = await newDevice(A1); finalising();
    const [a, b] = [res('verified', 4), res('entered', 3)]; const rep = report(a, b); const m = marker(rep);
    await devicePush(H, A1, dev, [m]);
    behave.verify = refuse('lab.verifier_not_distinct');
    expect(one(await devicePush(H, A1, dev, [verify(b, 3, { device_created_at: at(0.5) })]))).toMatchObject({ status: 'rejected', error_code: 'sync.verification_policy_failed' });
    expect(await stateOf(m)).toBe('recall_required');
    expect((await alertRows(TENANT_A)).flatMap((x) => x.report_ids ?? [])).toContain(rep);
  }, T);
  it('a recalled marker is never confirmed again by a later accepted sign off (recall_required is final until a person acts)', async () => {
    const dev = await newDevice(A1);
    const id = res(); const rep = report(id); const m = marker(rep);
    behave.verify = refuse('lab.verifier_not_distinct');
    await devicePush(H, A1, dev, [verify(id, 3), m]);
    expect(await stateOf(m)).toBe('recall_required');
    finalising(); results.set(id, { status: 'entered', version: 3 });
    await devicePush(H, A1, dev, [verify(id, 3, { device_created_at: at(0.2) })]);
    expect(await stateOf(m)).toBe('recall_required');
  }, T);
  it('the audit event of the print records the report version, the op id and the DEVICE time; no patient data, no file name', async () => {
    const dev = await newDevice(A1);
    const rep = report(res('verified', 4)); const m = marker(rep, { device_created_at: at(2) }); const audits: any[] = [];
    await devicePush(H, A1, dev, [m], { audits });
    const ev = audits.find((a) => a.action === 'report.print' && a.entityId === rep);
    expect(ev).toBeTruthy(); expect(ev).toMatchObject({ entityType: 'report_version', outcome: 'allowed' });
    expect(ev.detail).toMatchObject({ offline: true, op_id: m.op_id, device_created_at: at(2) });
    expect(JSON.stringify(audits)).not.toMatch(/Testperson|\.pdf/);
  }, T);
  it('the marker never calls the online print service twice: no verify / approve / enter / close side effect from a marker', async () => {
    const dev = await newDevice(A1);
    await devicePush(H, A1, dev, [marker(report(res('verified', 4)))]);
    expect(calls.verify.length + calls.approve.length + calls.enter.length + calls.close.length).toBe(0);
  }, T);
});

describe('report.print_marker: replay, order, permission, tenant, shape (done_when 6)', () => {
  it('replay: duplicate, ONE marker row; two different prints of the same report are two markers', async () => {
    const dev = await newDevice(A1);
    const rep = report(res('verified', 4)); const m = marker(rep);
    await devicePush(H, A1, dev, [m]);
    expect(one(await devicePush(H, A1, dev, [m]))).toMatchObject({ status: 'duplicate', entity_id: rep });
    expect(await markerRows([m.op_id])).toHaveLength(1);
    const m2 = marker(rep, { device_created_at: at(0.5) }); await devicePush(H, A1, dev, [m2]);
    expect(await markerRows([m.op_id, m2.op_id])).toHaveLength(2);
  }, T);
  it('out of order: the print sent before its sign off in the array is applied AFTER it (device time order) and is confirmed', async () => {
    const dev = await newDevice(A1); finalising();
    const id = res(); const rep = report(id);
    const m = marker(rep, { device_created_at: at(1) }), v = verify(id, 3, { device_created_at: at(2) });
    const rs = okBody(await devicePush(H, A1, dev, [m, v])).results;
    expect(rs.map((r: any) => r.op_id)).toEqual([m.op_id, v.op_id]); expect(calls.order).toEqual(['verify']);
    expect(await stateOf(m)).toBe('confirmed');
  }, T);
  it('permission removed meanwhile: auth.forbidden for reporting.report.print, no marker stored', async () => {
    const dev = await newDevice(A1);
    const m = marker(report(res('verified', 4)));
    const o = await devicePush(H, A1, dev, [m], { grants: { codes: ['sync.use'] } });
    expect(one(o)).toMatchObject({ status: 'rejected', error_code: 'auth.forbidden' }); expect(o.asserted).toContain('reporting.report.print');
    expect(await markerRows([m.op_id])).toHaveLength(0);
  }, T);
  it('unknown report version: common.not_found, nothing stored; cross tenant on the DEFAULT seam under RLS: common.not_found', async () => {
    const dev = await newDevice(A1); const m = marker(uid());
    expect(one(await devicePush(H, A1, dev, [m]))).toMatchObject({ status: 'rejected', error_code: 'common.not_found' });
    expect(await markerRows([m.op_id])).toHaveLength(0);
    const devB = await newDevice(B1);
    expect(one(await devicePush(HD, B1, devB, [marker(uid())]))).toMatchObject({ status: 'rejected', error_code: 'common.not_found' });
  }, T);
  it('payload shape: variant and copies are required, an unknown key is refused: common.validation_failed for the operation', async () => {
    const dev = await newDevice(A1);
    const rep = report(res('verified', 4));
    const rs = okBody(await devicePush(H, A1, dev, [marker(rep, { payload: { variant: 'plain' } }), marker(rep, { payload: { variant: 'plain', copies: 1, surplus: 1 } })])).results;
    for (const r of rs) expect(r).toMatchObject({ status: 'rejected', error_code: 'common.validation_failed' });
  }, T);
  it('the ledger keeps both device and server time of the print operation (audit trail of an offline print)', async () => {
    const dev = await newDevice(A1);
    const m = marker(report(res('verified', 4)), { device_created_at: at(5) });
    await devicePush(H, A1, dev, [m]);
    const [l] = await ledger([m.op_id]);
    expect(new Date(l.device_created_at).toISOString()).toBe(new Date(at(5)).toISOString()); expect(l.server_received_at).toBeTruthy(); expect(l.user_id).toBe(USER.a1);
  }, T);
});
