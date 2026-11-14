// C16.T-P1 — event consumers lab.specimen.status_changed.v1, lab.specimen.rejected.v1, reporting.report.released.v1, billing.balance.changed.v1 + stage recompute + in-app notifications
// (06-PLAN row T-P1; 02-TRD §4.4 consumer algorithm, §4.5 stage, §4.9 notifications, §7.2 consumed events; 01-PRD US-EN-07.1-5, US-EN-08.1-2; 02-CV §7.4 inbox + seq guard; 08 A13 P-4 unknown report_kind;
// 03-IC §3.5 / §3.7 / §3.8 / §3.17 example payloads, used verbatim). done_when: inbox dedupe; seq guard; unlinked no-op.
// Fails now: the four manifest subscriptions are the T-01 fail-closed stubs ("consumer <type> not implemented").
//
// SEAMS (spec fixes behaviour, not names): the handler under test is ALWAYS `manifest.subscriptions[<event type>]` of ../index.ts (TRD §3.3: consumers/<event>.ts in services/worker/src/jobs/engagement, each `export const handle: ConsumerHandler`
//   - T-B1 / T-B4 pattern). ctx = worker JobContext (system actor, tx, now(), ports{ReportingPort}, log). Two harnesses on the T-L2 link world (api __tests__/link.world.ts):
//   deliver()  = the handler called directly (handler behaviour: unlinked no-op, seq guard, stages, notifications, tenant guard);
//   consume()  = the REAL core wrapper core/consumer.ts consumerRun (inbox insert ON CONFLICT DO NOTHING, core.event_log read, ajv envelope validation with known-fields-only, one transaction: inbox row rolls back with it).
//   Link lookup: any plain SQL on engagement.account_patient_links (status IN ('active','suspended')). Views only through repository/views.repo.ts. Writes through service/projection.service.ts + service/notification.service.ts.
//   The world answers plain SQL only (no JOIN / sub-select / INSERT..SELECT / OR); see link.world.ts header. Notification dedupe = INSERT .. ON CONFLICT DO NOTHING (the world raises 23505 on a plain duplicate INSERT).
//   Report panel names / smart flag: ReportingPort.getReleasedReports(ctx, {filter:{orderId}, ..}) as the system actor - the REAL C6 fake (exactly one filter key; superseded rows only with includeSuperseded).
import '../../../../../api/src/__tests__/setup-env.js';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { consumerRun } from '../../../core/consumer.js';
import { validateManifests } from '../../../core/manifest.js';
import { manifest } from '../index.js';
import { createFakeReportingPort } from '../../../../../../packages/fakes/src/ReportingPort.fake';
import { REPO_ROOT } from '../../../../../api/src/core/module.js';
import { ID, SYSTEM_ACTOR, T0, TENANT_A, TENANT_B, makeLinkWorld, type LinkWorld } from '../../../../../api/src/modules/engagement/__tests__/link.world.js';

type Row = Record<string, any>;
const ST = 'lab.specimen.status_changed.v1', REJ = 'lab.specimen.rejected.v1', REL = 'reporting.report.released.v1', BAL = 'billing.balance.changed.v1';
const PHONE = '+99001000001', PHONE2 = '+99001000002';
const X = (n: number) => `01a1a98a-ac40-7000-8000-${n.toString(16).padStart(12, '0')}`;            // the id style of the 03-IC examples
const PAT = X(0x40001), PAT2 = X(0x40002), ORD = X(0x50001), ORD2 = X(0x50002), SPEC = X(0x90001), SPEC2 = X(0x90002), SPEC3 = X(0x90003), CENTRE = X(0x20002), BRANCH = X(0x10001), RPT = X(0xf0001), ITEM = X(0x60001);
const REG = '2026-11-05T02:00:00.000Z';                                                          // order registered before every event below
const rejection = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as any; } return undefined; };
const money = (n: number) => ({ amount_paisa: n, currency: 'NPR' });
const VOLATILE = ['created_at', 'updated_at', 'synced_at'];

// ---------------------------------------------------------------- payloads: 03-IC §3.7 / §3.8 / §3.17 / §3.5 examples
const stP = (o: Row = {}): Row => ({ specimen_id: SPEC, order_id: ORD, patient_id: PAT, centre_id: CENTRE, processing_branch_id: BRANCH, specimen_type_code: 'EDTA_WB', from_status: 'in_transit', to_status: 'received', changed_at: '2026-11-05T03:20:41.300Z', order_item_ids: [ITEM], ...o });
const rejP = (o: Row = {}): Row => ({ specimen_id: SPEC, order_id: ORD, patient_id: PAT, centre_id: CENTRE, reason_code: 'haemolysed', rejected_at: '2026-11-05T03:25:00.000Z', recollection_required: true, order_item_ids: [X(0x60002)], ...o });
const relP = (o: Row = {}): Row => ({ report_id: RPT, version_no: 1, order_id: ORD, patient_id: PAT, centre_id: CENTRE, referrer_id: X(0x140001), report_kind: 'final', released_at: '2026-11-05T04:35:00.000Z', release_basis: 'paid_in_full', audiences: ['patient', 'referrer'], order_item_ids: [ITEM], ...o });
const balP = (o: Row = {}): Row => ({ order_id: ORD, balance_version: 3, invoiced: money(225000), paid: money(225000), credited: money(0), balance_due: money(0), cause: 'payment_recorded', release_eligible: true, release_basis: 'paid_in_full', ...o });
const META: Record<string, { producer: string; agg: string; id: (p: Row) => string }> = {
  [ST]: { producer: 'lab', agg: 'specimen', id: (p) => p['specimen_id'] }, [REJ]: { producer: 'lab', agg: 'specimen', id: (p) => p['specimen_id'] },
  [REL]: { producer: 'reporting', agg: 'report', id: (p) => p['report_id'] }, [BAL]: { producer: 'billing', agg: 'order_balance', id: (p) => p['order_id'] },
};
let evn = 0;
const envelope = (tenant: string, type: string, payload: Row, seq: number, eventId?: string): Row => ({ event_id: eventId ?? ID(0xe000 + ++evn), event_type: type, tenant_id: tenant, occurred_at: T0, actor: { type: 'user', id: ID(0x5a1) },
  idempotency_key: `${META[type]!.id(payload)}:${type}:${seq}`, producer: META[type]!.producer, aggregate: { type: META[type]!.agg, id: META[type]!.id(payload), seq }, request_id: ID(0xf1), payload });

// ---------------------------------------------------------------- C6 fixture (what getReleasedReports returns)
const fxReport = (o: Row = {}): Row => ({ id: ID(0x4000 + (o['versionNo'] ?? 1) + (o['reportId'] && o['reportId'] !== RPT ? 100 : 0)), tenantId: TENANT_A, reportId: RPT, versionNo: 1, orderId: ORD, patientId: PAT, kind: 'final', status: 'valid', released: true,
  releasedAt: '2026-11-05T04:35:00.000Z', panelNames: ['Lipid Profile', 'CBC'], ...o });

interface Opt { seq?: number; eventId?: string; tenant?: string; ctx?: Row }
interface Fx {
  w: LinkWorld; rp: any; acct: Row; link: Row; inbox: Set<string>;
  deliver: (type: string, payload: Row, o?: Opt) => Promise<void>;
  env: (type: string, payload: Row, seq?: number, eventId?: string) => Row;
  consume: (e: Row, attempt?: number) => Promise<void>;
  addLink: (patient: string, over?: Row, phone?: string) => { acct: Row; link: Row };
  t: (name: string) => Row[]; orders: () => Row[]; specs: () => Row[]; reports: () => Row[]; notes: () => Row[];
  order: (id?: string) => Row; spec: (id?: string) => Row; stable: () => string;
}
async function setup(o: { reports?: Row[]; showPartner?: boolean; smart?: boolean; link?: Row | false } = {}): Promise<Fx> {
  const w = makeLinkWorld({ showPartnerOrders: o.showPartner ?? false, maxAccountsPerPatient: 10 });
  if (o.smart) w.setSetting('smart_report_in_app', true);
  const rp: any = createFakeReportingPort({ seed: 7, fixtures: { reports: o.reports ?? [] } as any });
  const acct = w.seedAccount(PHONE); const link = o.link === false ? ({} as Row) : w.seedLink(acct['id'], PAT, { method: 'link_code', ...(o.link ?? {}) });
  const ports = { ...w.ports, ReportingPort: rp };
  const handlerOf = (type: string) => { const h = manifest.subscriptions?.[type]; if (!h) throw new Error(`manifest has no subscription ${type}`); return h; };
  const env: Fx['env'] = (type, payload, seq = 1, eventId) => { const e = envelope(w.tenantId, type, payload, seq, eventId); evlog.set(`${e['tenant_id']}:${e['event_id']}`, e); return e; };
  const evlog = new Map<string, Row>(); const inbox = new Set<string>(); let lock: Promise<unknown> = Promise.resolve();
  const deps: any = { systemActorOf: () => SYSTEM_ACTOR, events: {}, core: {}, storage: {}, files: {}, audit: {}, log: w.log, now: () => new Date(w.now()),
    db: { async tx(_o: unknown, fn: (tx: any) => Promise<unknown>) { // serialised like a row lock; the inbox row lives and dies with the transaction
      const prev = lock; let release!: () => void; lock = new Promise<void>((r) => { release = r; }); await prev; const added: string[] = [];
      try { return await w.inTx(async () => { const base = w.jobCtx();
        const tx = { async query(text: string, values: unknown[] = []) {
          if (/event_inbox/i.test(text)) { const k = `${values[0]}:${values[1]}`; if (inbox.has(k)) return { rows: [] }; inbox.add(k); added.push(k); return { rows: [{ event_id: values[1] }] }; }
          if (/core\.event_log/i.test(text)) { const e = evlog.get(`${values[0]}:${values[1]}`); return { rows: e ? [{ event_type: e['event_type'], envelope: structuredClone(e) }] : [] }; }
          return base.tx.query(text, values); } };
        return fn(tx); }); } catch (e) { for (const k of added) inbox.delete(k); throw e; } finally { release(); } } } };
  const consume: Fx['consume'] = (e, attempt = 1) => consumerRun(deps, { module: 'engagement', identifier: `evt.engagement.${e['event_type']}` } as any, e['event_type'], (ev, c) => handlerOf(e['event_type'])(ev, { ...c, ports } as any))(
    { event_id: e['event_id'], tenant_id: e['tenant_id'], event_type: e['event_type'] }, { id: '1', attempts: attempt, max_attempts: 5 } as any);
  const deliver: Fx['deliver'] = (type, payload, p = {}) => w.inTx(() => handlerOf(type)(envelope(p.tenant ?? w.tenantId, type, payload, p.seq ?? 1, p.eventId), w.jobCtx({ ports, ...(p.ctx ?? {}) })));
  const addLink = (patient: string, over: Row = {}, phone = PHONE2) => { const a = w.seedAccount(phone); return { acct: a, link: w.seedLink(a['id'], patient, { method: 'link_code', ...over }) }; };
  const t = (n: string) => w.t[n]!;
  const fx: Fx = { w, rp, acct, link, inbox, deliver, env, consume, addLink, t, orders: () => t('patient_orders'), specs: () => t('patient_order_specimens'), reports: () => t('patient_reports'), notes: () => t('notifications'),
    order: (id = ORD) => t('patient_orders').find((r) => r['order_id'] === id)!, spec: (id = SPEC) => t('patient_order_specimens').find((r) => r['specimen_id'] === id)!,
    stable: () => JSON.stringify(['patient_orders', 'patient_order_specimens', 'patient_reports', 'notifications', 'jobs'].map((n) => t(n).map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !VOLATILE.includes(k)))))) };
  return fx;
}
// published-view row (frontdesk.v_pub_order_status) and already-projected rows
const viewOrder = (f: Fx, o: Row = {}) => { f.t('orders').push({ tenant_id: f.w.tenantId, order_id: ORD, patient_id: PAT, centre_id: CENTRE, branch_id: BRANCH, source: 'front_desk', source_ref_id: null, partner_id: null, status: 'registered', registered_at: REG, updated_at: REG, ...o }); };
const projOrder = (f: Fx, o: Row = {}): Row => { const r: Row = { tenant_id: f.w.tenantId, order_id: ORD, patient_id: PAT, centre_id: CENTRE, branch_id: BRANCH, source: 'front_desk', booking_id: null, order_status: 'registered', registered_at: REG, visible_at: REG, stage: 'registered', payment_due: false,
  invoiced_paisa: null, paid_paisa: null, balance_due_paisa: null, balance_version: null, release_basis: null, status_version: 1, synced_at: T0, created_at: T0, updated_at: T0, created_by: SYSTEM_ACTOR, updated_by: SYSTEM_ACTOR, ...o }; f.t('patient_orders').push(r); return r; };
const projSpec = (f: Fx, o: Row = {}): Row => { const r: Row = { tenant_id: f.w.tenantId, specimen_id: SPEC, order_id: ORD, patient_id: PAT, specimen_type_code: 'EDTA_WB', status: 'received', status_seq: 3, ordinal: 1, collected_at: null, received_at: '2026-11-05T03:20:41.300Z', rejected_at: null,
  rejection_reason_code: null, recollection_required: false, replaces_specimen_id: null, created_at: T0, updated_at: T0, created_by: SYSTEM_ACTOR, updated_by: SYSTEM_ACTOR, ...o }; f.t('patient_order_specimens').push(r); return r; };
const projReport = (f: Fx, o: Row = {}): Row => { const r: Row = { tenant_id: f.w.tenantId, report_id: RPT, version_no: 1, order_id: ORD, patient_id: PAT, report_kind: 'final', status: 'valid', released_at: '2026-11-05T04:35:00.000Z', supersedes_version_no: null, panel_names: ['Lipid Profile', 'CBC'],
  smart_summary_available: false, created_at: T0, updated_at: T0, created_by: SYSTEM_ACTOR, updated_by: SYSTEM_ACTOR, ...o }; f.t('patient_reports').push(r); return r; };
const ready = (o: { reports?: Row[]; smart?: boolean; link?: Row | false } = {}) => setup(o).then((f) => { projOrder(f, { stage: 'in_lab' }); projSpec(f); return f; });   // linked patient, order projected, one received specimen

beforeAll(async () => { // pay the lazy ajv / contract-schema compile outside a test's 5 s budget (swallow: the stubs throw)
  const f = await setup(); await f.consume(f.env(ST, stP(), 1)).catch(() => undefined);
}, 120_000);

// =============================================================================================================================================================================
describe('wiring (TRD §7.2, §8: EVENT_CONSUMERS.engagement)', () => {
  it('manifest validates and the four consumers are real handlers, not the T-01 fail-closed stubs: an event of an unlinked patient resolves', async () => {
    expect(() => validateManifests([manifest])).not.toThrow();
    for (const [type, p, seq] of [[ST, stP(), 1], [REJ, rejP(), 1], [REL, relP(), 1], [BAL, balP(), 3]] as const) {
      const f = await setup({ link: false }); const e = await rejection(f.deliver(type, p, { seq }));
      expect(String(e?.message ?? ''), type).not.toMatch(/not implemented/); expect(e, type).toBeUndefined();
    }
  });
});

describe('lab.specimen.status_changed.v1 (US-EN-07.1 / 07.2 / 07.3 / 07.5; TRD §7.2 row 1)', () => {
  it('03-IC §3.7 example, linked patient, order not yet projected: the order row is fetched from frontdesk.v_pub_order_status (tenant-filtered), the specimen is projected with status_seq = aggregate.seq, stage in_lab; NO notification', async () => {
    const f = await setup(); viewOrder(f); await f.deliver(ST, stP(), { seq: 7 });
    expect(f.orders()).toHaveLength(1);
    expect(f.order()).toMatchObject({ tenant_id: f.w.tenantId, order_id: ORD, patient_id: PAT, centre_id: CENTRE, branch_id: BRANCH, source: 'front_desk', order_status: 'registered', stage: 'in_lab' });
    expect(Date.parse(f.order()['registered_at'])).toBe(Date.parse(REG)); expect(Date.parse(f.order()['visible_at'])).toBe(Date.parse(REG));
    expect(f.spec()).toMatchObject({ tenant_id: f.w.tenantId, specimen_id: SPEC, order_id: ORD, patient_id: PAT, specimen_type_code: 'EDTA_WB', status: 'received', status_seq: 7, ordinal: 1, recollection_required: false, rejected_at: null, rejection_reason_code: null });
    expect(Date.parse(f.spec()['received_at'])).toBe(Date.parse('2026-11-05T03:20:41.300Z'));
    expect(f.w.viewQueries.length).toBeGreaterThan(0); for (const v of f.w.viewQueries) expect(v.text).toMatch(/tenant_id\s*=\s*\$\d+/i);
    expect(f.notes()).toHaveLength(0);
  });
  it('US-EN-07.1: ordered -> collected -> received on an order with 2 specimens: stage sample_collected, then in_lab; collected_at / received_at from changed_at; Sample numbers 1 and 2', async () => {
    const f = await setup(); viewOrder(f);
    await f.deliver(ST, stP({ to_status: 'collected', from_status: 'ordered', changed_at: '2026-11-05T02:30:00.000Z' }), { seq: 2 });
    await f.deliver(ST, stP({ specimen_id: SPEC2, to_status: 'collected', from_status: 'ordered', changed_at: '2026-11-05T02:31:00.000Z' }), { seq: 2 });
    expect(f.order()['stage']).toBe('sample_collected'); expect(f.spec()).toMatchObject({ status: 'collected', ordinal: 1, received_at: null }); expect(f.spec(SPEC2)).toMatchObject({ status: 'collected', ordinal: 2 });
    expect(Date.parse(f.spec()['collected_at'])).toBe(Date.parse('2026-11-05T02:30:00.000Z'));
    await f.deliver(ST, stP({ to_status: 'received', from_status: 'in_transit' }), { seq: 4 });
    expect(f.order()['stage']).toBe('in_lab'); expect(f.spec()).toMatchObject({ status: 'received', status_seq: 4, ordinal: 1 }); expect(f.spec(SPEC2)).toMatchObject({ status: 'collected', ordinal: 2 });
    expect(f.orders()).toHaveLength(1); expect(f.specs()).toHaveLength(2);
  });
  it('US-EN-07.2: out of order (seq 3 before seq 2): the projection keeps seq 3\'s state; the stale event changes nothing at all', async () => {
    const f = await setup(); viewOrder(f); await f.deliver(ST, stP({ to_status: 'received' }), { seq: 3 }); const after = f.stable();
    await f.deliver(ST, stP({ to_status: 'collected', from_status: 'ordered', changed_at: '2026-11-05T02:30:00.000Z' }), { seq: 2 });
    expect(f.spec()).toMatchObject({ status: 'received', status_seq: 3, collected_at: null }); expect(f.order()['stage']).toBe('in_lab'); expect(f.stable()).toBe(after);
  });
  it('the same seq delivered again under another event_id changes nothing (idempotent apply)', async () => {
    const f = await setup(); viewOrder(f); await f.deliver(ST, stP(), { seq: 5 }); const after = f.stable();
    await f.deliver(ST, stP(), { seq: 5 }); expect(f.stable()).toBe(after); expect(f.specs()).toHaveLength(1);
  });
  it('US-EN-07.3: the same event delivered twice through the real wrapper -> exactly one inbox row and one projection change; the second delivery writes nothing', async () => {
    const f = await setup(); viewOrder(f); const e = f.env(ST, stP(), 7);
    await f.consume(e); const after = f.stable(), writes = f.w.writes().length;
    await expect(f.consume(e, 2)).resolves.toBeUndefined();
    expect(f.inbox.size).toBe(1); expect(f.stable()).toBe(after); expect(f.w.writes().length).toBe(writes); expect(f.specs()).toHaveLength(1); expect(f.spec()['status_seq']).toBe(7);
  });
  it('two concurrent deliveries of one event project once', async () => {
    const f = await setup(); viewOrder(f); const e = f.env(ST, stP(), 7);
    await Promise.all([f.consume(e), f.consume(e)]); expect(f.inbox.size).toBe(1); expect(f.specs()).toHaveLength(1); expect(f.orders()).toHaveLength(1);
  });
  it('unlinked patient (no link / revoked / another patient\'s link / a link of another tenant): committed no-op - no write, no view read, no failure; the inbox row IS recorded', async () => {
    for (const mk of ['none', 'revoked', 'other_patient', 'other_tenant']) {
      const f = await setup({ link: mk === 'none' ? false : mk === 'revoked' ? { status: 'revoked', revoked_by_kind: 'account', revoked_reason_code: 'patient_request', revoked_at: T0 } : undefined });
      if (mk === 'other_patient') { f.t('account_patient_links').length = 0; f.addLink(PAT2); }
      if (mk === 'other_tenant') f.link['tenant_id'] = TENANT_B;
      viewOrder(f); const before = f.w.writes().length; const e = f.env(ST, stP(), 7);
      await expect(f.consume(e), mk).resolves.toBeUndefined();
      expect(f.w.writes().length, mk).toBe(before); expect(f.w.viewQueries, mk).toHaveLength(0); expect(f.orders(), mk).toHaveLength(0); expect(f.specs(), mk).toHaveLength(0); expect(f.notes(), mk).toHaveLength(0); expect(f.inbox.size, mk).toBe(1);
    }
  });
  it('a SUSPENDED link still gets the projection (§4.4: active or suspended)', async () => {
    const f = await setup({ link: { status: 'suspended', suspend_reason: 'dormant', suspended_at: T0 } }); viewOrder(f); await f.deliver(ST, stP(), { seq: 2 });
    expect(f.orders()).toHaveLength(1); expect(f.spec()).toMatchObject({ status: 'received' });
  });
  it('US-EN-07.5: partner_manifest order with show_partner_orders = false -> not projected (no order, no specimen, no notification), no failure; with the setting on it is', async () => {
    const off = await setup(); viewOrder(off, { source: 'partner_manifest', partner_id: X(0x9100) }); await expect(off.deliver(ST, stP(), { seq: 2 })).resolves.toBeUndefined();
    expect(off.orders()).toHaveLength(0); expect(off.specs()).toHaveLength(0); expect(off.notes()).toHaveLength(0);
    const on = await setup({ showPartner: true }); viewOrder(on, { source: 'partner_manifest', partner_id: X(0x9100) }); await on.deliver(ST, stP(), { seq: 2 });
    expect(on.order()).toMatchObject({ source: 'partner_manifest' }); expect(on.specs()).toHaveLength(1);
  });
  it('an already projected order is NOT re-fetched from the view; only that order\'s stage changes (other orders of the patient keep their status_version)', async () => {
    const f = await setup(); projOrder(f); const other = projOrder(f, { order_id: ORD2, stage: 'in_lab', status_version: 5 }); projSpec(f, { specimen_id: X(0x90009), order_id: ORD2, status: 'received' });
    await f.deliver(ST, stP({ to_status: 'collected', from_status: 'ordered' }), { seq: 1 });
    expect(f.w.viewQueries.filter((v) => v.view === 'v_pub_order_status')).toHaveLength(0); expect(f.order()['stage']).toBe('sample_collected'); expect(f.order()['status_version']).toBeGreaterThan(1);
    expect(other['status_version']).toBe(5); expect(other['stage']).toBe('in_lab');
  });
  it('recollection_ordered (replaces_specimen_id): recollection_required, replaces_specimen_id kept, stage recollection_needed', async () => {
    const f = await setup(); viewOrder(f); projOrder(f, { stage: 'in_lab' }); projSpec(f, { status: 'rejected', status_seq: 4, rejected_at: '2026-11-05T03:25:00.000Z', rejection_reason_code: 'haemolysed', recollection_required: true });
    await f.deliver(ST, stP({ specimen_id: SPEC3, to_status: 'recollection_ordered', replaces_specimen_id: SPEC }), { seq: 1 }); // from_status absent: a new specimen row (03-IC §3.7 trigger)
    expect(f.spec(SPEC3)).toMatchObject({ status: 'recollection_ordered', recollection_required: true, replaces_specimen_id: SPEC, ordinal: 2 }); expect(f.order()['stage']).toBe('recollection_needed');
  });
  it('unknown extra payload fields are ignored (direct) and dropped by the wrapper (known fields only); nothing of them is stored or observed', async () => {
    const f = await setup(); viewOrder(f); await f.deliver(ST, stP({ future_field: 'LEAK-SENTINEL', nested: { a: 'LEAK-SENTINEL' } }), { seq: 2 });
    const g = await setup(); viewOrder(g); await g.consume(g.env(ST, stP({ future_field: 'LEAK-SENTINEL' }), 2));
    for (const x of [f, g]) { expect(x.specs()).toHaveLength(1); expect(JSON.stringify([x.orders(), x.specs(), x.notes(), x.t('jobs')]) + x.w.observed()).not.toContain('LEAK-SENTINEL'); }
  });
  it('a payload that breaks the contract (missing to_status) fails through the wrapper before any write and leaves no inbox row (so the retry can run)', async () => {
    const f = await setup(); viewOrder(f); const { to_status: _t, ...broken } = stP(); const before = f.w.writes().length;
    expect(await rejection(f.consume(f.env(ST, broken, 2)))).toBeTruthy(); expect(f.w.writes().length).toBe(before); expect(f.inbox.size).toBe(0); expect(f.specs()).toHaveLength(0);
  });
  it('REQ-SEC-024: an event whose tenant is not the job tenant writes nothing; another tenant\'s order row is never read or touched; hostile ids never reach SQL text', async () => {
    const f = await setup(); viewOrder(f); viewOrder(f, { tenant_id: TENANT_B, order_id: ORD2, patient_id: PAT }); const before = f.stable();
    await f.deliver(ST, stP(), { seq: 2, tenant: TENANT_B }).catch(() => undefined); expect(f.stable()).toBe(before);
    await f.deliver(ST, stP({ order_id: ORD2, specimen_id: SPEC2 }), { seq: 2 }).catch(() => undefined); expect(f.orders().filter((r) => r['order_id'] === ORD2)).toHaveLength(0);
    const evil = `${PAT}'; DROP TABLE engagement.patient_orders;--`; const w0 = f.w.writes().length;
    await f.deliver(ST, stP({ patient_id: evil }), { seq: 3 }).catch(() => undefined);
    for (const s of f.w.stmts) expect(s.text).not.toContain('DROP TABLE'); expect(f.w.writes().length).toBe(w0);
  });
  it('order not yet in the published view (race): nothing half-written - either a quiet no-op or a throw that rolls back; once the view has it, the next delivery projects it', async () => {
    const f = await setup(); viewOrder(f); const orig = f.t('orders').splice(0); // view row not visible yet: the consumer must not invent an order
    const e = await rejection(f.deliver(ST, stP(), { seq: 2 })); if (e === undefined) expect(f.orders()).toHaveLength(0); else expect(f.specs()).toHaveLength(0);
    f.t('orders').push(...orig); await f.deliver(ST, stP(), { seq: 2 }); expect(f.specs()).toHaveLength(1); expect(f.orders()).toHaveLength(1);
  });
});

describe('lab.specimen.rejected.v1 (US-EN-07.4; TRD §7.2 row 2, §4.9 sample_recollection)', () => {
  const rejected = async (o: { link?: Row | false } = {}) => { const f = await setup(o); projOrder(f, { stage: 'in_lab' }); projSpec(f, { status: 'received', status_seq: 3 }); await f.deliver(ST, stP({ to_status: 'rejected', from_status: 'received' }), { seq: 4 }); return f; }; // C5 emits both events for one transition
  it('03-IC §3.8 example (recollection_required: true): rejected_at + rejection_reason_code stored (staff-only), stage recollection_needed, ONE notification sample_recollection for the account without the reason', async () => {
    const f = await rejected(); await f.deliver(REJ, rejP(), { seq: 4 });
    expect(f.spec()).toMatchObject({ status: 'rejected', rejection_reason_code: 'haemolysed', recollection_required: true }); expect(Date.parse(f.spec()['rejected_at'])).toBe(Date.parse('2026-11-05T03:25:00.000Z'));
    // review T-P1 #1: FakeSql returns whole rows whatever the SELECT list, so the real-PG failure (specimen_type_code undefined -> NULL into a NOT NULL column, 05-SCHEMA) is pinned on the SQL text: every SELECT on patient_order_specimens that feeds the upsert must list specimen_type_code.
    expect(f.spec()).toMatchObject({ specimen_type_code: 'EDTA_WB' });
    const sel = f.w.stmts.filter((s: { text: string }) => /^\s*select\b[^]*\bfrom\s+engagement\.patient_order_specimens\b/i.test(s.text)); expect(sel.length).toBeGreaterThan(0);
    for (const s of sel) expect((s as { text: string }).text, 'SELECT list of the specimen read').toMatch(/^\s*select\b[^]*?\bspecimen_type_code\b[^]*?\bfrom\b/i);
    expect(f.order()['stage']).toBe('recollection_needed');
    expect(f.notes()).toHaveLength(1); const n = f.notes()[0]!;
    expect(n).toMatchObject({ tenant_id: f.w.tenantId, account_id: f.acct['id'], patient_id: PAT, kind: 'sample_recollection', route_id: 'patient_app.order', created_by: SYSTEM_ACTOR, read_at: null });
    expect([ORD, SPEC]).toContain(n['entity_id']); expect(['order', null]).toContain(n['entity_type']);
    expect(JSON.stringify(n)).not.toContain('haemolysed'); const days = (Date.parse(n['expires_at']) - Date.parse(f.w.now())) / 86_400_000; expect(days).toBeGreaterThan(179); expect(days).toBeLessThan(181); // 180-day expiry [CONV]
    expect(Object.keys(n).every((k) => ['id', 'tenant_id', 'account_id', 'patient_id', 'kind', 'entity_type', 'entity_id', 'entity_seq', 'route_id', 'read_at', 'created_at', 'created_by', 'expires_at'].includes(k)), 'no text columns').toBe(true);
  });
  it('recollection_required: false -> rejection stored, stage stays in_lab, NO notification', async () => {
    const f = await rejected(); await f.deliver(REJ, rejP({ recollection_required: false }), { seq: 4 });
    expect(f.spec()).toMatchObject({ status: 'rejected', rejection_reason_code: 'haemolysed', recollection_required: false }); expect(f.order()['stage']).toBe('in_lab'); expect(f.notes()).toHaveLength(0);
  });
  it('the same rejection again (other event_id, or same event through the wrapper): one notification, no further change; every linked account is told once', async () => {
    const f = await rejected(); const second = f.addLink(PAT); await f.deliver(REJ, rejP(), { seq: 4 }); const after = f.stable();
    await f.deliver(REJ, rejP(), { seq: 4 }); expect(f.stable()).toBe(after); expect(f.notes().map((n) => n['account_id']).sort()).toEqual([f.acct['id'], second.acct['id']].sort());
    const g = await rejected(); const e = g.env(REJ, rejP(), 4); await g.consume(e); const once = g.stable(); await g.consume(e, 2); expect(g.stable()).toBe(once); expect(g.notes()).toHaveLength(1); expect(g.inbox.size).toBe(1);
  });
  it('the status_changed(rejected) event arriving AFTER the rejected event does not wipe recollection_required, the reason or rejected_at; the stage stays recollection_needed', async () => {
    const f = await setup(); projOrder(f, { stage: 'in_lab' }); projSpec(f, { status: 'received', status_seq: 3 });
    await f.deliver(REJ, rejP(), { seq: 4 }); await f.deliver(ST, stP({ to_status: 'rejected', from_status: 'received' }), { seq: 4 }); await f.deliver(ST, stP({ to_status: 'rejected', from_status: 'received' }), { seq: 5 });
    expect(f.spec()).toMatchObject({ status: 'rejected', rejection_reason_code: 'haemolysed', recollection_required: true }); expect(f.spec()['rejected_at']).toBeTruthy(); expect(f.order()['stage']).toBe('recollection_needed'); expect(f.notes()).toHaveLength(1);
  });
  it('rejected event BEFORE the specimen is projected: it is applied or retried (throws and rolls back), never acked and lost - after the status event and the retry the final state is the same', async () => {
    const f = await setup(); viewOrder(f); const e = await rejection(f.deliver(REJ, rejP(), { seq: 4 }));
    if (e) { expect(f.specs()).toHaveLength(0); expect(f.notes()).toHaveLength(0); }
    await f.deliver(ST, stP({ to_status: 'rejected', from_status: 'received' }), { seq: 4 }); await f.deliver(REJ, rejP(), { seq: 4, eventId: ID(0xe9f9) });
    expect(f.spec()).toMatchObject({ status: 'rejected', rejection_reason_code: 'haemolysed', recollection_required: true }); expect(f.order()['stage']).toBe('recollection_needed'); expect(f.notes()).toHaveLength(1);
  });
  it('unlinked patient / revoked link -> no write, no notification; partner order with show_partner_orders = false -> not projected, no notification', async () => {
    const none = await setup({ link: false }); projOrder(none, { stage: 'in_lab' }); const before = none.w.writes().length; await none.deliver(REJ, rejP(), { seq: 4 }); expect(none.w.writes().length).toBe(before); expect(none.notes()).toHaveLength(0);
    const partner = await setup(); viewOrder(partner, { source: 'partner_manifest', partner_id: X(0x9100) }); await expect(partner.deliver(REJ, rejP(), { seq: 4 })).resolves.toBeUndefined(); expect(partner.specs()).toHaveLength(0); expect(partner.notes()).toHaveLength(0);
  });
  it('unknown extra fields ignored; the rejection reason never reaches logs, audit, metrics or the notification (P1, staff-only)', async () => {
    const f = await rejected(); await f.deliver(REJ, rejP({ reason_code: 'secret_reason_code', future_field: 'LEAK-SENTINEL' }), { seq: 4 });
    expect(f.spec()['rejection_reason_code']).toBe('secret_reason_code'); expect(JSON.stringify(f.notes()) + f.w.observed()).not.toMatch(/secret_reason_code|LEAK-SENTINEL/);
  });
});

describe('reporting.report.released.v1 (US-EN-08.1 / 08.2; TRD §7.2 row 3, §4.5, §4.9; 08 A13 P-4)', () => {
  const calls = (f: Fx) => f.rp.calls('getReleasedReports') as Array<{ ctx: Row; input: any }>;
  it('03-IC §3.17 example: patient_reports row valid with released_at, panel names and smart flag from C6 (system actor, filter orderId); stage report_ready; ONE report_ready notification (report, version 1, route patient_app.report)', async () => {
    const f = await ready({ reports: [fxReport()] }); await f.deliver(REL, relP(), { seq: 1 });
    expect(f.reports()).toHaveLength(1); expect(f.reports()[0]).toMatchObject({ tenant_id: f.w.tenantId, report_id: RPT, version_no: 1, order_id: ORD, patient_id: PAT, report_kind: 'final', status: 'valid', panel_names: ['Lipid Profile', 'CBC'], smart_summary_available: false });
    expect(Date.parse(f.reports()[0]!['released_at'])).toBe(Date.parse('2026-11-05T04:35:00.000Z')); expect(f.order()['stage']).toBe('report_ready');
    expect(calls(f).length).toBeGreaterThan(0); expect(calls(f)[0]!.input.filter.orderId).toBe(ORD); expect(calls(f)[0]!.ctx.actorId).toBe(SYSTEM_ACTOR);
    expect(f.notes()).toHaveLength(1); expect(f.notes()[0]).toMatchObject({ account_id: f.acct['id'], patient_id: PAT, kind: 'report_ready', entity_type: 'report', entity_id: RPT, entity_seq: 1, route_id: 'patient_app.report', created_by: SYSTEM_ACTOR });
  });
  it('audiences without "patient" (referrer / print_only) -> no-op even for a linked patient: no row, no notification, no C6 call', async () => {
    const f = await ready({ reports: [fxReport()] }); const before = f.stable(); await f.deliver(REL, relP({ audiences: ['referrer', 'print_only'] }), { seq: 1 });
    expect(f.stable()).toBe(before); expect(calls(f)).toHaveLength(0);
  });
  it('US-EN-08.2: v2 (amended, supersedes_version_no 1) -> v1 becomes superseded, v2 valid, a NEW notification for v2 (entity_seq 2) next to v1\'s; stage report_ready', async () => {
    const f = await ready({ reports: [fxReport({ status: 'superseded' }), fxReport({ versionNo: 2, kind: 'amended', releasedAt: '2026-11-06T04:00:00.000Z', panelNames: ['Lipid Profile'] })] });
    await f.deliver(REL, relP(), { seq: 1 }); await f.deliver(REL, relP({ version_no: 2, report_kind: 'amended', supersedes_version_no: 1, released_at: '2026-11-06T04:00:00.000Z' }), { seq: 2 });
    const v = (n: number) => f.reports().find((r) => r['version_no'] === n)!;
    expect(f.reports()).toHaveLength(2); expect(v(1)['status']).toBe('superseded'); expect(v(2)).toMatchObject({ status: 'valid', report_kind: 'amended', supersedes_version_no: 1, panel_names: ['Lipid Profile'] });
    expect(f.notes().map((n) => n['entity_seq']).sort()).toEqual([1, 2]); expect(f.order()['stage']).toBe('report_ready');
  });
  it('v1\'s event arriving AFTER v2 (unordered): v1 is stored as superseded, never valid again; no change of the order stage', async () => {
    const f = await ready({ reports: [fxReport({ status: 'superseded' }), fxReport({ versionNo: 2, kind: 'amended', releasedAt: '2026-11-06T04:00:00.000Z' })] });
    await f.deliver(REL, relP({ version_no: 2, report_kind: 'amended', supersedes_version_no: 1, released_at: '2026-11-06T04:00:00.000Z' }), { seq: 2 }); await f.deliver(REL, relP(), { seq: 1 });
    expect(f.reports().filter((r) => r['status'] === 'valid').map((r) => r['version_no'])).toEqual([2]); expect(f.reports().find((r) => r['version_no'] === 1)?.['status']).toBe('superseded'); expect(f.order()['stage']).toBe('report_ready');
  });
  it('report kinds (§4.5): addendum -> report_ready; partial -> partial_report, a later final -> report_ready', async () => {
    const a = await ready({ reports: [fxReport({ kind: 'addendum' })] }); await a.deliver(REL, relP({ report_kind: 'addendum' }), { seq: 1 }); expect(a.reports()[0]!['report_kind']).toBe('addendum'); expect(a.order()['stage']).toBe('report_ready');
    const p = await ready({ reports: [fxReport({ kind: 'partial' }), fxReport({ reportId: X(0xf0002), kind: 'final', releasedAt: '2026-11-06T04:00:00.000Z' })] });
    await p.deliver(REL, relP({ report_kind: 'partial' }), { seq: 1 }); expect(p.order()['stage']).toBe('partial_report'); expect(p.notes()).toHaveLength(1);
    await p.deliver(REL, relP({ report_id: X(0xf0002), report_kind: 'final', released_at: '2026-11-06T04:00:00.000Z' }), { seq: 1 }); expect(p.order()['stage']).toBe('report_ready');
  });
  it('08 A13 P-4: an UNKNOWN report_kind does not fail: the row is stored with that kind (<= 32 chars), listed as valid, and counts as neither final nor partial - the order stays in_lab', async () => {
    const f = await ready({ reports: [fxReport({ kind: 'x_future_kind' })] }); await expect(f.deliver(REL, relP({ report_kind: 'x_future_kind' }), { seq: 1 })).resolves.toBeUndefined();
    expect(f.reports()).toHaveLength(1); expect(f.reports()[0]).toMatchObject({ report_kind: 'x_future_kind', status: 'valid' }); expect(f.order()['stage']).toBe('in_lab');
    const long = 'k'.repeat(40); const g = await ready({ reports: [fxReport({ kind: long })] }); await expect(g.deliver(REL, relP({ report_kind: long }), { seq: 1 })).resolves.toBeUndefined(); expect(g.reports()[0]!['report_kind'].length).toBeLessThanOrEqual(32);
    const w = await ready({ reports: [fxReport({ kind: 'x_future_kind' })] }); await w.consume(w.env(REL, relP({ report_kind: 'x_future_kind' }), 1)); expect(w.reports()).toHaveLength(1); expect(w.order()['stage']).toBe('in_lab'); // through the wrapper: x-extensible enum values pass the envelope check
  });
  it('US-EN-07.3 / 08: the same event twice (wrapper) -> one inbox row, one report row, one notification, one C6 read; another event_id for the same (report, version) changes nothing', async () => {
    const f = await ready({ reports: [fxReport()] }); const e = f.env(REL, relP(), 1); await f.consume(e); const after = f.stable(), reads = calls(f).length;
    await f.consume(e, 2); expect(f.inbox.size).toBe(1); expect(f.stable()).toBe(after); expect(calls(f).length).toBe(reads); expect(f.reports()).toHaveLength(1); expect(f.notes()).toHaveLength(1);
    await f.deliver(REL, relP(), { seq: 1 }); expect(f.stable()).toBe(after);
  });
  it('unlinked patient -> no row, no notification, no C6 call (committed no-op); a patient with only a revoked link too', async () => {
    for (const link of [false, { status: 'revoked', revoked_by_kind: 'account', revoked_reason_code: 'patient_request', revoked_at: T0 }] as const) {
      const f = await ready({ reports: [fxReport()], link }); const before = f.stable(); await f.deliver(REL, relP(), { seq: 1 }); expect(f.stable()).toBe(before); expect(calls(f)).toHaveLength(0);
    }
  });
  it('report_ready goes to VISIBLE links only: a link whose visible_from is after released_at gets no notification (the projection row is still written once)', async () => {
    const f = await ready({ reports: [fxReport()] }); const later = f.addLink(PAT, { visible_from: '2026-11-06T00:00:00.000Z' }); const earlier = f.addLink(PAT, { visible_from: '2026-11-01T00:00:00.000Z' }, '+99001000003');
    await f.deliver(REL, relP(), { seq: 1 }); expect(f.reports()).toHaveLength(1);
    expect(f.notes().map((n) => n['account_id']).sort()).toEqual([f.acct['id'], earlier.acct['id']].sort()); expect(f.notes().some((n) => n['account_id'] === later.acct['id'])).toBe(false);
  });
  it('smart summary: available + tenant setting smart_report_in_app -> ONE engagement.fetch_smart_summary job keyed smart:<report_id>:<version_no> (tenant payload), also after redelivery; setting off, or nothing to fetch -> no job', async () => {
    const smart = { status: 'approved' }; const on = await ready({ reports: [fxReport({ smartSummary: smart })], smart: true }); await on.deliver(REL, relP(), { seq: 1 }); await on.deliver(REL, relP(), { seq: 1 });
    expect(on.reports()[0]!['smart_summary_available']).toBe(true); const jobs = on.w.jobs('engagement.fetch_smart_summary'); expect(jobs).toHaveLength(1); expect(jobs[0]).toMatchObject({ jobKey: `smart:${RPT}:1` }); expect(jobs[0]!['payload']['tenant_id']).toBe(on.w.tenantId);
    const off = await ready({ reports: [fxReport({ smartSummary: smart })] }); await off.deliver(REL, relP(), { seq: 1 }); expect(off.w.jobs('engagement.fetch_smart_summary')).toHaveLength(0); expect(off.reports()[0]!['smart_summary_available']).toBe(true);
    const none = await ready({ reports: [fxReport()], smart: true }); await none.deliver(REL, relP(), { seq: 1 }); expect(none.w.jobs('engagement.fetch_smart_summary')).toHaveLength(0);
  });
  it('a C6 failure rolls the delivery back (no row, no notification, no job) and throws so the queue retries; the retry completes', async () => {
    const f = await ready({ reports: [fxReport()] }); f.rp.failNext('getReleasedReports', 'common.internal');
    expect(await rejection(f.deliver(REL, relP(), { seq: 1 }))).toBeTruthy(); expect(f.reports()).toHaveLength(0); expect(f.notes()).toHaveLength(0); expect(f.order()['stage']).toBe('in_lab');
    await f.deliver(REL, relP(), { seq: 1 }); expect(f.reports()).toHaveLength(1); expect(f.notes()).toHaveLength(1);
  });
  it('REQ-SEC-024 / privacy: other-tenant event writes nothing; unknown extra fields ignored; panel names and ids stay out of logs, audit and metrics; notification rows hold no text', async () => {
    const f = await ready({ reports: [fxReport()] }); const before = f.stable(); await f.deliver(REL, relP(), { seq: 1, tenant: TENANT_B }).catch(() => undefined); expect(f.stable()).toBe(before);
    await f.deliver(REL, relP({ future_field: 'LEAK-SENTINEL' }), { seq: 1 }); expect(JSON.stringify([f.reports(), f.notes()]) + f.w.observed()).not.toContain('LEAK-SENTINEL'); expect(f.w.observed()).not.toMatch(/Lipid Profile|CBC/);
    expect(Object.keys(f.notes()[0]!).filter((k) => /title|body|text|message|name/i.test(k))).toEqual([]);
  });
});

describe('billing.balance.changed.v1 (TRD §7.2 row 4; 03-IC §3.5; PRD payment-due flag)', () => {
  const balOrder = (f: Fx, o: Row = {}) => projOrder(f, { stage: 'in_lab', invoiced_paisa: 225000, paid_paisa: 0, balance_due_paisa: 225000, balance_version: 2, release_basis: 'due_outstanding', payment_due: true, ...o });
  it('03-IC §3.5 example: a projected order gets invoiced / paid / balance_due / balance_version / release_basis, payment_due = false (paid in full); status_version bumps (ETag)', async () => {
    const f = await setup(); balOrder(f); await f.deliver(BAL, balP(), { seq: 3 });
    expect(f.order()).toMatchObject({ invoiced_paisa: 225000, paid_paisa: 225000, balance_due_paisa: 0, balance_version: 3, release_basis: 'paid_in_full', payment_due: false, stage: 'in_lab' }); expect(f.order()['status_version']).toBeGreaterThan(1);
    expect(f.notes()).toHaveLength(0);
  });
  it('payment_due = balance_due > 0 AND release_basis = due_outstanding (a flag, not a stage)', async () => {
    const f = await setup(); balOrder(f, { balance_version: 1, payment_due: false });
    await f.deliver(BAL, balP({ balance_version: 2, paid: money(25000), balance_due: money(200000), cause: 'payment_recorded', release_eligible: false, release_basis: 'due_outstanding' }), { seq: 2 });
    expect(f.order()).toMatchObject({ paid_paisa: 25000, balance_due_paisa: 200000, release_basis: 'due_outstanding', payment_due: true, stage: 'in_lab' });
    await f.deliver(BAL, balP({ balance_version: 4, release_basis: 'zero_balance', balance_due: money(0) }), { seq: 4 }); expect(f.order()).toMatchObject({ balance_version: 4, payment_due: false });
  });
  it('release_basis is optional in 03-IC §3.5: an event without it still updates the amounts + balance_version, keeps the stored release_basis, payment_due follows the kept value (review T-P1 #3)', async () => {
    const f = await setup(); balOrder(f); const { release_basis: _omit, ...noBasis } = balP({ balance_version: 3, paid: money(100000), balance_due: money(125000), cause: 'payment_recorded', release_eligible: false });
    await f.deliver(BAL, noBasis, { seq: 3 });
    expect(f.order()).toMatchObject({ paid_paisa: 100000, balance_due_paisa: 125000, balance_version: 3, release_basis: 'due_outstanding', payment_due: true }); expect(f.order()['status_version']).toBeGreaterThan(1);
  });
  it('seq guard: a stale (lower) or equal balance_version is ignored - nothing changes, not even status_version; out of order 4 then 3 keeps 4', async () => {
    const f = await setup(); balOrder(f, { balance_version: 4, balance_due_paisa: 0, paid_paisa: 225000, release_basis: 'paid_in_full', payment_due: false }); const before = f.stable();
    await f.deliver(BAL, balP({ balance_version: 3, paid: money(100), balance_due: money(224900), release_basis: 'due_outstanding' }), { seq: 3 }); expect(f.stable()).toBe(before);
    await f.deliver(BAL, balP({ balance_version: 4, paid: money(1) }), { seq: 4 }); expect(f.stable()).toBe(before); expect(f.order()).toMatchObject({ balance_version: 4, paid_paisa: 225000 });
  });
  it('order not projected (unlinked patient, partner order filtered, nothing yet): committed no-op - no row created, no write, no failure', async () => {
    const f = await setup(); const before = f.w.writes().length; const e = f.env(BAL, balP(), 3); await expect(f.consume(e)).resolves.toBeUndefined();
    expect(f.orders()).toHaveLength(0); expect(f.w.writes().length).toBe(before); expect(f.inbox.size).toBe(1);
  });
  it('US-EN-07.3: the same event twice through the wrapper -> one inbox row, one change', async () => {
    const f = await setup(); balOrder(f); const e = f.env(BAL, balP(), 3); await f.consume(e); const after = f.stable(), writes = f.w.writes().length;
    await f.consume(e, 2); expect(f.inbox.size).toBe(1); expect(f.stable()).toBe(after); expect(f.w.writes().length).toBe(writes);
  });
  it('REQ-SEC-024: another tenant\'s order row with the same order_id is untouched; an event of another tenant writes nothing; unknown extra fields are ignored', async () => {
    const f = await setup(); balOrder(f); const foreign = balOrder(f, { tenant_id: TENANT_B, balance_version: 2 }); const b = JSON.stringify(foreign);
    await f.deliver(BAL, balP({ future_field: 'LEAK-SENTINEL' }), { seq: 3 }); expect(JSON.stringify(foreign)).toBe(b); expect(f.order()['balance_version']).toBe(3); expect(JSON.stringify(f.orders())).not.toContain('LEAK-SENTINEL');
    const before = f.stable(); await f.deliver(BAL, balP({ balance_version: 9 }), { seq: 9, tenant: TENANT_B }).catch(() => undefined); expect(f.stable()).toBe(before);
  });
});

describe('source guards (TRD §3.3 layout, 02-CV §5.13, shared projection writer)', () => {
  const api = join(REPO_ROOT, 'services/api/src/modules/engagement'), worker = join(REPO_ROOT, 'services/worker/src/jobs/engagement');
  const types = [ST, REJ, REL, BAL]; const src = (p: string) => readFileSync(p, 'utf8');
  const consumerFiles = (): string[] => [...types.map((t) => join(worker, 'consumers', `${t}.ts`))];
  it('the four consumer files, service/notification.service.ts and service/projection.service.ts exist', () => {
    for (const p of [...consumerFiles(), join(api, 'service/notification.service.ts'), join(api, 'service/projection.service.ts')]) expect(() => src(p), relative(REPO_ROOT, p)).not.toThrow();
  });
  it('consumers write read models only through the shared services (no inline INSERT/UPDATE of patient_* / notifications), read other schemas\' views only via views.repo, and leave the inbox to the core wrapper', () => {
    for (const p of consumerFiles()) {
      let s: string; try { s = src(p); } catch { continue; } const rel = relative(REPO_ROOT, p);
      expect(s, rel).not.toMatch(/(INSERT\s+INTO|UPDATE)\s+engagement\.(patient_orders|patient_order_specimens|patient_reports|notifications)/i); expect(s, rel).not.toMatch(/v_pub_order_status|v_pub_specimen_timeline|v_pub_order_balance/); expect(s, rel).not.toMatch(/event_inbox/i);
    }
  });
  it('the manifest entries of the four events are not the fail-closed stubs any more (source of index.ts)', () => {
    const s = src(join(worker, 'index.ts')); for (const t of types) expect(s, t).toMatch(new RegExp(`['"]${t.replace(/\./g, '\\.')}['"]\\s*:\\s*\\w+`));   // `'<type>': handler` map entry, not the bare SUBSCRIPTIONS list item
  });
  it('every file of the consumers directory is a handler module exporting `handle` (same shape as the T-B1 / T-B4 consumers)', () => {
    for (const f of readdirSync(join(worker, 'consumers')).filter((n) => n.endsWith('.ts'))) expect(src(join(worker, 'consumers', f)), f).toMatch(/export const handle\b|export (async )?function handle\b/);
  });
});
