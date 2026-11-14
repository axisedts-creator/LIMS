// Read-model upserts of D-PROJ (02-TRD §4.4): patient_orders, patient_order_specimens, patient_reports. ONE writer shared by the event consumers, the backfill_link task and reconcile (02-CV §7.4).
// Every statement binds tenant_id (REQ-SEC-024). Idempotent: plain INSERT .. ON CONFLICT (pk) DO UPDATE. The seq guards of 02-CV §7.4 (specimens: status_seq, orders: balance_version) are a
// `FOR UPDATE` pre-read + skip, so a row already ahead (an event applied after the view row was read) is never overwritten by older state and a concurrent consumer waits for the transaction.
// Callers pass the system actor's ctx (tx, tenantId, actor.id, now()). Rows hold P1 data: nothing here logs a value.
import { orderStage, type SpecimenStatus } from '../domain/stage.js';
import * as views from '../repository/views.repo.js';

type Row = Record<string, any>;
interface PCtx { readonly tx: any; readonly tenantId: string; readonly actor: { readonly id: string }; readonly now: () => string }

export interface OrderIn {
  orderId: string; patientId: string; centreId: string; branchId: string; source: string; orderStatus: string; registeredAt: string | null; visibleAt: string;
  balance: { invoicedPaisa: number; paidPaisa: number; balanceDuePaisa: number; balanceVersion: number; releaseBasis: string } | null;
}
export interface SpecimenIn {
  specimenId: string; orderId: string; patientId: string; specimenTypeCode: string; status: string; statusSeq: number; ordinal: number; collectedAt: string | null; receivedAt: string | null;
  rejectedAt: string | null; rejectionReasonCode: string | null; recollectionRequired: boolean; replacesSpecimenId: string | null;
}
export interface ReportIn { reportId: string; versionNo: number; orderId: string; patientId: string; kind: string; status: string; releasedAt: string; panelNames: readonly string[]; smartSummaryAvailable: boolean; supersedesVersionNo?: number | null }
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The write context of a consumer / task: its JobContext (system actor, tx, now()). */
export const projectionCtx = (c: any): PCtx => ({ tx: c.tx, tenantId: c.tenantId, actor: { id: c.actor.id }, now: () => c.now() });

const CHUNK = 100; // rows per statement (<= 2,000 bind parameters)
const num = (v: unknown): number | null => (v == null ? null : Number(v));
/** `($1, $2), ($3, $4)` for `n` rows of `w` columns. */
const tuples = (n: number, w: number): string => Array.from({ length: n }, (_, i) => `(${Array.from({ length: w }, (_, j) => `$${i * w + j + 1}`).join(', ')})`).join(', ');
const chunks = <T>(xs: readonly T[]): T[][] => { const out: T[][] = []; for (let i = 0; i < xs.length; i += CHUNK) out.push(xs.slice(i, i + CHUNK)); return out; };
const set = (cols: readonly string[]): string => cols.map((c) => `${c} = EXCLUDED.${c}`).join(', ');

export function createProjectionService() {
  return {
    /** T-L5 (TRD §4.4): the read model exists only for patients with an active / suspended link. System actor, tenant-scoped; children first (specimens / smart summaries), then their parents. */
    async deleteForPatients(ctx: Pick<PCtx, 'tx' | 'tenantId'>, patientIds: readonly string[]): Promise<void> {
      for (const ids of chunks(patientIds)) {
        for (const table of ['smart_summaries', 'patient_order_specimens', 'patient_reports', 'patient_orders']) {
          await ctx.tx.query(`DELETE FROM engagement.${table} WHERE tenant_id = $1 AND patient_id = ANY($2::uuid[])`, [ctx.tenantId, ids]);
        }
      }
    },

    /** Links of a patient that feed the read model (§4.4: active or suspended). No row = the consumer commits a no-op. */
    async liveLinks(ctx: Pick<PCtx, 'tx' | 'tenantId'>, patientId: string): Promise<Row[]> {
      const { rows } = await ctx.tx.query("SELECT id, account_id, status, visible_from FROM engagement.account_patient_links WHERE tenant_id = $1 AND patient_id = $2 AND status IN ('active', 'suspended')", [ctx.tenantId, patientId]);
      return rows;
    },

    async settingsOf(ctx: Pick<PCtx, 'tx' | 'tenantId'>): Promise<{ showPartnerOrders: boolean; smartReportInApp: boolean }> {
      const { rows: [s] } = await ctx.tx.query('SELECT show_partner_orders, smart_report_in_app FROM engagement.settings WHERE tenant_id = $1', [ctx.tenantId]);
      return { showPartnerOrders: s?.['show_partner_orders'] === true, smartReportInApp: s?.['smart_report_in_app'] === true };
    },

    /** The projected order (row locked), or - first sight - projected now from the published views (order + balance), tenant-filtered. null = filtered (partner order without show_partner_orders, or another patient's order).
     *  An order the view does not have yet THROWS (publication race): the queue retries, nothing is lost or half written. */
    async ensureOrder(ctx: PCtx, a: { orderId: string; patientId: string }): Promise<{ visibleAt: string } | null> {
      const { tx, tenantId } = ctx;
      const iso = (v: unknown) => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));
      const { rows: [cur] } = await tx.query('SELECT order_id, patient_id, visible_at FROM engagement.patient_orders WHERE tenant_id = $1 AND order_id = $2 FOR UPDATE', [tenantId, a.orderId]);
      if (cur) return cur['patient_id'] === a.patientId ? { visibleAt: iso(cur['visible_at'])! } : null;
      const o = await views.orderOf(tx, { tenantId, orderId: a.orderId });
      if (!o) throw new Error('order_not_in_published_view');
      if (o['patient_id'] !== a.patientId || (o['source'] === 'partner_manifest' && !(await this.settingsOf(ctx)).showPartnerOrders)) return null;
      const [b] = await views.balancesOf(tx, { tenantId, orderIds: [a.orderId] });
      const visibleAt = (iso(o['registered_at']) ?? iso(o['updated_at']))!;
      await this.upsertOrders(ctx, [{ orderId: a.orderId, patientId: a.patientId, centreId: o['centre_id'], branchId: o['branch_id'], source: o['source'], orderStatus: o['status'], registeredAt: iso(o['registered_at']), visibleAt,
        balance: b ? { invoicedPaisa: Number(b['invoiced_paisa']), paidPaisa: Number(b['paid_paisa']), balanceDuePaisa: Number(b['balance_due_paisa']), balanceVersion: Number(b['balance_version']), releaseBasis: b['release_basis'] } : null }]);
      return { visibleAt };
    },

    async specimensOfOrder(ctx: Pick<PCtx, 'tx' | 'tenantId'>, orderId: string): Promise<Row[]> {
      const { rows } = await ctx.tx.query('SELECT specimen_id, specimen_type_code, status, status_seq, ordinal, collected_at, received_at, rejected_at, rejection_reason_code, recollection_required, replaces_specimen_id FROM engagement.patient_order_specimens WHERE tenant_id = $1 AND order_id = $2 FOR UPDATE', [ctx.tenantId, orderId]);
      return rows;
    },

    async versionsOfReport(ctx: Pick<PCtx, 'tx' | 'tenantId'>, reportId: string): Promise<Row[]> {
      const { rows } = await ctx.tx.query('SELECT version_no, status FROM engagement.patient_reports WHERE tenant_id = $1 AND report_id = $2 FOR UPDATE', [ctx.tenantId, reportId]);
      return rows;
    },

    /** A newer version of a report supersedes every older `valid` one. */
    async supersedeBelow(ctx: PCtx, reportId: string, versionNo: number): Promise<void> {
      await ctx.tx.query("UPDATE engagement.patient_reports SET status = 'superseded', updated_at = now(), updated_by = $4 WHERE tenant_id = $1 AND report_id = $2 AND version_no < $3 AND status = 'valid'", [ctx.tenantId, reportId, versionNo, ctx.actor.id]);
    },

    /** billing.balance.changed (§4.4, 02-CV §7.4): only a projected order is touched; balance_version is the seq guard (lower or equal = ignored, status_version untouched). payment_due = balance_due > 0 AND release_basis = due_outstanding. */
    async applyBalance(ctx: PCtx, b: { orderId: string; invoicedPaisa: number; paidPaisa: number; balanceDuePaisa: number; balanceVersion: number; releaseBasis: string | null }): Promise<void> {
      const { tx, tenantId } = ctx;
      const { rows: [cur] } = await tx.query('SELECT order_id, balance_version, release_basis FROM engagement.patient_orders WHERE tenant_id = $1 AND order_id = $2 FOR UPDATE', [tenantId, b.orderId]);
      if (!cur || (cur['balance_version'] != null && Number(cur['balance_version']) >= b.balanceVersion)) return;
      const basis = b.releaseBasis ?? (cur['release_basis'] as string | null); // absent in event = keep stored (03-IC §3.5 optional)
      await tx.query(
        `UPDATE engagement.patient_orders SET invoiced_paisa = $3, paid_paisa = $4, balance_due_paisa = $5, balance_version = $6, release_basis = $7, payment_due = $8, status_version = status_version + 1, synced_at = $9, updated_at = now(), updated_by = $10
         WHERE tenant_id = $1 AND order_id = $2`,
        [tenantId, b.orderId, b.invoicedPaisa, b.paidPaisa, b.balanceDuePaisa, b.balanceVersion, basis, b.balanceDuePaisa > 0 && basis === 'due_outstanding', ctx.now(), ctx.actor.id]);
    },

    /** Orders by (tenant_id, order_id). Balance columns of a row already ahead (higher balance_version, or a balance the view does not have yet) are kept. `stage` is only set by `recomputeStages`. */
    async upsertOrders(ctx: PCtx, orders: readonly OrderIn[]): Promise<void> {
      if (orders.length === 0) return;
      const { tx, tenantId } = ctx; const now = ctx.now(); const by = ctx.actor.id;
      const have = new Map<string, Row>();
      for (const ids of chunks(orders.map((o) => o.orderId))) {
        const { rows } = await tx.query(
          'SELECT order_id, invoiced_paisa, paid_paisa, balance_due_paisa, balance_version, release_basis, payment_due FROM engagement.patient_orders WHERE tenant_id = $1 AND order_id = ANY($2::uuid[]) FOR UPDATE', [tenantId, ids]);
        for (const r of rows) have.set(r['order_id'], r);
      }
      for (const part of chunks(orders)) {
        const values: unknown[] = [];
        for (const o of part) {
          const cur = have.get(o.orderId);
          const ahead = cur && cur['balance_version'] != null && (o.balance === null || Number(cur['balance_version']) > o.balance.balanceVersion);
          const b = ahead ? { inv: num(cur['invoiced_paisa']), paid: num(cur['paid_paisa']), due: num(cur['balance_due_paisa']), ver: num(cur['balance_version']), basis: cur['release_basis'] as string | null }
            : { inv: o.balance?.invoicedPaisa ?? null, paid: o.balance?.paidPaisa ?? null, due: o.balance?.balanceDuePaisa ?? null, ver: o.balance?.balanceVersion ?? null, basis: o.balance?.releaseBasis ?? null };
          values.push(tenantId, o.orderId, o.patientId, o.centreId, o.branchId, o.source, o.orderStatus, o.registeredAt, o.visibleAt, 'registered', (b.due ?? 0) > 0 && b.basis === 'due_outstanding',
            b.inv, b.paid, b.due, b.ver, b.basis, now, by, by);
        }
        await tx.query(
          `INSERT INTO engagement.patient_orders (tenant_id, order_id, patient_id, centre_id, branch_id, source, order_status, registered_at, visible_at, stage, payment_due,
             invoiced_paisa, paid_paisa, balance_due_paisa, balance_version, release_basis, synced_at, created_by, updated_by)
           VALUES ${tuples(part.length, 19)}
           ON CONFLICT (tenant_id, order_id) DO UPDATE SET ${set(['patient_id', 'centre_id', 'branch_id', 'source', 'order_status', 'registered_at', 'visible_at', 'payment_due', 'invoiced_paisa', 'paid_paisa',
             'balance_due_paisa', 'balance_version', 'release_basis', 'synced_at', 'updated_by'])}, status_version = patient_orders.status_version + 1, updated_at = now()`, values);
      }
    },

    /** Specimens by (tenant_id, specimen_id); the order rows must exist (FK). A row whose status_seq is already higher is skipped (02-CV §7.4). Returns the number written. */
    async upsertSpecimens(ctx: PCtx, specimens: readonly SpecimenIn[]): Promise<number> {
      if (specimens.length === 0) return 0;
      const { tx, tenantId } = ctx; const by = ctx.actor.id;
      const have = new Map<string, number>();
      for (const ids of chunks([...new Set(specimens.map((s) => s.orderId))])) {
        const { rows } = await tx.query('SELECT specimen_id, specimen_type_code, status_seq FROM engagement.patient_order_specimens WHERE tenant_id = $1 AND order_id = ANY($2::uuid[]) FOR UPDATE', [tenantId, ids]);
        for (const r of rows) have.set(r['specimen_id'], Number(r['status_seq']));
      }
      const todo = specimens.filter((s) => !((have.get(s.specimenId) ?? -1) > s.statusSeq));
      for (const part of chunks(todo)) {
        const values: unknown[] = [];
        for (const s of part) values.push(tenantId, s.specimenId, s.orderId, s.patientId, s.specimenTypeCode, s.status, s.statusSeq, s.ordinal, s.collectedAt, s.receivedAt, s.rejectedAt, s.rejectionReasonCode,
          s.recollectionRequired, s.replacesSpecimenId, by, by);
        await tx.query(
          `INSERT INTO engagement.patient_order_specimens (tenant_id, specimen_id, order_id, patient_id, specimen_type_code, status, status_seq, ordinal, collected_at, received_at, rejected_at,
             rejection_reason_code, recollection_required, replaces_specimen_id, created_by, updated_by)
           VALUES ${tuples(part.length, 16)}
           ON CONFLICT (tenant_id, specimen_id) DO UPDATE SET ${set(['order_id', 'patient_id', 'specimen_type_code', 'status', 'status_seq', 'ordinal', 'collected_at', 'received_at', 'rejected_at',
             'rejection_reason_code', 'recollection_required', 'replaces_specimen_id', 'updated_by'])}, updated_at = now()`, values);
      }
      return todo.length;
    },

    /** Report versions by (tenant_id, report_id, version_no). */
    async upsertReports(ctx: PCtx, reports: readonly ReportIn[]): Promise<void> {
      const { tx, tenantId } = ctx; const by = ctx.actor.id;
      for (const part of chunks(reports)) {
        const values: unknown[] = [];
        for (const r of part) values.push(tenantId, r.reportId, r.versionNo, r.orderId, r.patientId, r.kind.slice(0, 32), r.status, r.releasedAt, r.panelNames.slice(0, 20), r.smartSummaryAvailable, r.supersedesVersionNo ?? null, by, by);
        await tx.query(
          `INSERT INTO engagement.patient_reports (tenant_id, report_id, version_no, order_id, patient_id, report_kind, status, released_at, panel_names, smart_summary_available, supersedes_version_no, created_by, updated_by)
           VALUES ${tuples(part.length, 13)}
           ON CONFLICT (tenant_id, report_id, version_no) DO UPDATE SET ${set(['order_id', 'patient_id', 'report_kind', 'status', 'released_at', 'panel_names', 'smart_summary_available', 'updated_by'])}, supersedes_version_no = coalesce(EXCLUDED.supersedes_version_no, supersedes_version_no), updated_at = now()`, values);
      }
    },

    /** Order stage (02-TRD §4.5) from the projected specimens + reports; one UPDATE per resulting stage, only for rows that change (status_version bumps = the ETag). */
    async recomputeStages(ctx: PCtx, orderIds: readonly string[]): Promise<void> {
      const { tx, tenantId } = ctx; const by = ctx.actor.id;
      for (const ids of chunks(orderIds)) {
        const [orders, specs, reps] = await Promise.all([
          tx.query('SELECT order_id, order_status, stage FROM engagement.patient_orders WHERE tenant_id = $1 AND order_id = ANY($2::uuid[])', [tenantId, ids]),
          tx.query('SELECT order_id, specimen_type_code, status, recollection_required FROM engagement.patient_order_specimens WHERE tenant_id = $1 AND order_id = ANY($2::uuid[])', [tenantId, ids]),
          tx.query('SELECT order_id, report_kind, status FROM engagement.patient_reports WHERE tenant_id = $1 AND order_id = ANY($2::uuid[])', [tenantId, ids]),
        ]);
        const sOf = new Map<string, Row[]>(), rOf = new Map<string, Row[]>();
        for (const s of specs.rows as Row[]) (sOf.get(s['order_id']) ?? sOf.set(s['order_id'], []).get(s['order_id'])!).push(s);
        for (const r of reps.rows as Row[]) (rOf.get(r['order_id']) ?? rOf.set(r['order_id'], []).get(r['order_id'])!).push(r);
        const byStage = new Map<string, string[]>();
        for (const o of orders.rows as Row[]) {
          const stage = orderStage({ orderStatus: o['order_status'], specimens: (sOf.get(o['order_id']) ?? []).map((s) => ({ status: s['status'] as SpecimenStatus, recollectionRequired: s['recollection_required'] === true })),
            reports: (rOf.get(o['order_id']) ?? []).map((r) => ({ kind: r['report_kind'], status: r['status'] })) });
          if (stage !== o['stage']) (byStage.get(stage) ?? byStage.set(stage, []).get(stage)!).push(o['order_id']);
        }
        for (const [stage, list] of byStage) {
          await tx.query('UPDATE engagement.patient_orders SET stage = $3, status_version = status_version + 1, updated_at = now(), updated_by = $4 WHERE tenant_id = $1 AND order_id = ANY($2::uuid[])', [tenantId, list, stage, by]);
        }
      }
    },
  };
}
export type ProjectionService = ReturnType<typeof createProjectionService>;
