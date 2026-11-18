// T0B-SYNC-3 done_when (1), (4), (5), (6): collection.mark_collected and accession.receive through the real engine + the real adapters on a real PG17 (RLS on). The lab SERVICE LAYER
// (collectSpecimen / receiveSpecimen) is a recording double; the specimen state the adapter reads comes through the `readSpecimen` seam (./doubles.ts header) so each state / version
// combination of the conflict matrix can be set up without a full order graph. The DEFAULT seam (SELECT from lab.specimens under RLS) is exercised with an unknown id.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../../../modules/frontdesk/service/registration.service.js', async (orig) => (await import('./doubles.js')).registrationMock(orig as never));
vi.mock('../../../../modules/billing/service/ledger.service.js', async (orig) => (await import('./doubles.js')).ledgerMock(orig as never));
vi.mock('../../../../modules/lab/service/specimen.service.js', async (orig) => (await import('./doubles.js')).specimenMock(orig as never));
import { LimsError } from '../../../errors.js';
import { A1, B1, TENANT_A, USER, CENTRE, code, conflictsOf, devicePush, engine, iso, newDevice, NOW, okBody, op, reserve, setCounters, uid, ok } from '../helpers2.js';
import { behave, calls, ensureCounter, readSpecimen, reset, specimens } from './doubles.js';
import { createCollectionMarkCollectedAdapter, collectionMarkCollectedAdapter } from '../../../../modules/lab/sync/collection.adapter.js';
import { createAccessionReceiveAdapter, accessionReceiveAdapter } from '../../../../modules/lab/sync/accession.adapter.js';

const T = 120_000;
const H = engine({}, [createCollectionMarkCollectedAdapter({ readSpecimen }), createAccessionReceiveAdapter({ readSpecimen })]);
const HD = engine({}, [collectionMarkCollectedAdapter, accessionReceiveAdapter]);   // default seam
const one = (o: any): any => okBody(o).results[0];
const col = (id: string, v: number, o: Record<string, unknown> = {}): any => op('collection.mark_collected', { entity_id: id, base_version: v, payload: {}, ...o });
const rec = (id: string, v: number, o: Record<string, unknown> = {}): any => op('accession.receive', { entity_id: id, base_version: v, payload: { processing_centre_id: CENTRE.a1 }, ...o });
const spec = (status: string, version: number): string => { const id = uid(); specimens.set(id, { status, version }); return id; };
beforeAll(ensureCounter);
beforeEach(() => { reset(); specimens.clear(); });
// the double moves the specimen like the online service does, so a second device sees the new state
const moves = (to: string): void => {
  const mv = async (_ctx: any, params: any) => { const s = specimens.get(params.specimen_id)!; specimens.set(params.specimen_id, { status: to, version: s.version + 1 }); return { status: 200, body: { id: params.specimen_id } }; };
  behave.collect = mv as never; behave.receive = mv as never;
};

describe('collection.mark_collected (done_when 1, 4)', () => {
  it('state ordered, base version current: the service ran once as the signed in user with If-Match "<base_version>", the entity id as specimen_id and the device time as collected_at', async () => {
    const dev = await newDevice(A1);
    const id = spec('ordered', 2); const at = new Date(NOW.getTime() - 2 * 3_600_000);
    const r = col(id, 2, {}); r.device_created_at = iso(at);
    expect(one(await devicePush(H, A1, dev, [r]))).toMatchObject({ op_id: r.op_id, status: 'accepted', entity_id: id });
    expect(calls.collect).toHaveLength(1);
    const { ctx, args } = calls.collect[0]!;
    expect(ctx.tenantId).toBe(TENANT_A); expect(ctx.actor).toMatchObject({ id: USER.a1, membershipId: USER.a1 });
    expect(args[0]).toMatchObject({ specimen_id: id }); expect(args[1]).toMatchObject({ 'if-match': '"2"' });
    expect(args[2].collected_at).toBe(iso(at));
  }, T);
  it('a collected_at the device put in the payload is kept (the device time only fills an absent one)', async () => {
    const dev = await newDevice(A1);
    const id = spec('ordered', 1); const mine = iso(new Date(NOW.getTime() - 90 * 60_000));
    await devicePush(H, A1, dev, [col(id, 1, { payload: { collected_at: mine } })]);
    expect(calls.collect[0]!.args[2].collected_at).toBe(mine);
  }, T);
  it('already in a later state (collected, in transit, received, stored): duplicate, no change, the service is not called', async () => {
    const dev = await newDevice(A1);
    const ids = ['collected', 'in_transit', 'received', 'stored'].map((s) => spec(s, 5));
    const rs = okBody(await devicePush(H, A1, dev, ids.map((i) => col(i, 2)))).results;
    expect(rs.map((r: any) => r.status)).toEqual(['duplicate', 'duplicate', 'duplicate', 'duplicate']);
    expect(rs.every((r: any) => r.error_code === undefined && r.conflict_id === undefined)).toBe(true);
    expect(calls.collect).toHaveLength(0);
  }, T);
  it('contradicted: the sample was rejected, recollection ordered or discarded by someone else: CONFLICT lab.specimen_invalid_transition with the server state, nothing changes', async () => {
    const dev = await newDevice(A1);
    const ids = ['rejected', 'recollection_ordered', 'discarded'].map((s) => spec(s, 4));
    const ops = ids.map((i) => col(i, 2));
    const rs = okBody(await devicePush(H, A1, dev, ops)).results;
    for (const r of rs) expect(r, r.op_id).toMatchObject({ status: 'conflict', error_code: 'lab.specimen_invalid_transition' });
    const [c] = await conflictsOf([ops[0]!.op_id]);
    expect(c).toMatchObject({ entity_type: 'specimen', entity_id: ids[0] });
    expect(c.server_payload).toMatchObject({ status: 'rejected', version: 4 });
    expect(calls.collect).toHaveLength(0);
  }, T);
  it('stale base version while still ordered (another device edited it): CONFLICT sync.base_version_stale', async () => {
    const dev = await newDevice(A1);
    const id = spec('ordered', 6);
    expect(one(await devicePush(H, A1, dev, [col(id, 2)]))).toMatchObject({ status: 'conflict', error_code: 'sync.base_version_stale' });
    expect(calls.collect).toHaveLength(0);
  }, T);
  it('two devices collect the same specimen: the first is accepted, the second is a duplicate (and the service ran once)', async () => {
    const [d1, d2] = [await newDevice(A1), await newDevice(A1)];
    moves('collected');
    const id = spec('ordered', 2);
    expect(one(await devicePush(H, A1, d1, [col(id, 2)])).status).toBe('accepted');
    expect(one(await devicePush(H, A1, d2, [col(id, 2)])).status).toBe('duplicate');
    expect(calls.collect).toHaveLength(1);
  }, T);
  it('replay of the same operation: duplicate with the first outcome', async () => {
    const dev = await newDevice(A1);
    const id = spec('ordered', 2); const r = col(id, 2);
    await devicePush(H, A1, dev, [r]);
    expect(one(await devicePush(H, A1, dev, [r]))).toMatchObject({ status: 'duplicate', entity_id: id });
    expect(calls.collect).toHaveLength(1);
  }, T);
  it('the service refusing (e.g. inactive specimen) is a per operation rejection with its closed code', async () => {
    const dev = await newDevice(A1);
    behave.collect = async () => { throw new LimsError('lab.specimen_inactive'); };
    expect(one(await devicePush(H, A1, dev, [col(spec('ordered', 1), 1)]))).toMatchObject({ status: 'rejected', error_code: 'lab.specimen_inactive' });
  }, T);
  it('permission removed meanwhile: auth.forbidden, nothing read or written; unknown specimen: common.not_found; cross tenant (default seam under RLS): common.not_found', async () => {
    const dev = await newDevice(A1);
    const id = spec('ordered', 1);
    const o = await devicePush(H, A1, dev, [col(id, 1)], { grants: { codes: ['sync.use'] } });
    expect(one(o)).toMatchObject({ status: 'rejected', error_code: 'auth.forbidden' }); expect(o.asserted).toContain('lab.specimen.collect');
    expect(calls.collect).toHaveLength(0);
    expect(one(await devicePush(H, A1, dev, [col(uid(), 1)]))).toMatchObject({ status: 'rejected', error_code: 'common.not_found' });
    const devB = await newDevice(B1);
    expect(one(await devicePush(HD, B1, devB, [col(uid(), 1)]))).toMatchObject({ status: 'rejected', error_code: 'common.not_found' });
    expect(calls.collect).toHaveLength(0);
  }, T);
  it('reserved_numbers are not accepted on collection.mark_collected: common.validation_failed for the request', async () => {
    const dev = await newDevice(A1);
    const o = await devicePush(H, A1, dev, [col(spec('ordered', 1), 1, { reserved_numbers: { lab_codes: [1] } })]);
    expect(code(o) ?? one(o).error_code).toBe('common.validation_failed');
  }, T);
});

describe('accession.receive (done_when 1, 4)', () => {
  it('collected, base version current: accepted; the service got the specimen id, If-Match, the payload and the same actor', async () => {
    const dev = await newDevice(A1);
    const id = spec('collected', 3); const r = rec(id, 3);
    expect(one(await devicePush(H, A1, dev, [r]))).toMatchObject({ status: 'accepted', entity_id: id });
    const { ctx, args } = calls.receive[0]!;
    expect(ctx.actor).toMatchObject({ id: USER.a1 }); expect(args[0]).toMatchObject({ specimen_id: id }); expect(args[1]).toMatchObject({ 'if-match': '"3"' });
    expect(args[2]).toEqual(r.payload);
  }, T);
  it('in transit is receivable too', async () => {
    const dev = await newDevice(A1);
    expect(one(await devicePush(H, A1, dev, [rec(spec('in_transit', 3), 3)])).status).toBe('accepted');
  }, T);
  it('already received or further (received, aliquoted, in process, resulted): duplicate, service not called', async () => {
    const dev = await newDevice(A1);
    const rs = okBody(await devicePush(H, A1, dev, ['received', 'aliquoted', 'in_process', 'resulted'].map((s) => rec(spec(s, 7), 3)))).results;
    expect(rs.map((r: any) => r.status)).toEqual(['duplicate', 'duplicate', 'duplicate', 'duplicate']);
    expect(calls.receive).toHaveLength(0);
  }, T);
  it('a rejected sample, a discarded one, or one never collected (another device contradicts the move): CONFLICT lab.specimen_invalid_transition', async () => {
    const dev = await newDevice(A1);
    const ops = ['rejected', 'discarded', 'recollection_ordered', 'ordered'].map((s) => rec(spec(s, 4), 2));
    const rs = okBody(await devicePush(H, A1, dev, ops)).results;
    for (const r of rs) expect(r, r.op_id).toMatchObject({ status: 'conflict', error_code: 'lab.specimen_invalid_transition' });
    expect(calls.receive).toHaveLength(0);
    expect((await conflictsOf(ops.map((x: any) => x.op_id))).map((c) => c.entity_type)).toEqual(['specimen', 'specimen', 'specimen', 'specimen']);
  }, T);
  it('stale base version while still collected: CONFLICT sync.base_version_stale', async () => {
    const dev = await newDevice(A1);
    expect(one(await devicePush(H, A1, dev, [rec(spec('collected', 9), 3)]))).toMatchObject({ status: 'conflict', error_code: 'sync.base_version_stale' });
  }, T);
  it('two devices receive the same specimen: first accepted, second duplicate', async () => {
    const [d1, d2] = [await newDevice(A1), await newDevice(A1)];
    moves('received');
    const id = spec('collected', 3);
    expect(one(await devicePush(H, A1, d1, [rec(id, 3)])).status).toBe('accepted');
    expect(one(await devicePush(H, A1, d2, [rec(id, 3)])).status).toBe('duplicate');
    expect(calls.receive).toHaveLength(1);
  }, T);
  it('accession has no captured time field: the device time goes into the audit event of the operation (and stays in the ledger)', async () => {
    const id = spec('collected', 3); const at = iso(new Date(NOW.getTime() - 4 * 3_600_000));
    const audit: any[] = [];
    const ctx: any = { tenantId: TENANT_A, actor: { type: 'user', id: USER.a1, membershipId: USER.a1 }, tx: { query: async () => ({ rows: [], rowCount: 0 }) }, requestId: uid(),
      now: () => NOW.toISOString(), log: { info() {}, warn() {}, error() {}, debug() {} }, metrics: { inc() {}, set() {}, observe() {} }, events: {}, core: {}, db: {},
      audit: { access: async (e: any) => { audit.push(e); } }, ports: { IdentityPort: { async assertRole() {}, async getActor() { return { centreScope: { all: true, centreIds: [] } }; } } } };
    const adapter = createAccessionReceiveAdapter({ readSpecimen });
    const o = { opId: uid(), opType: 'accession.receive', entityId: id, baseVersion: 3, payload: { processing_centre_id: CENTRE.a1 }, deviceCreatedAt: at, idempotencyKey: '', deviceId: uid() };
    o.idempotencyKey = o.opId;
    await adapter.execute(ctx, o as never);
    expect(audit.length).toBeGreaterThan(0);
    const blob = JSON.stringify(audit);
    expect(blob).toContain(at); expect(blob).toContain(o.opId);
  }, T);
});

describe('accession.receive: a lab code used offline lies in a block of this device (done_when 2 / catalogue)', () => {
  let dev: string; let block: any;
  beforeAll(async () => {
    await setCounters(TENANT_A, { lab: 9000 });
    dev = await newDevice(A1); block = ok(await reserve(A1, dev, 'lab_code', 50)).block;
  }, T);
  const withNumbers = (labs: number[], o: Record<string, unknown> = {}): any => rec(spec('collected', 3), 3, { reserved_numbers: { lab_codes: labs }, ...o });
  it('inside the block: accepted', async () => {
    expect(one(await devicePush(H, A1, dev, [withNumbers([block.from_value, block.to_value])])).status).toBe('accepted');
  }, T);
  it('outside the block (one below / above): rejected sync.number_out_of_block, the service is not called', async () => {
    for (const n of [block.from_value - 1, block.to_value + 1]) expect(one(await devicePush(H, A1, dev, [withNumbers([n])]))).toMatchObject({ status: 'rejected', error_code: 'sync.number_out_of_block' });
    expect(calls.receive).toHaveLength(0);
  }, T);
  it('the block of another device is not this device block', async () => {
    const other = await newDevice(A1);
    const ob = ok(await reserve(A1, other, 'lab_code', 50)).block;
    expect(one(await devicePush(H, A1, dev, [withNumbers([ob.from_value])]))).toMatchObject({ status: 'rejected', error_code: 'sync.number_out_of_block' });
  }, T);
  it('a patient id is not accepted on a lab operation: common.validation_failed', async () => {
    const o = await devicePush(H, A1, dev, [rec(spec('collected', 3), 3, { reserved_numbers: { patient_id: block.from_value } })]);
    expect(code(o) ?? one(o).error_code).toBe('common.validation_failed');
  }, T);
});

describe('no personal data in logs (done_when 5)', () => {
  it('a failing service with a name in its message never leaks to the result or the logs', async () => {
    const dev = await newDevice(A1);
    behave.collect = async () => { throw new Error('boom Sync Testperson Alpha'); };
    const o = await devicePush(H, A1, dev, [col(spec('ordered', 1), 1)]);
    expect(one(o)).toMatchObject({ status: 'rejected', error_code: 'common.internal' });
    expect(JSON.stringify(o.reply!.body) + o.logs.join('\n')).not.toContain('Testperson');
  }, T);
});
