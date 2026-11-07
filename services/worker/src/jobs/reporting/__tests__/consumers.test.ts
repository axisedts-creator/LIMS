// C6-T04 — reporting event consumers (02-TRD §3.3, §4.1, §4.2, §8.2; PRD AC-01.1..AC-01.5; 07-SECURITY REQ-SEC-024 / PHI rules).
// Integration level: each consumer's `handle(event, ctx)` against an in-memory tenant-aware Postgres fake (consumers.helpers.ts) and
// FrontdeskPort / CatalogPort fakes. ASSUMED API (spec gives no signatures; header of each describe repeats it):
//   consumers/<event_type>.ts  ->  `export const handle: ConsumerHandler`  (event envelope, JobContext & { ports: { frontdesk, catalog } })
//   centre code via `ctx.core.centre(ctx, { centreId }) -> { centreCode }` (05-SCHEMA §2.3 reports.centre_code); jobs via `SELECT app.enqueue_job(...)` on ctx.tx.
// Inbox dedupe by event_id is the core wrapper's job (consumers.core.test.ts); here "duplicate" also proves the handler body itself is replay-safe (upserts).
import { describe, expect, it } from 'vitest';
import { ASSEMBLY_DEBOUNCE_MS } from '../../../../../api/src/modules/reporting/domain/readiness.js';
import { handle as onCreated } from '../consumers/frontdesk.order.created.v1.js';
import { handle as onItemsChanged } from '../consumers/frontdesk.order.items_changed.v1.js';
import { handle as onCancelled } from '../consumers/frontdesk.order.cancelled.v1.js';
import { handle as onSpecimen } from '../consumers/lab.specimen.status_changed.v1.js';
import { handle as onApproved } from '../consumers/lab.result.approved.v1.js';
import { handle as onAmended } from '../consumers/lab.result.amended.v1.js';
import { handle as onReady } from '../consumers/lab.order.ready_for_report.v1.js';
import { handle as onCatalog } from '../consumers/catalog.changed.v1.js';
import {
  BRANCH, CENTRE, CENTRE_CODE, HASH_1, HASH_2, ITEM_CBC, ITEM_OUT, ITEM_XRAY, NOW, ORDER, PARTNER, PATIENT, REFERRER, REG_NO, SYSTEM_ACTOR, TEMPLATE_XRAY,
  TENANT_A, TENANT_B, TEST_CBC, TEST_OUT, TEST_XRAY, catalogChanged, idN, itemsChanged, makeCtx, makeDb, makePorts, orderCancelled, orderCreated, orderSummary,
  readyForReport, rejection, resultAmended, resultApproved, seededShell, specimenStatus, THREE_ITEMS,
  type Db, type JobRec, type Row,
} from './consumers.helpers.js';

const XRAY_SECTIONS = [{ key: 'findings', title: 'Findings' }, { key: 'impression', title: 'Impression' }];
const XRAY_TEMPLATE = { 'reporting.narrative_templates': [{ id: TEMPLATE_XRAY, tenant_id: TENANT_A, code: 'XRAY_CHEST', name: 'Chest X-ray', kind: 'xray', test_id: TEST_XRAY, sections: XRAY_SECTIONS, is_active: true }] };
const COMBINED = { 'reporting.settings': [{ id: idN(0x5e71), tenant_id: TENANT_A, narrative_report_mode: 'combined' }] };

/** REQ-SEC-024: every statement on a reporting table carries an explicit tenant (column list or predicate), and no row of another tenant is written. */
function expectTenantScoped(db: Db, tenant = TENANT_A) {
  for (const s of db.reportingStmts()) expect(s.text, `no tenant_id in: ${s.text}`).toMatch(/\btenant_id\b/);
  for (const s of db.writes()) expect(s.values.every((v) => v !== TENANT_B), `tenant B value written: ${s.text}`).toBe(true);
  for (const t of Object.keys(db.store)) for (const r of db.store[t]!) if (t.startsWith('reporting.') && r['_seed'] === undefined) expect(r['tenant_id']).toBe(tenant);
}
const byFamily = (db: Db, f: string): Row => db.reports().find((r) => r['family'] === f && r['tenant_id'] === TENANT_A)!;
const itemRow = (db: Db, id: string): Row => db.items().find((r) => r['order_item_id'] === id && r['tenant_id'] === TENANT_A)!;
const iso = (v: unknown) => new Date(v as string).toISOString();
const jobsFor = (db: Db, id = 'reporting.assemble_report') => db.jobs.filter((j) => j.identifier === id);

function created(seed: Record<string, Row[]> = {}, o: { summary?: any; workflow?: Record<string, string>; dbOpts?: Parameters<typeof makeDb>[1] } = {}) {
  const db = makeDb({ ...XRAY_TEMPLATE, ...seed }, o.dbOpts);
  const { ports, calls } = makePorts({ summary: o.summary ?? orderSummary(), ...(o.workflow ? { workflow: o.workflow } : {}) });
  const { ctx, logs } = makeCtx(db, { ports });
  return { db, ports, calls, ctx, logs };
}

// ============================================================================================ frontdesk.order.created.v1
describe('frontdesk.order.created.v1 (AC-01.1, AC-01.2, AC-01.4; 02-TRD §4.1, §8.2)', () => {
  it('AC-01.1: CBC + X-ray + outsourced, mode separate -> laboratory + narrative report, three items with their requirement flags', async () => {
    const { db, ctx, calls } = created();
    await onCreated(orderCreated(), ctx);
    expect(db.reports().map((r) => r['family']).sort()).toEqual(['laboratory', 'narrative']);
    const lab = byFamily(db, 'laboratory'); const nar = byFamily(db, 'narrative');
    expect(db.items()).toHaveLength(3);
    const cbc = itemRow(db, ITEM_CBC); const xr = itemRow(db, ITEM_XRAY); const out = itemRow(db, ITEM_OUT);
    expect([cbc['requires_lab'], cbc['requires_narrative'], cbc['requires_outsourced']]).toEqual([true, false, false]);
    expect([xr['requires_lab'], xr['requires_narrative'], xr['requires_outsourced']]).toEqual([false, true, false]);
    expect([out['requires_lab'], out['requires_narrative'], out['requires_outsourced']]).toEqual([false, false, true]);
    expect(cbc['report_id']).toBe(lab['id']); expect(out['report_id']).toBe(lab['id']); expect(xr['report_id']).toBe(nar['id']);
    expect(xr['narrative_test_ids']).toEqual([TEST_XRAY]);
    for (const r of db.items()) {
      expect(r).toMatchObject({ tenant_id: TENANT_A, centre_id: CENTRE, order_id: ORDER, item_status: 'active', orderable_kind: 'test', priority: 'routine',
        lab_ready: false, narrative_ready: false, outsourced_ready: false, created_by: SYSTEM_ACTOR });
    }
    expect(cbc['test_ids']).toEqual([TEST_CBC]); expect(xr['test_ids']).toEqual([TEST_XRAY]); expect(out['test_ids']).toEqual([TEST_OUT]);
    expect(calls.getOrderSummary.map((c) => c.orderId)).toContain(ORDER);
    expect(new Set(calls.getTest.map((c) => c.testId))).toEqual(new Set([TEST_CBC, TEST_XRAY, TEST_OUT]));
    expectTenantScoped(db);
  });

  it('report shell snapshots order data once: ids, source, registered_at, registration_no, centre_code, state open', async () => {
    const { db, ctx } = created();
    await onCreated(orderCreated(), ctx);
    for (const r of db.reports()) {
      expect(r).toMatchObject({ tenant_id: TENANT_A, order_id: ORDER, patient_id: PATIENT, centre_id: CENTRE, branch_id: BRANCH, referrer_id: REFERRER,
        order_source: 'front_desk', registration_no: REG_NO, centre_code: CENTRE_CODE, state: 'open', created_by: SYSTEM_ACTOR });
      expect(r['partner_id'] ?? null).toBeNull();
      expect(iso(r['registered_at'])).toBe(iso('2026-11-07T12:00:00.000Z'));
    }
  });

  it('partner_id is copied from FrontdeskPort.getOrderSummary (08 R25) onto every report', async () => {
    const { db, ctx } = created({}, { summary: orderSummary({ partnerId: PARTNER, source: 'partner_manifest' }) });
    await onCreated(orderCreated({ source: 'partner_manifest' }), ctx);
    expect(db.reports().length).toBeGreaterThan(0);
    for (const r of db.reports()) expect(r).toMatchObject({ partner_id: PARTNER, order_source: 'partner_manifest' });
  });

  it('narrative test -> narrative_reports row (draft, v1) + narrative_versions v1 copied from the matching narrative template', async () => {
    const { db, ctx } = created();
    await onCreated(orderCreated(), ctx);
    expect(db.narratives()).toHaveLength(1);
    const n = db.narratives()[0]!;
    expect(n).toMatchObject({ tenant_id: TENANT_A, order_id: ORDER, order_item_id: ITEM_XRAY, test_id: TEST_XRAY, report_id: byFamily(db, 'narrative')['id'],
      status: 'draft', current_version_no: 1, template_kind: 'xray', centre_id: CENTRE });
    expect(db.nversions()).toHaveLength(1);
    expect(db.nversions()[0]).toMatchObject({ tenant_id: TENANT_A, narrative_report_id: n['id'], version_no: 1, status: 'draft', template_id: TEMPLATE_XRAY, centre_id: CENTRE });
    expect(db.nversions()[0]!['sections']).toEqual(XRAY_SECTIONS);
  });

  it.each([
    ['standard', 'lab'], ['attachment', 'lab'], ['microbiology', 'lab'], ['anatomic', 'lab'], ['molecular', 'lab'], ['narrative', 'narrative'], ['outsourced', 'outsourced'],
  ])('02-TRD §4.1: a %s test -> requires %s only', async (workflowType, flag) => {
    const T = idN(0x3999); const ITEM = idN(0x1999);
    const { db, ctx } = created({}, { workflow: { [T]: workflowType }, summary: orderSummary({}, [{ orderItemId: ITEM, orderableId: idN(0x2999), orderableKind: 'test', testIds: [T], priority: 'routine', status: 'active', outsourced: false }]) });
    await onCreated(orderCreated({ items: [{ order_item_id: ITEM, orderable_id: idN(0x2999), orderable_kind: 'test', test_ids: [T], priority: 'routine' }] }), ctx);
    const row = itemRow(db, ITEM);
    expect({ lab: row['requires_lab'], narrative: row['requires_narrative'], outsourced: row['requires_outsourced'] })
      .toEqual({ lab: flag === 'lab', narrative: flag === 'narrative', outsourced: flag === 'outsourced' });
    const fam = db.reports().find((r) => r['id'] === row['report_id'])!['family'];
    expect(fam).toBe(flag === 'narrative' ? 'narrative' : 'laboratory');
  });

  it('an item flagged outsourced:true is requires_outsourced even when its test workflow is standard', async () => {
    const { db, ctx } = created({}, { summary: orderSummary({}, [{ orderItemId: ITEM_CBC, orderableId: idN(0x2001), orderableKind: 'test', testIds: [TEST_CBC], priority: 'routine', status: 'active', outsourced: true }]) });
    await onCreated(orderCreated({ items: [{ order_item_id: ITEM_CBC, orderable_id: idN(0x2001), orderable_kind: 'test', test_ids: [TEST_CBC], priority: 'routine', outsourced: true }] }), ctx);
    const r = itemRow(db, ITEM_CBC);
    expect([r['requires_lab'], r['requires_narrative'], r['requires_outsourced']]).toEqual([false, false, true]);
  });

  it('AC-01.4: narrative_report_mode = combined -> only the laboratory report exists and it requires all three items', async () => {
    const { db, ctx } = created(COMBINED);
    await onCreated(orderCreated(), ctx);
    expect(db.reports().map((r) => r['family'])).toEqual(['laboratory']);
    const lab = byFamily(db, 'laboratory');
    expect(db.items()).toHaveLength(3);
    for (const r of db.items()) expect(r['report_id']).toBe(lab['id']);
    expect(itemRow(db, ITEM_XRAY)).toMatchObject({ requires_narrative: true, requires_lab: false });
    expect(itemRow(db, ITEM_OUT)['requires_outsourced']).toBe(true);
    expect(db.narratives().every((n) => n['report_id'] === lab['id'])).toBe(true);
  });

  it('AC-01.2: the same event delivered twice creates no new rows and does not fail', async () => {
    const { db, ctx } = created();
    const ev = orderCreated();
    await onCreated(ev, ctx);
    const before = { r: db.reports().map((x) => x['id']).sort(), i: db.items().map((x) => x['id']).sort(), n: db.narratives().map((x) => x['id']), v: db.nversions().map((x) => x['id']) };
    await expect(onCreated(structuredClone(ev), ctx)).resolves.toBeUndefined();
    expect({ r: db.reports().map((x) => x['id']).sort(), i: db.items().map((x) => x['id']).sort(), n: db.narratives().map((x) => x['id']), v: db.nversions().map((x) => x['id']) }).toEqual(before);
    expect(before.r).toHaveLength(2); expect(before.i).toHaveLength(3);
  });

  it('a re-published order.created under a NEW event_id (producer retry) is also a no-op for row counts', async () => {
    const { db, ctx } = created();
    await onCreated(orderCreated(), ctx);
    await onCreated(orderCreated(), ctx);
    expect([db.reports().length, db.items().length, db.narratives().length, db.nversions().length]).toEqual([2, 3, 1, 1]);
  });

  it('two concurrent deliveries of the same order still leave exactly 2 reports / 3 items (upsert, no 23505)', async () => {
    const { db, ports } = created();
    const a = makeCtx(db, { ports }).ctx; const b = makeCtx(db, { ports }).ctx;
    await Promise.all([onCreated(orderCreated(), a), onCreated(orderCreated(), b)]);
    expect([db.reports().length, db.items().length, db.narratives().length]).toEqual([2, 3, 1]);
  });

  it('unknown fields (envelope, payload, item) are tolerated (02-CV §7.2, "unknown fields" fixture)', async () => {
    const { db, ctx } = created();
    const ev = orderCreated({ x_future_flag: true, items: THREE_ITEMS().map((i) => ({ ...i, x_future: { a: 1 } })) }, { x_envelope_future: 'v2' });
    await expect(onCreated(ev, ctx)).resolves.toBeUndefined();
    expect([db.reports().length, db.items().length]).toEqual([2, 3]);
  });

  it('a CatalogPort failure (test not found) rejects so the job retries; it is not swallowed', async () => {
    const { ctx } = created({}, { workflow: { [TEST_CBC]: 'standard' } });   // X-ray / outsourced tests unknown to the catalog
    const err = await rejection(onCreated(orderCreated(), ctx));
    expect(err).toBeInstanceOf(Error);
  });

  it('SEC: an envelope claiming another tenant never makes the consumer write that tenant (job tenant wins, or it refuses)', async () => {
    const { db, ctx } = created();
    await onCreated(orderCreated({}, { tenant_id: TENANT_B }), ctx).catch(() => undefined);
    expect(db.all('reporting.reports').concat(db.items()).every((r) => r['tenant_id'] !== TENANT_B)).toBe(true);
    expect(db.writes().every((s) => !s.values.includes(TENANT_B))).toBe(true);
  });

  it('SEC: another tenant\'s report for the same order id is neither read nor changed (explicit tenant predicate, RLS off in this fake)', async () => {
    const other = { id: idN(0xb0b1), tenant_id: TENANT_B, centre_id: idN(0xcb), branch_id: BRANCH, order_id: ORDER, patient_id: idN(0xb0b2), family: 'laboratory', order_source: 'front_desk',
      registered_at: NOW, registration_no: 'OTHER-1', centre_code: 'OTH', _seed: true };
    const { db, ctx } = created({ 'reporting.reports': [other] }, { dbOpts: { rls: false } });
    await onCreated(orderCreated(), ctx);
    expect(db.reports().find((r) => r['id'] === other.id)).toMatchObject({ registration_no: 'OTHER-1', centre_code: 'OTH', patient_id: other.patient_id });
    expect(db.reports().filter((r) => r['tenant_id'] === TENANT_A)).toHaveLength(2);
    expectTenantScoped(db);
  });

  it('SEC: no registration number (PHI-adjacent, 02-CV §9.2) reaches a log line', async () => {
    const { ctx, logs } = created();
    await onCreated(orderCreated(), ctx);
    expect(logs.text()).not.toContain(REG_NO);
  });
});

// ============================================================================================ frontdesk.order.items_changed.v1
describe('frontdesk.order.items_changed.v1 (AC-01.3; 02-TRD §8.2: add/remove, drafts -> cancelled, needs_assembly, stale items_version)', () => {
  const ctxFor = (db: Db, summary?: any) => makeCtx(db, { ports: makePorts({ summary }).ports }).ctx;

  it('AC-01.3: removing the outsourced item marks it removed, leaves the others active and flags the laboratory report for assembly', async () => {
    const { db, LAB } = seededShell();
    await onItemsChanged(itemsChanged(), ctxFor(db));
    expect(itemRow(db, ITEM_OUT)['item_status']).toBe('removed');
    expect(itemRow(db, ITEM_CBC)['item_status']).toBe('active'); expect(itemRow(db, ITEM_XRAY)['item_status']).toBe('active');
    const lab = db.reports().find((r) => r['id'] === LAB)!;
    expect(lab['needs_assembly']).toBe(true); expect(lab['needs_assembly_since']).toBeTruthy();
    expectTenantScoped(db);
  });

  it('removed items stay as rows (history) and a removed item is not deleted', async () => {
    const { db } = seededShell();
    await onItemsChanged(itemsChanged(), ctxFor(db));
    expect(db.items()).toHaveLength(3);
    expect(db.writes().some((s) => s.verb === 'delete')).toBe(false);
  });

  it('added items get rows on the right report with flags; an added narrative test gets a draft narrative + v1; needs_assembly is set', async () => {
    const T_STD = idN(0x3004); const T_NAR = idN(0x3005); const I_STD = idN(0x1004); const I_NAR = idN(0x1005);
    const workflow = { [T_STD]: 'standard', [T_NAR]: 'narrative' };
    const tpl = { id: idN(0x4002), tenant_id: TENANT_A, code: 'USG_ABD', name: 'USG', kind: 'usg', test_id: T_NAR, sections: XRAY_SECTIONS, is_active: true };
    const { db, LAB, NAR } = seededShell({ 'reporting.narrative_templates': [tpl] });
    const added = [
      { order_item_id: I_STD, orderable_id: idN(0x2004), orderable_kind: 'test', test_ids: [T_STD], priority: 'routine' },
      { order_item_id: I_NAR, orderable_id: idN(0x2005), orderable_kind: 'test', test_ids: [T_NAR], priority: 'urgent' },
    ];
    const summary = orderSummary({ version: 2 }, [
      ...orderSummary().items,
      { orderItemId: I_STD, orderableId: idN(0x2004), orderableKind: 'test', testIds: [T_STD], priority: 'routine', status: 'active', outsourced: false },
      { orderItemId: I_NAR, orderableId: idN(0x2005), orderableKind: 'test', testIds: [T_NAR], priority: 'urgent', status: 'active', outsourced: false }]);
    const { ctx } = makeCtx(db, { ports: makePorts({ summary, workflow: { [TEST_CBC]: 'standard', [TEST_XRAY]: 'narrative', [TEST_OUT]: 'outsourced', ...workflow } }).ports });
    await onItemsChanged(itemsChanged({ added, removed: [] }), ctx);
    expect(itemRow(db, I_STD)).toMatchObject({ report_id: LAB, requires_lab: true, requires_narrative: false, requires_outsourced: false, item_status: 'active' });
    expect(itemRow(db, I_NAR)).toMatchObject({ report_id: NAR, requires_lab: false, requires_narrative: true, priority: 'urgent' });
    const n = db.narratives().find((x) => x['order_item_id'] === I_NAR)!;
    expect(n).toMatchObject({ test_id: T_NAR, status: 'draft', current_version_no: 1, template_kind: 'usg', report_id: NAR });
    expect(db.nversions().find((v) => v['narrative_report_id'] === n['id'])).toMatchObject({ version_no: 1, status: 'draft', template_id: tpl.id });
    expect(db.reports().find((r) => r['id'] === LAB)!['needs_assembly']).toBe(true);
  });

  it('removing a narrative item cancels its narrative draft', async () => {
    const { db, NAR } = seededShell();
    const n = { id: idN(0xc501), tenant_id: TENANT_A, centre_id: CENTRE, report_id: NAR, order_id: ORDER, order_item_id: ITEM_XRAY, test_id: TEST_XRAY, template_kind: 'xray', created_by: SYSTEM_ACTOR, updated_by: SYSTEM_ACTOR };
    db.store['reporting.narrative_reports'] = [{ status: 'draft', current_version_no: 1, signed_version_no: null, version: 1, ...n }];
    await onItemsChanged(itemsChanged({ removed: [{ order_item_id: ITEM_XRAY, reason_code: 'patient_request' }] }), ctxFor(db));
    expect(itemRow(db, ITEM_XRAY)['item_status']).toBe('removed');
    expect(db.narratives().find((x) => x['id'] === n.id)!['status']).toBe('cancelled');
  });

  it('stale items_version (<= stored) is ignored: nothing removed, no needs_assembly', async () => {
    for (const v of [3, 5]) {
      const { db } = seededShell();
      for (const r of db.store['reporting.report_order_items']!) r['items_version'] = 5;
      await expect(onItemsChanged(itemsChanged({ items_version: v }), ctxFor(db))).resolves.toBeUndefined();
      expect(itemRow(db, ITEM_OUT)['item_status'], `items_version ${v}`).toBe('active');
      expect(db.reports().every((r) => r['needs_assembly'] === false)).toBe(true);
    }
  });

  it('a newer items_version (> stored) is applied', async () => {
    const { db } = seededShell();
    for (const r of db.store['reporting.report_order_items']!) r['items_version'] = 5;
    await onItemsChanged(itemsChanged({ items_version: 6 }), ctxFor(db));
    expect(itemRow(db, ITEM_OUT)['item_status']).toBe('removed');
  });

  it('delivering the same change twice is a no-op the second time and does not fail', async () => {
    const { db } = seededShell();
    const ev = itemsChanged();
    await onItemsChanged(ev, ctxFor(db));
    const after = db.snapshot();
    await expect(onItemsChanged(structuredClone(ev), ctxFor(db))).resolves.toBeUndefined();
    expect(db.items().map((r) => [r['order_item_id'], r['item_status']])).toEqual(after.i.map((r: Row) => [r['order_item_id'], r['item_status']]));
    expect(db.items()).toHaveLength(3);
  });

  it('removing an item the report does not know is not an error', async () => {
    const { db } = seededShell();
    await expect(onItemsChanged(itemsChanged({ removed: [{ order_item_id: idN(0x1fff), reason_code: 'x' }] }), ctxFor(db))).resolves.toBeUndefined();
    expect(db.items().every((r) => r['item_status'] === 'active')).toBe(true);
  });

  it('unknown order -> creates the shell through FrontdeskPort.getOrderSummary instead of failing', async () => {
    const db = makeDb(XRAY_TEMPLATE);
    const summary = orderSummary({ version: 2 }, [
      { orderItemId: ITEM_CBC, orderableId: idN(0x2001), orderableKind: 'test', testIds: [TEST_CBC], priority: 'routine', status: 'active', outsourced: false },
      { orderItemId: ITEM_XRAY, orderableId: idN(0x2002), orderableKind: 'test', testIds: [TEST_XRAY], priority: 'routine', status: 'active', outsourced: false },
      { orderItemId: ITEM_OUT, orderableId: idN(0x2003), orderableKind: 'test', testIds: [TEST_OUT], priority: 'routine', status: 'removed', outsourced: true }]);
    const { ports, calls } = makePorts({ summary });
    await onItemsChanged(itemsChanged(), makeCtx(db, { ports }).ctx);
    expect(calls.getOrderSummary.map((c) => c.orderId)).toContain(ORDER);
    expect(byFamily(db, 'laboratory')).toMatchObject({ order_id: ORDER, registration_no: REG_NO, centre_code: CENTRE_CODE });
    expect(itemRow(db, ITEM_CBC)['item_status']).toBe('active'); expect(itemRow(db, ITEM_XRAY)['item_status']).toBe('active');
    expect(itemRow(db, ITEM_OUT)?.['item_status'] ?? 'removed').toBe('removed');
  });

  it('unknown fields are tolerated', async () => {
    const { db } = seededShell();
    const ev = itemsChanged({ x_future: 1, removed: [{ order_item_id: ITEM_OUT, reason_code: 'patient_request', x_extra: true }] }, 2, { x_envelope_future: 1 });
    await expect(onItemsChanged(ev, ctxFor(db))).resolves.toBeUndefined();
    expect(itemRow(db, ITEM_OUT)['item_status']).toBe('removed');
  });

  it('SEC: another tenant\'s item with the same order_item_id is untouched (explicit tenant predicate)', async () => {
    const { db } = seededShell({}, { rls: false });
    db.store['reporting.report_order_items']!.push({ ...itemRow(db, ITEM_OUT), id: idN(0xb0b3), tenant_id: TENANT_B, report_id: idN(0xb0b4), _seed: true });
    await onItemsChanged(itemsChanged(), ctxFor(db));
    expect(db.items().find((r) => r['id'] === idN(0xb0b3))!['item_status']).toBe('active');
    expectTenantScoped(db);
  });
});

// ============================================================================================ frontdesk.order.cancelled.v1
describe('frontdesk.order.cancelled.v1 (02-TRD §8.2: state cancelled, unreleased versions discarded, released ones flagged)', () => {
  const version = (n: number, report: string, status: string, extra: Row = {}) => ({ id: idN(0xd100 + n), tenant_id: TENANT_A, centre_id: CENTRE, report_id: report, order_id: ORDER, version_no: n, status, discarded_at: null, discard_reason: null, ...extra, _seed: true });
  const ctxFor = (db: Db) => makeCtx(db, { ports: makePorts().ports }).ctx;

  it('sets every report of the order to cancelled; unreleased versions -> discarded (order_cancelled); a released version is untouched and the report is flagged', async () => {
    const { db, LAB, NAR } = seededShell({});
    db.store['reporting.report_versions'] = [version(1, LAB, 'released', { released_at: NOW }), version(2, LAB, 'rendering'), version(3, LAB, 'rendered'), version(1, NAR, 'rendering')]
      .map((v, i) => ({ ...v, id: idN(0xd100 + i) }));
    db.store['reporting.reports']!.find((r) => r['id'] === LAB)!['released_version_no'] = 1;
    await onCancelled(orderCancelled(), ctxFor(db));
    expect(db.reports().map((r) => r['state'])).toEqual(['cancelled', 'cancelled']);
    expect(db.reports().every((r) => r['cancelled_at'])).toBe(true);
    const vs = db.all('reporting.report_versions');
    expect(vs.find((v) => v['report_id'] === LAB && v['version_no'] === 1)).toMatchObject({ status: 'released', discard_reason: null });
    for (const v of vs.filter((x) => x['status'] !== 'released')) expect(v).toMatchObject({ status: 'discarded', discard_reason: 'order_cancelled' });
    expect(vs.filter((v) => v['status'] === 'discarded')).toHaveLength(3);
    expect(db.reports().find((r) => r['id'] === LAB)!['review_flag']).toBe('released_order_cancelled');
    expect(db.reports().find((r) => r['id'] === NAR)!['review_flag']).toBeNull();
    expectTenantScoped(db);
  });

  it('a cancelled order with nothing released just becomes cancelled (no review flag)', async () => {
    const { db } = seededShell({});
    await onCancelled(orderCancelled(), ctxFor(db));
    expect(db.reports().map((r) => [r['state'], r['review_flag']])).toEqual([['cancelled', null], ['cancelled', null]]);
  });

  it('is idempotent: a second delivery changes nothing and does not fail', async () => {
    const { db, LAB } = seededShell({});
    db.store['reporting.report_versions'] = [version(1, LAB, 'rendered')];
    await onCancelled(orderCancelled(), ctxFor(db));
    const first = structuredClone({ r: db.reports(), v: db.all('reporting.report_versions') });
    await expect(onCancelled(orderCancelled(), ctxFor(db))).resolves.toBeUndefined();
    expect({ r: db.reports(), v: db.all('reporting.report_versions') }).toEqual(first);
  });

  it('an order with no report yet is not an error and creates nothing', async () => {
    const db = makeDb({});
    await expect(onCancelled(orderCancelled(), ctxFor(db))).resolves.toBeUndefined();
    expect(db.reports()).toHaveLength(0);
  });

  it('SEC: another tenant\'s reports for the same order id stay open (explicit tenant predicate)', async () => {
    const { db } = seededShell({}, { rls: false });
    db.store['reporting.reports']!.push({ ...db.reports()[0], id: idN(0xb0b5), tenant_id: TENANT_B, family: 'laboratory', _seed: true });
    await onCancelled(orderCancelled(), ctxFor(db));
    expect(db.reports().find((r) => r['id'] === idN(0xb0b5))).toMatchObject({ state: 'open', review_flag: null });
    expect(db.reports().filter((r) => r['tenant_id'] === TENANT_A).every((r) => r['state'] === 'cancelled')).toBe(true);
  });

  it('unknown fields are tolerated', async () => {
    const { db } = seededShell({});
    await expect(onCancelled(orderCancelled({ x_envelope_future: 1 }), ctxFor(db))).resolves.toBeUndefined();
    expect(db.reports().every((r) => r['state'] === 'cancelled')).toBe(true);
  });
});

// ============================================================================================ lab.specimen.status_changed.v1
describe('lab.specimen.status_changed.v1 (02-TRD §8.2: specimen_hint on the order items, ordered by aggregate.seq)', () => {
  const ctxFor = (db: Db) => makeCtx(db, { ports: makePorts().ports }).ctx;

  it('rejected -> specimen_hint = rejected on the named items only (with its seq); no assembly is requested', async () => {
    const { db } = seededShell();
    await onSpecimen(specimenStatus('rejected', 3, [ITEM_CBC]), ctxFor(db));
    expect(itemRow(db, ITEM_CBC)).toMatchObject({ specimen_hint: 'rejected', specimen_hint_seq: 3 });
    expect(itemRow(db, ITEM_XRAY)['specimen_hint'] ?? null).toBeNull();
    expect(db.reports().every((r) => r['needs_assembly'] === false)).toBe(true);
    expect(db.jobs).toHaveLength(0);
    expectTenantScoped(db);
  });

  it('recollection_ordered replaces rejected when its seq is newer', async () => {
    const { db } = seededShell();
    await onSpecimen(specimenStatus('rejected', 3), ctxFor(db));
    await onSpecimen(specimenStatus('recollection_ordered', 4), ctxFor(db));
    expect(itemRow(db, ITEM_CBC)).toMatchObject({ specimen_hint: 'recollection_ordered', specimen_hint_seq: 4 });
  });

  it('a stale seq is ignored (older rejected after newer recollection_ordered, and an equal seq)', async () => {
    const { db } = seededShell();
    await onSpecimen(specimenStatus('recollection_ordered', 4), ctxFor(db));
    await onSpecimen(specimenStatus('rejected', 2), ctxFor(db));
    await onSpecimen(specimenStatus('rejected', 4), ctxFor(db));
    expect(itemRow(db, ITEM_CBC)).toMatchObject({ specimen_hint: 'recollection_ordered', specimen_hint_seq: 4 });
  });

  it('a later non-problem status (received) clears the hint', async () => {
    const { db } = seededShell();
    await onSpecimen(specimenStatus('recollection_ordered', 4), ctxFor(db));
    await onSpecimen(specimenStatus('received', 5), ctxFor(db));
    expect(itemRow(db, ITEM_CBC)['specimen_hint'] ?? null).toBeNull();
  });

  it('an item the report does not know yet is not an error (no row created)', async () => {
    const { db } = seededShell();
    await expect(onSpecimen(specimenStatus('rejected', 3, [idN(0x1fff)]), ctxFor(db))).resolves.toBeUndefined();
    expect(db.items()).toHaveLength(3);
  });

  it('SEC + unknown fields: tolerated; another tenant\'s item with the same id is untouched', async () => {
    const { db } = seededShell({}, { rls: false });
    db.store['reporting.report_order_items']!.push({ ...itemRow(db, ITEM_CBC), id: idN(0xb0b6), tenant_id: TENANT_B, _seed: true });
    await onSpecimen(specimenStatus('rejected', 3, [ITEM_CBC], { x_envelope_future: 1 }), ctxFor(db));
    expect(db.items().find((r) => r['id'] === idN(0xb0b6))!['specimen_hint'] ?? null).toBeNull();
    expect(itemRow(db, ITEM_CBC)['specimen_hint']).toBe('rejected');
  });
});

// ============================================================================================ lab.result.approved.v1 / amended.v1
describe('lab.result.approved.v1 / lab.result.amended.v1 (02-TRD §8.2: progress counters only, no assembly)', () => {
  const ctxFor = (db: Db) => makeCtx(db, { ports: makePorts().ports }).ctx;

  it('approved: increments approved_results of that item only; requests no assembly and flips no flag', async () => {
    const { db } = seededShell();
    await onApproved(resultApproved(ITEM_CBC), ctxFor(db));
    await onApproved(resultApproved(ITEM_CBC), ctxFor(db));   // a second, different result event
    expect(itemRow(db, ITEM_CBC)['approved_results']).toBe(2);
    expect(itemRow(db, ITEM_XRAY)['approved_results']).toBe(0); expect(itemRow(db, ITEM_OUT)['approved_results']).toBe(0);
    expect(itemRow(db, ITEM_CBC)['lab_ready']).toBe(false);
    expect(db.reports().every((r) => r['needs_assembly'] === false)).toBe(true);
    expect(db.jobs).toHaveLength(0);
    expectTenantScoped(db);
  });

  it('approved for an item no report knows yet is not an error', async () => {
    const { db } = seededShell();
    await expect(onApproved(resultApproved(idN(0x1fff)), ctxFor(db))).resolves.toBeUndefined();
    expect(db.items().every((r) => r['approved_results'] === 0)).toBe(true);
  });

  it('amended: amendment_pending = true on that item only; no assembly', async () => {
    const { db } = seededShell();
    await onAmended(resultAmended(ITEM_CBC), ctxFor(db));
    expect(itemRow(db, ITEM_CBC)['amendment_pending']).toBe(true);
    expect(itemRow(db, ITEM_OUT)['amendment_pending']).toBe(false);
    expect(db.jobs).toHaveLength(0);
    expect(db.reports().every((r) => r['needs_assembly'] === false)).toBe(true);
  });

  it('amended twice is idempotent (flag stays true, no failure)', async () => {
    const { db } = seededShell();
    await onAmended(resultAmended(ITEM_CBC), ctxFor(db)); await onAmended(resultAmended(ITEM_CBC), ctxFor(db));
    expect(itemRow(db, ITEM_CBC)['amendment_pending']).toBe(true);
  });

  it('SEC + unknown fields: tolerated; another tenant\'s item with the same id is untouched', async () => {
    const { db } = seededShell({}, { rls: false });
    db.store['reporting.report_order_items']!.push({ ...itemRow(db, ITEM_CBC), id: idN(0xb0b7), tenant_id: TENANT_B, _seed: true });
    await onApproved(resultApproved(ITEM_CBC, { x_envelope_future: 1 }), ctxFor(db));
    await onAmended(resultAmended(ITEM_CBC, { x_envelope_future: 1 }), ctxFor(db));
    const b = db.items().find((r) => r['id'] === idN(0xb0b7))!;
    expect([b['approved_results'], b['amendment_pending']]).toEqual([0, false]);
  });
});

// ============================================================================================ lab.order.ready_for_report.v1
describe('lab.order.ready_for_report.v1 (AC-01.5; 02-TRD §4.2, §8.2)', () => {
  const ctxFor = (db: Db, summary?: any) => { const p = makePorts({ summary }); return { ...makeCtx(db, { ports: p.ports }), calls: p.calls }; };
  const assemble = (db: Db, report: string): JobRec | undefined => jobsFor(db).find((j) => j.jobKey === `assemble:${report}`);
  const runAtOk = (job: JobRec) => {
    const v: any = job.runAt;
    const ms = v instanceof Date ? +v : typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v) ? Date.parse(v) : undefined;
    if (ms !== undefined) expect(Math.abs(ms - (Date.parse(NOW) + ASSEMBLY_DEBOUNCE_MS))).toBeLessThanOrEqual(2000);
    else expect(String(v)).toMatch(/30/);   // SQL expression such as now() + interval '30 seconds'
  };

  it('stores readiness on the laboratory report, marks the ready items, sets needs_assembly and enqueues a debounced assemble_report', async () => {
    const { db, LAB } = seededShell();
    await onReady(readyForReport(1, [ITEM_CBC], { contains_amendment: true, completeness: 'partial' }), ctxFor(db).ctx);
    const lab = db.reports().find((r) => r['id'] === LAB)!;
    expect(lab).toMatchObject({ lab_ready_seq: 1, lab_approved_set_hash: HASH_1, lab_completeness: 'partial', lab_contains_amendment: true, needs_assembly: true });
    expect(lab['needs_assembly_since']).toBeTruthy();
    expect(itemRow(db, ITEM_CBC)['lab_ready']).toBe(true);
    expect(itemRow(db, ITEM_OUT)['lab_ready']).toBe(false); expect(itemRow(db, ITEM_XRAY)['lab_ready']).toBe(false);
    const job = assemble(db, LAB)!;
    expect(job, 'reporting.assemble_report with job key assemble:<report_id>').toBeDefined();
    expect(job.payload).toMatchObject({ tenant_id: TENANT_A, report_id: LAB });
    runAtOk(job);
    expectTenantScoped(db);
  });

  it('the readiness list is authoritative: items missing from the latest event lose lab_ready', async () => {
    const CBC2 = idN(0x1010);
    const { db, LAB } = seededShell();
    db.store['reporting.report_order_items']!.push({ ...itemRow(db, ITEM_CBC), id: idN(0xb110), order_item_id: CBC2, lab_ready: false });
    db.store['reporting.report_order_items']!.find((r) => r['order_item_id'] === ITEM_CBC)!['lab_ready'] = true;
    await onReady(readyForReport(2, [CBC2], { approved_set_hash: HASH_2 }), ctxFor(db).ctx);
    expect(itemRow(db, CBC2)['lab_ready']).toBe(true);
    expect(itemRow(db, ITEM_CBC)['lab_ready']).toBe(false);
    expect(db.reports().find((r) => r['id'] === LAB)).toMatchObject({ lab_ready_seq: 2, lab_approved_set_hash: HASH_2 });
  });

  it('clears amendment_pending of the ready items ("until the next readiness event")', async () => {
    const { db } = seededShell();
    await onAmended(resultAmended(ITEM_CBC), ctxFor(db).ctx);
    expect(itemRow(db, ITEM_CBC)['amendment_pending']).toBe(true);
    await onReady(readyForReport(1, [ITEM_CBC], { contains_amendment: true }), ctxFor(db).ctx);
    expect(itemRow(db, ITEM_CBC)['amendment_pending']).toBe(false);
  });

  it('stale aggregate.seq (<= stored lab_ready_seq) changes nothing and enqueues nothing; a newer seq applies', async () => {
    for (const seq of [4, 5]) {
      const { db, LAB } = seededShell();
      Object.assign(db.store['reporting.reports']!.find((r) => r['id'] === LAB)!, { lab_ready_seq: 5, lab_approved_set_hash: HASH_1, lab_completeness: 'complete' });
      await expect(onReady(readyForReport(seq, [ITEM_CBC], { approved_set_hash: HASH_2, completeness: 'partial' }), ctxFor(db).ctx)).resolves.toBeUndefined();
      expect(db.reports().find((r) => r['id'] === LAB)).toMatchObject({ lab_ready_seq: 5, lab_approved_set_hash: HASH_1, lab_completeness: 'complete', needs_assembly: false });
      expect(itemRow(db, ITEM_CBC)['lab_ready'], `seq ${seq}`).toBe(false);
      expect(jobsFor(db), `seq ${seq}`).toHaveLength(0);
    }
    const { db, LAB } = seededShell();
    db.store['reporting.reports']!.find((r) => r['id'] === LAB)!['lab_ready_seq'] = 5;
    await onReady(readyForReport(6, [ITEM_CBC], { approved_set_hash: HASH_2 }), ctxFor(db).ctx);
    expect(db.reports().find((r) => r['id'] === LAB)).toMatchObject({ lab_ready_seq: 6, lab_approved_set_hash: HASH_2, needs_assembly: true });
  });

  it('delivering the same readiness twice keeps one job key and the same state', async () => {
    const { db, LAB } = seededShell();
    const ev = readyForReport(1, [ITEM_CBC]);
    await onReady(ev, ctxFor(db).ctx);
    await expect(onReady(structuredClone(ev), ctxFor(db).ctx)).resolves.toBeUndefined();
    expect(db.reports().find((r) => r['id'] === LAB)).toMatchObject({ lab_ready_seq: 1, lab_approved_set_hash: HASH_1 });
    expect(new Set(jobsFor(db).map((j) => j.jobKey))).toEqual(new Set([`assemble:${LAB}`]));
  });

  it('AC-01.5: ready_for_report before order.created -> fetches the order through FrontdeskPort.getOrderSummary, creates the shell and records readiness (no failure)', async () => {
    const db = makeDb(XRAY_TEMPLATE);
    const { ctx, calls } = ctxFor(db, orderSummary());
    await expect(onReady(readyForReport(1, [ITEM_CBC]), ctx)).resolves.toBeUndefined();
    expect(calls.getOrderSummary.map((c) => c.orderId)).toContain(ORDER);
    const lab = byFamily(db, 'laboratory');
    expect(lab).toMatchObject({ order_id: ORDER, registration_no: REG_NO, centre_code: CENTRE_CODE, patient_id: PATIENT, state: 'open',
      lab_ready_seq: 1, lab_approved_set_hash: HASH_1, lab_completeness: 'complete', needs_assembly: true });
    expect(itemRow(db, ITEM_CBC)).toMatchObject({ report_id: lab['id'], requires_lab: true, lab_ready: true });
    expect(assemble(db, lab['id'])).toBeDefined();
    expectTenantScoped(db);
  });

  it('AC-01.5 (continued): order.created arriving afterwards completes the shell without duplicates and keeps the recorded readiness', async () => {
    const db = makeDb(XRAY_TEMPLATE);
    const { ctx } = ctxFor(db, orderSummary());
    await onReady(readyForReport(1, [ITEM_CBC]), ctx);
    await expect(onCreated(orderCreated(), ctx)).resolves.toBeUndefined();
    expect(db.reports().map((r) => r['family']).sort()).toEqual(['laboratory', 'narrative']);
    expect(db.items()).toHaveLength(3);
    expect(db.narratives()).toHaveLength(1);
    expect(byFamily(db, 'laboratory')).toMatchObject({ lab_ready_seq: 1, lab_approved_set_hash: HASH_1, needs_assembly: true });
    expect(itemRow(db, ITEM_CBC)['lab_ready']).toBe(true);
  });

  it('ready-before-created with an order FrontdeskPort cannot find rejects (the job retries; C4 should have it)', async () => {
    const db = makeDb(XRAY_TEMPLATE);
    const err = await rejection(onReady(readyForReport(1, [ITEM_CBC]), ctxFor(db).ctx));   // no summary configured -> common.not_found
    expect(err).toBeInstanceOf(Error);
    expect(db.reports()).toHaveLength(0);
  });

  it('ready item ids unknown to the report are skipped, known ones still applied', async () => {
    const { db } = seededShell();
    await expect(onReady(readyForReport(1, [ITEM_CBC, idN(0x1fff)]), ctxFor(db).ctx)).resolves.toBeUndefined();
    expect(itemRow(db, ITEM_CBC)['lab_ready']).toBe(true);
    expect(db.items()).toHaveLength(3);
  });

  it('unknown fields (envelope + payload) and the optional department_ids are tolerated', async () => {
    const { db, LAB } = seededShell();
    await expect(onReady(readyForReport(1, [ITEM_CBC], { x_future: 1, department_ids: [idN(0x5001)] }, { x_envelope_future: 'v2' }), ctxFor(db).ctx)).resolves.toBeUndefined();
    expect(db.reports().find((r) => r['id'] === LAB)!['lab_ready_seq']).toBe(1);
  });

  it('SEC: another tenant\'s report for the same order id is not touched and gets no job', async () => {
    const { db } = seededShell({}, { rls: false });
    const other = { ...db.reports().find((r) => r['family'] === 'laboratory'), id: idN(0xb0b8), tenant_id: TENANT_B, _seed: true };
    db.store['reporting.reports']!.push(other);
    await onReady(readyForReport(1, [ITEM_CBC]), ctxFor(db).ctx);
    expect(db.reports().find((r) => r['id'] === other.id)).toMatchObject({ lab_ready_seq: null, needs_assembly: false });
    expect(jobsFor(db).every((j) => j.payload.tenant_id === TENANT_A)).toBe(true);
    expectTenantScoped(db);
  });

  it('SEC: nothing PHI-adjacent (registration number) is logged', async () => {
    const db = makeDb(XRAY_TEMPLATE);
    const { ctx, logs } = ctxFor(db, orderSummary());
    await onReady(readyForReport(1, [ITEM_CBC]), ctx);
    expect(logs.text()).not.toContain(REG_NO);
  });
});

// ============================================================================================ catalog.changed.v1
describe('catalog.changed.v1 (02-TRD §8.2: invalidate the in-process catalog cache; unknown entity_type -> invalidate all, 08 R13)', () => {
  it.each(['test', 'analyte', 'panel', 'department', 'doctor', 'price_list', 'future_entity_type'])('entity_type %s is accepted without error and without touching the database', async (entityType) => {
    const db = makeDb({});
    const { ctx } = makeCtx(db, { ports: makePorts().ports });
    await expect(onCatalog(catalogChanged(entityType), ctx)).resolves.toBeUndefined();
    expect(db.writes()).toHaveLength(0);
  });

  it('an older catalog_revision after a newer one is not an error', async () => {
    const db = makeDb({}); const { ctx } = makeCtx(db, { ports: makePorts().ports });
    await onCatalog(catalogChanged('test'), ctx);
    const older = catalogChanged('test'); older.payload.catalog_revision = 2;
    await expect(onCatalog(older, ctx)).resolves.toBeUndefined();
  });

  it('unknown fields are tolerated', async () => {
    const db = makeDb({}); const { ctx } = makeCtx(db, { ports: makePorts().ports });
    const ev = catalogChanged('test', { x_envelope_future: 1 }); ev.payload.x_future = 'y';
    await expect(onCatalog(ev, ctx)).resolves.toBeUndefined();
  });
});
