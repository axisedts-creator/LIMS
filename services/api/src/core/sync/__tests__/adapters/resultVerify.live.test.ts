// T0B-SYNC-4 done_when (2), (5), (6): result.verify re-checks the T0B-VERLEVEL-1 policy AT SYNC TIME through the real engine + the real adapters (result.verify, result.enter, report.print_marker) on a
// real PG17 (RLS on). The lab SERVICE LAYER (verifyResult / approveResult, which own the policy) is a recording double that refuses with the codes of signoff.service.ts; the policy itself is
// covered by the lab verlevel suite. Pinned seams: ./doubles4.ts header. Pathologist = holds lab.result.approve in IdentityPort.getActor().permissions (assertRole of that privileged code needs aal2).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../../../modules/lab/service/result.service.js', async (orig) => (await import('./doubles4.js')).resultMock(orig as never));
vi.mock('../../../../modules/billing/service/cash.service.js', async (orig) => (await import('./doubles4.js')).cashMock(orig as never));
import { LimsError } from '../../../errors.js';
import { A1, B1, TENANT_A, USER, devicePush, engine, iso, ledger, newDevice, NOW, okBody, op, uid } from '../helpers2.js';
import { POLICY_CODES, alertRows, behave, calls, clearAll, effect, effectTags, ensure4, flags, markerRows, markerPayload, refuse, reports, reset, results, seams, verifyRows } from './doubles4.js';
import { createResultVerifyAdapter, resultVerifyAdapter } from '../../../../modules/lab/sync/resultVerify.adapter.js';
import { createResultEnterAdapter } from '../../../../modules/lab/sync/resultEnter.adapter.js';
import { createReportPrintMarkerAdapter } from '../../../../modules/reporting/sync/printMarker.adapter.js';

const T = 120_000;
const S = seams();
const H = engine({}, [createResultVerifyAdapter(S), createResultEnterAdapter(S), createReportPrintMarkerAdapter(S)]);
const HD = engine({}, [resultVerifyAdapter]);   // default seams
const PATH = { actorPermissions: ['lab.result.approve', 'lab.result.verify'] };
const one = (o: any): any => okBody(o).results[0];
const verify = (id: string, v: number, o: Record<string, unknown> = {}): any => op('result.verify', { entity_id: id, base_version: v, payload: {}, ...o });
const marker = (reportVersionId: string, o: Record<string, unknown> = {}): any => op('report.print_marker', { entity_id: reportVersionId, payload: markerPayload(), ...o });
const res = (status = 'entered', version = 3): string => { const id = uid(); results.set(id, { status, version }); return id; };
/** the double moves the result like the online service: a successful verify makes it verified (final policy) at version + 1 */
const finalising = (): void => { behave.verify = async (ctx: any, i: any) => { await effect(ctx, `verify:${i.resultId}`, i.resultId); results.set(i.resultId, { status: 'verified', version: i.version + 1 }); return { id: i.resultId, status: 'verified' }; }; };
beforeAll(ensure4, T);
beforeEach(async () => { reset(); await clearAll(); });
afterAll(clearAll, T);

describe('result.verify accepted (done_when 2)', () => {
  it('policy passes: accepted with the result id; the service got the result id, the base version as the version to sign, the acknowledged flags, and the SAME actor and tenant', async () => {
    const dev = await newDevice(A1);
    const id = res(); const r = verify(id, 3, { payload: { acknowledged_flags: ['critical'] } });
    expect(one(await devicePush(H, A1, dev, [r]))).toMatchObject({ op_id: r.op_id, status: 'accepted', entity_id: id });
    expect(calls.verify).toHaveLength(1);
    const { ctx, args } = calls.verify[0]!;
    expect(ctx.tenantId).toBe(TENANT_A); expect(ctx.actor).toMatchObject({ id: USER.a1 });
    expect(args[0]).toEqual({ resultId: id, version: 3, acknowledgedFlags: ['critical'] });
    expect(calls.approve).toHaveLength(0); expect(await alertRows(TENANT_A)).toHaveLength(0);
    expect((await verifyRows([r.op_id])).map((x) => [x.result_id, x.outcome])).toEqual([[id, 'accepted']]);
  }, T);
  it('without acknowledged flags the service call carries none (no empty list invented)', async () => {
    const dev = await newDevice(A1);
    const id = res(); await devicePush(H, A1, dev, [verify(id, 3)]);
    expect(calls.verify[0]!.args[0]).toEqual({ resultId: id, version: 3 });
  }, T);
  it('the first of two required sign offs (level 2 or 3: not final yet) is accepted like any other', async () => {
    const dev = await newDevice(A1);
    behave.verify = async (ctx: any, i: any) => { await effect(ctx, `verify:${i.resultId}`, i.resultId); return { id: i.resultId, status: 'entered', signoff_count: 1, signoff_required: 2 }; };
    expect(one(await devicePush(H, A1, dev, [verify(res(), 3)])).status).toBe('accepted');
  }, T);
});

describe('result.verify refused by the policy at sync time: rejected, recall, alert (done_when 2, 6)', () => {
  it.each([
    ['sign off by the enterer', 'lab.enterer_cannot_verify'], ['not enough distinct people (the same person signs twice)', 'lab.verifier_not_distinct'],
    ['result already final / superseded by the chain', 'lab.result_invalid_transition'],
  ])('%s (%s): rejected sync.verification_policy_failed, no effect of the service remains, an alert with the original code, the failed outcome recorded', async (_n, lab) => {
    const dev = await newDevice(A1);
    behave.verify = async (ctx: any, i: any) => { await effect(ctx, `half:${i.resultId}`, i.resultId); throw new LimsError(lab as never); };
    const id = res(); const r = verify(id, 3);
    expect(one(await devicePush(H, A1, dev, [r]))).toMatchObject({ op_id: r.op_id, status: 'rejected', error_code: 'sync.verification_policy_failed' });
    expect(await effectTags([`half:${id}`])).toHaveLength(0);
    const al = await alertRows(TENANT_A);
    expect(al).toHaveLength(1); expect(al[0]).toMatchObject({ kind: 'verification_policy_failed', op_id: r.op_id, result_id: id, code: lab });
    expect((await verifyRows([r.op_id])).map((x) => x.outcome)).toEqual(['rejected']);
    expect((await ledger([r.op_id]))[0]).toMatchObject({ status: 'rejected', error_code: 'sync.verification_policy_failed' });
  }, T);
  it('a final sign off that needs a pathologist, signed by someone who is not one (wrong role): rejected sync.verification_policy_failed, approveResult is never called', async () => {
    const dev = await newDevice(A1);
    behave.verify = refuse('lab.pathologist_required'); flags.offlineApproval = true;
    expect(one(await devicePush(H, A1, dev, [verify(res(), 3)]))).toMatchObject({ status: 'rejected', error_code: 'sync.verification_policy_failed' });
    expect(calls.approve).toHaveLength(0);
  }, T);
  it('the result moved on (version differs: superseded): rejected sync.verification_policy_failed, the service is not called, the alert is written', async () => {
    const dev = await newDevice(A1);
    const id = res('entered', 7);
    expect(one(await devicePush(H, A1, dev, [verify(id, 3)]))).toMatchObject({ status: 'rejected', error_code: 'sync.verification_policy_failed' });
    expect(calls.verify).toHaveLength(0); expect(await alertRows(TENANT_A)).toHaveLength(1);
  }, T);
  it('RECALL: every report printed offline on this result (pending or already confirmed) becomes recall_required and the alert lists ALL their report version ids', async () => {
    const dev = await newDevice(A1);
    finalising();
    const [rid, other] = [res(), res()];
    const [rep1, rep2, rep3] = [uid(), uid(), uid()];
    reports.set(rep1, [rid]); reports.set(rep2, [rid, other]); reports.set(rep3, [other]);
    const v1 = verify(rid, 3, { device_created_at: iso(new Date(NOW.getTime() - 5 * 3_600_000)) });
    const m1 = marker(rep1, { device_created_at: iso(new Date(NOW.getTime() - 4 * 3_600_000)) }), m2 = marker(rep2, { device_created_at: iso(new Date(NOW.getTime() - 3 * 3_600_000)) }), m3 = marker(rep3);
    okBody(await devicePush(H, A1, dev, [v1, m1, m2, m3]));
    expect((await markerRows([m1.op_id, m2.op_id])).map((x) => x.state)).toEqual(expect.arrayContaining(['pending', 'confirmed']));   // m2 waits for `other`
    // later the same result is signed again from another offline sync by the same person: the policy refuses it and the earlier prints rest on a sign off the server does not accept
    behave.verify = refuse('lab.verifier_not_distinct');
    const bad = verify(rid, 4, { device_created_at: iso(new Date(NOW.getTime() - 2 * 3_600_000)) });
    expect(one(await devicePush(H, A1, dev, [bad]))).toMatchObject({ status: 'rejected', error_code: 'sync.verification_policy_failed' });
    const state = Object.fromEntries((await markerRows([m1.op_id, m2.op_id, m3.op_id])).map((x) => [x.op_id, x.state]));
    expect(state[m1.op_id]).toBe('recall_required'); expect(state[m2.op_id]).toBe('recall_required');
    expect(state[m3.op_id]).not.toBe('recall_required');   // a report that does not show this result is untouched
    const al = (await alertRows(TENANT_A)).filter((x) => x.op_id === bad.op_id);
    expect(al).toHaveLength(1); expect([...al[0].report_ids].sort()).toEqual([rep1, rep2].sort());
  }, T);
  it('no report was printed on it: the alert is still written, with an empty report list, and nothing else changes', async () => {
    const dev = await newDevice(A1);
    behave.verify = refuse('lab.enterer_cannot_verify');
    const r = verify(res(), 3); await devicePush(H, A1, dev, [r]);
    const al = await alertRows(TENANT_A);
    expect(al).toHaveLength(1); expect(al[0].report_ids ?? []).toEqual([]);
  }, T);
  it('the alert carries ids and codes only: no value, no person name', async () => {
    const dev = await newDevice(A1);
    behave.verify = async () => { throw new LimsError('lab.enterer_cannot_verify', 'Sync Testperson Alpha'); };
    await devicePush(H, A1, dev, [verify(res(), 3)]);
    expect(JSON.stringify(await alertRows(TENANT_A))).not.toContain('Testperson');
  }, T);
  it('POLICY_CODES are the whole set that means a policy failure: any other refusal keeps its own code and recalls NOTHING (on hold, flag not acknowledged, stale precondition)', async () => {
    const dev = await newDevice(A1);
    expect(POLICY_CODES).toHaveLength(4);
    for (const lab of ['lab.result_on_hold', 'lab.flag_ack_required']) {
      behave.verify = refuse(lab);
      expect(one(await devicePush(H, A1, dev, [verify(res(), 3)]))).toMatchObject({ status: 'rejected', error_code: lab });
    }
    expect(await alertRows(TENANT_A)).toHaveLength(0);
    behave.verify = async () => { throw new Error('boom Sync Testperson Alpha'); };
    const o = await devicePush(H, A1, dev, [verify(res(), 3)]);
    expect(one(o)).toMatchObject({ status: 'rejected', error_code: 'common.internal' });
    expect(JSON.stringify(o.reply!.body) + o.logs.join('\n')).not.toContain('Testperson');
  }, T);
});

describe('approval that needs MFA step up from an offline device (done_when 5)', () => {
  it('a pathologist final sign off, tenant policy off (default): rejected sync.offline_not_allowed, approveResult NOT called, nothing signed', async () => {
    const dev = await newDevice(A1);
    behave.verify = refuse('lab.pathologist_required');
    const id = res(); const r = verify(id, 3);
    expect(one(await devicePush(H, A1, dev, [r], PATH))).toMatchObject({ status: 'rejected', error_code: 'sync.offline_not_allowed' });
    expect(calls.approve).toHaveLength(0); expect(await effectTags([`approve:${id}`])).toHaveLength(0);
  }, T);
  it('tenant policy allows offline approval and the signer is a (locally signed in) pathologist: approveResult runs, accepted, and the audit event records the OFFLINE APPROVAL with the op id and the device time', async () => {
    const dev = await newDevice(A1);
    behave.verify = refuse('lab.pathologist_required'); flags.offlineApproval = true;
    const id = res(); const at = iso(new Date(NOW.getTime() - 6 * 3_600_000)); const r = verify(id, 3, { device_created_at: at });
    const audits: any[] = [];
    expect(one(await devicePush(H, A1, dev, [r], { ...PATH, audits }))).toMatchObject({ status: 'accepted', entity_id: id });
    expect(calls.approve).toHaveLength(1); expect(calls.approve[0]!.args[0]).toEqual({ resultId: id, version: 3 });
    expect(calls.approve[0]!.ctx.actor).toMatchObject({ id: USER.a1 });
    const ev = audits.find((a) => a.detail?.event === 'offline_approval');
    expect(ev).toBeTruthy(); expect(ev).toMatchObject({ entityType: 'result', entityId: id, outcome: 'allowed' });
    expect(ev.detail).toMatchObject({ op_id: r.op_id, device_created_at: at });
    expect((await verifyRows([r.op_id])).map((x) => x.outcome)).toEqual(['accepted']);
  }, T);
  it('policy allows it but the signer is NOT a pathologist: still the policy failure (wrong role), approveResult never called', async () => {
    const dev = await newDevice(A1);
    behave.verify = refuse('lab.pathologist_required'); flags.offlineApproval = true;
    expect(one(await devicePush(H, A1, dev, [verify(res(), 3)], { actorPermissions: ['lab.result.verify'] }))).toMatchObject({ status: 'rejected', error_code: 'sync.verification_policy_failed' });
    expect(calls.approve).toHaveLength(0);
  }, T);
  it('an ordinary verify (no approval needed) never touches the offline approval path or its audit event, whatever the tenant policy says', async () => {
    const dev = await newDevice(A1);
    flags.offlineApproval = true; const audits: any[] = [];
    expect(one(await devicePush(H, A1, dev, [verify(res(), 3)], { ...PATH, audits })).status).toBe('accepted');
    expect(calls.approve).toHaveLength(0); expect(audits.some((a) => a.detail?.event === 'offline_approval')).toBe(false);
  }, T);
  it('the approval refused by the service even when allowed (e.g. self approval) is a per operation rejection with its closed code and no audit of an approval', async () => {
    const dev = await newDevice(A1);
    behave.verify = refuse('lab.pathologist_required'); behave.approve = refuse('lab.self_approval_forbidden'); flags.offlineApproval = true;
    const audits: any[] = [];
    const rs = one(await devicePush(H, A1, dev, [verify(res(), 3)], { ...PATH, audits }));
    expect(rs.status).toBe('rejected'); expect(['sync.verification_policy_failed', 'common.internal', 'lab.self_approval_forbidden']).toContain(rs.error_code);
    expect(audits.some((a) => a.detail?.event === 'offline_approval' && a.outcome === 'allowed')).toBe(false);
  }, T);
});

describe('result.verify: replay, order, permission, tenant, shape (done_when 6)', () => {
  it('replay: duplicate with the first outcome, the service ran once; replay of a policy failure: duplicate, ONE alert, ONE recorded outcome', async () => {
    const dev = await newDevice(A1);
    const ok1 = verify(res(), 3); await devicePush(H, A1, dev, [ok1]);
    expect(one(await devicePush(H, A1, dev, [ok1]))).toMatchObject({ status: 'duplicate' }); expect(calls.verify).toHaveLength(1);
    behave.verify = refuse('lab.verifier_not_distinct');
    const bad = verify(res(), 3); await devicePush(H, A1, dev, [bad]);
    expect(one(await devicePush(H, A1, dev, [bad]))).toMatchObject({ status: 'duplicate', error_code: 'sync.verification_policy_failed' });
    expect(await alertRows(TENANT_A)).toHaveLength(1); expect(await verifyRows([bad.op_id])).toHaveLength(1);
  }, T);
  it('out of order: verify sent before its result.enter in the array runs AFTER it (device time order); results answer in the order sent', async () => {
    const dev = await newDevice(A1);
    const id = res('entered', 1);
    const e = op('result.enter', { payload: { entries: [{ result_id: id, version: 1, value_numeric: '1' }] } }, new Date(NOW.getTime() - 4 * 3_600_000));
    const v = verify(id, 1, { device_created_at: iso(new Date(NOW.getTime() - 2 * 3_600_000)) });
    const rs = okBody(await devicePush(H, A1, dev, [v, e])).results;
    expect(rs.map((r: any) => r.op_id)).toEqual([v.op_id, e.op_id]);
    expect(calls.order).toEqual(['enter', 'verify']);
  }, T);
  it('permission removed meanwhile: auth.forbidden for lab.result.verify, the service is not called, no alert, no recall', async () => {
    const dev = await newDevice(A1);
    const o = await devicePush(H, A1, dev, [verify(res(), 3)], { grants: { codes: ['sync.use'] } });
    expect(one(o)).toMatchObject({ status: 'rejected', error_code: 'auth.forbidden' }); expect(o.asserted).toContain('lab.result.verify');
    expect(calls.verify).toHaveLength(0); expect(await alertRows(TENANT_A)).toHaveLength(0);
  }, T);
  it('unknown result: common.not_found (no alert, no recall); cross tenant on the DEFAULT seam under RLS: common.not_found', async () => {
    const dev = await newDevice(A1);
    expect(one(await devicePush(H, A1, dev, [verify(uid(), 3)]))).toMatchObject({ status: 'rejected', error_code: 'common.not_found' });
    expect(await alertRows(TENANT_A)).toHaveLength(0);
    const devB = await newDevice(B1);
    expect(one(await devicePush(HD, B1, devB, [verify(uid(), 3)]))).toMatchObject({ status: 'rejected', error_code: 'common.not_found' });
    expect(calls.verify).toHaveLength(0);
  }, T);
  it('payload shape: an unknown key is common.validation_failed; base_version and entity_id are required by the catalogue (400 for the request)', async () => {
    const dev = await newDevice(A1);
    expect(one(await devicePush(H, A1, dev, [verify(res(), 3, { payload: { surplus: true } })]))).toMatchObject({ status: 'rejected', error_code: 'common.validation_failed' });
    expect(calls.verify).toHaveLength(0);
  }, T);
});
