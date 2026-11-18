// T0B-SYNC-4 done_when (1), (6): result.enter through the real engine + the real adapter on a real PG17 (RLS on). The lab SERVICE LAYER (bulkEnterResults) is a recording double; the result state
// the adapter classifies on comes through the `readResult` seam and the lab manager alert through the `alerts` seam (./doubles4.ts header).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../../../modules/lab/service/result.service.js', async (orig) => (await import('./doubles4.js')).resultMock(orig as never));
vi.mock('../../../../modules/billing/service/cash.service.js', async (orig) => (await import('./doubles4.js')).cashMock(orig as never));
import { LimsError } from '../../../errors.js';
import { A1, B1, TENANT_A, USER, code, conflictsOf, devicePush, engine, iso, ledger, newDevice, NOW, okBody, op, uid } from '../helpers2.js';
import { alertRows, alerts, behave, calls, clearAll, effectTags, ensure4, enterPayload, flags, readResult, reset, results } from './doubles4.js';
import { createResultEnterAdapter, resultEnterAdapter } from '../../../../modules/lab/sync/resultEnter.adapter.js';

const T = 120_000;
const H = engine({}, [createResultEnterAdapter({ readResult, alerts })]);
const HD = engine({}, [resultEnterAdapter]);   // default seams
const one = (o: any): any => okBody(o).results[0];
const enter = (resultId: string, version = 1, o: Record<string, unknown> = {}): any => op('result.enter', { payload: enterPayload(resultId, version), ...o });
const res = (status: string, version = 1, specimenStatus?: string): string => { const id = uid(); results.set(id, { status, version, ...(specimenStatus ? { specimenStatus } : {}) }); return id; };
beforeAll(ensure4, T);
beforeEach(async () => { reset(); await clearAll(); });
afterAll(clearAll, T);

describe('result.enter, append only through the existing result service (done_when 1)', () => {
  it('result open for entry, version current: accepted; the service ran once as the signed in user, same tenant, with the entry mapped like the online handler (camelCase)', async () => {
    const dev = await newDevice(A1);
    const id = res('entered', 1); const r = enter(id, 1);
    expect(one(await devicePush(H, A1, dev, [r]))).toMatchObject({ op_id: r.op_id, status: 'accepted' });
    expect(calls.enter).toHaveLength(1);
    const { ctx, args } = calls.enter[0]!;
    expect(ctx.tenantId).toBe(TENANT_A); expect(ctx.actor).toMatchObject({ id: USER.a1 });
    expect(args[0].entries).toEqual([{ resultId: id, version: 1, valueNumeric: '5.4' }]);
  }, T);
  it('a downtime back-entry carries its block (occurredAt, downtimeRef) to the service; every value kind and comment is mapped', async () => {
    const dev = await newDevice(A1);
    const id = res('entered', 1); const at = iso(new Date(NOW.getTime() - 5 * 3_600_000));
    const r = enter(id, 1, { payload: { entry_mode: 'downtime_backentry', occurred_at: at, downtime_ref: 'DT-OFFLINE-1', entries: [{ result_id: id, version: 1, value_text: 'reactive', manual_abnormal: true, comment_codes: ['C1'], comment_text: 'synthetic' }] } });
    expect(one(await devicePush(H, A1, dev, [r])).status).toBe('accepted');
    expect(calls.enter[0]!.args[0]).toEqual({ entries: [{ resultId: id, version: 1, valueText: 'reactive', manualAbnormal: true, commentCodes: ['C1'], commentText: 'synthetic' }], downtime: { occurredAt: at, downtimeRef: 'DT-OFFLINE-1' } });
  }, T);
  it('several entries in one operation are one service call with all of them, in order', async () => {
    const dev = await newDevice(A1);
    const [a, b] = [res('entered', 1), res('entered', 3)];
    const r = enter(a, 1, { payload: { entries: [{ result_id: a, version: 1, value_numeric: '1.0' }, { result_id: b, version: 3, value_numeric: '2.0' }] } });
    expect(one(await devicePush(H, A1, dev, [r])).status).toBe('accepted');
    expect(calls.enter).toHaveLength(1); expect(calls.enter[0]!.args[0].entries.map((e: any) => e.resultId)).toEqual([a, b]);
  }, T);
  it('a result already VERIFIED or APPROVED on the server: rejected sync.result_locked, the service is not called, and an alert for the lab manager is written and SURVIVES the rejection', async () => {
    const dev = await newDevice(A1);
    const [v, a] = [res('verified', 4), res('approved', 5)];
    const ops = [enter(v, 3), enter(a, 4)];
    const rs = okBody(await devicePush(H, A1, dev, ops)).results;
    for (const r of rs) expect(r, r.op_id).toMatchObject({ status: 'rejected', error_code: 'sync.result_locked' });
    expect(calls.enter).toHaveLength(0);
    const al = await alertRows(TENANT_A);
    expect(al.map((x) => [x.kind, x.op_id, x.result_id])).toEqual([['result_locked', ops[0].op_id, v], ['result_locked', ops[1].op_id, a]]);
    expect((await ledger(ops.map((x) => x.op_id))).map((x) => [x.status, x.error_code])).toEqual([['rejected', 'sync.result_locked'], ['rejected', 'sync.result_locked']]);
  }, T);
  it('one locked entry among open ones rejects the WHOLE operation (nothing is half appended) and alerts for the locked result only', async () => {
    const dev = await newDevice(A1);
    const [open, locked] = [res('entered', 1), res('verified', 2)];
    const r = enter(open, 1, { payload: { entries: [{ result_id: open, version: 1, value_numeric: '1' }, { result_id: locked, version: 1, value_numeric: '2' }] } });
    expect(one(await devicePush(H, A1, dev, [r]))).toMatchObject({ status: 'rejected', error_code: 'sync.result_locked' });
    expect(calls.enter).toHaveLength(0); expect(await effectTags(['enter'])).toHaveLength(0);
    expect((await alertRows(TENANT_A)).map((x) => x.result_id)).toEqual([locked]);
  }, T);
  it('the alert carries ids and codes only: no value, no entered text, no person name', async () => {
    const dev = await newDevice(A1);
    const id = res('verified', 2);
    await devicePush(H, A1, dev, [enter(id, 1, { payload: { entries: [{ result_id: id, version: 1, value_text: 'Sync Testperson Alpha', comment_text: 'Sync Testperson Alpha' }] } })]);
    expect(JSON.stringify(await alertRows(TENANT_A))).not.toContain('Testperson');
  }, T);
  it('the alert sink failing is a per operation failure that leaves nothing behind (a lock is never silent): the operation is rejected, not accepted, and the batch goes on', async () => {
    const dev = await newDevice(A1);
    flags.failAlerts = true;
    const [bad, good] = [enter(res('verified', 2), 1), enter(res('entered', 1), 1)];
    const rs = okBody(await devicePush(H, A1, dev, [bad, good])).results;
    expect(rs[0].status).toBe('rejected'); expect(rs[0].error_code).not.toBe('sync.result_locked');   // no silent rejection without the alert
    expect(rs[1].status).toBe('accepted');
  }, T);
  it('cancelled result, or a sample that was rejected / recollected / discarded meanwhile: CONFLICT sync.entity_changed with the server state, nothing appended', async () => {
    const dev = await newDevice(A1);
    const ids = [res('cancelled', 2), res('entered', 2, 'rejected'), res('entered', 2, 'recollection_ordered'), res('entered', 2, 'discarded')];
    const ops = ids.map((i) => enter(i, 2));
    const rs = okBody(await devicePush(H, A1, dev, ops)).results;
    for (const r of rs) expect(r, r.op_id).toMatchObject({ status: 'conflict', error_code: 'sync.entity_changed' });
    const cs = await conflictsOf(ops.map((x) => x.op_id));
    expect(cs).toHaveLength(4); expect(cs[0]).toMatchObject({ entity_type: 'result' }); expect(cs.map((c) => c.server_payload.status)).toContain('cancelled');
    expect(calls.enter).toHaveLength(0); expect(await alertRows(TENANT_A)).toHaveLength(0);
  }, T);
  it('an entry older than the server version (another device entered a newer one): CONFLICT sync.base_version_stale, never an overwrite', async () => {
    const dev = await newDevice(A1);
    expect(one(await devicePush(H, A1, dev, [enter(res('entered', 6), 2)]))).toMatchObject({ status: 'conflict', error_code: 'sync.base_version_stale' });
    expect(calls.enter).toHaveLength(0);
  }, T);
  it('the service refusing an entry (bad value) is a per operation rejection with its closed code and leaves no effect', async () => {
    const dev = await newDevice(A1);
    behave.enter = async (ctx: any, input: any) => { await ctx.tx.query(`INSERT INTO sync2_test.effect (tenant_id, op_id, op_type, actor_id, tag) VALUES ($1, $2, 'svc', $3, 'enter-half')`, [ctx.tenantId, uid(), ctx.actor.id]);
      return { results: input.entries.map((e: any) => ({ resultId: e.resultId, outcome: 'error', code: 'lab.result_value_invalid' })), recomputed: [] }; };
    expect(one(await devicePush(H, A1, dev, [enter(res('entered', 1), 1)]))).toMatchObject({ status: 'rejected', error_code: 'lab.result_value_invalid' });
    expect(await effectTags(['enter-half'])).toHaveLength(0);
  }, T);
  it('a service that throws a LimsError (on hold) is rejected with that code; an unexpected Error is common.internal and leaks nothing', async () => {
    const dev = await newDevice(A1);
    behave.enter = async () => { throw new LimsError('lab.result_on_hold'); };
    expect(one(await devicePush(H, A1, dev, [enter(res('entered', 1), 1)]))).toMatchObject({ status: 'rejected', error_code: 'lab.result_on_hold' });
    behave.enter = async () => { throw new Error('boom Sync Testperson Alpha'); };
    const o = await devicePush(H, A1, dev, [enter(res('entered', 1), 1)]);
    expect(one(o)).toMatchObject({ status: 'rejected', error_code: 'common.internal' });
    expect(JSON.stringify(o.reply!.body) + o.logs.join('\n')).not.toContain('Testperson');
  }, T);
});

describe('result.enter: replay, order, permission, tenant, shape (done_when 6)', () => {
  it('replay of the same operation: duplicate with the first outcome, the service ran once', async () => {
    const dev = await newDevice(A1);
    const r = enter(res('entered', 1), 1);
    await devicePush(H, A1, dev, [r]);
    expect(one(await devicePush(H, A1, dev, [r]))).toMatchObject({ status: 'duplicate' });
    expect(calls.enter).toHaveLength(1);
  }, T);
  it('replay of a LOCKED rejection: duplicate (the alert is not written twice)', async () => {
    const dev = await newDevice(A1);
    const r = enter(res('verified', 2), 1);
    await devicePush(H, A1, dev, [r]);
    expect(one(await devicePush(H, A1, dev, [r]))).toMatchObject({ status: 'duplicate', error_code: 'sync.result_locked' });
    expect(await alertRows(TENANT_A)).toHaveLength(1);
  }, T);
  it('same op id with another payload: sync.op_id_reused (nothing is entered)', async () => {
    const dev = await newDevice(A1);
    const id = res('entered', 1); const r = enter(id, 1);
    await devicePush(H, A1, dev, [r]);
    expect(one(await devicePush(H, A1, dev, [{ ...r, payload: enterPayload(id, 1, { value_numeric: '9.9' }) }]))).toMatchObject({ status: 'rejected', error_code: 'sync.op_id_reused' });
    expect(calls.enter).toHaveLength(1);
  }, T);
  it('out of order: two entries for the same result sent newest first are applied oldest device time first; the second one then finds the version moved by the first (conflict, never an overwrite)', async () => {
    const dev = await newDevice(A1);
    const id = res('entered', 1);
    behave.enter = async (ctx: any, input: any) => { results.set(id, { status: 'entered', version: 2 }); return { results: input.entries.map((e: any) => ({ resultId: e.resultId, outcome: 'ok' })), recomputed: [] }; };
    const older = enter(id, 1, { device_created_at: iso(new Date(NOW.getTime() - 3 * 3_600_000)) }), newer = enter(id, 1, { device_created_at: iso(new Date(NOW.getTime() - 1 * 3_600_000)) });
    const rs = okBody(await devicePush(H, A1, dev, [newer, older])).results;   // results come back in the order SENT
    expect(rs[1]).toMatchObject({ op_id: older.op_id, status: 'accepted' });
    expect(rs[0]).toMatchObject({ op_id: newer.op_id, status: 'conflict', error_code: 'sync.base_version_stale' });
    expect(calls.enter).toHaveLength(1);
  }, T);
  it('permission removed meanwhile: auth.forbidden for lab.result.enter, nothing read, nothing written, no alert', async () => {
    const dev = await newDevice(A1);
    const o = await devicePush(H, A1, dev, [enter(res('verified', 2), 1)], { grants: { codes: ['sync.use'] } });
    expect(one(o)).toMatchObject({ status: 'rejected', error_code: 'auth.forbidden' }); expect(o.asserted).toContain('lab.result.enter');
    expect(calls.enter).toHaveLength(0); expect(await alertRows(TENANT_A)).toHaveLength(0);
  }, T);
  it('unknown result: common.not_found; cross tenant on the DEFAULT seam (RLS): common.not_found, no conflict row and no alert', async () => {
    const dev = await newDevice(A1);
    expect(one(await devicePush(H, A1, dev, [enter(uid(), 1)]))).toMatchObject({ status: 'rejected', error_code: 'common.not_found' });
    const devB = await newDevice(B1); const r = enter(uid(), 1);
    expect(one(await devicePush(HD, B1, devB, [r]))).toMatchObject({ status: 'rejected', error_code: 'common.not_found' });
    expect(await conflictsOf([r.op_id])).toHaveLength(0); expect(calls.enter).toHaveLength(0);
  }, T);
  it('payload shape: an unknown key, or a missing entries list: common.validation_failed for the operation; reserved_numbers are not accepted', async () => {
    const dev = await newDevice(A1);
    const rs = okBody(await devicePush(H, A1, dev, [op('result.enter', { payload: { entries: [], surplus: 1 } }), op('result.enter', { payload: {} })])).results;
    for (const r of rs) expect(r).toMatchObject({ status: 'rejected', error_code: 'common.validation_failed' });
    const o = await devicePush(H, A1, dev, [{ ...enter(res('entered', 1), 1), reserved_numbers: { lab_codes: [1] } } as any]);
    expect(code(o) ?? one(o).error_code).toBe('common.validation_failed');
  }, T);
});
