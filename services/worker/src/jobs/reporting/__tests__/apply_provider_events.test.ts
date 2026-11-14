// C6-T29 worker task reporting.apply_provider_events (01-PRD AC-09.3; 02-TRD §4.8 status machine, §9 row "map provider events to deliveries; transition; publish events", max attempts 10,
// "dedupe on (provider_message_id, mapped_status)"; 05-SCHEMA §2.10 provider_events: ignored_reason IN (unknown_message, duplicate, backwards); 07-SECURITY T12 "no backwards transitions").
// ASSUMED: tasks/apply_provider_events.ts exports `applyProviderEvents` (TaskHandler) or `createApplyProviderEvents()`; payload { tenant_id } (what the CB1 handler enqueues under LD-49 (b));
// ctx.tx, system actor, ctx.events. The task loads the tenant's provider_events with applied_at IS NULL, oldest first, and for each: finds the delivery by
// (channel_account_id = event.channel_account_id, provider_message_id) in the SAME tenant; none => applied_at set + ignored_reason 'unknown_message'; delivery already in that status =>
// 'duplicate'; event status behind the delivery's (queued < sent < delivered < read; a delivery in failed/suppressed accepts nothing) => 'backwards' (no change, no event); else the delivery
// moves to the status (status_<x>_at set, version + 1) and ONE reporting.delivery.status_changed.v1 is published (idempotencyKey `<delivery_id>:<status>`); the provider_event row gets
// applied_at + delivery_id. Only applied_at / delivery_id / ignored_reason of provider_events may change (DB trigger, enforced by the wrapper below).
// A payload whose tenant_id differs from ctx.tenantId throws (never a silent cross-tenant run). Not covered: `read` on non-WhatsApp channels, failed-after-delivered, the order of
// out-of-order events inside one batch (only "never regress"), real PG/RLS, graphile job key collapse (api handler test), the WhatsApp fallback task (T23).
import '../../../../../api/src/__tests__/setup-env.js';
import { describe, expect, it } from 'vitest';
import { ACC, D, deliveryWorld, dRow, EMAIL, FULL_NAME, idN, minutesAgo, NOW, PHONE, sentRow, STATUS_EVENT, SYSTEM_ACTOR, TENANT_A, TENANT_B, type DW, type DWorldOpts, type Row } from './delivery.helpers.js';

type Task = (p: any, c: any) => Promise<void>;
const PE = (n: number) => idN(0xe000 + n);
/** A provider_events row as app.reporting_ingest_provider_callback writes it. */
const pe = (n: number, status: string, over: Row = {}): Row => ({ id: PE(n), tenant_id: TENANT_A, channel_account_id: ACC.whatsapp, provider_kind: 'recording', provider_message_id: `rec-${n}`, status_raw: status,
  mapped_status: status, occurred_at: minutesAgo(1), received_at: minutesAgo(1), delivery_id: null, applied_at: null, ignored_reason: null, created_at: minutesAgo(1), created_by: ACC.whatsapp, ...over });
const PE_MUTABLE = new Set(['applied_at', 'delivery_id', 'ignored_reason']);
const IGNORED = [null, 'unknown_message', 'duplicate', 'backwards'];

async function setup(events: Row[], o: DWorldOpts = {}) {
  const w = deliveryWorld({ ...o, extraSeed: { 'reporting.provider_events': events.map((e) => ({ ...e })), ...o.extraSeed } });
  const m: any = await import('../tasks/apply_provider_events.js');
  const task: Task = m.applyProviderEvents ?? m.createApplyProviderEvents?.();
  // provider_events DDL rules the fake does not model: mutable columns (trigger), ignored_reason CHECK, NO DELETE grant
  const base = w.tx;
  const tx: any = Object.create(base, {});
  tx.query = async (text: string, values: unknown[] = []) => {
    if (/^\s*delete\b[\s\S]*reporting\.provider_events/i.test(text)) throw Object.assign(new Error('permission denied for table provider_events'), { code: '42501' });
    if (/^\s*update\b[\s\S]*reporting\.provider_events/i.test(text)) {
      const before = new Map((w.db.all('reporting.provider_events') as Row[]).map((r) => [r['id'], { ...r }]));
      const res = await base.query(text, values);
      for (const r of w.db.all('reporting.provider_events') as Row[]) {
        const b = before.get(r['id']); if (!b) continue;
        for (const k of Object.keys(r)) if (!PE_MUTABLE.has(k) && JSON.stringify(r[k]) !== JSON.stringify(b[k])) throw Object.assign(new Error('immutable_row reporting.provider_events'), { code: 'P0001' });
        if (!IGNORED.includes(r['ignored_reason'])) throw Object.assign(new Error('provider_events__ignored__ck'), { code: '23514' });
      }
      return res;
    }
    return base.query(text, values);
  };
  Object.defineProperty(tx, 'startedAt', { get: () => (base as any).startedAt });
  const go = (tenant: string = TENANT_A, over: Row = {}) => w.run(task, { tenant_id: tenant }, { tx, ...over });
  const evt = (id: string) => (w.db.all('reporting.provider_events') as Row[]).find((r) => r['id'] === id)!;
  return { w, task, go, evt };
}
const trans = (w: DW) => w.statusEvents().map((e) => e.input.payload as Row);

describe('manifest', () => {
  it('reporting.apply_provider_events is registered in the worker manifest with max_attempts 10 (02-TRD §9)', async () => {
    const { manifest }: any = await import('../index.js');
    expect(typeof manifest.tasks['reporting.apply_provider_events']).toBe('function'); expect(manifest.maxAttempts['reporting.apply_provider_events']).toBe(10);
  });
});

describe('AC-09.3: a provider status callback moves the delivery forward, one event per transition', () => {
  it('sent -> delivered: status, delivered_at, version + 1; the provider_event is applied and linked to the delivery', async () => {
    const { w, go, evt } = await setup([pe(1, 'delivered')], { deliveries: [sentRow(1, 5)] });
    expect(await go()).toBe('ok');
    expect(w.delivery(D(1))).toMatchObject({ status: 'delivered', version: 3 }); expect(w.delivery(D(1))['delivered_at']).toBeTruthy(); expect(w.delivery(D(1))['read_at']).toBeNull();
    expect(evt(PE(1))).toMatchObject({ delivery_id: D(1), ignored_reason: null }); expect(evt(PE(1))['applied_at']).toBeTruthy();
  });
  it('publishes exactly ONE reporting.delivery.status_changed.v1 (to_status delivered, same delivery / channel / purpose / report) with key <delivery_id>:delivered', async () => {
    const { w, go } = await setup([pe(1, 'delivered')], { deliveries: [sentRow(1, 5)] }); await go();
    const ev = w.statusEvents(); expect(ev).toHaveLength(1); expect(ev[0]!.type).toBe(STATUS_EVENT);
    expect(ev[0]!.input.payload).toMatchObject({ delivery_id: D(1), channel: 'whatsapp', purpose: 'report_ready', to_status: 'delivered', recipient_kind: 'patient' });
    expect(ev[0]!.input.idempotencyKey).toBe(`${D(1)}:delivered`); expect(ev[0]!.input.aggregate).toMatchObject({ type: 'delivery', id: D(1) });
  });
  it('WhatsApp sent -> read: status read, read_at set', async () => {
    const { w, go } = await setup([pe(1, 'read')], { deliveries: [sentRow(1, 5)] }); await go();
    expect(w.delivery(D(1))).toMatchObject({ status: 'read' }); expect(w.delivery(D(1))['read_at']).toBeTruthy(); expect(trans(w).map((p) => p['to_status'])).toEqual(['read']);
  });
  it('delivered then read in one batch (both arrive): ends `read`, one event per ACTUAL transition, never a regression', async () => {
    const { w, go, evt } = await setup([pe(1, 'delivered', { provider_message_id: 'rec-1', occurred_at: minutesAgo(3), received_at: minutesAgo(3) }), pe(2, 'read', { provider_message_id: 'rec-1', occurred_at: minutesAgo(1), received_at: minutesAgo(1) })],
      { deliveries: [sentRow(1, 5)] }); await go();
    expect(w.delivery(D(1))['status']).toBe('read'); expect(trans(w).map((p) => p['to_status'])).toEqual(['delivered', 'read']);
    expect(evt(PE(1))['ignored_reason']).toBeNull(); expect(evt(PE(2))['ignored_reason']).toBeNull();
  });
  it('arrival order read then delivered (provider re-ordering): never regresses; the delivery ends `read`; every event row is applied; any skipped one says `backwards`', async () => {
    const { w, go, evt } = await setup([pe(2, 'read', { provider_message_id: 'rec-1', received_at: minutesAgo(2) }), pe(1, 'delivered', { provider_message_id: 'rec-1', received_at: minutesAgo(1), occurred_at: minutesAgo(3) })],
      { deliveries: [sentRow(1, 5)] }); await go();
    expect(w.delivery(D(1))['status']).toBe('read');
    const seq = trans(w).map((p) => p['to_status']); expect(seq.length).toBeGreaterThanOrEqual(1); expect(seq.at(-1)).toBe('read'); expect(seq.filter((s) => s === 'delivered').length).toBeLessThanOrEqual(1);
    for (const id of [PE(1), PE(2)]) { expect(evt(id)['applied_at']).toBeTruthy(); expect([null, 'backwards']).toContain(evt(id)['ignored_reason']); }
  });
  it('sent -> failed: status failed, failed_at set, one event', async () => {
    const { w, go } = await setup([pe(1, 'failed')], { deliveries: [sentRow(1, 5)] }); await go();
    expect(w.delivery(D(1))).toMatchObject({ status: 'failed' }); expect(w.delivery(D(1))['failed_at']).toBeTruthy(); expect(trans(w).map((p) => p['to_status'])).toEqual(['failed']);
  });
  it('handles several deliveries in one run, each its own transition and event', async () => {
    const { w, go } = await setup([pe(1, 'delivered'), pe(2, 'delivered'), pe(3, 'read')], { deliveries: [sentRow(1, 5), sentRow(2, 5), sentRow(3, 5)] }); await go();
    expect([1, 2, 3].map((n) => w.delivery(D(n))['status'])).toEqual(['delivered', 'delivered', 'read']); expect(w.statusEvents()).toHaveLength(3);
  });
});

describe('AC-09.3: a duplicate callback causes no second transition', () => {
  it('running the task twice over the same events: second run changes nothing and publishes nothing', async () => {
    const { w, go } = await setup([pe(1, 'delivered')], { deliveries: [sentRow(1, 5)] }); await go();
    const snap = JSON.stringify([w.delivery(D(1)), w.db.all('reporting.provider_events')]); const n = w.statusEvents().length; await go();
    expect(JSON.stringify([w.delivery(D(1)), w.db.all('reporting.provider_events')])).toBe(snap); expect(w.statusEvents()).toHaveLength(n);
  });
  it('an already-applied event is never re-processed (applied_at set => skipped even if it would transition)', async () => {
    const { w, go } = await setup([pe(1, 'delivered', { applied_at: minutesAgo(1) })], { deliveries: [sentRow(1, 5)] }); await go();
    expect(w.delivery(D(1))['status']).toBe('sent'); expect(w.statusEvents()).toEqual([]);
  });
  it('an event for the status the delivery already has: applied with ignored_reason `duplicate`, no change, no event', async () => {
    const { w, go, evt } = await setup([pe(1, 'delivered')], { deliveries: [sentRow(1, 5, { status: 'delivered', delivered_at: minutesAgo(2), version: 3 })] }); await go();
    expect(evt(PE(1))).toMatchObject({ ignored_reason: 'duplicate', delivery_id: D(1) }); expect(evt(PE(1))['applied_at']).toBeTruthy();
    expect(w.delivery(D(1))).toMatchObject({ status: 'delivered', version: 3 }); expect(w.statusEvents()).toEqual([]);
  });
});

describe('07-SECURITY T12: no backwards moves', () => {
  const back: Array<[string, Row, string]> = [
    ['`sent` event for a delivered delivery', { status: 'delivered', delivered_at: minutesAgo(2), version: 3 }, 'sent'],
    ['`delivered` event for a read delivery', { status: 'read', delivered_at: minutesAgo(3), read_at: minutesAgo(2), version: 4 }, 'delivered'],
    ['`sent` event for a read delivery', { status: 'read', delivered_at: minutesAgo(3), read_at: minutesAgo(2), version: 4 }, 'sent'],
    ['`delivered` event for a FAILED delivery (failed only leaves via a staff retry)', { status: 'failed', failed_at: minutesAgo(2), failure_code: 'provider_rejected', version: 3 }, 'delivered'],
    ['`delivered` event for a suppressed delivery', { status: 'suppressed', suppressed_at: minutesAgo(2), provider_message_id: 'rec-1', version: 2 }, 'delivered'],
  ];
  for (const [name, over, status] of back) {
    it(`${name}: ignored_reason \`backwards\`, delivery untouched, no event`, async () => {
      const { w, go, evt } = await setup([pe(1, status)], { deliveries: [sentRow(1, 5, over)] }); const before = JSON.stringify(w.delivery(D(1))); expect(await go()).toBe('ok');
      expect(JSON.stringify(w.delivery(D(1)))).toBe(before); expect(w.statusEvents()).toEqual([]);
      expect(evt(PE(1))).toMatchObject({ ignored_reason: 'backwards' }); expect(evt(PE(1))['applied_at']).toBeTruthy();
    });
  }
});

describe('unknown / foreign messages are ignored, never guessed', () => {
  it('no delivery has that provider_message_id: applied with `unknown_message`, delivery_id stays NULL, nothing else changes', async () => {
    const { w, go, evt } = await setup([pe(9, 'delivered')], { deliveries: [sentRow(1, 5)] }); await go();
    expect(evt(PE(9))).toMatchObject({ ignored_reason: 'unknown_message', delivery_id: null }); expect(evt(PE(9))['applied_at']).toBeTruthy();
    expect(w.delivery(D(1))['status']).toBe('sent'); expect(w.statusEvents()).toEqual([]);
  });
  it('the message id exists but on a delivery of ANOTHER channel account: `unknown_message` (an account\'s token cannot move another account\'s deliveries)', async () => {
    const { w, go, evt } = await setup([pe(1, 'delivered', { channel_account_id: ACC.sms })], { deliveries: [sentRow(1, 5)] }); await go();
    expect(evt(PE(1))['ignored_reason']).toBe('unknown_message'); expect(w.delivery(D(1))['status']).toBe('sent'); expect(w.statusEvents()).toEqual([]);
  });
  it('the message id exists only on ANOTHER TENANT\'s delivery: `unknown_message`, the other tenant\'s delivery is untouched', async () => {
    const foreign = sentRow(2, 5, { tenant_id: TENANT_B, provider_message_id: 'rec-1', idempotency_key: 'b-key-1' });
    const { w, go, evt } = await setup([pe(1, 'delivered')], { deliveries: [foreign] }); await go();
    expect(evt(PE(1))['ignored_reason']).toBe('unknown_message'); expect(w.delivery(D(2))['status']).toBe('sent'); expect(w.statusEvents()).toEqual([]);
  });
  it('only the payload tenant\'s events are processed: another tenant\'s pending events and deliveries stay untouched', async () => {
    const bEvt = pe(5, 'delivered', { tenant_id: TENANT_B, provider_message_id: 'rec-b' }); const bDel = sentRow(5, 5, { tenant_id: TENANT_B, provider_message_id: 'rec-b', idempotency_key: 'b-key-5' });
    const { w, go, evt } = await setup([pe(1, 'delivered'), bEvt], { deliveries: [sentRow(1, 5), bDel] }); await go(TENANT_A);
    expect(w.delivery(D(1))['status']).toBe('delivered'); expect(w.delivery(D(5))['status']).toBe('sent'); expect(evt(PE(5))['applied_at']).toBeNull();
  });
  it('a payload for a tenant other than the ctx tenant throws (no silent cross-tenant run), nothing changes', async () => {
    const { w, go } = await setup([pe(1, 'delivered')], { deliveries: [sentRow(1, 5)] }); const r = await go(TENANT_B);
    expect(r).toBeInstanceOf(Error); expect(w.delivery(D(1))['status']).toBe('sent'); expect(w.statusEvents()).toEqual([]);
  });
  it('a payload without tenant_id throws', async () => {
    const { w, task } = await setup([pe(1, 'delivered')], { deliveries: [sentRow(1, 5)] }); expect(await w.run(task, {})).toBeInstanceOf(Error);
  });
});

describe('no pending events / robustness', () => {
  it('nothing pending: resolves, writes nothing, publishes nothing', async () => {
    const { w, go } = await setup([], { deliveries: [sentRow(1, 5)] }); const before = JSON.stringify(w.delivery(D(1))); expect(await go()).toBe('ok');
    expect(JSON.stringify(w.delivery(D(1)))).toBe(before); expect(w.statusEvents()).toEqual([]);
  });
  it('a queued delivery (no provider_message_id yet) is never matched by an event; the event is `unknown_message`', async () => {
    const { w, go, evt } = await setup([pe(1, 'delivered')], { deliveries: [dRow(1)] }); await go();
    expect(w.delivery(D(1))['status']).toBe('queued'); expect(evt(PE(1))['ignored_reason']).toBe('unknown_message');
  });
  it('provider_events rows are never deleted or re-inserted by the task (append-only class A)', async () => {
    const { w, go } = await setup([pe(1, 'delivered'), pe(9, 'delivered')], { deliveries: [sentRow(1, 5)] }); await go();
    expect((w.db.all('reporting.provider_events') as Row[]).map((r) => r['id']).sort()).toEqual([PE(1), PE(9)].sort());
  });
});

describe('privacy (02-CV §9.2)', () => {
  it('events, logs and job output carry no phone, e-mail, name, provider body or token', async () => {
    const { w, go } = await setup([pe(1, 'delivered', { status_raw: 'delivered' })], { deliveries: [sentRow(1, 5)] }); await go();
    const t = w.leakText(); for (const s of [PHONE, EMAIL, FULL_NAME, 'rec-1']) expect(t, s).not.toContain(s);
    void NOW; void SYSTEM_ACTOR;
  });
});
