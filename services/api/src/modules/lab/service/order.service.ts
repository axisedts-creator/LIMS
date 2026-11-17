// Order consumers' service layer (06 row T-06; 02-TRD §4.1, §7.2 rows 1-3; PRD AC-01.1–AC-01.8; 03-APP-FLOW E2/E3).
// Runs in the caller's transaction (ctx.tx = the job transaction): any throw rolls everything back (retry / dead letter). Tenant and actor come from ctx only (REQ-SEC-024).
// Inbox dedupe (02-CV §7.4) is the worker wrapper's; on top of it every step here is idempotent (order row lock, (order_item_id, test_id), creation_key / attach).
// [CONV] stale rules: created is applied once (lab.orders.collection_mode NULL = no created applied yet, so a late created after items_changed/cancelled still
//   fills it and adds the missing items); items_changed applies only when items_version > stored; cancelled only when the order is still active.
// [CONV] items_changed additions attach to an active specimen of the same type/container still before receipt (ordered/collected/in_transit), else a new specimen
//   with creation_key suffixed by items_version; removals run after additions so a replacement test keeps its specimen.
// [CONV] approved results are never touched (02-TRD §7.2 "non-approved"); an order test with an approved result is not cancelled.
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { LimsError } from '../../../core/errors.js';
import { evaluateReadiness, type ReadinessDecision, type ReadinessInput } from '../domain/readiness.js';
import { createLabEvents } from '../events/publish.js';
import { insertOrderIfAbsent, lockOrder, updateOrder } from '../repository/orders.repo.js';
import { insertOrderTest, listOrderTestsByOrder, updateOrderTest } from '../repository/orderTests.repo.js';
import { insertResult, listResultsByOrder, updateResult } from '../repository/results.repo.js';
import { insertSpecimen, insertSpecimenTransition, listSpecimensByOrder, updateSpecimen } from '../repository/specimens.repo.js';
import type { RepoCtx, Row } from '../repository/base.repo.js';
import { allocateBarcode, type LabCtx } from './specimen.service.js';

type Port = (ctx: any, input: any) => Promise<any>;
export interface OrderCtx extends LabCtx {
  readonly events: { publish(ctx: never, type: string, input: never): Promise<{ eventId: string; duplicate: boolean }> };
  readonly ports: NonNullable<LabCtx['ports']> & {
    readonly FrontdeskPort: { getOrderSummary: Port; getPatientDemographics: Port };
    readonly CatalogPort: { resolveOrderables: Port };
  };
}
export interface OrderEnvelope { readonly event_id: string; readonly occurred_at?: string; readonly aggregate: { readonly id: string; readonly seq: number }; readonly payload: Row }

const UNRECEIVED = new Set(['ordered', 'collected', 'in_transit']);
const iso = (d: Date) => d.toISOString();
const getOrderTestsAndResults = async (rc: RepoCtx, orderId: string) => ({ tests: await listOrderTestsByOrder(rc, orderId), results: await listResultsByOrder(rc, orderId) });

function scope(ctx: OrderCtx, env: OrderEnvelope): { rc: RepoCtx; orderId: string; seq: number } {
  const orderId = env?.aggregate?.id;
  if (!ctx?.tx || typeof ctx.tenantId !== 'string' || typeof ctx.actor?.id !== 'string' || typeof orderId !== 'string' || env.payload?.order_id !== orderId
    || !Number.isInteger(env.aggregate.seq)) throw new LimsError('common.internal');
  return { rc: { tx: ctx.tx, tenantId: ctx.tenantId, actorId: ctx.actor.id }, orderId, seq: env.aggregate.seq };
}

/** 02-TRD §4.1 step 2: whole days birthOn -> registered_at when birthOn is known, else years*365 + months*30 + days [CONV approximation]; clamped to the column CHECK. */
function ageDaysOf(d: Row, registeredAt: string): number | null {
  const n = d['birthOn'] ? Math.floor((Date.parse(registeredAt) - Date.parse(`${d['birthOn']}T00:00:00Z`)) / 86_400_000)
    : d['ageAtOrder'] ? d['ageAtOrder'].years * 365 + d['ageAtOrder'].months * 30 + d['ageAtOrder'].days : null;
  return n === null || !Number.isFinite(n) ? null : Math.min(60000, Math.max(0, n));
}

/** Lock the order row, or build it (registration_no from getOrderSummary, sex/age from getPatientDemographics purpose result_evaluation). fresh = this call inserted it. */
async function loadOrBuild(ctx: OrderCtx, rc: RepoCtx, env: OrderEnvelope, orderId: string, seq: number, kind: 'created' | 'changed' | 'cancelled'): Promise<{ order: Row; fresh: boolean }> {
  const existing = await lockOrder(rc, orderId);
  if (existing) return { order: existing, fresh: false };
  const summary = await ctx.ports.FrontdeskPort.getOrderSummary(ctx, { orderId });
  const p = env.payload;
  const base = kind === 'created'
    ? { centre_id: p['centre_id'], branch_id: p['branch_id'], patient_id: p['patient_id'], visit_type: p['visit_type'], priority: p['priority'], referrer_id: p['referrer_id'],
      collection_mode: p['collection_mode'], source: p['source'], registered_at: p['registered_at'] }
    : { centre_id: summary.centreId, branch_id: summary.branchId, patient_id: summary.patientId, visit_type: summary.visitType, priority: summary.priority, referrer_id: summary.referrerId,
      collection_mode: null, source: summary.source, registered_at: summary.registeredAt ?? env.occurred_at ?? iso(ctx.now()) };   // E2/E3: collection_mode stays NULL
  const demo = await ctx.ports.FrontdeskPort.getPatientDemographics(ctx, { patientId: base.patient_id, purpose: 'result_evaluation' });
  const inserted = await insertOrderIfAbsent(rc, { id: orderId, ...base, registration_no: summary.registrationNo, patient_sex: demo.sex, patient_age_days: ageDaysOf(demo, base.registered_at),
    lab_status: kind === 'cancelled' ? 'cancelled' : 'active', cancelled_at: kind === 'cancelled' ? p['cancelled_at'] : null, last_order_seq: seq, items_version: 1 });
  const order = (await lockOrder(rc, orderId))!;
  return { order, fresh: inserted !== null };
}

interface Item { order_item_id: string; orderable_id: string; test_ids: string[]; priority: 'routine' | 'urgent'; outsourced?: boolean }

/** 02-TRD §4.1 steps 3-6 for the given items: order_tests, attach-or-create specimens (+S1 event), pending results. Items/tests already present are skipped. */
async function addItems(ctx: OrderCtx, rc: RepoCtx, order: Row, items: readonly Item[], asOf: string, keySuffix: string | null): Promise<void> {
  const have = new Set((await getOrderTestsAndResults(rc, order['id'])).tests.map((t) => `${t['order_item_id']}:${t['test_id']}`));
  const todo = items.flatMap((item) => item.test_ids.filter((tid) => !have.has(`${item.order_item_id}:${tid}`)).map((tid) => ({ item, tid })));
  if (todo.length === 0) return;
  const resolved = await ctx.ports.CatalogPort.resolveOrderables(ctx, { orderableIds: [...new Set(todo.map((x) => x.item.orderable_id))], asOf });
  const tests = new Map<string, any>((resolved.tests as any[]).map((t) => [t.id, t]));
  const now = iso(ctx.now());
  const rows = todo.map(({ item, tid }) => {
    const t = tests.get(tid);
    if (!t) throw new LimsError('common.internal');   // fail closed: the catalog did not resolve a test of the order
    const status0 = t.workflowType === 'narrative' ? 'excluded' : item.outsourced || t.workflowType === 'outsourced' ? 'outsourced' : t.usesExistingMaterial ? 'in_process' : 'awaiting_collection';
    return { item, t, status0 };
  });

  // specimens: one per requirement that has >= 1 testable (non-excluded, non-outsourced, non-existing-material) test of this call
  const specimens: Row[] = [...(await listSpecimensByOrder(rc, order['id']))];
  const specimenOfTest = new Map<string, Row>();
  const events = createLabEvents(ctx.events as never);
  const testable = new Set(rows.filter((r) => r.status0 === 'awaiting_collection').map((r) => r.t.id as string));
  const urgentTest = (tid: string) => rows.some((r) => r.t.id === tid && r.item.priority === 'urgent');
  for (const req of resolved.specimenRequirements as any[]) {
    const ids = (req.testIds as string[]).filter((id) => testable.has(id));
    if (ids.length === 0) continue;
    const container = req.containerCode ?? null;
    let sp: Row | undefined = specimens.find((s) => s['is_active'] && UNRECEIVED.has(s['status']) && s['specimen_type_code'] === req.specimenTypeCode && (s['container_code'] ?? null) === container);
    if (!sp) {
      const barcode = await allocateBarcode(ctx);
      const orderItemIds = [...new Set(rows.filter((r) => ids.includes(r.t.id)).map((r) => r.item.order_item_id))];
      sp = await insertSpecimen(rc, { id: uuidv7(), centre_id: order['centre_id'], order_id: order['id'], patient_id: order['patient_id'], barcode,
        creation_key: `${order['id']}:${req.specimenTypeCode}:${container ?? '-'}${keySuffix ? `:${keySuffix}` : ''}`, specimen_type_code: req.specimenTypeCode, container_code: container,
        priority: ids.some(urgentTest) ? 'urgent' : 'routine', patient_sex: order['patient_sex'], patient_age_days: order['patient_age_days'], status: 'ordered', ordered_at: now });
      specimens.push(sp);
      await insertSpecimenTransition(rc, { id: uuidv7(), centre_id: sp['centre_id'], specimen_id: sp['id'], transition_code: 'S1', from_status: null, to_status: 'ordered', specimen_version: 1,
        occurred_at: now, actor_type: ctx.actor.type ?? 'system', actor_id: ctx.actor.id });
      await events.specimenStatusChanged(ctx as never, { specimen_id: sp['id'], order_id: order['id'], patient_id: order['patient_id'], centre_id: order['centre_id'],
        specimen_type_code: sp['specimen_type_code'], to_status: 'ordered', changed_at: now, order_item_ids: orderItemIds }, { specimenVersion: 1 });
    }
    for (const id of ids) specimenOfTest.set(id, sp);
  }

  // processing centre of an existing-material test: the order's earliest received active specimen, when there is one (02-TRD §4.1 step 5)
  const received = specimens.filter((s) => s['is_active'] && s['received_at'] && s['processing_centre_id']).sort((a, b) => +new Date(a['received_at']) - +new Date(b['received_at']))[0];

  for (const { item, t, status0 } of rows) {
    const sp = specimenOfTest.get(t.id);
    const status = sp && status0 === 'awaiting_collection' && sp['status'] !== 'ordered' ? 'awaiting_receipt' : status0;
    const existing = status0 === 'in_process';
    const ot = await insertOrderTest(rc, { id: uuidv7(), centre_id: order['centre_id'], order_id: order['id'], order_item_id: item.order_item_id, test_id: t.id, test_code: t.code,
      test_revision: t.revision, catalog_revision: resolved.catalogRevision, department_id: t.departmentId, workflow_type: t.workflowType, priority: item.priority,
      specimen_id: sp?.['id'] ?? null, uses_existing_material: existing, status, tat_target_seconds: t.tatTargetSeconds?.[item.priority] ?? null, ordered_at: now,
      processing_centre_id: existing ? received?.['processing_centre_id'] ?? null : null, processing_branch_id: existing ? received?.['processing_branch_id'] ?? null : null });
    if (status0 === 'excluded' || status0 === 'outsourced') continue;
    // R1: one pending result per reportable analyte and per formula-input analyte (is_reportable snapshot)
    const inputs = new Set<string>((t.analytes as any[]).flatMap((a) => a.formula?.inputAnalyteCodes ?? []));
    for (const a of (t.analytes as any[]).filter((x) => x.reportable || inputs.has(x.code))) {
      await insertResult(rc, { id: uuidv7(), centre_id: order['centre_id'], order_id: order['id'], order_item_id: item.order_item_id, order_test_id: ot['id'], specimen_id: sp?.['id'] ?? null,
        patient_id: order['patient_id'], test_id: t.id, analyte_id: a.id, analyte_code: a.code, department_id: t.departmentId, is_reportable: a.reportable, result_type: a.resultType,
        status: 'pending', ...(a.unitCode ? { unit_code: a.unitCode } : {}) });
    }
  }
}

/** R8 for the non-approved results of the picked order tests; a test that has an approved result stays (its other results are still cancelled). */
async function cancelOrderTests(rc: RepoCtx, orderId: string, pick: (t: Row) => boolean, reason: string, at: string): Promise<void> {
  const { tests, results } = await getOrderTestsAndResults(rc, orderId);
  for (const t of tests.filter((x) => x['status'] !== 'cancelled' && pick(x))) {
    const rs = results.filter((r) => r['order_test_id'] === t['id'] && r['status'] !== 'cancelled');
    for (const r of rs.filter((x) => x['status'] !== 'approved')) await updateResult(rc, r['id'], r['version'], { status: 'cancelled', cancelled_at: at, cancel_reason: reason });
    if (!rs.some((r) => r['status'] === 'approved')) await updateOrderTest(rc, t['id'], t['version'], { status: 'cancelled', cancelled_at: at, cancel_reason: reason });
  }
}

/** AC-01.7 / AC-01.8: an un-received specimen with no live order test is no longer needed. No specimen status event (no state exists for it). */
async function inactivateIdleSpecimens(rc: RepoCtx, orderId: string): Promise<void> {
  const { tests } = await getOrderTestsAndResults(rc, orderId);
  for (const s of await listSpecimensByOrder(rc, orderId)) {
    if (s['is_active'] && UNRECEIVED.has(s['status']) && !tests.some((t) => t['specimen_id'] === s['id'] && t['status'] !== 'cancelled')) await updateSpecimen(rc, s['id'], s['version'], { is_active: false });
  }
}

export async function applyOrderCreated(ctx: OrderCtx, env: OrderEnvelope): Promise<void> {
  const { rc, orderId, seq } = scope(ctx, env);
  const p = env.payload;
  let { order, fresh } = await loadOrBuild(ctx, rc, env, orderId, seq, 'created');
  let items: Item[] = p['items'];
  if (!fresh) {
    if (order['collection_mode'] !== null) return;                       // created already applied (duplicate / stale seq)
    order = await updateOrder(rc, orderId, order['version'], { collection_mode: p['collection_mode'], last_order_seq: Math.max(order['last_order_seq'], seq) });   // late created (E2/E3)
    if (order['lab_status'] === 'cancelled') return;
    const active = new Set<string>(((await ctx.ports.FrontdeskPort.getOrderSummary(ctx, { orderId })).items as any[]).filter((i) => i.status === 'active').map((i) => i.orderItemId));
    items = items.filter((i) => active.has(i.order_item_id));            // items removed before this created arrived must not come back
  }
  await addItems(ctx, rc, order, items, p['registered_at'], null);
}

export async function applyOrderItemsChanged(ctx: OrderCtx, env: OrderEnvelope): Promise<void> {
  const { rc, orderId, seq } = scope(ctx, env);
  const p = env.payload;
  let { order } = await loadOrBuild(ctx, rc, env, orderId, seq, 'changed');
  if (order['lab_status'] === 'cancelled' || p['items_version'] <= order['items_version']) return;   // cancelled order / stale items_version
  await addItems(ctx, rc, order, p['added'], p['changed_at'], String(p['items_version']));
  const removed = new Set<string>((p['removed'] as { order_item_id: string }[]).map((r) => r.order_item_id));
  if (removed.size) {
    await cancelOrderTests(rc, orderId, (t) => removed.has(t['order_item_id']), 'item_removed', p['changed_at']);
    await inactivateIdleSpecimens(rc, orderId);
  }
  order = (await lockOrder(rc, orderId))!;
  await updateOrder(rc, orderId, order['version'], { items_version: p['items_version'], last_order_seq: Math.max(order['last_order_seq'], seq) });
}

export async function applyOrderCancelled(ctx: OrderCtx, env: OrderEnvelope): Promise<void> {
  const { rc, orderId, seq } = scope(ctx, env);
  const p = env.payload;
  const { order, fresh } = await loadOrBuild(ctx, rc, env, orderId, seq, 'cancelled');
  if (fresh || order['lab_status'] === 'cancelled') return;              // E3 row built already cancelled / re-delivery
  await updateOrder(rc, orderId, order['version'], { lab_status: 'cancelled', cancelled_at: p['cancelled_at'], last_order_seq: Math.max(order['last_order_seq'], seq) });
  await cancelOrderTests(rc, orderId, () => true, 'order_cancelled', p['cancelled_at']);
  await inactivateIdleSpecimens(rc, orderId);
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// T-17 readiness (02-TRD §4.7, §7.1 key `<order_id>:ready:<approved_set_hash>`; 03-IC §3.12; 08 A13 D-5; PRD AC-16.5, AC-16.6, AC-17.1).
// Called by approve / bulk approve / amend after all their writes, once per order, in the same transaction. The lab.order_readiness row is locked first
// (serialises two approvals of one order), the pure rules are domain/readiness.ts; bookkeeping is written only when an event was emitted.
// ---------------------------------------------------------------------------------------------------------------------------------------------
export interface ReadinessStore {
  /** Locks the lab.order_readiness row (defaults when absent: seq 0, no hashes). */
  lockReadiness(tx: unknown, tenantId: string, orderId: string): Promise<{ readinessSeq: number; lastEmittedHash?: string | undefined; lastCompleteness?: 'complete' | 'partial' | undefined; departmentHashes: Record<string, string> }>;
  listReadinessInputs(tx: unknown, tenantId: string, orderId: string): Promise<{ orderTests: ReadinessInput['orderTests']; results: ReadinessInput['results'] }>;
  saveReadiness(tx: unknown, tenantId: string, a: { orderId: string; readinessSeq: number; lastEmittedHash: string; lastCompleteness: 'complete' | 'partial'; departmentHashes: Record<string, string>; emittedAt: string }): Promise<void>;
}
export interface ReadinessCtx {
  readonly tenantId: string; readonly tx: object; now(): Date; readonly store: ReadinessStore;
  readonly events: OrderCtx['events'];
  readonly ports: { readonly IdentityPort: { getTenantSettings(ctx: unknown, i: { keys: readonly string[] }): Promise<{ partialReleaseAllowed?: boolean }> } };
}

export async function evaluateOrderReadiness(rawCtx: unknown, orderId: string): Promise<ReadinessDecision | null> {
  const ctx = rawCtx as ReadinessCtx;
  const { tx, tenantId, store } = ctx;
  const last = await store.lockReadiness(tx, tenantId, orderId);
  const inputs = await store.listReadinessInputs(tx, tenantId, orderId);
  if (!inputs.results.some((r) => r.status === 'approved')) return null;   // nothing approved: neither complete nor partial, the tenant setting is not needed
  const settings = await ctx.ports.IdentityPort.getTenantSettings(ctx, { keys: ['partialReleaseAllowed'] });
  const d = evaluateReadiness({
    ...inputs, partialReleaseAllowed: settings.partialReleaseAllowed === true,
    last: { hash: last.lastEmittedHash, completeness: last.lastCompleteness, departmentHashes: last.departmentHashes },
  });
  if (!d) return null;
  const readyAt = ctx.now().toISOString();
  const seq = last.readinessSeq + 1;
  // 03-IC §3.12: ids + hash only; approved_set_hash is added by the publisher from the set (same function as the hash stored below).
  await createLabEvents(ctx.events as never).orderReadyForReport(ctx as never, {
    order_id: orderId, completeness: d.completeness, order_item_ids: d.orderItemIds, ...(d.departmentIds === undefined ? {} : { department_ids: d.departmentIds }),
    contains_amendment: d.containsAmendment, ready_at: readyAt,
  }, { approvedSet: d.approvedSet, readinessSeq: seq });
  await store.saveReadiness(tx, tenantId, { orderId, readinessSeq: seq, lastEmittedHash: d.approvedSetHash, lastCompleteness: d.completeness, departmentHashes: d.departmentHashes, emittedAt: readyAt });
  return d;
}
