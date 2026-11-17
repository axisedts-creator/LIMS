// Pending tests (live) + report backlog (snapshot) — 02-TRD §5 #11/#12, §6.7; PRD US-10.1–10.5; 08 A13 D-13, A17 D-49; 07-SECURITY P1, P4.
// Live reads run in the caller's tx (ctx.tx): centre scope = C5 RLS only. A centre predicate is sent ONLY for an explicit centre_id / branch_id filter
// (already resolved against the caller's scope). The backlog snapshot follows the SCOPE like every rollup.
import { LimsError } from '../../../core/errors.js';
import type { Scope } from '../domain/scope.js';
import * as rollups from '../repository/rollups.repo.js';
import * as sourceViews from '../repository/sourceViews.repo.js';
import { MAX_FILTER_IDS } from './context.service.js';
import { branchLabels, centreLabels, departmentLabels, testLabels } from './labels.service.js';
import { MAX_DEPARTMENT_IDS, checkGroupBy, checkInt, checkUuidList, invalidField, type ReportsContext } from './reports.service.js';

export const ITEM_STATUSES = ['awaiting_collection', 'awaiting_receipt', 'in_process', 'resulted', 'verified'] as const;
export const AGE_BUCKETS = ['lt_4h', 'h4_24', 'd1_3', 'gt_3d'] as const;
export const PRIORITIES = ['routine', 'urgent'] as const;
export const PENDING_SORT = ['-age_seconds', 'age_seconds'] as const;
export type PendingSort = (typeof PENDING_SORT)[number];
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const shortId = (id: string): string => id.slice(-8);

export interface PendingFilters {
  centreIds: string[]; branchIds: string[]; departmentIds: string[]; processingBranchIds: string[]; priority?: 'routine' | 'urgent';
}
/** Pure validation of the shared filters (closed lists, size limits, uuid shape) — runs before any lookup or read. */
export function pendingFilters(q: Record<string, any>): PendingFilters {
  const centreIds = checkUuidList(q.centre_id, 'centre_id', MAX_FILTER_IDS);
  const branchIds = checkUuidList(q.branch_id, 'branch_id', MAX_FILTER_IDS);
  const departmentIds = [...new Set(checkUuidList(q.department_id, 'department_id', MAX_DEPARTMENT_IDS))];
  const processingBranchIds = [...new Set(checkUuidList(q.processing_branch_id, 'processing_branch_id', MAX_FILTER_IDS))];
  if (q.priority !== undefined && !(PRIORITIES as readonly unknown[]).includes(q.priority)) throw invalidField('priority');
  return { centreIds, branchIds, departmentIds, processingBranchIds, ...(q.priority === undefined ? {} : { priority: q.priority as 'routine' | 'urgent' }) };
}

export interface ItemsQuery { itemStatuses: string[]; overdueOnly: boolean; sort: PendingSort; limit: number; after?: { age_seconds: number; order_item_id: string } }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const encodeCursor = (r: { age_seconds: number; order_item_id: string }): string =>
  Buffer.from(JSON.stringify({ a: r.age_seconds, i: r.order_item_id })).toString('base64url');
export function decodeCursor(c: unknown): { age_seconds: number; order_item_id: string } {
  const invalid = () => new LimsError('common.invalid_cursor'); // nothing of the input is echoed
  if (typeof c !== 'string' || c.length === 0 || c.length > 512 || !/^[A-Za-z0-9_-]+$/.test(c)) throw invalid();
  try {
    const o = JSON.parse(Buffer.from(c, 'base64url').toString('utf8')) as { a?: unknown; i?: unknown } | null;
    if (!o || typeof o !== 'object' || !Number.isSafeInteger(o.a) || (o.a as number) < 0 || typeof o.i !== 'string' || !UUID.test(o.i)) throw invalid();
    return { age_seconds: o.a as number, order_item_id: o.i };
  } catch { throw invalid(); }
}

export function itemsQuery(q: Record<string, any>): ItemsQuery {
  const sort = checkGroupBy(PENDING_SORT, q.sort, '-age_seconds', 'sort');
  const st = q.item_status === undefined ? [] : q.item_status;
  if (!Array.isArray(st) || st.length > ITEM_STATUSES.length || st.some((s) => !(ITEM_STATUSES as readonly unknown[]).includes(s))) throw invalidField('item_status');
  const o = q.overdue_only;
  if (o !== undefined && o !== true && o !== false && o !== 'true' && o !== 'false') throw invalidField('overdue_only');
  const limit = checkInt(q.limit, 'limit', 1, MAX_LIMIT, DEFAULT_LIMIT);
  const after = q.cursor === undefined ? undefined : decodeCursor(q.cursor);
  return { itemStatuses: [...new Set(st as string[])], overdueOnly: o === true || o === 'true', sort, limit, ...(after ? { after } : {}) };
}

/** Explicit filter ids must exist in the caller's tenant: one shape (404), id never echoed (07 P1). */
async function checkKnown(ctx: ReportsContext, f: PendingFilters): Promise<Map<string, { name: string; isActive: boolean }>> {
  const depts = f.departmentIds.length ? await departmentLabels(ctx) : new Map<string, { name: string; isActive: boolean }>();
  if (f.departmentIds.some((id) => !depts.has(id))) throw new LimsError('common.not_found');
  if (f.processingBranchIds.length) {
    const known = await branchLabels(ctx);
    if (f.processingBranchIds.some((id) => !known.has(id))) throw new LimsError('common.not_found');
  }
  return depts;
}
/** D-49: undefined = no centre predicate (C5 RLS only). An explicit centre/branch filter sends the resolved list ([] = match nothing). */
const centrePredicate = (f: PendingFilters, scope: Scope): string[] | undefined => (f.centreIds.length || f.branchIds.length ? [...scope.centreIds] : undefined);
const liveArgs = (ctx: ReportsContext, f: PendingFilters, scope: Scope) => ({
  tenantId: ctx.tenantId, centreIds: centrePredicate(f, scope), departmentIds: f.departmentIds, priority: f.priority, processingBranchIds: f.processingBranchIds,
});

const total = (xs: readonly number[]): number => {
  const t = xs.reduce((a, b) => a + b, 0);
  if (!Number.isSafeInteger(t)) throw new RangeError('pending: total is not a safe integer'); // refused, never rounded
  return t;
};

export interface PendingSummaryOut {
  total: number; overdue: number; no_target: number;
  by_status: { item_status: string; count: number }[]; by_priority: { priority: string; count: number }[];
  by_department: { department_id: string; label: string; count: number; overdue: number }[]; by_age_bucket: { bucket: string; count: number }[];
  backlog: { reports_pending: number; awaiting_results: number; ready_unreleased: number; oldest_registered_at?: string; by_centre: { centre_id: string; label: string; reports_pending: number; awaiting_results: number; ready_unreleased: number }[] };
}

export async function pendingSummary(ctx: ReportsContext, a: { scope: Scope; filters: PendingFilters }): Promise<PendingSummaryOut> {
  const depts = await checkKnown(ctx, a.filters);
  const rows = await sourceViews.pendingSummaryRows(ctx.tx, liveArgs(ctx, a.filters, a.scope)); // the request tx: RLS applies
  const backlog = await rollups.backlogRows(ctx.tx, { tenantId: ctx.tenantId, scope: a.scope });   // snapshot, scope predicate

  const names = depts.size || !rows.length ? depts : await departmentLabels(ctx);
  const group = <K extends string>(key: (r: sourceViews.PendingSummaryRow) => K) => {
    const m = new Map<K, number>();
    for (const r of rows) m.set(key(r), (m.get(key(r)) ?? 0) + r.n);
    return m;
  };
  const canon = <T extends string>(order: readonly T[], m: Map<string, number>) => order.filter((k) => m.has(k)).map((k) => [k, m.get(k)!] as const);
  const dept = new Map<string, { count: number; overdue: number }>();
  for (const r of rows) { const d = dept.get(r.department_id) ?? { count: 0, overdue: 0 }; dept.set(r.department_id, { count: d.count + r.n, overdue: d.overdue + r.overdue }); }

  const centres = backlog.length ? await centreLabels(ctx) : new Map<string, { name: string }>();
  const per = new Map<string, { awaiting_results: number; ready_unreleased: number }>();
  for (const b of backlog) {
    const c = per.get(b.centre_id) ?? { awaiting_results: 0, ready_unreleased: 0 };
    c[b.stage] += b.orders;
    per.set(b.centre_id, c);
  }
  const oldest = backlog.map((b) => b.oldest_registered_at).filter((x): x is string => x !== null).sort()[0];
  const awaiting = total([...per.values()].map((c) => c.awaiting_results));
  const ready = total([...per.values()].map((c) => c.ready_unreleased));

  return {
    total: total(rows.map((r) => r.n)), overdue: total(rows.map((r) => r.overdue)), no_target: total(rows.map((r) => r.no_target)),
    by_status: canon(ITEM_STATUSES, group((r) => r.item_status)).map(([item_status, count]) => ({ item_status, count })),
    by_priority: canon(PRIORITIES, group((r) => r.priority)).map(([priority, count]) => ({ priority, count })),
    by_age_bucket: canon(AGE_BUCKETS, group((r) => r.age_bucket)).map(([bucket, count]) => ({ bucket, count })),
    by_department: [...dept].map(([department_id, d]) => ({ department_id, label: (names.get(department_id)?.name ?? `Department ${shortId(department_id)}`).slice(0, 200), ...d }))
      .sort((x, y) => x.label.localeCompare(y.label) || x.department_id.localeCompare(y.department_id)).slice(0, 200),
    backlog: {
      reports_pending: awaiting + ready, awaiting_results: awaiting, ready_unreleased: ready, ...(oldest === undefined ? {} : { oldest_registered_at: oldest }),
      by_centre: [...per].map(([centre_id, c]) => ({
        centre_id, label: (centres.get(centre_id)?.name ?? `Centre ${shortId(centre_id)}`).slice(0, 200), reports_pending: c.awaiting_results + c.ready_unreleased, ...c,
      })).sort((x, y) => x.label.localeCompare(y.label) || x.centre_id.localeCompare(y.centre_id)).slice(0, 200),
    },
  };
}

export interface PendingItemOut {
  order_item_id: string; order_id: string; centre_id: string; processing_branch_id?: string; department_id: string; test_id: string; test_code: string; test_label: string;
  priority: string; item_status: string; age_seconds: number; tat_target_seconds?: number; is_overdue: boolean;
}

export async function pendingItems(ctx: ReportsContext, a: { scope: Scope; filters: PendingFilters; query: ItemsQuery }): Promise<{ rows: PendingItemOut[]; nextCursor?: string }> {
  const { query: q, filters: f } = a;
  await checkKnown(ctx, f);
  const raw = await sourceViews.pendingItems(ctx.tx, {
    ...liveArgs(ctx, f, a.scope), itemStatuses: q.itemStatuses, overdueOnly: q.overdueOnly, sort: q.sort, after: q.after, limit: q.limit + 1, // +1 row: is there a next page
  });
  const more = raw.length > q.limit;
  const page = raw.slice(0, q.limit);
  const tests = page.length ? await testLabels(ctx, page.map((r) => r.test_id)) : new Map<string, { code: string; name: string }>();
  const rows = page.map((r): PendingItemOut => {
    const t = tests.get(r.test_id); // no directory row: short id as code (never a guess at a name)
    return {
      order_item_id: r.order_item_id, order_id: r.order_id, centre_id: r.centre_id, ...(r.processing_branch_id === null ? {} : { processing_branch_id: r.processing_branch_id }),
      department_id: r.department_id, test_id: r.test_id, test_code: t?.code ?? shortId(r.test_id), test_label: (t?.name ?? `Test ${shortId(r.test_id)}`).slice(0, 200),
      priority: r.priority, item_status: r.item_status, age_seconds: r.age_seconds, ...(r.tat_target_seconds === null ? {} : { tat_target_seconds: r.tat_target_seconds }),
      is_overdue: r.tat_target_seconds !== null && r.age_seconds > r.tat_target_seconds,
    };
  });
  const last = page.at(-1);
  return { rows, ...(more && last ? { nextCursor: encodeCursor(last) } : {}) };
}
