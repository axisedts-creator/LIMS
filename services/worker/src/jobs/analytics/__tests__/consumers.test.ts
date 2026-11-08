// AN-T05 (C8) — the 12 analytics event consumers (06-IMPLEMENTATION-PLAN row AN-T05; 02-TRD §8.2 + "Conditionally absent fields"; PRD US-20.1/20.2; 07-SECURITY "Event-driven dirtying");
// 08 A13 D-1/D-2, A17 D-45/D-48; DECISION D-C8-04 (no aggregate.seq checks). No DB: statements run against the in-memory model in consumersFake.ts.
// ASSUMED seam (spec fixes behaviour, not names; writer: dispute via .orchestra/notes if wrong):
//   the handlers are reached ONLY through `manifest.subscriptions[<event type>]` of ../index.js (a ConsumerHandler `(envelope, ctx)`), files `consumers/*.ts`.
//   They run inside the C0 wrapper's tx: they use `ctx.tx` (or `ctx.db.tx`, same tx), never open another one; inbox dedupe by event_id is the wrapper's job (core consumer tests),
//   so "duplicate delivery" here re-delivers the SAME envelope to the handler and requires an unchanged result. Tenant = ctx.tenantId only (an envelope naming another tenant writes nothing).
//   Marks go through `INSERT INTO analytics.dirty_partitions (...) ... ON CONFLICT ... DO UPDATE` (reason 'event', created_by = ctx.actor.id) and exactly one
//   `SELECT app.enqueue_job('analytics.refresh_tenant', {tenant_id}, 'analytics.refresh_tenant:<tenant>', now()+60 s, 5)` follows them. bd(ts) may be computed in JS (UTC+05:45) or in SQL.
//   order.cancelled learns `registered_on` from the order_index row it just updated (UPDATE … RETURNING or a SELECT); a placeholder row => orders/centre/referrer families are NOT marked (date unknown).
import { describe, expect, it } from 'vitest';
import { eventValidators } from '../../../../../api/src/core/events/publish.js';
import { manifest } from '../index.js';
import { ACTOR, DAY, NOW, SNAPSHOT, TA, TB, bd, createWorld, envelope, id, type World } from './consumersFake.js';

// ---- ids / payload builders (valid against contracts/events/*.schema.json: asserted below) --------------------------------------------------------------------------------------------
const ORDER = id(100), PATIENT = id(101), BRANCH = id(102), CENTRE = id(103), REFERRER = id(104), ITEM = id(105), TEST = id(106), ANALYTE = id(107), DEPT = id(108),
  SPECIMEN = id(109), RESULT = id(110), INVOICE = id(111), CREDIT_NOTE = id(112), REPORT = id(113), DELIVERY = id(114), AGENT = id(115), CRIT = id(116), MEMBER = id(117), PARTY = id(118);
const money = (n: number) => ({ amount_paisa: n, currency: 'NPR' });
const TOTALS = { gross: money(100000), discount: money(0), exempt: money(0), taxable: money(100000), vat: money(13000), other_tax: money(0), net: money(113000) };
const OMIT = Symbol('omit');
/** Spreads `over` on `base`; a value of OMIT deletes the key (optional field absent). */
const mix = (base: Record<string, unknown>, over: Record<string, unknown> = {}) => {
  const o = { ...base, ...over };
  for (const k of Object.keys(o)) if (o[k] === OMIT) delete o[k];
  return o;
};

interface Ev {
  type: string; producer: string; agg: string; aggId: string;
  /** the payload field the business date is read from (undefined: the event is anchored on "today") */
  anchor: string | undefined;
  payload(ts: string, over?: Record<string, unknown>): Record<string, unknown>;
  /** the exact dirty set for the anchor timestamp `ts` (sorted `family@date`) */
  marks(ts: string): string[];
}
const at = (D: string, ...families: string[]) => families.map((f) => `${f}@${D}`);
const SNAP = `report_backlog@${SNAPSHOT}`;
const sorted = (...xs: (string | string[])[]) => xs.flat().sort();

const EVENTS: Record<string, Ev> = {
  order_created: {
    type: 'frontdesk.order.created.v1', producer: 'frontdesk', agg: 'order', aggId: ORDER, anchor: 'registered_at',
    payload: (ts, o) => mix({ order_id: ORDER, patient_id: PATIENT, branch_id: BRANCH, centre_id: CENTRE, referrer_id: REFERRER, visit_type: 'opd', billing_mode: 'cash', priority: 'routine', collection_mode: 'walk_in', source: 'front_desk',
      registered_at: ts, items: [{ order_item_id: ITEM, orderable_id: TEST, orderable_kind: 'test', test_ids: [TEST], priority: 'routine' }] }, o),
    marks: (ts) => sorted(at(bd(ts), 'orders', 'centre_volume', 'referrer_volume'), SNAP),
  },
  order_cancelled: {
    type: 'frontdesk.order.cancelled.v1', producer: 'frontdesk', agg: 'order', aggId: ORDER, anchor: 'cancelled_at',
    payload: (ts, o) => mix({ order_id: ORDER, reason_code: 'duplicate_registration', cancelled_at: ts, requires_credit_note: false }, o),
    marks: () => [SNAP],                                                    // no order_index row yet => placeholder => registered_on unknown (the dated families are tested with a known row below)
  },
  invoice_issued: {
    type: 'billing.invoice.issued.v1', producer: 'billing', agg: 'invoice', aggId: INVOICE, anchor: 'issued_at',
    payload: (ts, o) => mix({ invoice_id: INVOICE, invoice_no: 'INV-2083-000123', fiscal_year_bs: '2083/84', invoice_kind: 'tax_invoice', order_id: ORDER, branch_id: BRANCH, centre_id: CENTRE, issued_at: ts, totals: TOTALS }, o),
    marks: (ts) => at(bd(ts), 'income', 'department_income', 'referrer_billing').sort(),
  },
  invoice_cancelled: {
    type: 'billing.invoice.cancelled.v1', producer: 'billing', agg: 'invoice', aggId: INVOICE, anchor: 'cancelled_at',
    payload: (ts, o) => mix({ invoice_id: INVOICE, invoice_no: 'INV-2083-000123', fiscal_year_bs: '2083/84', order_id: ORDER, credit_note_id: CREDIT_NOTE, credit_note_no: 'CN-2083-000009', reason_code: 'billing_error', cancelled_at: ts, credited_total: money(113000) }, o),
    marks: (ts) => at(bd(ts), 'income', 'department_income', 'referrer_billing').sort(),
  },
  specimen_status: {   // to_status 'collected' = none of the tat / rejections statuses
    type: 'lab.specimen.status_changed.v1', producer: 'lab', agg: 'specimen', aggId: SPECIMEN, anchor: 'changed_at',
    payload: (ts, o) => mix({ specimen_id: SPECIMEN, order_id: ORDER, patient_id: PATIENT, centre_id: CENTRE, specimen_type_code: 'SERUM', from_status: 'ordered', to_status: 'collected', changed_at: ts }, o),
    marks: (ts) => sorted(at(bd(ts), 'specimens'), SNAP),
  },
  result_verified: {
    type: 'lab.result.verified.v1', producer: 'lab', agg: 'result', aggId: RESULT, anchor: 'verified_at',
    payload: (ts, o) => mix({ result_id: RESULT, result_version_no: 1, order_id: ORDER, order_item_id: ITEM, specimen_id: SPECIMEN, test_id: TEST, analyte_id: ANALYTE, department_id: DEPT, origin: 'manual', mode: 'manual', verified_at: ts, verified_by_membership_id: MEMBER }, o),
    marks: (ts) => at(bd(ts), 'results', 'tat').sort(),
  },
  result_approved: {
    type: 'lab.result.approved.v1', producer: 'lab', agg: 'result', aggId: RESULT, anchor: 'approved_at',
    payload: (ts, o) => mix({ result_id: RESULT, result_version_no: 1, order_id: ORDER, order_item_id: ITEM, test_id: TEST, analyte_id: ANALYTE, department_id: DEPT, approved_at: ts, approved_by_membership_id: MEMBER }, o),
    marks: (ts) => sorted(at(bd(ts), 'results'), SNAP),
  },
  result_amended: {
    type: 'lab.result.amended.v1', producer: 'lab', agg: 'result', aggId: RESULT, anchor: 'amended_at',
    payload: (ts, o) => mix({ result_id: RESULT, previous_version_no: 1, new_version_no: 2, order_id: ORDER, order_item_id: ITEM, test_id: TEST, analyte_id: ANALYTE, amendment_reason_code: 'transcription_error', amended_at: ts, amended_by_membership_id: MEMBER }, o),
    marks: (ts) => at(bd(ts), 'results'),
  },
  critical_detected: {
    type: 'lab.critical_value.detected.v1', producer: 'lab', agg: 'result', aggId: RESULT, anchor: 'detected_at',
    payload: (ts, o) => mix({ critical_event_id: CRIT, result_id: RESULT, result_version_no: 1, order_id: ORDER, patient_id: PATIENT, centre_id: CENTRE, analyte_id: ANALYTE, direction: 'high', detected_at: ts }, o),
    marks: (ts) => at(bd(ts), 'critical_values', 'results').sort(),
  },
  agent_health: {   // anchored on "today" = bd(now), not on a payload field
    type: 'instruments.agent.health_changed.v1', producer: 'instruments', agg: 'agent', aggId: AGENT, anchor: undefined,
    payload: (ts, o) => mix({ agent_id: AGENT, centre_id: CENTRE, from_state: 'online', to_state: 'offline', last_heartbeat_at: ts, agent_version: '1.4.2', queue_depth: 3 }, o),
    marks: (now) => at(bd(now), 'interface_messages'),
  },
  report_released: {
    type: 'reporting.report.released.v1', producer: 'reporting', agg: 'report', aggId: REPORT, anchor: 'released_at',
    payload: (ts, o) => mix({ report_id: REPORT, version_no: 1, order_id: ORDER, patient_id: PATIENT, centre_id: CENTRE, report_kind: 'final', released_at: ts, release_basis: 'paid_in_full', audiences: ['patient'] }, o),
    marks: (ts) => sorted(at(bd(ts), 'releases', 'tat'), SNAP),
  },
  delivery_status: {   // delivery_created_at absent here => falls back to changed_at; the cohort-day case is tested separately
    type: 'reporting.delivery.status_changed.v1', producer: 'reporting', agg: 'delivery', aggId: DELIVERY, anchor: 'changed_at',
    payload: (ts, o) => mix({ delivery_id: DELIVERY, report_id: REPORT, report_version_no: 1, channel: 'sms', purpose: 'report_ready', recipient_kind: 'patient', from_status: 'queued', to_status: 'sent', attempt_no: 1, changed_at: ts }, o),
    marks: (ts) => at(bd(ts), 'deliveries'),
  },
};
const KEYS = Object.keys(EVENTS);
const DATED = KEYS.filter((k) => EVENTS[k]!.anchor !== undefined);

const T1 = '2026-11-03T09:30:00.000Z';                                   // ordinary instant; bd = 2026-11-03
const env = (e: Ev, ts: string, over: Record<string, unknown> = {}, eo: { event_id?: string; tenant_id?: string } = {}) => envelope(e.type, e.producer, e.agg, e.aggId, e.payload(ts, over), eo);
const handler = (e: Ev) => {
  const h = manifest.subscriptions?.[e.type];
  if (typeof h !== 'function') throw new Error(`manifest.subscriptions has no handler for ${e.type}`);
  return h as (env: any, ctx: any) => Promise<void>;
};
const run = (w: World, e: Ev, ev: unknown) => w.deliver(handler(e), ev);
/** Precondition of every "is refused" test: the same handler DOES process a valid delivery, so a stub that throws on everything cannot pass them. */
const accepts = async (e: Ev, ts: string) => { const w = createWorld(); await run(w, e, env(e, ts)); expect(w.dirty.size, `${e.type} must process a valid event`).toBeGreaterThan(0); };
const rejected = async (p: Promise<unknown>) => { try { await p; } catch (err) { return err ?? new Error('rejected'); } return undefined; };

/** Invariants that hold after ANY delivery. */
function invariants(w: World) {
  expect(w.unknownWrites().map((l) => l.text), 'handler used a write statement shape the model cannot interpret').toEqual([]);
  for (const d of w.dirty.values()) {
    expect(d.tenant_id).toBe(TA);                                          // tenant from ctx only
    expect(d.reason).toBe('event');
    expect(d.created_by).toBe(ACTOR);                                      // created_by = the analytics system actor
    expect(d.family === 'report_backlog', `${d.family}@${d.business_date}`).toBe(d.business_date === SNAPSHOT);   // dirty_partitions__snapshot__ck
  }
  for (const o of w.orders.values()) { expect(o.tenant_id).toBe(TA); expect(o.created_by).toBe(ACTOR); expect(o.expires_at).not.toBeNull(); }
}
/** No statement text embeds a payload-derived value: ids, instants and event ids are always bound parameters (SQL injection / TRD "never take values from payloads"). */
function noSplicing(w: World, ev: any) {
  const needles = [ev.event_id, ...JSON.stringify(ev.payload).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d{4}-\d\d-\d\dT[\d:.]+Z/g) ?? []];
  for (const l of w.log) for (const n of needles) expect(l.text, `statement splices ${n}`).not.toContain(n);
}
const enqueueOk = (w: World, expectedCount = 1) => {
  const q = w.enqueues();
  expect(q).toHaveLength(expectedCount);
  for (const e of q) {
    const all = e.text + ' ' + JSON.stringify(e.values);
    expect(all).toContain('analytics.refresh_tenant');
    expect(all).toContain(TA);
    expect(all).not.toContain(TB);
    expect(e.values.includes(`analytics.refresh_tenant:${TA}`) || /'analytics\.refresh_tenant:'\s*\|\|/.test(e.text), 'job_key = analytics.refresh_tenant:<tenant>').toBe(true);
    expect(e.values.includes(5) || /,\s*5\s*\)/.test(e.text), 'max_attempts 5').toBe(true);
    expect(/60\s*seconds/.test(e.text) || e.values.some((v) => typeof v === 'string' && Math.abs(Date.parse(v) - (Date.parse(NOW) + 60_000)) < 1000), 'debounce 60 s').toBe(true);
  }
  const lastMark = Math.max(-1, ...w.log.filter((l) => l.kind === 'dirty_insert').map((l) => l.i));
  expect(Math.min(...q.map((e) => e.i)), 'enqueue comes after the marks').toBeGreaterThan(lastMark);
};

// ============================================================================================================================================================================================
describe('contract guard: the example payloads below are valid IC events (so the handlers are tested on what the producers really send)', () => {
  const validate = eventValidators();
  it.each(KEYS)('%s example envelope validates against contracts/events', (k) => {
    const e = EVENTS[k]!, v = validate.get(e.type)!;
    expect(v, `no schema for ${e.type}`).toBeTypeOf('function');
    const ok = v(env(e, T1));
    expect(ok, JSON.stringify((v as any).errors)).toBe(true);
  });
});

describe('wiring: manifest.subscriptions carry real consumers, not the AN-T01 fail-closed stubs', () => {
  it('all 12 subscribed events accept their IC example without throwing', async () => {
    for (const k of KEYS) {
      const w = createWorld();
      const e = EVENTS[k]!;
      await expect(run(w, e, env(e, T1)), e.type).resolves.toBeUndefined();
      expect(w.dirty.size, `${e.type} marked nothing`).toBeGreaterThan(0);
    }
  });
});

describe.each(KEYS)('%s', (k) => {
  const e = EVENTS[k]!;
  const ts = e.anchor ? T1 : NOW;

  it('IC example payload -> exactly the families/dates of TRD §8.2 are dirtied (reason event, created_by = system actor), then one debounced refresh is enqueued', async () => {
    const w = createWorld();
    const ev = env(e, ts);
    await run(w, e, ev);
    expect(w.marks()).toEqual(e.marks(ts));
    invariants(w);
    enqueueOk(w);
    noSplicing(w, ev);
  });

  it('duplicate delivery (same envelope twice) -> same dirty set (upsert, no extra rows), same order_index, no unique-violation', async () => {
    const w = createWorld();
    const ev = env(e, ts);
    await run(w, e, ev);
    const marks = w.marks(), orders = JSON.stringify([...w.orders]), n = w.dirty.size;
    await run(w, e, ev);
    expect(w.marks()).toEqual(marks);
    expect(w.dirty.size).toBe(n);
    expect(JSON.stringify([...w.orders])).toBe(orders);
    invariants(w);
  });

  it('unknown extra payload fields are ignored (never read, never bound into SQL)', async () => {
    const w = createWorld();
    const ev = env(e, ts, { surprise_field: "x'; DROP TABLE analytics.dirty_partitions;--", patient_name: 'Synthetic Person', amount_paisa: 999999, nested: { a: [1, 2, 3] } });
    await run(w, e, ev);
    expect(w.marks()).toEqual(e.marks(ts));
    const all = JSON.stringify(w.log);
    expect(all).not.toMatch(/DROP TABLE|Synthetic Person|999999|surprise_field/);
    invariants(w);
  });

  it('an envelope that names another tenant than the job context writes nothing (tenant comes from ctx only)', async () => {
    await accepts(e, ts);
    const w = createWorld();
    await rejected(run(w, e, env(e, ts, {}, { tenant_id: TB })));
    expect(w.dirty.size).toBe(0);
    expect(w.orders.size).toBe(0);
    expect(w.enqueues()).toHaveLength(0);
  });

  it('no tenant in the job context -> nothing is written (fail closed)', async () => {
    await accepts(e, ts);
    const w = createWorld({ tenantId: undefined });
    await rejected(run(w, e, env(e, ts)));
    expect(w.dirty.size).toBe(0);
    expect(w.orders.size).toBe(0);
  });

  it('a failing enqueue makes the handler reject (the wrapper rolls the marks back and the delivery is retried), never swallowed', async () => {
    await accepts(e, ts);
    const w = createWorld({ failEnqueue: true });
    expect(await rejected(run(w, e, env(e, ts)))).toBeDefined();
    expect(w.dirty.size).toBe(0);
    expect(w.orders.size).toBe(0);
  });
});

describe.each(DATED)('%s — business-date boundary (Asia/Kathmandu midnight = 18:15 UTC, PRD §5 AC 6)', (k) => {
  const e = EVENTS[k]!;
  const BEFORE = '2026-11-05T18:14:59.999Z', ON = '2026-11-05T18:15:00.000Z';
  const family = (m: string) => m.split('@')[0]!;
  it('18:14:59.999Z stays on 2026-11-05, 18:15:00.000Z moves to 2026-11-06 (snapshot mark unaffected)', async () => {
    for (const [instant, day] of [[BEFORE, '2026-11-05'], [ON, '2026-11-06']] as const) {
      const w = createWorld();
      await run(w, e, env(e, instant));
      const dated = w.marks().filter((m) => family(m) !== 'report_backlog');
      expect(dated.every((m) => m.endsWith(`@${day}`)), `${instant} -> ${dated}`).toBe(true);
      expect(dated.length + w.marks().filter((m) => family(m) === 'report_backlog').length).toBe(w.dirty.size);
      expect(w.marks()).toEqual(e.marks(instant));
    }
  });
  it('the day does not depend on the UTC date of the instant: 2026-12-31T18:15Z -> 2027-01-01, 2026-03-01T00:00Z -> 2026-03-01 (year / month rollover)', async () => {
    for (const [instant, day] of [['2026-12-31T18:15:00.000Z', '2027-01-01'], ['2026-03-01T00:00:00.000Z', '2026-03-01'], ['2026-02-28T18:15:00.000Z', '2026-03-01']] as const) {
      const w = createWorld();
      await run(w, e, env(e, instant));
      expect(w.marks().filter((m) => !m.startsWith('report_backlog')).every((m) => m.endsWith(`@${day}`)), `${instant} -> ${w.marks()}`).toBe(true);
    }
  });
});

describe.each(DATED)('%s — malformed anchor is refused before any write (poison event: reject => retry/dead-letter, never a silent ack or a guessed date)', (k) => {
  const e = EVENTS[k]!;
  it.each([
    ['missing', OMIT], ['null', null], ['empty', ''], ['not a date', 'yesterday'], ['number', 1762500000000], ['object', { $date: 'x' }],
    ['sql in the instant', "2026-11-05T00:00:00.000Z'; DROP TABLE analytics.daily_income;--"], ['no timezone', '2026-11-05T10:00:00'],
  ])('%s', async (_name, bad) => {
    await accepts(e, T1);
    const w = createWorld();
    expect(await rejected(run(w, e, env(e, T1, { [e.anchor!]: bad })))).toBeDefined();
    expect(w.dirty.size).toBe(0);
    expect(w.orders.size).toBe(0);
    expect(w.enqueues()).toHaveLength(0);
    expect(w.unknownWrites()).toEqual([]);
  });
});

// ============================================================================================================================================================================================
describe('lab.specimen.status_changed — to_status decides the extra families (TRD §8.2)', () => {
  const e = EVENTS['specimen_status']!;
  const D = bd(T1);
  const STATUSES = ['ordered', 'collected', 'in_transit', 'received', 'aliquoted', 'in_process', 'resulted', 'verified', 'approved', 'reported', 'rejected', 'recollection_ordered', 'stored', 'discarded'];
  const expected = (s: string) => sorted(at(D, 'specimens'), SNAP, ['received', 'verified', 'rejected'].includes(s) ? at(D, 'tat') : [], ['rejected', 'recollection_ordered'].includes(s) ? at(D, 'rejections') : []);
  it.each(STATUSES)('to_status %s', async (s) => {
    const w = createWorld();
    await run(w, e, env(e, T1, { to_status: s }));
    expect(w.marks()).toEqual(expected(s));
    invariants(w);
  });
  it('from_status absent (first status of a specimen, S1) is accepted', async () => {
    const w = createWorld();
    await run(w, e, env(e, T1, { from_status: OMIT, to_status: 'received' }));
    expect(w.marks()).toEqual(expected('received'));
  });
  it('an unknown future status (open enum) still dirties specimens + the backlog and never throws', async () => {
    const w = createWorld();
    await run(w, e, env(e, T1, { to_status: 'quarantined' }));
    expect(w.marks()).toEqual(sorted(at(D, 'specimens'), SNAP));
  });
  it('the date is changed_at, not the other dates the payload could carry', async () => {
    const w = createWorld();
    await run(w, e, env(e, '2026-11-06T10:00:00.000Z', { to_status: 'rejected' }, { }));
    expect(w.marks()).toEqual(sorted(at('2026-11-06', 'specimens', 'tat', 'rejections'), SNAP));
  });
});

describe('optional / conditionally absent fields are accepted and never read (08 A13 D-1, D-2, A17 D-48; TRD §8.2 last paragraph)', () => {
  const validate = eventValidators();
  const check = async (e: Ev, over: Record<string, unknown>, expectMarks: string[]) => {
    const ev = env(e, T1, over);
    expect(validate.get(e.type)!(ev), `contract: ${JSON.stringify((validate.get(e.type) as any).errors)}`).toBe(true);   // the variant really is a legal IC payload
    const w = createWorld();
    await run(w, e, ev);
    expect(w.marks()).toEqual(expectMarks);
    invariants(w);
  };

  it('billing.invoice.issued without centre_id (periodic credit bill, D-1; also no order_id) -> same three families', async () => {
    await check(EVENTS['invoice_issued']!, { centre_id: OMIT, order_id: OMIT, is_periodic_credit_bill: true, credit_party_id: PARTY }, at(bd(T1), 'income', 'department_income', 'referrer_billing').sort());
  });
  it('billing.invoice.issued with centre_id for a normal invoice is identical (centre_id is not a dirty key)', async () => {
    await check(EVENTS['invoice_issued']!, {}, at(bd(T1), 'income', 'department_income', 'referrer_billing').sort());
  });
  it('lab.result.verified (auto-verified: mode auto carries no verifier) without specimen_id and verified_by_membership_id (D-2) -> results + tat', async () => {
    await check(EVENTS['result_verified']!, { specimen_id: OMIT, verified_by_membership_id: OMIT, mode: 'auto', origin: 'instrument' }, at(bd(T1), 'results', 'tat').sort());
  });
  it('lab.result.verified without optional instrument_id / processing_branch_id -> results + tat', async () => {
    await check(EVENTS['result_verified']!, { instrument_id: OMIT, processing_branch_id: OMIT }, at(bd(T1), 'results', 'tat').sort());
  });
  it('reporting.delivery.status_changed without delivery_created_at (D-48) -> deliveries @ bd(changed_at)', async () => {
    await check(EVENTS['delivery_status']!, { delivery_created_at: OMIT }, at(bd(T1), 'deliveries'));
  });
  it('reporting.delivery.status_changed WITH delivery_created_at -> the cohort day bd(delivery_created_at), not bd(changed_at) (D-48)', async () => {
    await check(EVENTS['delivery_status']!, { delivery_created_at: '2026-10-30T09:00:00.000Z' }, at('2026-10-30', 'deliveries'));
  });
  it('delivery_created_at is bucketed with the 18:15 rule too (created 17:00Z on 11-01 is 11-01; created 18:15Z on 11-01 is 11-02)', async () => {
    await check(EVENTS['delivery_status']!, { delivery_created_at: '2026-11-01T17:00:00.000Z' }, at('2026-11-01', 'deliveries'));
    await check(EVENTS['delivery_status']!, { delivery_created_at: '2026-11-01T18:15:00.000Z' }, at('2026-11-02', 'deliveries'));
  });
  it('a malformed delivery_created_at is not trusted blindly: the handler rejects (writes nothing) rather than binding garbage', async () => {
    const e = EVENTS['delivery_status']!, w = createWorld();
    await accepts(e, T1);
    expect(await rejected(run(w, e, env(e, T1, { delivery_created_at: "2026-11-01'; DROP TABLE x;--" })))).toBeDefined();
    expect(w.dirty.size).toBe(0);
  });
  it('recipient_kind phone_otp (D-3 open enum) and an unknown future value are accepted and not read', async () => {
    const e = EVENTS['delivery_status']!;
    for (const kind of ['phone_otp', 'carrier_pigeon']) {
      const w = createWorld();
      await run(w, e, env(e, T1, { recipient_kind: kind }));
      expect(w.marks()).toEqual(at(bd(T1), 'deliveries'));
      expect(JSON.stringify(w.log)).not.toContain(kind);
    }
  });
  it('order.created without optional referrer_id / credit_party_id / source_ref_id -> order_index.referrer_id NULL, same families', async () => {
    const e = EVENTS['order_created']!, w = createWorld();
    await run(w, e, env(e, T1, { referrer_id: OMIT, credit_party_id: OMIT, source_ref_id: OMIT }));
    expect(w.marks()).toEqual(e.marks(T1));
    expect(w.order(ORDER)).toMatchObject({ centre_id: CENTRE, branch_id: BRANCH, referrer_id: null });
  });
});

describe('lab.critical_value.detected / report.released / amended / approved read only their own date field', () => {
  it('released_at, not the order or delivery dates', async () => {
    const e = EVENTS['report_released']!, w = createWorld();
    await run(w, e, env(e, '2026-11-06T04:00:00.000Z', { supersedes_version_no: 1, report_kind: 'amended', audiences: ['patient', 'referrer'], partner_id: id(119) }));
    expect(w.marks()).toEqual(sorted(at('2026-11-06', 'releases', 'tat'), SNAP));
  });
  it('critical value without referrer_id', async () => {
    const e = EVENTS['critical_detected']!, w = createWorld();
    await run(w, e, env(e, T1, { referrer_id: OMIT }));
    expect(w.marks()).toEqual(e.marks(T1));
  });
});

describe('instruments.agent.health_changed — interface_messages @ today (bd of the job clock, not of the payload)', () => {
  const e = EVENTS['agent_health']!;
  it.each([
    ['2026-11-08T06:00:00.000Z', '2026-11-08'], ['2026-11-08T18:14:59.999Z', '2026-11-08'], ['2026-11-08T18:15:00.000Z', '2026-11-09'], ['2026-12-31T18:15:00.000Z', '2027-01-01'],
  ])('now %s -> today %s', async (now, day) => {
    const w = createWorld({ now });
    await run(w, e, env(e, '2026-01-01T00:00:00.000Z'));                    // last_heartbeat_at is old: it must not be the anchor
    expect(w.marks()).toEqual(at(day, 'interface_messages'));
    invariants(w);
  });
  it('optional clock_offset_seconds / silent_instrument_ids / from_state absent or present are not read', async () => {
    const w = createWorld();
    await run(w, e, env(e, NOW, { from_state: OMIT, clock_offset_seconds: -4, silent_instrument_ids: [id(120), id(121)] }));
    expect(w.marks()).toEqual(at('2026-11-08', 'interface_messages'));
    expect(JSON.stringify(w.log)).not.toContain(id(120));
  });
});

// ============================================================================================================================================================================================
describe('out of order (D-C8-04: no aggregate.seq check; dirty marking is order-insensitive — PRD US-20.2)', () => {
  const both = async (a: [Ev, string, Record<string, unknown>?], b: [Ev, string, Record<string, unknown>?]) => {
    const out: string[][] = [];
    for (const [first, second] of [[a, b], [b, a]]) {
      const w = createWorld();
      await run(w, first[0], env(first[0], first[1], first[2]));
      await run(w, second[0], env(second[0], second[1], second[2]));
      invariants(w);
      out.push(w.marks());
    }
    return out;
  };
  it('verified / approved / amended / critical arriving in any order give the same marks', async () => {
    const orders: [Ev, string][][] = [
      [[EVENTS['result_verified']!, '2026-11-03T09:00:00.000Z'], [EVENTS['result_approved']!, '2026-11-04T09:00:00.000Z']],
      [[EVENTS['result_approved']!, '2026-11-04T09:00:00.000Z'], [EVENTS['result_amended']!, '2026-11-05T09:00:00.000Z']],
      [[EVENTS['report_released']!, '2026-11-05T09:00:00.000Z'], [EVENTS['delivery_status']!, '2026-11-05T10:00:00.000Z']],
    ];
    for (const [a, b] of orders) { const [x, y] = await both(a, b); expect(x).toEqual(y); expect(x.length).toBeGreaterThan(1); }
  });
  it('an event carrying an old aggregate.seq / old occurred_at after a newer one is still applied (no stale-seq skip)', async () => {
    const e = EVENTS['result_amended']!, w = createWorld();
    const newer = env(e, '2026-11-05T09:00:00.000Z'); newer.aggregate.seq = 9;
    const older = env(e, '2026-11-02T09:00:00.000Z'); older.aggregate.seq = 2; older.occurred_at = '2026-11-02T09:00:00.000Z';
    await run(w, e, newer); await run(w, e, older);
    expect(w.marks()).toEqual(['results@2026-11-02', 'results@2026-11-05']);
  });
  it('the same invoice issued at two instants yields one mark per day (upsert) — PRD US-20.1: marked dirty once', async () => {
    const e = EVENTS['invoice_issued']!, w = createWorld();
    await run(w, e, env(e, '2026-11-03T04:00:00.000Z'));
    await run(w, e, env(e, '2026-11-03T05:00:00.000Z'));
    expect(w.marks()).toEqual(at('2026-11-03', 'income', 'department_income', 'referrer_billing').sort());
  });
});

// ============================================================================================================================================================================================
describe('analytics.order_index maintenance (TRD §8.2; review #5; D-45)', () => {
  const created = EVENTS['order_created']!, cancelled = EVENTS['order_cancelled']!;
  const REG = '2026-11-02T04:20:00.000Z', CANCEL = '2026-11-08T05:00:00.000Z';
  const plus400 = (iso: string) => new Date(Date.parse(iso) + 400 * DAY).toISOString();
  const same = (a: string | null | undefined, b: string) => expect(a == null ? a : new Date(a).toISOString()).toBe(new Date(b).toISOString());

  it('order.created inserts the row: ids from the payload, registered_on = bd(registered_at), created_by = system actor, source_event_id = event_id, expires_at = registered_at + 400 d', async () => {
    const w = createWorld(), ev = env(created, REG);
    await run(w, created, ev);
    const r = w.order(ORDER)!;
    expect(r).toMatchObject({ tenant_id: TA, order_id: ORDER, centre_id: CENTRE, branch_id: BRANCH, referrer_id: REFERRER, registered_on: '2026-11-02', cancelled_at: null, source_event_id: ev.event_id, created_by: ACTOR });
    same(r.registered_at, REG); same(r.expires_at, plus400(REG));
    expect(w.orders.size).toBe(1);
  });
  it('registered_on follows the 18:15 rule (18:14:59.999Z -> same A.D. day, 18:15:00.000Z -> next day)', async () => {
    for (const [ts, day] of [['2026-11-05T18:14:59.999Z', '2026-11-05'], ['2026-11-05T18:15:00.000Z', '2026-11-06']] as const) {
      const w = createWorld();
      await run(w, created, env(created, ts));
      expect(w.order(ORDER)!.registered_on).toBe(day);
      expect(w.marks()).toEqual(created.marks(ts));
    }
  });
  it('order.created delivered again (new event_id, same order) leaves the complete row untouched — even if the payload differs', async () => {
    const w = createWorld();
    await run(w, created, env(created, REG));
    const before = JSON.stringify(w.order(ORDER));
    await run(w, created, env(created, '2026-11-04T10:00:00.000Z', { centre_id: id(130), branch_id: id(131), referrer_id: id(132) }));
    expect(JSON.stringify(w.order(ORDER))).toBe(before);
    expect(w.orders.size).toBe(1);
  });

  it('order.cancelled on a known order sets cancelled_at once and dirties orders/centre_volume/referrer_volume at the REGISTRATION day (registered_on), plus the backlog', async () => {
    const w = createWorld();
    await run(w, created, env(created, REG));
    await run(w, cancelled, env(cancelled, CANCEL));
    same(w.order(ORDER)!.cancelled_at, CANCEL);
    expect(w.marks()).toEqual(sorted(at('2026-11-02', 'orders', 'centre_volume', 'referrer_volume'), SNAP));
    // a later duplicate/second cancel never moves cancelled_at (… AND cancelled_at IS NULL)
    await run(w, cancelled, env(cancelled, '2026-11-09T05:00:00.000Z'));
    same(w.order(ORDER)!.cancelled_at, CANCEL);
    invariants(w);
  });
  it('the cancel does not dirty the day of cancellation for the order families', async () => {
    const w = createWorld();
    await run(w, created, env(created, REG));
    w.dirty.clear();
    await run(w, cancelled, env(cancelled, CANCEL));
    expect(w.marks().some((m) => m.endsWith(`@${bd(CANCEL)}`))).toBe(false);
  });

  it('cancel BEFORE create: placeholder row (registered_at/on NULL, cancelled_at set, created_by = actor, source_event_id = cancel event, expires_at = now + 400 d); only the backlog is dirtied', async () => {
    const w = createWorld(), ev = env(cancelled, CANCEL);
    await run(w, cancelled, ev);
    const r = w.order(ORDER)!;
    expect(r).toMatchObject({ tenant_id: TA, order_id: ORDER, registered_at: null, registered_on: null, centre_id: null, branch_id: null, referrer_id: null, source_event_id: ev.event_id, created_by: ACTOR });
    same(r.cancelled_at, CANCEL); same(r.expires_at, plus400(NOW));
    expect(w.marks()).toEqual([SNAP]);                                      // registered_on unknown => no dated order mark
    invariants(w);
  });
  it('… then the LATE order.created completes the placeholder (centre/branch/referrer/registered_*/expires_at set), keeps cancelled_at + the placeholder\'s created_by/source_event_id, and dirties the registration day', async () => {
    const w = createWorld(), cev = env(cancelled, CANCEL);
    await run(w, cancelled, cev);
    await run(w, created, env(created, REG));
    const r = w.order(ORDER)!;
    expect(r).toMatchObject({ centre_id: CENTRE, branch_id: BRANCH, referrer_id: REFERRER, registered_on: '2026-11-02', source_event_id: cev.event_id, created_by: ACTOR });
    same(r.registered_at, REG); same(r.cancelled_at, CANCEL); same(r.expires_at, plus400(REG));
    expect(w.orders.size).toBe(1);
    expect(w.marks()).toEqual(sorted(at('2026-11-02', 'orders', 'centre_volume', 'referrer_volume'), SNAP));
    invariants(w);
  });
  it('… and a second order.created after completion does not overwrite it (WHERE registered_on IS NULL)', async () => {
    const w = createWorld();
    await run(w, cancelled, env(cancelled, CANCEL));
    await run(w, created, env(created, REG));
    const before = JSON.stringify(w.order(ORDER));
    await run(w, created, env(created, '2026-11-09T04:00:00.000Z', { centre_id: id(140) }));
    expect(JSON.stringify(w.order(ORDER))).toBe(before);
  });
  it('cancel delivered twice before the create: one placeholder, cancelled_at from the first, no unique violation', async () => {
    const w = createWorld();
    await run(w, cancelled, env(cancelled, CANCEL));
    await run(w, cancelled, env(cancelled, '2026-11-09T05:00:00.000Z'));
    expect(w.orders.size).toBe(1);
    same(w.order(ORDER)!.cancelled_at, CANCEL);
  });
  it('a pre-existing order from another tenant with the same order_id is never read or changed', async () => {
    const w = createWorld({ orders: [{ tenant_id: TB, order_id: ORDER, registered_at: REG, registered_on: '2026-11-02', centre_id: id(150), created_by: id(151), expires_at: plus400(REG) }] });
    await run(w, cancelled, env(cancelled, CANCEL));
    expect(w.order(ORDER, TB)).toMatchObject({ cancelled_at: null, centre_id: id(150), created_by: id(151) });
    expect(w.order(ORDER, TA)).toMatchObject({ registered_on: null });      // TA got its own placeholder
    expect(w.marks()).toEqual([SNAP]);
  });
  it('order.created with a hostile order_id / centre_id is refused before any write', async () => {
    for (const over of [{ order_id: "x'; DROP TABLE analytics.order_index;--" }, { centre_id: 'not-a-uuid' }, { branch_id: 42 }, { order_id: OMIT }]) {
      await accepts(created, REG);
      const w = createWorld();
      expect(await rejected(run(w, created, env(created, REG, over))), JSON.stringify(over)).toBeDefined();
      expect(w.orders.size + w.dirty.size).toBe(0);
    }
  });
  it('order.cancelled with a hostile order_id is refused before any write', async () => {
    await accepts(cancelled, CANCEL);
    const w = createWorld();
    expect(await rejected(run(w, cancelled, env(cancelled, CANCEL, { order_id: "1' OR '1'='1" })))).toBeDefined();
    expect(w.orders.size + w.dirty.size).toBe(0);
  });
  it('other events never touch order_index', async () => {
    for (const k of KEYS.filter((x) => !x.startsWith('order_'))) {
      const w = createWorld();
      await run(w, EVENTS[k]!, env(EVENTS[k]!, T1));
      expect(w.orders.size, k).toBe(0);
      expect(w.log.some((l) => /order_index/i.test(l.text)), k).toBe(false);
    }
  });
});

describe('marks already pending are bumped, not duplicated; other tenants\' marks are untouched', () => {
  it('an existing mark for the same (family, date) gets last_marked_at = now and keeps first_marked_at', async () => {
    const e = EVENTS['invoice_issued']!;
    const w = createWorld({ marks: [{ family: 'income', date: bd(T1) }] });
    await run(w, e, env(e, T1));
    const m = [...w.dirty.values()].find((d) => d.family === 'income')!;
    expect(m.first_marked_at).toBe('2026-11-07T00:00:00.000Z');
    expect(new Date(m.last_marked_at).toISOString()).toBe(NOW);
    expect(w.dirty.size).toBe(3);
  });
});
