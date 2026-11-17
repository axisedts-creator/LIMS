// C11.T-05 — worker consumer contract for lab.specimen.status_changed.v1 (03-IC §3.7; 02-TRD §4.1, §7 consumers table; AC-01.2).
// Runs the REAL worker core wrapper (core/consumer.ts: event_inbox insert, event_log read, envelope schema validation with known-fields-only, tenant claims) around the C11 consumer.
// intake.service is replaced by a spy here (its behaviour is proved by services/api/src/modules/anatomic/__tests__/intake.service.test.ts).
// SEAMS: services/worker/src/jobs/anatomic/consumers/lab.specimen.status_changed.v1.ts exports `handle: ConsumerHandler` (same shape as jobs/reporting/consumers/*.ts) and calls
//        onSpecimenStatusChanged(ctx, event) of services/api/src/modules/anatomic/service/intake.service.ts exactly once per delivery, with the validated envelope.
// Fails now: neither the consumer file nor intake.service.ts exists.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EVENT_ID, OCCURRED_AT, TENANT_A, evtId, rejects, setup } from '../../../core/__tests__/helpers.js';

vi.mock('../../../../../api/src/modules/anatomic/service/intake.service.js', () => ({ onSpecimenStatusChanged: vi.fn(async () => undefined) }));
const intake = (await import('../../../../../api/src/modules/anatomic/service/intake.service.js')) as unknown as { onSpecimenStatusChanged: ReturnType<typeof vi.fn> };
const { handle } = await import('../consumers/lab.specimen.status_changed.v1.js');

const TYPE = 'lab.specimen.status_changed.v1';
const task = evtId('anatomic', TYPE);
const jobPayload = { event_id: EVENT_ID, tenant_id: TENANT_A, event_type: TYPE };
// 03-IC §3.7 example payload, verbatim.
const EXAMPLE = { specimen_id: '01a1a98a-ac40-7000-8000-000000090001', order_id: '01a1a98a-ac40-7000-8000-000000050001', patient_id: '01a1a98a-ac40-7000-8000-000000040001',
  centre_id: '01a1a98a-ac40-7000-8000-000000020002', processing_branch_id: '01a1a98a-ac40-7000-8000-000000010001', specimen_type_code: 'EDTA_WB', from_status: 'in_transit',
  to_status: 'received', changed_at: '2026-11-05T03:20:41.300Z', order_item_ids: ['01a1a98a-ac40-7000-8000-000000060001'] };
const envelope = (payload: Record<string, unknown> = EXAMPLE, seq = 7, over: Record<string, unknown> = {}): any => ({
  event_id: EVENT_ID, event_type: TYPE, tenant_id: TENANT_A, occurred_at: OCCURRED_AT, actor: { type: 'user', id: '0190a000-0000-7000-8000-00000000a001' },
  idempotency_key: `${EXAMPLE.specimen_id}:received:${seq}`, producer: 'lab', aggregate: { type: 'specimen', id: EXAMPLE.specimen_id, seq },
  request_id: '0190a000-0000-7000-8000-0000000000f1', payload, ...over });

async function anatomicSetup(env: any = envelope()) {
  const s = await setup([{ module: 'anatomic', subscriptions: { [TYPE]: handle } }]);
  s.world.seedEvent(env);
  return s;
}
beforeEach(() => { intake.onSpecimenStatusChanged.mockReset(); intake.onSpecimenStatusChanged.mockResolvedValue(undefined); });
// pay the lazy worker-graph transform (setup() imports tasklist) outside a test's 5s budget
beforeAll(async () => { await import('../../../core/tasklist.js'); const w = await anatomicSetup(); await w.run(task, jobPayload); }, 120_000);

describe('lab.specimen.status_changed.v1 consumer (03-IC §3.7)', () => {
  it('registers as evt.anatomic.lab.specimen.status_changed.v1 and delegates the §3.7 example once, with the verified tenant context and aggregate.seq', async () => {
    const s = await anatomicSetup();
    await s.run(task, jobPayload);
    expect(intake.onSpecimenStatusChanged).toHaveBeenCalledTimes(1);
    const [ctx, ev] = intake.onSpecimenStatusChanged.mock.calls[0] as [any, any];
    expect(ctx.tenantId).toBe(TENANT_A);
    expect(ctx.actor.type).toBe('system');
    expect(ctx.tx).toBeTruthy();
    expect(ev.event_type).toBe(TYPE);
    expect(ev.tenant_id).toBe(TENANT_A);
    expect(ev.aggregate).toMatchObject({ type: 'specimen', id: EXAMPLE.specimen_id, seq: 7 });
    expect(ev.payload).toEqual(EXAMPLE);
    expect(s.world.inbox).toEqual([{ module: 'anatomic', tenant_id: TENANT_A, event_id: EVENT_ID }]);
  });

  it('duplicate event_id (AC-01.2): the second delivery succeeds and the intake runs once', async () => {
    const s = await anatomicSetup();
    await s.run(task, jobPayload);
    await expect(s.run(task, jobPayload, { attempts: 2 })).resolves.toBeUndefined();
    expect(intake.onSpecimenStatusChanged).toHaveBeenCalledTimes(1);
    expect(s.world.inbox).toHaveLength(1);
    expect(s.world.txLog.at(-1)!.outcome).toBe('commit');
  });

  it('two concurrent deliveries of the same event run the intake once', async () => {
    const s = await anatomicSetup();
    await Promise.all([s.run(task, jobPayload, { id: '1' }), s.run(task, jobPayload, { id: '2' })]);
    expect(intake.onSpecimenStatusChanged).toHaveBeenCalledTimes(1);
    expect(s.world.inbox).toHaveLength(1);
  });

  it('unknown payload fields are dropped by the wrapper (known-fields-only) and the delivery still succeeds', async () => {
    const s = await anatomicSetup(envelope({ ...EXAMPLE, future_field: 'LEAK-SENTINEL', parent_specimen_id: '01a1a98a-ac40-7000-8000-000000090009' }));
    await s.run(task, jobPayload);
    const ev = intake.onSpecimenStatusChanged.mock.calls[0]![1] as any;
    expect(ev.payload).not.toHaveProperty('future_field');
    expect(ev.payload.parent_specimen_id).toBe('01a1a98a-ac40-7000-8000-000000090009');   // known optional fields survive
    expect(JSON.stringify(ev)).not.toContain('LEAK-SENTINEL');
  });

  it('a payload that violates the contract (missing required field) fails the job before the intake runs and leaves no inbox row', async () => {
    const { to_status: _drop, ...broken } = EXAMPLE;
    const s = await anatomicSetup(envelope(broken));
    await rejects(s.run(task, jobPayload));
    expect(intake.onSpecimenStatusChanged).not.toHaveBeenCalled();
    expect(s.world.inbox).toHaveLength(0);
  });

  it('an intake failure (port outage → retry) rolls the inbox row back; the retry runs the intake again and then sticks', async () => {
    intake.onSpecimenStatusChanged.mockRejectedValueOnce(Object.assign(new Error('not found'), { code: 'common.not_found' }));
    const s = await anatomicSetup();
    await rejects(s.run(task, jobPayload));
    expect(s.world.inbox).toHaveLength(0);
    await s.run(task, jobPayload, { attempts: 2 });
    expect(intake.onSpecimenStatusChanged).toHaveBeenCalledTimes(2);
    expect(s.world.inbox).toHaveLength(1);
  });

  it('the job runs under the job tenant: a job payload for another tenant does not see this tenant’s event', async () => {
    const s = await anatomicSetup();
    await rejects(s.run(task, { ...jobPayload, tenant_id: '0190a000-0000-7000-8000-00000000bbbb' }));
    expect(intake.onSpecimenStatusChanged).not.toHaveBeenCalled();
  });
});
