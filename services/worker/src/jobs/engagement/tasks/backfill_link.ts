// Task engagement.backfill_link {tenant_id, link_id} (02-TRD §4.4 Backfill, §4.3.3 step 4, §4.3.5, §8.1 max 10, job key backfill:<link_id>; 03-IC §6.3 views, §4.7 ReportingPort).
// A link that is not active / suspended (revoked, missing, other tenant) or a bad payload is a silent no-op. Otherwise, as the system actor, in ONE transaction (a throw rolls every write back and the queue retries):
//   1. FrontdeskPort.getPatientDemographics({purpose:'patient_app_link'}): merged / anonymised patient -> link `suspended` (patient_merged / patient_anonymised) and nothing is projected;
//      report_link: display_name + sex_snapshot are refreshed here (review C16 #16).
//   2. the three published order / specimen / balance views (200 orders per page, max 1,000 orders [CONV]; timeline + balance in batches of 50 orders) -> patient_orders / patient_order_specimens
//      (status_seq = specimen_version; recollection_required from status = 'recollection_ordered'); partner_manifest orders only with settings.show_partner_orders.
//   3. ReportingPort.getReleasedReports({filter:{patientId, includeSuperseded:true}}) page by page -> patient_reports; then the order stages.
// Writes go only through projection.service (shared with the consumers); views are read only through views.repo (02-CV §5.13). Nothing sensitive (phone, name, rejection reason) is logged.
import type { TaskHandler } from '../../../core/manifest.js';
import { createProjectionService, type OrderIn, type ReportIn, type SpecimenIn } from '../../../../../api/src/modules/engagement/service/projection.service.js';
import * as views from '../../../../../api/src/modules/engagement/repository/views.repo.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PURPOSE = 'patient_app_link';
const ORDER_PAGE = 200, MAX_ORDERS = 1000, BATCH = 50; // TRD §4.4
const REPORT_PAGE = 100; // [CONV] TRD says 200; the C6 port (and its fake) caps a page at 100
type Row = Record<string, any>;

const iso = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));
const batches = <T>(xs: readonly T[], n: number): T[][] => { const out: T[][] = []; for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n)); return out; };

export function createBackfillLink(): TaskHandler {
  const projection = createProjectionService();
  return async (payload, jobCtx) => {
    const ctx = jobCtx as any;
    const tenantId = ctx.tenantId; const linkId = payload?.['link_id'];
    if (typeof tenantId !== 'string' || (payload?.['tenant_id'] !== undefined && payload['tenant_id'] !== tenantId) || typeof linkId !== 'string' || !UUID.test(linkId)) {
      ctx.log?.warn?.({ event: 'backfill_link_skipped', reason: 'bad_payload' });
      return;
    }
    const tx = ctx.tx; const now: string = ctx.now(); const by: string = ctx.actor.id;
    const { rows: [link] } = await tx.query('SELECT id, patient_id, method, status FROM engagement.account_patient_links WHERE tenant_id = $1 AND id = $2', [tenantId, linkId]) as { rows: Row[] };
    if (!link || !['active', 'suspended'].includes(link['status'])) { ctx.log?.info?.({ event: 'backfill_link_noop' }); return; }
    const patientId: string = link['patient_id'];

    // 1. link refresh (system actor; the demographics never leave this function)
    const demo = await ctx.ports.FrontdeskPort.getPatientDemographics(ctx, { patientId, purpose: PURPOSE });
    const gone = demo?.status === 'merged' ? 'patient_merged' : demo?.status === 'anonymised' ? 'patient_anonymised' : undefined;
    if (gone) {
      if (link['status'] === 'active') await tx.query(
        "UPDATE engagement.account_patient_links SET status = 'suspended', suspend_reason = $3, suspended_at = $4, version = version + 1, updated_at = $4, updated_by = $5 WHERE tenant_id = $1 AND id = $2 AND status = 'active'",
        [tenantId, linkId, gone, now, by]);
      ctx.log?.info?.({ event: 'backfill_link_suspended', reason: gone });
      return; // nothing of a merged / anonymised patient is projected
    }
    if (link['method'] === 'report_link') {
      const name = typeof demo?.fullName === 'string' ? demo.fullName.trim().slice(0, 200) : '';
      await tx.query('UPDATE engagement.account_patient_links SET display_name = $3, sex_snapshot = coalesce($4, sex_snapshot), version = version + 1, updated_at = $5, updated_by = $6 WHERE tenant_id = $1 AND id = $2',
        [tenantId, linkId, name || 'Patient', typeof demo?.sex === 'string' ? demo.sex : null, now, by]);
    }

    // 2. orders / specimens / balances from the published views
    const { rows: [settings] } = await tx.query('SELECT show_partner_orders FROM engagement.settings WHERE tenant_id = $1', [tenantId]) as { rows: Row[] };
    const showPartner = settings?.['show_partner_orders'] === true;
    const viewOrders: Row[] = [];
    for (let offset = 0; offset < MAX_ORDERS; offset += ORDER_PAGE) {
      const page = await views.orderPage(tx, { tenantId, patientId, limit: Math.min(ORDER_PAGE, MAX_ORDERS - offset), offset });
      viewOrders.push(...page);
      if (page.length < ORDER_PAGE) break;
    }
    const kept = viewOrders.filter((o) => showPartner || o['source'] !== 'partner_manifest');
    const orderIds = kept.map((o) => o['order_id'] as string);
    const timeline: Row[] = [], balances = new Map<string, Row>();
    for (const ids of batches(orderIds, BATCH)) {
      timeline.push(...await views.timelineOf(tx, { tenantId, orderIds: ids }));
      for (const b of await views.balancesOf(tx, { tenantId, orderIds: ids })) balances.set(b['order_id'], b);
    }
    // [CONV] visible_at: registered_at; a pre_registered order has none in the view -> the view's updated_at until the booking consumer sets the slot start (05-SCHEMA patient_orders.visible_at)
    const orders: OrderIn[] = kept.map((o) => {
      const b = balances.get(o['order_id']);
      return { orderId: o['order_id'], patientId, centreId: o['centre_id'], branchId: o['branch_id'], source: o['source'], orderStatus: o['status'], registeredAt: iso(o['registered_at']),
        visibleAt: (iso(o['registered_at']) ?? iso(o['updated_at']))!, balance: b ? { invoicedPaisa: Number(b['invoiced_paisa']), paidPaisa: Number(b['paid_paisa']), balanceDuePaisa: Number(b['balance_due_paisa']),
          balanceVersion: Number(b['balance_version']), releaseBasis: b['release_basis'] } : null };
    });
    const ordinal = new Map<string, number>();
    const specimens: SpecimenIn[] = timeline.map((s) => { // rows arrive ordered by (order_id, ordered_at, specimen_id): "Sample n"
      const n = (ordinal.get(s['order_id']) ?? 0) + 1; ordinal.set(s['order_id'], n);
      return { specimenId: s['specimen_id'], orderId: s['order_id'], patientId, specimenTypeCode: s['specimen_type_code'], status: s['status'], statusSeq: Number(s['specimen_version'] ?? 0), ordinal: n,
        collectedAt: iso(s['collected_at']), receivedAt: iso(s['received_at']), rejectedAt: iso(s['rejected_at']), rejectionReasonCode: s['rejection_reason_code'] ?? null,
        recollectionRequired: s['status'] === 'recollection_ordered', replacesSpecimenId: s['replaces_specimen_id'] ?? null };
    });
    const pctx = { tx, tenantId, actor: { id: by }, now: () => now };
    await projection.upsertOrders(pctx, orders);
    await projection.upsertSpecimens(pctx, specimens);

    // 3. reports from C6 (every version, superseded included)
    const reports: ReportIn[] = [];
    for (let cursor: string | undefined; ;) {
      const page = await ctx.ports.ReportingPort.getReleasedReports(ctx, { filter: { patientId, includeSuperseded: true }, limit: REPORT_PAGE, ...(cursor ? { cursor } : {}) });
      for (const r of page.items as Row[]) {
        if (r['patientId'] !== patientId) continue; // defence in depth: only the link's patient
        reports.push({ reportId: r['reportId'], versionNo: r['versionNo'], orderId: r['orderId'], patientId, kind: r['kind'], status: r['status'], releasedAt: iso(r['releasedAt'])!,
          panelNames: r['panelNames'] ?? [], smartSummaryAvailable: r['smartSummaryAvailable'] === true });
      }
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    await projection.upsertReports(pctx, reports);
    await projection.recomputeStages(pctx, orderIds);
    ctx.log?.info?.({ event: 'backfill_link_done', orders: orders.length, specimens: specimens.length, reports: reports.length });
  };
}
