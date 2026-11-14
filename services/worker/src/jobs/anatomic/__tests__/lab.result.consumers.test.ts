// C11.T-27 — worker consumer contract for lab.result.approved.v1 / lab.result.amended.v1 (03-IC §3.10/§3.11; 02-TRD §7 consumers table, §9 tasks; CR-C11-011).
// Runs the REAL worker core wrapper (event_inbox insert, event_log read, envelope validation, known-fields-only, tenant claims) around the C11 consumers.
// labresult.service is replaced by a spy (its behaviour is proved by services/api/src/modules/anatomic/__tests__/labresult.service.test.ts).
// SEAMS: consumers/lab.result.approved.v1.ts and consumers/lab.result.amended.v1.ts each export `handle: ConsumerHandler` and call
//        onResultApproved(ctx, event) / onResultAmended(ctx, event) of services/api/src/modules/anatomic/service/labresult.service.ts exactly once per delivery.
//        index.ts subscribes both types (tasks evt.anatomic.lab.result.approved.v1 / .amended.v1, per_tenant consumers).
// Fails now: neither consumer file nor labresult.service.ts exists, and the manifest has no lab.result.* subscription.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EVENT_ID, OCCURRED_AT, TENANT_A, evtId, rejects, setup } from '../../../core/__tests__/helpers.js';

vi.mock('../../../../../api/src/modules/anatomic/service/labresult.service.js', () => ({
  onResultApproved: vi.fn(async () => undefined), onResultAmended: vi.fn(async () => undefined),
}));
const svc = (await import('../../../../../api/src/modules/anatomic/service/labresult.service.js')) as unknown as { onResultApproved: ReturnType<typeof vi.fn>; onResultAmended: ReturnType<typeof vi.fn> };
const { manifest } = await import('../index.js');

const APPROVED = 'lab.result.approved.v1', AMENDED = 'lab.result.amended.v1';
const jobPayload = (type: string) => ({ event_id: EVENT_ID, tenant_id: TENANT_A, event_type: type });
// 03-IC §3.10 / §3.11 example payloads, verbatim.
const APPROVED_EX = { result_id: '01a1a98a-ac40-7000-8000-0000000a0001', result_version_no: 1, order_id: '01a1a98a-ac40-7000-8000-000000050001', order_item_id: '01a1a98a-ac40-7000-8000-000000060001',
  test_id: '01a1a98a-ac40-7000-8000-000000070001', analyte_id: '01a1a98a-ac40-7000-8000-000000080001', department_id: '01a1a98a-ac40-7000-8000-000000150001', approved_at: '2026-11-05T04:30:00.000Z',
  approved_by_membership_id: '01a1a98a-ac40-7000-8000-000000030003' };
const AMENDED_EX = { result_id: '01a1a98a-ac40-7000-8000-0000000a0001', previous_version_no: 1, new_version_no: 2, order_id: '01a1a98a-ac40-7000-8000-000000050001', order_item_id: '01a1a98a-ac40-7000-8000-000000060001',
  test_id: '01a1a98a-ac40-7000-8000-000000070001', analyte_id: '01a1a98a-ac40-7000-8000-000000080001', amendment_reason_code: 'transcription_error', amended_at: '2026-11-06T05:00:00.000Z',
  amended_by_membership_id: '01a1a98a-ac40-7000-8000-000000030003' };
const envelope = (type: string, payload: Record<string, unknown>, seq: number): any => ({
  event_id: EVENT_ID, event_type: type, tenant_id: TENANT_A, occurred_at: OCCURRED_AT, actor: { type: 'user', id: '0190a000-0000-7000-8000-00000000a001' },
  idempotency_key: `${payload['result_id']}:${type === APPROVED ? 'approved' : 'amended'}:${type === APPROVED ? 1 : 2}`, producer: 'lab',
  aggregate: { type: 'result', id: payload['result_id'], seq }, request_id: '0190a000-0000-7000-8000-0000000000f1', payload });

async function anatomicSetup(env: any) {
  const s = await setup([manifest]);
  s.world.seedEvent(env);
  return s;
}
const CASES = [
  { type: APPROVED, ex: APPROVED_EX, seq: 1, spy: () => svc.onResultApproved, other: () => svc.onResultAmended },
  { type: AMENDED, ex: AMENDED_EX, seq: 2, spy: () => svc.onResultAmended, other: () => svc.onResultApproved },
];
beforeEach(() => { svc.onResultApproved.mockReset(); svc.onResultApproved.mockResolvedValue(undefined); svc.onResultAmended.mockReset(); svc.onResultAmended.mockResolvedValue(undefined); });
beforeAll(async () => { await import('../../../core/tasklist.js'); await setup([manifest]); }, 120_000);

describe('manifest wiring (CR-C11-011, 02-TRD §3.2/§9)', () => {
  it('subscribes lab.specimen.status_changed.v1 + the two lab.result.* types, each with a handler; no permissions; crontab empty', () => {
    expect(Object.keys(manifest.subscriptions ?? {}).sort()).toEqual([AMENDED, APPROVED, 'lab.specimen.status_changed.v1']);
    for (const t of [APPROVED, AMENDED]) expect(typeof manifest.subscriptions?.[t], t).toBe('function');
    expect((manifest as any).permissions).toBeUndefined();
    expect([...(manifest.crontab ?? [])]).toEqual([]);
  });

  it.each([APPROVED, AMENDED])('registers one per_tenant consumer task evt.anatomic.%s', async (type) => {
    const s = await setup([manifest]);
    expect(s.entry(evtId('anatomic', type))).toMatchObject({ module: 'anatomic', kind: 'consumer', scope: 'per_tenant' });
  });
});

describe.each(CASES)('$type consumer', ({ type, ex, seq, spy, other }) => {
  const task = evtId('anatomic', type);

  it('delegates the 03-IC example once, with the verified tenant context and aggregate.seq; only its own service function runs', async () => {
    const s = await anatomicSetup(envelope(type, ex, seq));
    await s.run(task, jobPayload(type));
    expect(spy()).toHaveBeenCalledTimes(1);
    expect(other()).not.toHaveBeenCalled();
    const [ctx, ev] = spy().mock.calls[0] as [any, any];
    expect(ctx.tenantId).toBe(TENANT_A);
    expect(ctx.actor.type).toBe('system');
    expect(ctx.tx).toBeTruthy();
    expect(ev.event_type).toBe(type);
    expect(ev.aggregate).toMatchObject({ type: 'result', id: ex.result_id, seq });
    expect(ev.payload).toEqual(ex);
    expect(s.world.inbox).toEqual([{ module: 'anatomic', tenant_id: TENANT_A, event_id: EVENT_ID }]);
  });

  it('duplicate event_id: the second delivery succeeds and the service runs once', async () => {
    const s = await anatomicSetup(envelope(type, ex, seq));
    await s.run(task, jobPayload(type));
    await expect(s.run(task, jobPayload(type), { attempts: 2 })).resolves.toBeUndefined();
    expect(spy()).toHaveBeenCalledTimes(1);
    expect(s.world.inbox).toHaveLength(1);
  });

  it('unknown payload fields are dropped by the wrapper (known-fields-only)', async () => {
    const s = await anatomicSetup(envelope(type, { ...ex, future_field: 'LEAK-SENTINEL' }, seq));
    await s.run(task, jobPayload(type));
    expect(JSON.stringify(spy().mock.calls[0]![1])).not.toContain('LEAK-SENTINEL');
  });

  it('a payload that violates the contract (missing result_id) fails the job before the service runs and leaves no inbox row', async () => {
    const { result_id: _drop, ...broken } = ex as Record<string, unknown>;
    const s = await anatomicSetup(envelope(type, broken, seq));
    await rejects(s.run(task, jobPayload(type)));
    expect(spy()).not.toHaveBeenCalled();
    expect(s.world.inbox).toHaveLength(0);
  });

  it('a service failure rolls the inbox row back; the retry runs the service again and then sticks', async () => {
    spy().mockRejectedValueOnce(Object.assign(new Error('db down'), { code: '08006' }));
    const s = await anatomicSetup(envelope(type, ex, seq));
    await rejects(s.run(task, jobPayload(type)));
    expect(s.world.inbox).toHaveLength(0);
    await s.run(task, jobPayload(type), { attempts: 2 });
    expect(spy()).toHaveBeenCalledTimes(2);
    expect(s.world.inbox).toHaveLength(1);
  });

  it('runs under the job tenant: a job payload for another tenant does not see this tenant’s event', async () => {
    const s = await anatomicSetup(envelope(type, ex, seq));
    await rejects(s.run(task, { ...jobPayload(type), tenant_id: '0190a000-0000-7000-8000-00000000bbbb' }));
    expect(spy()).not.toHaveBeenCalled();
  });
});
