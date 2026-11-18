// T0B-SYNC-4 done_when (4), (5), (6): daily_cash.close through the real engine + the real adapter on a real PG17 (RLS on). The billing SERVICE LAYER (createCashService().closeCashSession, which owns the
// own-session rule, the variance, the deposit limit and the carry forward of the next session) is a recording double: "carried forward cash follows the online rule" = the adapter calls the same
// service with the same inputs and adds no rule of its own. The session state the adapter classifies on comes through the `readSession` seam (./doubles4.ts header).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../../../modules/lab/service/result.service.js', async (orig) => (await import('./doubles4.js')).resultMock(orig as never));
vi.mock('../../../../modules/billing/service/cash.service.js', async (orig) => (await import('./doubles4.js')).cashMock(orig as never));
import { LimsError } from '../../../errors.js';
import { A1, B1, TENANT_A, USER, conflictsOf, devicePush, engine, iso, ledger, newDevice, NOW, okBody, op, uid } from '../helpers2.js';
import { alertRows, behave, calls, clearAll, closePayload, effect, effectTags, ensure4, flags, reset, seams, sessions } from './doubles4.js';
import { createDailyCashCloseAdapter, dailyCashCloseAdapter } from '../../../../modules/billing/sync/cashClose.adapter.js';

const T = 120_000;
const S = seams();
const H = engine({}, [createDailyCashCloseAdapter(S)]);
const HD = engine({}, [dailyCashCloseAdapter]);   // default seams
const one = (o: any): any => okBody(o).results[0];
const close = (id: string, v: number, o: Record<string, unknown> = {}): any => op('daily_cash.close', { entity_id: id, base_version: v, payload: closePayload(), ...o });
const session = (status: 'open' | 'closed' = 'open', version = 2, closedBy?: string): string => { const id = uid(); sessions.set(id, { status, version, ...(closedBy ? { closedByMembershipId: closedBy } : {}) }); return id; };
/** the double closes like the online service: the session becomes closed, version + 1, by the actor */
const closing = (): void => { behave.close = async (ctx: any, i: any) => { await effect(ctx, `close:${i.sessionId}`, i.sessionId); sessions.set(i.sessionId, { status: 'closed', version: i.expectedVersion + 1, closedByMembershipId: ctx.actor.membershipId }); return { id: i.sessionId, status: 'closed' }; }; };
beforeAll(ensure4, T);
beforeEach(async () => { reset(); await clearAll(); });
afterAll(clearAll, T);

describe('daily_cash.close (done_when 4)', () => {
  it('own open session, base version current: accepted with the session id; the online service ran once as the signed in user with the version as If-Match value and the payload as the online handler maps it', async () => {
    const dev = await newDevice(A1);
    const id = session('open', 2); const r = close(id, 2);
    expect(one(await devicePush(H, A1, dev, [r]))).toMatchObject({ op_id: r.op_id, status: 'accepted', entity_id: id });
    expect(calls.close).toHaveLength(1);
    const { ctx, args } = calls.close[0]!;
    expect(ctx.tenantId).toBe(TENANT_A); expect(ctx.actor).toMatchObject({ id: USER.a1, membershipId: USER.a1 });
    expect(args[0]).toEqual({ sessionId: id, expectedVersion: 2, counted: [{ method_code: 'cash', amount_paisa: 150_000 }], note: 'synthetic close', deposit: 100_000 });
  }, T);
  it('optional note and deposit_paisa absent: the service input carries neither key (absent deposit = 0 is the SERVICE rule, never decided by the adapter)', async () => {
    const dev = await newDevice(A1);
    const id = session(); await devicePush(H, A1, dev, [close(id, 2, { payload: { counted: [{ method_code: 'cash', amount_paisa: 5 }] } })]);
    expect(Object.keys(calls.close[0]!.args[0]).sort()).toEqual(['counted', 'expectedVersion', 'sessionId']);
  }, T);
  it('carried forward cash follows the online rule: no carry / outstanding value is computed or passed by the adapter, the service decides (deposit above the cash on hand is its validation error, per operation, no effect left)', async () => {
    const dev = await newDevice(A1);
    behave.close = async (ctx: any) => { await effect(ctx, 'close-half'); throw new LimsError('common.validation_failed'); };
    const id = session();
    expect(one(await devicePush(H, A1, dev, [close(id, 2, { payload: closePayload({ deposit_paisa: 9_999_999_999 }) })]))).toMatchObject({ status: 'rejected', error_code: 'common.validation_failed' });
    expect(JSON.stringify(calls.close[0]!.args[0])).not.toMatch(/carr|outstanding|previous/i);
    expect(await effectTags(['close-half'])).toHaveLength(0);
  }, T);
  it('idempotent: the session is already closed by THIS user (another device, an earlier sync, a second op id): duplicate, the service is not called, no conflict row', async () => {
    const dev = await newDevice(A1);
    const id = session('closed', 3, USER.a1); const r = close(id, 2);
    expect(one(await devicePush(H, A1, dev, [r]))).toMatchObject({ status: 'duplicate', entity_id: id });
    expect(calls.close).toHaveLength(0); expect(await conflictsOf([r.op_id])).toHaveLength(0);
  }, T);
  it('a close already made by SOMEONE ELSE: CONFLICT common.immutable_record with the server state (status, version), a conflict row for a person, nothing closed', async () => {
    const dev = await newDevice(A1);
    const id = session('closed', 3, uid()); const r = close(id, 2);
    expect(one(await devicePush(H, A1, dev, [r]))).toMatchObject({ status: 'conflict', error_code: 'common.immutable_record' });
    const [c] = await conflictsOf([r.op_id]);
    expect(c).toMatchObject({ entity_type: 'cash_session', entity_id: id }); expect(c.server_payload).toMatchObject({ status: 'closed', version: 3 });
    expect(JSON.stringify(c.server_payload)).not.toMatch(/amount|counted|deposit/);   // the server state tells who acted, never the counted money of someone else
    expect(calls.close).toHaveLength(0);
  }, T);
  it('stale base version while still open (the session moved on another device): CONFLICT sync.base_version_stale, nothing closed', async () => {
    const dev = await newDevice(A1);
    expect(one(await devicePush(H, A1, dev, [close(session('open', 5), 2)]))).toMatchObject({ status: 'conflict', error_code: 'sync.base_version_stale' });
    expect(calls.close).toHaveLength(0);
  }, T);
  it('another user session (the service answers auth.forbidden: own session only) is a per operation rejection with that code and no effect', async () => {
    const dev = await newDevice(A1);
    behave.close = async (ctx: any) => { await effect(ctx, 'close-foreign'); throw new LimsError('auth.forbidden'); };
    expect(one(await devicePush(H, A1, dev, [close(session(), 2)]))).toMatchObject({ status: 'rejected', error_code: 'auth.forbidden' });
    expect(await effectTags(['close-foreign'])).toHaveLength(0);
  }, T);
  it('no alert and no recall belong to a cash close: the lab manager alert channel stays empty', async () => {
    const dev = await newDevice(A1);
    await devicePush(H, A1, dev, [close(session('closed', 3, uid()), 2), close(session(), 2)]);
    expect(await alertRows(TENANT_A)).toHaveLength(0);
  }, T);
});

describe('daily_cash.close needing MFA step up from an offline device (done_when 5)', () => {
  it('the tenant requires a step up to close the day: rejected sync.offline_not_allowed, the service is not called, nothing is closed', async () => {
    const dev = await newDevice(A1);
    flags.stepUp = true;
    const r = close(session(), 2);
    expect(one(await devicePush(H, A1, dev, [r]))).toMatchObject({ status: 'rejected', error_code: 'sync.offline_not_allowed' });
    expect(calls.close).toHaveLength(0); expect((await ledger([r.op_id]))[0]).toMatchObject({ status: 'rejected', error_code: 'sync.offline_not_allowed' });
  }, T);
  it('step up not required (the default): the close goes through', async () => {
    const dev = await newDevice(A1);
    expect(one(await devicePush(H, A1, dev, [close(session(), 2)])).status).toBe('accepted');
  }, T);
});

describe('daily_cash.close: replay, order, permission, tenant, shape (done_when 6)', () => {
  it('replay of the same operation: duplicate with the first outcome, closed once', async () => {
    const dev = await newDevice(A1); closing();
    const r = close(session(), 2); await devicePush(H, A1, dev, [r]);
    expect(one(await devicePush(H, A1, dev, [r]))).toMatchObject({ status: 'duplicate' }); expect(calls.close).toHaveLength(1);
  }, T);
  it('out of order: two close operations for the same session sent newest first: the OLDER device time is applied first and accepted, the newer one finds it closed by the same user: duplicate', async () => {
    const dev = await newDevice(A1); closing();
    const id = session('open', 2);
    const older = close(id, 2, { device_created_at: iso(new Date(NOW.getTime() - 4 * 3_600_000)) }), newer = close(id, 2, { device_created_at: iso(new Date(NOW.getTime() - 2 * 3_600_000)) });
    const rs = okBody(await devicePush(H, A1, dev, [newer, older])).results;
    expect(rs[0]).toMatchObject({ op_id: newer.op_id, status: 'duplicate' }); expect(rs[1]).toMatchObject({ op_id: older.op_id, status: 'accepted' });
    expect(calls.close).toHaveLength(1);
  }, T);
  it('permission removed meanwhile: auth.forbidden for billing.payment.record, nothing read or closed', async () => {
    const dev = await newDevice(A1);
    const o = await devicePush(H, A1, dev, [close(session(), 2)], { grants: { codes: ['sync.use'] } });
    expect(one(o)).toMatchObject({ status: 'rejected', error_code: 'auth.forbidden' }); expect(o.asserted).toContain('billing.payment.record');
    expect(calls.close).toHaveLength(0);
  }, T);
  it('unknown session: common.not_found; cross tenant on the DEFAULT seam under RLS: common.not_found, no conflict row', async () => {
    const dev = await newDevice(A1);
    expect(one(await devicePush(H, A1, dev, [close(uid(), 2)]))).toMatchObject({ status: 'rejected', error_code: 'common.not_found' });
    const devB = await newDevice(B1); const r = close(uid(), 2);
    expect(one(await devicePush(HD, B1, devB, [r]))).toMatchObject({ status: 'rejected', error_code: 'common.not_found' });
    expect(await conflictsOf([r.op_id])).toHaveLength(0); expect(calls.close).toHaveLength(0);
  }, T);
  it('payload shape: counted is required and an unknown key is refused: common.validation_failed for the operation', async () => {
    const dev = await newDevice(A1);
    const id = session();
    const rs = okBody(await devicePush(H, A1, dev, [close(id, 2, { payload: { note: 'x' } }), close(id, 2, { payload: closePayload({ surplus: 1 }) })])).results;
    for (const r of rs) expect(r).toMatchObject({ status: 'rejected', error_code: 'common.validation_failed' });
    expect(calls.close).toHaveLength(0);
  }, T);
  it('an unexpected failure of the service is common.internal and leaks nothing', async () => {
    const dev = await newDevice(A1);
    behave.close = async () => { throw new Error('boom Sync Testperson Alpha'); };
    const o = await devicePush(H, A1, dev, [close(session(), 2)]);
    expect(one(o)).toMatchObject({ status: 'rejected', error_code: 'common.internal' });
    expect(JSON.stringify(o.reply!.body) + o.logs.join('\n')).not.toContain('Testperson');
  }, T);
});
