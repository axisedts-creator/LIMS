// C13 T12 test world (tester-owned): in-memory SQL world for the partners tracking projections, their event consumers and the reconcile / enrich tasks.
// Not a test file (no *.test.ts suffix). It EXTENDS the T17 world (projection.world.ts: same SQL subset, documented in its header, same bound-$n-only rule) with the
// writable tables partners.order_tracking / tracked_specimens / order_reports / manifest_lines (05-SCHEMA CHECKs, NOT NULLs, PKs and the (order_id, partner_id) FKs
// emulated; pg codes 23502/23503/23505/23514) and the read-only views lab.v_pub_specimen_timeline / frontdesk.v_pub_order_status (03-IC §6).
// Anything outside the subset throws "fake SQL: ..." so the writer sees it: no joins, no subqueries, no aggregates (count/max/greatest), no `interval` arithmetic
// (bind a Date computed from ctx.now()), no `DO UPDATE ... WHERE` (use `UPDATE ... WHERE ... AND last_seq < $n` for compare-and-set).
// partners.event_inbox is deliberately NOT writable: the C0 consumer wrapper (core/consumer.ts consumerRun) already inserted the inbox row and de-duplicated before the handler runs,
// so a handler that touches the inbox (02-TRD §7.2 step 1 is the wrapper's) fails here with "table partners.event_inbox is not writable here".
// All data is synthetic. The 03-IC example payloads (§3.7, §3.17) are used verbatim (ids 01a1a98a-…), so "each 03 example" is literal.
import { LimsError } from '../../../core/errors.js';
import { id, jobCtx, makeWorld, NOW, NOW_ISO, P, SYSTEM, T_A, T_B, type Def, type Row, type World } from './projection.world.js';

export { id, NOW, NOW_ISO, P, SYSTEM, T_A, T_B };
export type { Row, World };

const nowD = () => NOW;
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));
const SPECIMEN_STATUSES = ['ordered', 'collected', 'in_transit', 'received', 'aliquoted', 'in_process', 'resulted', 'verified', 'approved', 'reported', 'rejected', 'recollection_ordered', 'stored', 'discarded'];
const hasTracking = (t: Record<string, Row[]>, r: Row) => t['partners.order_tracking']!.some((o) => o.tenant_id === r.tenant_id && o.order_id === r.order_id && o.partner_id === r.partner_id);

export const TRACKING_DEFS: Record<string, Def> = {
  'partners.manifest_lines': {
    pk: ['tenant_id', 'id'], bigint: [], defaults: { created_at: nowD, updated_at: nowD, failure_code: () => null, failed_at: () => null },
    notNull: ['tenant_id', 'id', 'state'],
    check: (r) => !['draft', 'submitted', 'converting', 'converted', 'conversion_failed', 'not_received', 'withdrawn', 'discarded', 'cancelled'].includes(r.state) ? 'manifest_lines__state__ck'
      : (r.state === 'conversion_failed') !== (r.failure_code != null) ? 'manifest_lines__failed__ck' : null,
  },
  'partners.order_tracking': {
    pk: ['tenant_id', 'order_id'], fk: true, bigint: [], defaults: { created_at: nowD, updated_at: nowD, report_count: () => 0, version: () => 1, cancelled_at: () => null, stored_order_status: () => null, reconciled_at: () => null },
    notNull: ['tenant_id', 'order_id', 'partner_id', 'line_id', 'manifest_id', 'receiving_centre_id', 'tracking_status', 'registered_at', 'last_event_at', 'report_count', 'version', 'created_by', 'updated_by'],
    check: (r) => !['registered', 'in_transit', 'in_lab', 'action_needed', 'partially_reported', 'reported', 'cancelled'].includes(r.tracking_status) ? 'order_tracking__status__ck'
      : r.stored_order_status != null && !['pre_registered', 'registered', 'cancelled'].includes(r.stored_order_status) ? 'order_tracking__stored__ck' : null,
  },
  'partners.tracked_specimens': {
    pk: ['tenant_id', 'specimen_id'], fk: true, bigint: [], defaults: { created_at: nowD, updated_at: nowD, collected_at: () => null, in_transit_at: () => null, received_at: () => null, rejected_at: () => null, reported_at: () => null,
      rejection_reason_code: () => null, replaces_specimen_id: () => null, parent_specimen_id: () => null },
    notNull: ['tenant_id', 'specimen_id', 'order_id', 'partner_id', 'receiving_centre_id', 'specimen_type_code', 'status', 'last_seq', 'changed_at', 'created_by', 'updated_by'],
    check: (r) => r.specimen_type_code.length < 1 || r.specimen_type_code.length > 64 ? 'tracked_specimens__type__ck' : !SPECIMEN_STATUSES.includes(r.status) ? 'tracked_specimens__status__ck'
      : !(r.last_seq >= 0) ? 'tracked_specimens__seq__ck' : r.rejection_reason_code != null && r.rejection_reason_code.length > 64 ? 'tracked_specimens__reason__ck' : null,
    fkCheck: (r, t) => (hasTracking(t, r) ? null : 'tracked_specimens__order__fk'),
  },
  'partners.order_reports': {
    pk: ['tenant_id', 'report_id', 'version_no'], bigint: [], defaults: { created_at: nowD, updated_at: nowD, status: () => 'valid', is_new: () => true, panel_names: () => null, seen_at: () => null, seen_by: () => null, enriched_at: () => null },
    notNull: ['tenant_id', 'report_id', 'version_no', 'order_id', 'partner_id', 'receiving_centre_id', 'kind', 'status', 'released_at', 'is_new', 'created_by', 'updated_by'],
    check: (r) => r.kind.length < 1 || r.kind.length > 32 ? 'order_reports__kind__ck' : !['valid', 'superseded'].includes(r.status) ? 'order_reports__status__ck' : !(r.version_no >= 1) ? 'order_reports__version__ck'
      : r.panel_names != null && r.panel_names.length > 50 ? 'order_reports__panels__ck' : !r.is_new && r.seen_at == null ? 'order_reports__seen__ck' : null,
    fkCheck: (r, t) => (hasTracking(t, r) ? null : 'order_reports__order__fk'),
  },
};

export const makeTrackingWorld = () => makeWorld({ defs: TRACKING_DEFS, tables: ['lab.v_pub_specimen_timeline', 'frontdesk.v_pub_order_status'] });

// ------------------------------------------------------------------ ids (03-IC §3.7 / §3.17 example ids are used verbatim)
const ex = (n: string) => `01a1a98a-ac40-7000-8000-${n}`;
export const EX = { specimen: ex('000000090001'), order: ex('000000050001'), patient: ex('000000040001'), centre: ex('000000020002'), branch: ex('000000010001'), item: ex('000000060001'),
  report: ex('0000000f0001'), referrer: ex('000000140001') };
export const O = { ex: EX.order, y: id(101), done: id(102), cancelled: id(103), old: id(104), foreign: id(105), x2: id(106), b: id(107) };
export const L = { ex: id(111), y: id(112), done: id(113), cancelled: id(114), old: id(115), x2: id(116), b: id(117), converting: id(118), convertingFresh: id(119), convertedOther: id(120) };
export const S = { a: id(201), b: id(202), c: id(203), repl: id(204), y: id(205), unseen: id(206), x2: id(207) };
export const R = { a: id(301), b: id(302), y: id(303) };
export const CENTRE_Y = id(60), MANIFEST = id(70);
const DAY = 86_400_000;
export const ago = (ms: number) => new Date(NOW.getTime() - ms);
export const AT = { registered: new Date('2026-11-05T02:00:00.000Z'), changed: '2026-11-05T03:20:41.300Z', later: '2026-11-05T05:00:00.000Z', released: '2026-11-05T04:35:00.000Z' };

const tracking = (o: Row): Row => ({ tenant_id: T_A, partner_id: P.x, manifest_id: MANIFEST, receiving_centre_id: EX.centre, registration_no: 'SYN-0001', tracking_status: 'registered', registered_at: AT.registered,
  last_event_at: AT.registered, cancelled_at: null, report_count: 0, stored_order_status: null, reconciled_at: null, version: 1, created_at: AT.registered, created_by: SYSTEM, updated_at: ago(DAY), updated_by: SYSTEM, ...o });

/** Tenant A: partner X owns O.ex (example order, centre = the example centre), O.x2, O.done (reported), O.cancelled, O.old (stale: untouched for 31 days); partner Y owns O.y; tenant B owns O.b and O.foreign. */
export function seedTracking(w: World) {
  const T = w.t;
  T['partners.partners']!.push(
    { id: P.x, tenant_id: T_A, partner_code: 'SYN-X', name: 'Synthetic Partner X', status: 'active' }, { id: P.y, tenant_id: T_A, partner_code: 'SYN-Y', name: 'Synthetic Partner Y', status: 'active' },
    { id: P.b, tenant_id: T_B, partner_code: 'SYN-B', name: 'Synthetic Partner B', status: 'active' });
  const line = (i: string, state: string, over: Row = {}) => T['partners.manifest_lines']!.push({ tenant_id: T_A, id: i, state, updated_at: ago(DAY), failure_code: null, failed_at: null, ...over });
  line(L.ex, 'converted'); line(L.y, 'converted'); line(L.done, 'converted'); line(L.cancelled, 'converted'); line(L.old, 'converted'); line(L.x2, 'converted'); line(L.convertedOther, 'converted');
  line(L.converting, 'converting', { updated_at: ago(45 * 60_000) });        // > 30 min: reconcile (c) flags it
  line(L.convertingFresh, 'converting', { updated_at: ago(5 * 60_000) });    // 5 min: untouched
  T['partners.manifest_lines']!.push({ tenant_id: T_B, id: L.b, state: 'converting', updated_at: ago(90 * 60_000), failure_code: null, failed_at: null });   // other tenant: never touched
  T['partners.order_tracking']!.push(
    tracking({ order_id: O.ex, line_id: L.ex }),
    tracking({ order_id: O.x2, line_id: L.x2, registration_no: 'SYN-0006' }),
    tracking({ order_id: O.y, line_id: L.y, partner_id: P.y, receiving_centre_id: CENTRE_Y, registration_no: 'SYN-0002' }),
    tracking({ order_id: O.done, line_id: L.done, registration_no: 'SYN-0003', tracking_status: 'reported', report_count: 1 }),
    tracking({ order_id: O.cancelled, line_id: L.cancelled, registration_no: 'SYN-0004', tracking_status: 'cancelled', cancelled_at: AT.registered }),
    tracking({ order_id: O.old, line_id: L.old, registration_no: 'SYN-0005', updated_at: ago(31 * DAY) }),
    tracking({ tenant_id: T_B, order_id: O.b, line_id: L.b, partner_id: P.b, registration_no: 'SYN-B001' }),
    tracking({ tenant_id: T_B, order_id: O.foreign, line_id: id(121), partner_id: P.b, registration_no: 'SYN-B002' }));
}

// ------------------------------------------------------------------ events (full envelope as the C0 wrapper hands it to a ConsumerHandler)
let evN = 0;
const envelope = (tenant: string, type: string, aggregate: Row, payload: Row, eventId?: string) => ({ event_id: eventId ?? id(900 + evN++), event_type: type, event_version: 1, tenant_id: tenant,
  occurred_at: String(payload['changed_at'] ?? payload['released_at'] ?? AT.changed), aggregate, payload });

/** 03-IC §3.7 example payload, verbatim (to_status received, specimen 90001 of order 50001). */
export const STATUS_EXAMPLE: Row = { specimen_id: EX.specimen, order_id: EX.order, patient_id: EX.patient, centre_id: EX.centre, processing_branch_id: EX.branch, specimen_type_code: 'EDTA_WB',
  from_status: 'in_transit', to_status: 'received', changed_at: AT.changed, order_item_ids: [EX.item] };
export const statusEvent = (payload: Row = {}, seq = 4, over: { tenant?: string; eventId?: string } = {}) => {
  const p = { ...STATUS_EXAMPLE, ...payload };
  return envelope(over.tenant ?? T_A, 'lab.specimen.status_changed.v1', { type: 'specimen', id: p['specimen_id'], seq }, p, over.eventId);
};
/** 03-IC §3.17 example payload, verbatim: audiences patient+referrer, no partner_id (so NOT a partner report). */
export const RELEASED_EXAMPLE: Row = { report_id: EX.report, version_no: 1, order_id: EX.order, patient_id: EX.patient, centre_id: EX.centre, referrer_id: EX.referrer, report_kind: 'final',
  released_at: AT.released, release_basis: 'paid_in_full', audiences: ['patient', 'referrer'], order_item_ids: [EX.item] };
/** the example made a partner report of partner X (partner_id + audience partner). */
export const PARTNER_RELEASED: Row = { ...RELEASED_EXAMPLE, partner_id: P.x, audiences: ['patient', 'partner'] };
export const releasedEvent = (payload: Row = {}, seq = 1, over: { tenant?: string; eventId?: string } = {}) => {
  const p = { ...PARTNER_RELEASED, ...payload };
  return envelope(over.tenant ?? T_A, 'reporting.report.released.v1', { type: 'report', id: p['report_id'], seq }, p, over.eventId);
};

// ------------------------------------------------------------------ views and ports
export const timeline = (w: World, o: Row) => w.t['lab.v_pub_specimen_timeline']!.push({ tenant_id: T_A, centre_id: EX.centre, specimen_type_code: 'EDTA_WB', collected_at: null, in_transit_at: null, received_at: null, reported_at: null,
  rejected_at: null, rejection_reason_code: null, parent_specimen_id: null, replaces_specimen_id: null, ...o });
export const orderStatus = (w: World, o: Row) => w.t['frontdesk.v_pub_order_status']!.push({ tenant_id: T_A, partner_id: P.x, status: 'registered', registered_at: AT.registered, updated_at: ago(60_000), ...o });

export function summary(o: Row) {
  return { reportId: EX.report, versionNo: 1, orderId: EX.order, patientId: EX.patient, kind: 'final', status: 'valid', releasedAt: AT.released, panelNames: ['Synthetic Lipid Package'], smartSummaryAvailable: false, ...o };
}
/** ReportingPort fake (03-IC §4.7): getReleasedReports(ctx, { filter, cursor?, limit? }) -> Page { items }. Records every call; `reject` makes it throw. */
export function reportingPort(items: Row[] | ((input: any) => Row[]), reject?: Error) {
  const calls: Array<{ ctx: any; input: any }> = [];
  return { calls, async getReleasedReports(ctx: any, input: any) { calls.push({ ctx, input }); if (reject) throw reject; return { items: typeof items === 'function' ? items(input) : items }; } };
}
export const portDown = () => new LimsError('common.dependency_unavailable');

export interface Metric { name: string; labels: Row; by: number }
/** worker JobContext + ctx.metrics (recorded) + ctx.ports.ReportingPort. */
export function trackingCtx(w: World, over: { tenant?: string; port?: ReturnType<typeof reportingPort>; now?: string } = {}) {
  const metrics: Metric[] = [];
  const { ctx, logs } = jobCtx(w, over.tenant ?? T_A, { ctx: { metrics: { inc: (name: string, labels: Row = {}, by = 1) => metrics.push({ name, labels, by }), observe: () => undefined, set: () => undefined },
    ports: { ReportingPort: over.port ?? reportingPort([]) }, ...(over.now ? { now: () => over.now } : {}) } });
  return { ctx, logs, metrics };
}
export const outcomes = (m: Metric[], eventType: string) => m.filter((x) => x.name === 'lims_partners_events_consumed_total' && x.labels['event_type'] === eventType).map((x) => x.labels['outcome']);

/** One job = one transaction (rolled back on throw), as the worker runs it. */
export async function run(w: World, fn: (ctx: any) => Promise<unknown>, over: Parameters<typeof trackingCtx>[1] = {}) {
  const { ctx, logs, metrics } = trackingCtx(w, over); const snap = w.snapshot();
  try { await fn(ctx); return { ok: true as const, error: undefined, logs, metrics, ctx }; } catch (error) { w.restore(snap); return { ok: false as const, error: error as Error, logs, metrics, ctx }; }
}

// ------------------------------------------------------------------ readers
export const row = (w: World, table: string, where: Row) => w.t[`partners.${table}`]!.find((r) => Object.entries(where).every(([k, v]) => r[k] === v));
export const trackingOf = (w: World, order: string, tenant = T_A) => row(w, 'order_tracking', { tenant_id: tenant, order_id: order })!;
export const specimenOf = (w: World, specimen: string, tenant = T_A) => row(w, 'tracked_specimens', { tenant_id: tenant, specimen_id: specimen });
export const reportOf = (w: World, report: string, version: number, tenant = T_A) => row(w, 'order_reports', { tenant_id: tenant, report_id: report, version_no: version });
export const isoOrNull = (v: unknown) => (v == null ? null : iso(v));
/** deep copy of every partners.* table, to assert "nothing changed". */
export const projection = (w: World) => structuredClone(Object.fromEntries(Object.entries(w.t).filter(([k]) => k.startsWith('partners.'))));
export const jobsOf = (w: World, identifier: string) => w.jobs.filter((j) => j.identifier === identifier);
/** statements that write a partners.* projection table (INSERT/UPDATE/DELETE), excluding job enqueues. */
export const projectionWrites = (w: World) => w.writes().filter((q) => /\bpartners\.(order_tracking|tracked_specimens|order_reports|manifest_lines)\b/i.test(q.text));
/** every bound-parameter rule: no seeded uuid / free text may appear in the statement text itself. */
export const literalLeaks = (w: World, needles: string[]) => w.log.filter((q) => needles.some((n) => q.text.includes(n))).map((q) => q.text);
export { iso, DAY };
