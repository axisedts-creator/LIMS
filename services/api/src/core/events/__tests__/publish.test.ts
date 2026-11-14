// T0D-08 events.publish (02-TRD §6.10; AC-0D-5.1, 5.2, 5.3; REQ-ARCH-038).
// Contract assumed from the spec and written down in .orchestra/notes/T0D-08-tests.md:
//   services/api/src/core/events/publish.ts exports createEvents({ producer, metrics?, log? }) -> { publish(ctx, type, input) }
//   where producer is the calling module (from its manifest). Schemas are loaded from contracts/events/*.schema.json.
import { describe, expect, it } from 'vitest';
import { LimsError } from '../../errors.js';
import { createEvents } from '../publish.js';
import {
  EVENT, PATIENT_ID, TENANT_A, TENANT_B, USER, MEMBERSHIP, SUPPORT_SESSION, REQ_ID, STARTED_AT, UUIDV7,
  ctxFor, makeEventDb, orderCreatedPayload, publishInput, recorder, rejection, ORDER_ID,
} from './helpers.js';

const setup = (producer = 'frontdesk') => {
  const db = makeEventDb();
  const rec = recorder();
  const events = createEvents({ producer, metrics: rec.metrics, log: rec.log } as never);
  return { db, rec, events, ctx: ctxFor(db) };
};
const publish = (s: ReturnType<typeof setup>, input: unknown = publishInput(), type: string = EVENT, ctx: unknown = s.ctx) =>
  (s.events as any).publish(ctx, type, input) as Promise<{ eventId: string; duplicate: boolean }>;

describe('AC-0D-5.1 publish is atomic with the caller transaction', () => {
  it('rolled-back transaction leaves no core.event_log row and no job', async () => {
    const s = setup();
    await rejection(s.db.transaction(async () => { await publish(s); }, { rollback: true }));
    expect(s.db.events).toHaveLength(0);
    expect(s.db.jobs).toHaveLength(0);
  });

  it('committed transaction has exactly one row and one core.event_fanout job carrying event_id and tenant_id', async () => {
    const s = setup();
    const out = await s.db.transaction(() => publish(s));
    expect(out.duplicate).toBe(false);
    expect(out.eventId).toMatch(UUIDV7);
    expect(s.db.events).toHaveLength(1);
    expect(s.db.events[0]!.eventId).toBe(out.eventId);
    expect(s.db.jobs).toHaveLength(1);
    const j = s.db.jobs[0]!;
    expect([j.text, ...j.values].join('|')).toContain('core.event_fanout');
    expect(j.values).toContain(out.eventId);   // payload.event_id and job_key = event_id
    expect(j.values).toContain(TENANT_A);      // payload.tenant_id
  });

  it('INSERT precedes enqueue, both go through ctx.tx (the only handle publish is given)', async () => {
    const s = setup();
    await s.db.transaction(() => publish(s));
    const i = s.db.stmts.findIndex((x) => /INSERT\s+INTO\s+core\.event_log/i.test(x.text));
    const q = s.db.stmts.findIndex((x) => /app\.enqueue_job/i.test(x.text));
    expect(i).toBeGreaterThanOrEqual(0);
    expect(q).toBeGreaterThan(i);
  });

  it('a failing enqueue rejects publish, so the caller transaction rolls back the event_log row too', async () => {
    const s = setup();
    s.db.fail(/app\.enqueue_job/i);
    await rejection(s.db.transaction(() => publish(s)));
    expect(s.db.events).toHaveLength(0);
    expect(s.db.jobs).toHaveLength(0);
  });

  it('INSERT uses ON CONFLICT (tenant_id, event_type, idempotency_key) DO NOTHING', async () => {
    const s = setup();
    await s.db.transaction(() => publish(s));
    const ins = s.db.stmts.find((x) => /INSERT\s+INTO\s+core\.event_log/i.test(x.text))!;
    expect(ins.text).toMatch(/ON\s+CONFLICT\s*\(\s*tenant_id\s*,\s*event_type\s*,\s*idempotency_key\s*\)\s*DO\s+NOTHING/i);
  });
});

describe('envelope (02-TRD §6.10 step 1)', () => {
  it('is built from ctx and tx, never from caller-supplied tenant/producer/time', async () => {
    const s = setup();
    const smuggled = { ...publishInput(), tenantId: TENANT_B, tenant_id: TENANT_B, producer: 'billing', occurredAt: '2001-01-01T00:00:00.000Z' };
    const out = await s.db.transaction(() => publish(s, smuggled));
    const env = s.db.events[0]!.envelope;
    expect(env).toMatchObject({
      event_id: out.eventId, event_type: EVENT, tenant_id: TENANT_A, producer: 'frontdesk',
      occurred_at: STARTED_AT.toISOString(),                       // tx.startedAt, ms precision, Z
      actor: { type: 'user', id: USER, membership_id: MEMBERSHIP }, // snake-cased
      idempotency_key: `${ORDER_ID}:created`, request_id: REQ_ID,
      aggregate: { type: 'order', id: ORDER_ID, seq: 1 },
    });
    expect(env.payload).toEqual(orderCreatedPayload());
    expect(env).not.toHaveProperty('causation_event_id');
    expect(Object.keys(env).sort()).not.toContain('tenantId');
  });

  it('carries support_session_id and causation_event_id when given', async () => {
    const s = setup();
    const cause = '0190a000-0000-7000-8000-0000000000ca';
    const ctx = ctxFor(s.db, { actor: { type: 'user', id: USER, membershipId: MEMBERSHIP, supportSessionId: SUPPORT_SESSION } });
    await s.db.transaction(() => publish(s, publishInput({ causationEventId: cause }), EVENT, ctx));
    const env = s.db.events[0]!.envelope;
    expect(env.actor.support_session_id).toBe(SUPPORT_SESSION);
    expect(env.causation_event_id).toBe(cause);
  });

  it('writes the log columns (tenant, type, producer, key, aggregate, occurred_at, created_by) as bound values', async () => {
    const s = setup();
    await s.db.transaction(() => publish(s));
    const v = s.db.stmts.find((x) => /INSERT\s+INTO\s+core\.event_log/i.test(x.text))!.values.map((x) => (x instanceof Date ? x.toISOString() : x));
    for (const want of [TENANT_A, EVENT, 'frontdesk', `${ORDER_ID}:created`, 'order', ORDER_ID, 1, STARTED_AT.toISOString(), USER]) {
      expect(v, String(want)).toContain(want);
    }
  });

  it('counts lims_core_events_published_total{event_type,tenant_id} once per new event', async () => {
    const s = setup();
    await s.db.transaction(() => publish(s));
    const m = s.rec.incs.filter((i) => i.name === 'lims_core_events_published_total');
    expect(m).toHaveLength(1);
    expect(m[0]!.labels).toEqual({ event_type: EVENT, tenant_id: TENANT_A });
  });
});

describe('AC-0D-5.2 schema violations throw and nothing is written', () => {
  const bad: Array<[string, unknown]> = [
    ['payload missing a required field', publishInput({ payload: (({ items, ...rest }) => rest)(orderCreatedPayload()) })],
    ['payload with an unknown field (additionalProperties false)', publishInput({ payload: orderCreatedPayload({ patient_name: 'Synthetic Person' }) })],
    ['payload field of the wrong enum value', publishInput({ payload: orderCreatedPayload({ visit_type: 'icu' }) })],
    ['aggregate.type not the schema constant', publishInput({ aggregate: { type: 'invoice', id: ORDER_ID, seq: 1 } })],
    ['aggregate.seq below 1', publishInput({ aggregate: { type: 'order', id: ORDER_ID, seq: 0 } })],
    ['empty idempotency key', publishInput({ idempotencyKey: '' })],
    ['idempotency key over 200 chars', publishInput({ idempotencyKey: 'k'.repeat(201) })],
    ['aggregate id that is not a UUIDv7', publishInput({ aggregate: { type: 'order', id: 'not-a-uuid', seq: 1 } })],
  ];
  for (const [name, input] of bad) {
    it(`${name}: throws common.internal, logs event_schema_violation{event_type}, issues no SQL`, async () => {
      const s = setup();
      const e = await rejection(s.db.transaction(() => publish(s, input)));
      expect(e).toBeInstanceOf(LimsError);
      expect(e.code).toBe('common.internal');
      expect(s.db.stmts).toHaveLength(0);                 // validated before the INSERT
      expect(s.db.events).toHaveLength(0);
      expect(s.db.jobs).toHaveLength(0);
      const v = s.rec.logs.filter((l) => l.obj?.event === 'event_schema_violation');
      expect(v).toHaveLength(1);
      expect(v[0]!.obj.event_type).toBe(EVENT);
      expect(s.rec.countOf('lims_core_events_published_total')).toBe(0);
    });
  }

  it('never echoes payload values into the log or the error', async () => {
    const s = setup();
    const e = await rejection(s.db.transaction(() => publish(s, publishInput({ payload: orderCreatedPayload({ visit_type: 'icu', patient_name: 'Synthetic Person' }) }))));
    const dump = JSON.stringify([s.rec.logs, e.message, e.detail, e.errors]);
    expect(dump).not.toContain(PATIENT_ID);
    expect(dump).not.toContain('Synthetic Person');
  });

  it('rejects an unknown event type', async () => {
    const s = setup();
    const e = await rejection(s.db.transaction(() => publish(s, publishInput(), 'frontdesk.order.exploded.v1')));
    expect(e).toBeInstanceOf(LimsError);
    expect(s.db.stmts).toHaveLength(0);
  });

  it('rejects an event whose schema names a different producer (module billing publishing a frontdesk event)', async () => {
    const s = setup('billing');
    const e = await rejection(s.db.transaction(() => publish(s)));
    expect(e).toBeInstanceOf(LimsError);
    expect(s.db.stmts).toHaveLength(0);
    expect(s.db.events).toHaveLength(0);
  });

  it('rejects a producer that is not in EVENT_PRODUCERS', async () => {
    const s = setup('identity');
    const e = await rejection(s.db.transaction(() => publish(s)));
    expect(e).toBeInstanceOf(LimsError);
    expect(s.db.stmts).toHaveLength(0);
  });
});

describe('AC-0D-5.3 dedupe on (tenant_id, event_type, idempotency_key)', () => {
  it('same key twice in one transaction: one row, one fan-out, second call reports duplicate with the first eventId', async () => {
    const s = setup();
    const [a, b] = await s.db.transaction(async () => [await publish(s), await publish(s)] as const);
    expect(a.duplicate).toBe(false);
    expect(b).toEqual({ eventId: a.eventId, duplicate: true });
    expect(s.db.events).toHaveLength(1);
    expect(s.db.jobs).toHaveLength(1);
    expect(s.rec.countOf('lims_core_events_published_total')).toBe(1);
  });

  it('same key in a later transaction is still a duplicate', async () => {
    const s = setup();
    const a = await s.db.transaction(() => publish(s));
    const b = await s.db.transaction(() => publish(s));
    expect(b).toEqual({ eventId: a.eventId, duplicate: true });
    expect(s.db.events).toHaveLength(1);
    expect(s.db.jobs).toHaveLength(1);
  });

  it('same (event_type, idempotency_key) in another tenant creates a second row and a second fan-out (review C0 m#41)', async () => {
    const s = setup();
    const ctxB = ctxFor(s.db, { tenantId: TENANT_B });
    const a = await s.db.transaction(() => publish(s));
    const b = await s.db.transaction(() => publish(s, publishInput(), EVENT, ctxB));
    expect(b.duplicate).toBe(false);
    expect(b.eventId).not.toBe(a.eventId);
    expect(s.db.events.map((e) => e.tenantId).sort()).toEqual([TENANT_A, TENANT_B]);
    expect(s.db.jobs).toHaveLength(2);
  });

  it('a different idempotency key is a new event', async () => {
    const s = setup();
    await s.db.transaction(async () => { await publish(s); await publish(s, publishInput({ idempotencyKey: `${ORDER_ID}:created:2` })); });
    expect(s.db.events).toHaveLength(2);
    expect(s.db.jobs).toHaveLength(2);
  });
});
