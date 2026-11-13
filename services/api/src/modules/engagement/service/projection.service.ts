// Read-model upserts of D-PROJ (02-TRD §4.4): patient_orders, patient_order_specimens, patient_reports. ONE writer shared by the event consumers, the backfill_link task and reconcile (02-CV §7.4).
// Every statement binds tenant_id (REQ-SEC-024). Idempotent: plain INSERT .. ON CONFLICT (pk) DO UPDATE. The seq guards of 02-CV §7.4 (specimens: status_seq, orders: balance_version) are a
// `FOR UPDATE` pre-read + skip, so a row already ahead (an event applied after the view row was read) is never overwritten by older state and a concurrent consumer waits for the transaction.
// Callers pass the system actor's ctx (tx, tenantId, actor.id, now()). Rows hold P1 data: nothing here logs a value.
import { orderStage, type SpecimenStatus } from '../domain/stage.js';

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
export interface ReportIn { reportId: string; versionNo: number; orderId: string; patientId: string; kind: string; status: string; releasedAt: string; panelNames: readonly string[]; smartSummaryAvailable: boolean }

const CHUNK = 100; // rows per statement (<= 2,000 bind parameters)
const num = (v: unknown): number | null => (v == null ? null : Number(v));
/** `($1, $2), ($3, $4)` for `n` rows of `w` columns. */
const tuples = (n: number, w: number): string => Array.from({ length: n }, (_, i) => `(${Array.from({ length: w }, (_, j) => `$${i * w + j + 1}`).join(', ')})`).join(', ');
const chunks = <T>(xs: readonly T[]): T[][] => { const out: T[][] = []; for (let i = 0; i < xs.length; i += CHUNK) out.push(xs.slice(i, i + CHUNK)); return out; };
const set = (cols: readonly string[]): string => cols.map((c) => `${c} = EXCLUDED.${c}`).join(', ');

export function createProjectionService() {
  return {
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
        const { rows } = await tx.query('SELECT specimen_id, status_seq FROM engagement.patient_order_specimens WHERE tenant_id = $1 AND order_id = ANY($2::uuid[]) FOR UPDATE', [tenantId, ids]);
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
        for (const r of part) values.push(tenantId, r.reportId, r.versionNo, r.orderId, r.patientId, r.kind.slice(0, 32), r.status, r.releasedAt, r.panelNames.slice(0, 20), r.smartSummaryAvailable, by, by);
        await tx.query(
          `INSERT INTO engagement.patient_reports (tenant_id, report_id, version_no, order_id, patient_id, report_kind, status, released_at, panel_names, smart_summary_available, created_by, updated_by)
           VALUES ${tuples(part.length, 12)}
           ON CONFLICT (tenant_id, report_id, version_no) DO UPDATE SET ${set(['order_id', 'patient_id', 'report_kind', 'status', 'released_at', 'panel_names', 'smart_summary_available', 'updated_by'])}, updated_at = now()`, values);
      }
    },

    /** Order stage (02-TRD §4.5) from the projected specimens + reports; one UPDATE per resulting stage, only for rows that change (status_version bumps = the ETag). */
    async recomputeStages(ctx: PCtx, orderIds: readonly string[]): Promise<void> {
      const { tx, tenantId } = ctx; const by = ctx.actor.id;
      for (const ids of chunks(orderIds)) {
        const [orders, specs, reps] = await Promise.all([
          tx.query('SELECT order_id, order_status, stage FROM engagement.patient_orders WHERE tenant_id = $1 AND order_id = ANY($2::uuid[])', [tenantId, ids]),
          tx.query('SELECT order_id, status, recollection_required FROM engagement.patient_order_specimens WHERE tenant_id = $1 AND order_id = ANY($2::uuid[])', [tenantId, ids]),
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
