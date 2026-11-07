// Report shell + items + narrative drafts and the consumer-side report state (02-TRD §4.1, §4.2, §8.2; PRD AC-01.1..AC-01.5).
// Called by the reporting worker consumers inside the consumer transaction (ctx.tx). REQ-SEC-024: every statement binds tenant_id.
// Single-table statements with $n parameters; replays are safe (ON CONFLICT DO NOTHING / guarded UPDATEs).
// [CONV] relative import until @lims/shared-ts is a services/api dependency (lockfile is C0-0A's, LD-05).
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { LimsError } from '../../../core/errors.js';
import { requirementsFor } from '../domain/readiness.js';
import type { Tx } from '../repository/settings.repo.js';

export interface ReportsCtx {
  readonly tx: Tx;
  readonly tenantId: string | undefined;
  readonly actor: { readonly id: string };
  readonly core: any;    // core-repo: centre(ctx, { centreId }) -> { centreCode }
  readonly ports: {
    frontdesk: { getOrderSummary(ctx: unknown, input: { orderId: string }): Promise<any> };
    catalog: { getTest(ctx: unknown, input: { testId: string }): Promise<{ workflowType: string }> };
  };
}

interface OrderSnap {
  orderId: string; patientId: string; centreId: string; branchId: string; referrerId: string | null; partnerId: string | null;
  source: string; registeredAt: string; registrationNo: string; centreCode: string;
}
interface ItemIn {
  orderItemId: string; orderableId: string; orderableKind: string; testIds: string[]; priority: string; outsourced: boolean;
  status: 'active' | 'removed' | 'cancelled';
}

/** The job tenant is the only tenant used; an envelope naming another tenant is refused (REQ-SEC-024). */
export function tenantFor(event: any, ctx: { tenantId: string | undefined }): string {
  const t = ctx.tenantId;
  if (!t || (event?.tenant_id !== undefined && event.tenant_id !== t)) throw new LimsError('common.internal', 'event tenant does not match the job tenant');
  return t;
}

const evItem = (i: any): ItemIn => ({ orderItemId: i.order_item_id, orderableId: i.orderable_id, orderableKind: i.orderable_kind, testIds: [...i.test_ids],
  priority: i.priority, outsourced: i.outsourced === true, status: 'active' });
const summaryItem = (i: any): ItemIn => ({ orderItemId: i.orderItemId, orderableId: i.orderableId, orderableKind: i.orderableKind, testIds: [...i.testIds],
  priority: i.priority, outsourced: i.outsourced === true, status: i.status === 'removed' || i.status === 'cancelled' ? i.status : 'active' });

async function centreCode(ctx: ReportsCtx, centreId: string): Promise<string> {
  return (await ctx.core.centre(ctx, { centreId })).centreCode;
}

async function narrativeMode(tx: Tx, tenantId: string): Promise<string> {
  const { rows } = await tx.query('SELECT narrative_report_mode FROM reporting.settings WHERE tenant_id = $1', [tenantId]);
  return rows[0]?.narrative_report_mode ?? 'separate';
}

async function reportId(ctx: ReportsCtx, tenantId: string, s: OrderSnap, family: string): Promise<string> {
  const ins = await ctx.tx.query(`INSERT INTO reporting.reports (id, tenant_id, centre_id, branch_id, order_id, patient_id, referrer_id, partner_id,
      family, order_source, registered_at, registration_no, centre_code, created_by, updated_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $14)
    ON CONFLICT (tenant_id, order_id, family) DO NOTHING RETURNING id`,
  [uuidv7(), tenantId, s.centreId, s.branchId, s.orderId, s.patientId, s.referrerId, s.partnerId, family, s.source, s.registeredAt, s.registrationNo,
    s.centreCode, ctx.actor.id]);
  if (ins.rows[0]) return ins.rows[0].id;
  const { rows } = await ctx.tx.query('SELECT id FROM reporting.reports WHERE tenant_id = $1 AND order_id = $2 AND family = $3', [tenantId, s.orderId, family]);
  return rows[0].id;
}

async function narrativeDraft(ctx: ReportsCtx, tenantId: string, s: OrderSnap, report: string, item: string, testId: string): Promise<void> {
  const tpl = (await ctx.tx.query(`SELECT id, kind, sections FROM reporting.narrative_templates
    WHERE tenant_id = $1 AND test_id = $2 AND is_active = true ORDER BY code LIMIT 1`, [tenantId, testId])).rows[0];
  const ins = await ctx.tx.query(`INSERT INTO reporting.narrative_reports (id, tenant_id, centre_id, report_id, order_id, order_item_id, test_id, template_kind,
      created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
    ON CONFLICT (tenant_id, order_item_id, test_id) DO NOTHING RETURNING id`,
  [uuidv7(), tenantId, s.centreId, report, s.orderId, item, testId, tpl?.kind ?? 'other', ctx.actor.id]);   // [CONV] no template -> kind other, empty sections
  const nid = ins.rows[0]?.id;
  if (!nid) return;                                                         // exists already (replay)
  // [CONV] sections are bound as the parsed jsonb value; the pg adapter must JSON-encode array parameters bound to ::jsonb.
  await ctx.tx.query(`INSERT INTO reporting.narrative_versions (id, tenant_id, centre_id, narrative_report_id, version_no, template_id, sections,
      created_by, updated_by) VALUES ($1, $2, $3, $4, 1, $5, $6::jsonb, $7, $7)
    ON CONFLICT (tenant_id, narrative_report_id, version_no) DO NOTHING`,
  [uuidv7(), tenantId, s.centreId, nid, tpl?.id ?? null, tpl?.sections ?? [], ctx.actor.id]);
}

/** Reports (family by §4.1 + narrative_report_mode), report_order_items and narrative drafts for `items`. Returns the reports that got new items. */
async function upsertItems(ctx: ReportsCtx, tenantId: string, s: OrderSnap, items: readonly ItemIn[], itemsVersion: number | null): Promise<Set<string>> {
  const testIds = [...new Set(items.flatMap((i) => i.testIds))];
  const wf = new Map(await Promise.all(testIds.map(async (t) => [t, (await ctx.ports.catalog.getTest(ctx, { testId: t })).workflowType] as const)));
  const mode = await narrativeMode(ctx.tx, tenantId);
  const touched = new Set<string>();
  const reports = new Map<string, string>();
  for (const i of items) {
    const req = requirementsFor({ workflowTypes: i.testIds.map((t) => wf.get(t)!), outsourced: i.outsourced });
    if (!req.requiresLab && !req.requiresNarrative && !req.requiresOutsourced) req.requiresLab = true;   // [CONV] unknown workflowType -> lab
    const narrativeTests = req.requiresNarrative ? i.testIds.filter((t) => wf.get(t) === 'narrative') : [];
    const family = mode !== 'combined' && req.requiresNarrative && !req.requiresLab ? 'narrative' : 'laboratory';
    if (!reports.has(family)) reports.set(family, await reportId(ctx, tenantId, s, family));
    const report = reports.get(family)!;
    const ins = await ctx.tx.query(`INSERT INTO reporting.report_order_items (id, tenant_id, centre_id, report_id, order_id, order_item_id, orderable_id,
        orderable_kind, test_ids, narrative_test_ids, priority, item_status, requires_lab, requires_narrative, requires_outsourced, items_version,
        created_by, updated_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::uuid[], $10::uuid[], $11, $12, $13, $14, $15, $16, $17, $17)
      ON CONFLICT (tenant_id, order_item_id, report_id) DO NOTHING RETURNING report_id`,
    [uuidv7(), tenantId, s.centreId, report, s.orderId, i.orderItemId, i.orderableId, i.orderableKind, i.testIds, narrativeTests, i.priority, i.status,
      req.requiresLab, req.requiresNarrative, req.requiresOutsourced, itemsVersion, ctx.actor.id]);
    if (ins.rows[0]) touched.add(report);
    if (i.status === 'active') for (const t of narrativeTests) await narrativeDraft(ctx, tenantId, s, report, i.orderItemId, t);
  }
  return touched;
}

/** Shell from FrontdeskPort.getOrderSummary (ready-before-created, items_changed for an unknown order). Rejects if C4 has no such order. */
async function shellFromSummary(ctx: ReportsCtx, tenantId: string, orderId: string): Promise<void> {
  const o = await ctx.ports.frontdesk.getOrderSummary(ctx, { orderId });
  const s: OrderSnap = { orderId, patientId: o.patientId, centreId: o.centreId, branchId: o.branchId, referrerId: o.referrerId ?? null,
    partnerId: o.partnerId ?? null, source: o.source, registeredAt: o.registeredAt, registrationNo: o.registrationNo, centreCode: await centreCode(ctx, o.centreId) };
  await upsertItems(ctx, tenantId, s, o.items.map(summaryItem), null);
}

// ------------------------------------------------------------------------------------------------ frontdesk events

export async function createFromOrderCreated(ctx: ReportsCtx, tenantId: string, p: any): Promise<void> {
  const o = await ctx.ports.frontdesk.getOrderSummary(ctx, { orderId: p.order_id });   // registration_no + partner_id (08 R25)
  const s: OrderSnap = { orderId: p.order_id, patientId: p.patient_id, centreId: p.centre_id, branchId: p.branch_id, referrerId: p.referrer_id ?? null,
    partnerId: o.partnerId ?? null, source: p.source, registeredAt: p.registered_at, registrationNo: o.registrationNo, centreCode: await centreCode(ctx, p.centre_id) };
  await upsertItems(ctx, tenantId, s, p.items.map(evItem), null);
}

const SNAP_SQL = `SELECT id, centre_id, branch_id, order_id, patient_id, referrer_id, partner_id, order_source, registered_at, registration_no, centre_code
  FROM reporting.reports WHERE tenant_id = $1 AND order_id = $2`;

export async function applyItemsChanged(ctx: ReportsCtx, tenantId: string, p: any): Promise<void> {
  const v: number = p.items_version;
  let reports = (await ctx.tx.query(SNAP_SQL, [tenantId, p.order_id])).rows;
  if (reports.length === 0) {
    await shellFromSummary(ctx, tenantId, p.order_id);
    reports = (await ctx.tx.query(SNAP_SQL, [tenantId, p.order_id])).rows;
  }
  const items = (await ctx.tx.query('SELECT items_version FROM reporting.report_order_items WHERE tenant_id = $1 AND order_id = $2', [tenantId, p.order_id])).rows;
  if (items.some((r) => r.items_version !== null && r.items_version !== undefined && r.items_version >= v)) return;   // stale
  const touched = new Set<string>();
  if (p.added.length > 0 && reports[0]) {
    const r = reports[0];
    const s: OrderSnap = { orderId: p.order_id, patientId: r.patient_id, centreId: r.centre_id, branchId: r.branch_id, referrerId: r.referrer_id ?? null,
      partnerId: r.partner_id ?? null, source: r.order_source, registeredAt: r.registered_at, registrationNo: r.registration_no, centreCode: r.centre_code };
    for (const id of await upsertItems(ctx, tenantId, s, p.added.map(evItem), v)) touched.add(id);
  }
  const removedIds: string[] = p.removed.map((r: any) => r.order_item_id);
  if (removedIds.length > 0) {
    const rm = await ctx.tx.query(`UPDATE reporting.report_order_items SET item_status = 'removed', version = version + 1, updated_by = $3, updated_at = now()
      WHERE tenant_id = $1 AND order_id = $2 AND order_item_id = ANY($4::uuid[]) AND item_status = 'active' RETURNING report_id`,
    [tenantId, p.order_id, ctx.actor.id, removedIds]);
    for (const r of rm.rows) touched.add(r.report_id);
    const nar = await ctx.tx.query(`UPDATE reporting.narrative_reports SET status = 'cancelled', version = version + 1, updated_by = $2, updated_at = now()
      WHERE tenant_id = $1 AND order_item_id = ANY($3::uuid[]) AND status = 'draft' RETURNING id`, [tenantId, ctx.actor.id, removedIds]);
    if (nar.rows.length > 0) {
      await ctx.tx.query(`UPDATE reporting.narrative_versions SET status = 'cancelled', version = version + 1, updated_by = $2, updated_at = now()
        WHERE tenant_id = $1 AND narrative_report_id = ANY($3::uuid[]) AND status = 'draft'`, [tenantId, ctx.actor.id, nar.rows.map((r) => r.id)]);
    }
  }
  await ctx.tx.query(`UPDATE reporting.report_order_items SET items_version = $3, version = version + 1, updated_by = $4, updated_at = now()
    WHERE tenant_id = $1 AND order_id = $2 AND (items_version IS NULL OR items_version < $3)`, [tenantId, p.order_id, v, ctx.actor.id]);
  if (touched.size > 0) {
    await ctx.tx.query(`UPDATE reporting.reports SET needs_assembly = true, needs_assembly_since = COALESCE(needs_assembly_since, now()),
        version = version + 1, updated_by = $2, updated_at = now()
      WHERE tenant_id = $1 AND id = ANY($3::uuid[])`, [tenantId, ctx.actor.id, [...touched]]);
  }
}

export async function cancelOrder(ctx: ReportsCtx, tenantId: string, orderId: string): Promise<void> {
  const ids = (await ctx.tx.query('SELECT id FROM reporting.reports WHERE tenant_id = $1 AND order_id = $2', [tenantId, orderId])).rows.map((r) => r.id);
  if (ids.length === 0) return;
  await ctx.tx.query(`UPDATE reporting.reports SET state = 'cancelled', cancelled_at = now(), version = version + 1, updated_by = $3, updated_at = now()
    WHERE tenant_id = $1 AND order_id = $2 AND state = 'open'`, [tenantId, orderId, ctx.actor.id]);
  await ctx.tx.query(`UPDATE reporting.report_versions SET status = 'discarded', discard_reason = 'order_cancelled', discarded_at = now(),
      version = version + 1, updated_by = $2, updated_at = now()
    WHERE tenant_id = $1 AND report_id = ANY($3::uuid[]) AND status IN ('rendering', 'rendered', 'render_failed')`, [tenantId, ctx.actor.id, ids]);
  await ctx.tx.query(`UPDATE reporting.reports SET review_flag = 'released_order_cancelled', version = version + 1, updated_by = $3, updated_at = now()
    WHERE tenant_id = $1 AND order_id = $2 AND released_version_no IS NOT NULL AND review_flag IS NULL`, [tenantId, orderId, ctx.actor.id]);
}

// ------------------------------------------------------------------------------------------------ lab events

const HINTS = new Set(['rejected', 'recollection_ordered']);

/** Latest specimen status per item by aggregate.seq; a non-problem status clears the hint.
 *  ponytail: one seq per item, so two specimens of one item compare seqs of different aggregates; key by specimen if that matters. */
export async function setSpecimenHint(ctx: ReportsCtx, tenantId: string, itemIds: readonly string[], toStatus: string, seq: number): Promise<void> {
  if (itemIds.length === 0) return;
  await ctx.tx.query(`UPDATE reporting.report_order_items SET specimen_hint = $3, specimen_hint_seq = $4, version = version + 1, updated_by = $5, updated_at = now()
    WHERE tenant_id = $1 AND order_item_id = ANY($2::uuid[]) AND (specimen_hint_seq IS NULL OR specimen_hint_seq < $4)`,
  [tenantId, itemIds, HINTS.has(toStatus) ? toStatus : null, seq, ctx.actor.id]);
}

export async function countApprovedResult(ctx: ReportsCtx, tenantId: string, itemId: string): Promise<void> {
  await ctx.tx.query(`UPDATE reporting.report_order_items SET approved_results = approved_results + 1, version = version + 1, updated_by = $3, updated_at = now()
    WHERE tenant_id = $1 AND order_item_id = $2`, [tenantId, itemId, ctx.actor.id]);
}

export async function markAmendmentPending(ctx: ReportsCtx, tenantId: string, itemId: string): Promise<void> {
  await ctx.tx.query(`UPDATE reporting.report_order_items SET amendment_pending = true, version = version + 1, updated_by = $3, updated_at = now()
    WHERE tenant_id = $1 AND order_item_id = $2 AND amendment_pending = false`, [tenantId, itemId, ctx.actor.id]);
}

/** §4.2 lab readiness on the laboratory report (only when seq > stored). Returns the report id to assemble, or undefined (stale / no lab report). */
export async function recordLabReadiness(ctx: ReportsCtx & { isNewer(last: number | undefined, seq: number): boolean }, tenantId: string, p: any, seq: number): Promise<string | undefined> {
  const find = async () => (await ctx.tx.query(`SELECT id, lab_ready_seq FROM reporting.reports WHERE tenant_id = $1 AND order_id = $2 AND family = 'laboratory'`,
    [tenantId, p.order_id])).rows[0];
  let lab = await find();
  if (!lab) { await shellFromSummary(ctx, tenantId, p.order_id); lab = await find(); }    // AC-01.5 ready before created
  if (!lab || !ctx.isNewer(lab.lab_ready_seq ?? undefined, seq)) return undefined;
  const upd = await ctx.tx.query(`UPDATE reporting.reports SET lab_ready_seq = $3, lab_approved_set_hash = $4, lab_completeness = $5, lab_contains_amendment = $6,
      needs_assembly = true, needs_assembly_since = COALESCE(needs_assembly_since, now()), version = version + 1, updated_by = $7, updated_at = now()
    WHERE tenant_id = $1 AND id = $2 AND (lab_ready_seq IS NULL OR lab_ready_seq < $3) RETURNING id`,
  [tenantId, lab.id, seq, p.approved_set_hash, p.completeness, p.contains_amendment, ctx.actor.id]);
  if (!upd.rows[0]) return undefined;
  const ready = new Set<string>(p.order_item_ids);
  const items = (await ctx.tx.query('SELECT order_item_id, lab_ready FROM reporting.report_order_items WHERE tenant_id = $1 AND report_id = $2',
    [tenantId, lab.id])).rows;
  const lost = items.filter((r) => r.lab_ready && !ready.has(r.order_item_id)).map((r) => r.order_item_id);
  await ctx.tx.query(`UPDATE reporting.report_order_items SET lab_ready = true, amendment_pending = false, version = version + 1, updated_by = $3, updated_at = now()
    WHERE tenant_id = $1 AND report_id = $2 AND order_item_id = ANY($4::uuid[])`, [tenantId, lab.id, ctx.actor.id, [...ready]]);
  if (lost.length > 0) {
    await ctx.tx.query(`UPDATE reporting.report_order_items SET lab_ready = false, version = version + 1, updated_by = $3, updated_at = now()
      WHERE tenant_id = $1 AND report_id = $2 AND order_item_id = ANY($4::uuid[])`, [tenantId, lab.id, ctx.actor.id, lost]);
  }
  return lab.id;
}
