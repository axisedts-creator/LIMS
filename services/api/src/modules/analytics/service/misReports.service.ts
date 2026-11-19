// T0B-MISREPORTS-1 (LD-321, LD-325, LD-346; founder 2026-11-17 04:57 / 09:18 NPT): the delivered MIS reports of the analytics catalogue as ONE parameterised SQL
// statement per page (no per row query), keyset paged by the rank of the contract default_sort (+ the row's natural key as tie break), tenant predicate explicit
// ($1, holds even where RLS is bypassed) on every table, business dates INCLUSIVE and capped at 366 days, result capped at the contract row_cap.
// Money is integer paisa from posted rows only: issued invoices and ledger entries (payments net of reversals and refunds). [CONV] The Hold status of FINCTRL
// lives on billing.account_ledger_entries, which no report here reads, so held entries never enter a figure (LD-321 "held ledger entries are excluded").
// Errors (standard): bad range / filter / limit / a result above row_cap -> common.validation_failed 400 with errors[]; a bad cursor -> common.invalid_cursor.
import { LimsError } from '../../../core/errors.js';
import { misColumns, type MisDef, type MisParam } from '../domain/misReports.js';
import { MIS_ALL_DEFS } from '../domain/reportRegistry.js';
import type { ExportColumn } from '../export/layout.js';
import { branchLabels, staffLabels, type LabelsContext } from './labels.service.js';
import { checkUuidList, invalidField } from './reports.service.js';

export { MIS_REPORT_CODES } from '../domain/misReports.js';

type Row = Record<string, string | number>;
export interface MisCtx { tenantId: string; tx: { query(text: string, values?: unknown[]): Promise<{ rows: any[] }> }; core?: Partial<LabelsContext['core']> }
export interface MisRange { from: string; to: string }
export interface MisArgs { range: MisRange; scope: { all: boolean; centreIds: readonly string[] }; filters?: unknown; limit?: unknown; cursor?: unknown }
export interface MisPage { columns: ExportColumn[]; rows: Row[]; next_cursor?: string }

export const MAX_RANGE_DAYS = 366;
const MAX_IDS = 20;
const DEFAULT_LIMIT = 100, MAX_LIMIT = 1000;
const TZ = `'Asia/Kathmandu'`;

const defOf = (code: string): MisDef => {
  if (typeof code !== 'string' || !Object.hasOwn(MIS_ALL_DEFS, code)) throw new LimsError('analytics.report_unknown');
  return MIS_ALL_DEFS[code]!;
};

// ------------------------------------------------------------------ validation (shared with the export request: reads nothing)
const dayNo = (iso: string): number => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86_400_000;
function isoDate(v: unknown, path: string): string {
  const m = typeof v === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(v) : null;
  const t = m ? new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!)) : null;
  if (!m || !t || t.getUTCFullYear() !== +m[1]! || t.getUTCMonth() !== +m[2]! - 1 || t.getUTCDate() !== +m[3]!) throw invalidField(path);
  return v as string;
}
/** Both ends inclusive; from <= to; at most 366 days (done_when 2/3). */
export function checkMisRange(r: unknown, paths: [string, string] = ['range.from', 'range.to']): MisRange {
  const o = (r && typeof r === 'object' ? r : {}) as { from?: unknown; to?: unknown };
  const from = isoDate(o.from, paths[0]), to = isoDate(o.to, paths[1]);
  const days = dayNo(to) - dayNo(from) + 1;
  if (days < 1) throw invalidField(paths[1]);
  if (days > MAX_RANGE_DAYS) throw new LimsError('common.validation_failed', `At most ${MAX_RANGE_DAYS} days`, [{ path: paths[1], code: 'common.field_invalid', message: 'Field invalid' }]);
  return { from, to };
}

export interface MisFilters { ids: Partial<Record<Exclude<MisParam, 'min_repeat_count' | 'visit_type'>, string[] | null>>; minRepeat: number; visitType: string | null }
const ID_PARAMS = ['centre_id', 'party_id', 'representative_id', 'referrer_id', 'department_id', 'collector_id'] as const;
/** Closed per report: a key the contract does not list for the report, a malformed uuid, an out of range count or an unknown patient type -> 400. */
export function checkMisFilters(code: string, f: unknown, base = 'filters'): MisFilters {
  const d = defOf(code);
  if (f !== undefined && (typeof f !== 'object' || f === null || Array.isArray(f))) throw invalidField(base);
  const o = (f ?? {}) as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!(d.params as readonly string[]).includes(k)) throw invalidField(`${base}.${k}`);
  const ids: MisFilters['ids'] = {};
  for (const k of ID_PARAMS) { const l = checkUuidList(o[k], `${base}.${k}`, MAX_IDS); ids[k] = l.length ? l : null; }
  const mr = o.min_repeat_count;
  if (mr !== undefined && (typeof mr !== 'number' || !Number.isInteger(mr) || mr < 2 || mr > 1000)) throw invalidField(`${base}.min_repeat_count`);
  const vt = o.visit_type;
  if (vt !== undefined && vt !== 'opd' && vt !== 'ipd') throw invalidField(`${base}.visit_type`);
  return { ids, minRepeat: (mr as number | undefined) ?? 2, visitType: (vt as string | undefined) ?? null };
}

const EXPORT_KEYS = ['business_date_from', 'business_date_to', 'centre_id', 'branch_id', 'filters'];
/** ExportParams of an MIS report (request time and build time): business dates only (inclusive, <= 366 days), closed filters. */
export function checkMisExportParams(code: string, p: Record<string, unknown>): { range: MisRange; filters: MisFilters } {
  defOf(code);
  for (const k of Object.keys(p)) if (!EXPORT_KEYS.includes(k)) throw invalidField(`params.${k}`);
  const range = checkMisRange({ from: p.business_date_from, to: p.business_date_to }, ['params.business_date_from', 'params.business_date_to']);
  return { range, filters: checkMisFilters(code, p.filters, 'params.filters') };
}

function checkLimit(v: unknown): number {
  if (v === undefined) return DEFAULT_LIMIT;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > MAX_LIMIT) throw invalidField('limit');
  return v;
}
const cursorOf = (code: string, rank: number): string => Buffer.from(JSON.stringify({ c: code, r: rank })).toString('base64url');
function rankOf(code: string, v: unknown): number {
  if (v === undefined) return 0;
  try {
    if (typeof v !== 'string' || v.length > 200) throw new Error('bad');
    const c = JSON.parse(Buffer.from(v, 'base64url').toString('utf8'));
    if (c?.c !== code || !Number.isSafeInteger(c?.r) || c.r < 1) throw new Error('bad');
    return c.r as number;
  } catch { throw new LimsError('common.invalid_cursor'); }
}

// ------------------------------------------------------------------ SQL
class Params {
  readonly values: unknown[] = [];
  add(v: unknown): string { this.values.push(v); return `$${this.values.length}`; }
}
interface Q { p: Params; t: string; from: string; to: string; centre(col: string): string; f: MisFilters }
const iso = (col: string) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const ymd = (col: string) => `to_char(${col}, 'YYYY-MM-DD')`;
const inRange = (q: Q, col: string) => `${col} >= (${q.from}::date)::timestamp AT TIME ZONE ${TZ} AND ${col} < ((${q.to}::date + 1)::timestamp AT TIME ZONE ${TZ})`;
const idIn = (q: Q, col: string, k: keyof MisFilters['ids']) => (q.f.ids[k] ? ` AND ${col} = ANY(${q.p.add(q.f.ids[k])}::uuid[])` : '');
/** Issued invoices of the range in scope (the billing register). */
const invoices = (q: Q, extra = '') => `SELECT i.* , (i.issued_at AT TIME ZONE ${TZ})::date AS bdate FROM billing.invoices i
  WHERE i.tenant_id = ${q.t} AND i.status = 'issued' AND ${inRange(q, 'i.issued_at')} AND ${q.centre('i.centre_id')}${extra}`;
/** Posted payments per invoice of `inv` (payments net of reversals / refunds). */
const paid = (q: Q, inv: string) => `SELECT l.invoice_id, sum(l.amount_paisa) AS p FROM billing.ledger_entries l
  WHERE l.tenant_id = ${q.t} AND l.invoice_id IN (SELECT id FROM ${inv}) GROUP BY l.invoice_id`;
/**
 * T0B-MISREPORTS-2 (A39-4, M33, LD-346): per credit party with a partners.party_commercial_setting row (party_kind credit_party) and >= 1 issued invoice in range:
 * base = Σ (gross - discount - credited_total) of its OWN issued invoices (posted data, cancelled excluded, credit notes subtracted); the rates are read from the
 * settings at run time (C8 stores none); commission = round half up (base x commission_bp / 10000); tds = round half up (commission x tds_bp / 10000).
 * [CONV] Held ledger entries (billing.account_ledger_entries, FINCTRL) never enter the base: it is invoice based (CR T0B-MISREPORTS-2 item 2).
 * [CONV] No party -> parent party link exists (CR T0B-MISREPORTS-2 item 1, open): every row is level 1 with an empty parent until the lead rules.
 */
const halfUp = (n: string, bp: string) => `floor((${n} * ${bp} + 5000)::numeric / 10000)::bigint`;
const partyMoney = (q: Q) => `WITH inv AS (${invoices(q, ` AND i.credit_party_id IS NOT NULL${idIn(q, 'i.credit_party_id', 'party_id')}`)}),
      b AS (SELECT inv.credit_party_id AS party_id, count(DISTINCT inv.order_id) AS n, sum(inv.gross_paisa - inv.discount_paisa - inv.credited_total_paisa) AS base FROM inv GROUP BY 1)
      SELECT b.party_id, coalesce(cp.name, '') AS party_name, b.n, b.base, s.commission_bp, s.tds_bp, ${halfUp('b.base', 's.commission_bp')} AS c
        FROM b JOIN partners.party_commercial_setting s ON s.tenant_id = ${q.t} AND s.party_kind = 'credit_party' AND s.party_id = b.party_id
        LEFT JOIN catalog.credit_parties cp ON cp.tenant_id = ${q.t} AND cp.id = b.party_id`;
const orders = (q: Q) => `SELECT o.id, o.patient_id, (o.registered_at AT TIME ZONE ${TZ})::date AS d FROM frontdesk.orders o
  WHERE o.tenant_id = ${q.t} AND o.status <> 'cancelled' AND ${inRange(q, 'o.registered_at')} AND ${q.centre('o.centre_id')}`;

/** Per report: the SELECT producing exactly the contract columns, and the unique tie break after the default sort. */
const SQL: Readonly<Record<string, { body(q: Q): string; tie: string }>> = {
  bill_of_the_day: {
    tie: 'invoice_id DESC',
    body: (q) => `WITH inv AS (${invoices(q, idIn(q, 'i.credit_party_id', 'party_id'))}), pay AS (${paid(q, 'inv')})
      SELECT inv.id::text AS invoice_id, inv.invoice_no AS invoice_number, ${iso('inv.issued_at')} AS billed_at, ${ymd('inv.bdate')} AS business_date,
             inv.centre_id::text AS centre_id, coalesce(inv.credit_party_id::text, '') AS party_id, inv.gross_paisa, inv.discount_paisa, inv.net_paisa,
             coalesce(pay.p, 0) AS paid_paisa, inv.net_paisa - coalesce(pay.p, 0) AS due_paisa
        FROM inv LEFT JOIN pay ON pay.invoice_id = inv.id`,
  },
  // [CONV] party assignments of kind credit_party match invoices.credit_party_id on the business days inside the (inclusive) window; no roll up of the manager tree.
  sales_representative: {
    tie: 'representative_id',
    body: (q) => `WITH asg AS (
        SELECT a.representative_id, a.party_id, greatest(a.effective_from, ${q.from}::date) AS f, least(coalesce(a.effective_to, ${q.to}::date), ${q.to}::date) AS t
          FROM partners.party_sales_assignment a
         WHERE a.tenant_id = ${q.t} AND a.party_kind = 'credit_party' AND a.effective_from <= ${q.to}::date AND coalesce(a.effective_to, ${q.to}::date) >= ${q.from}::date
           ${idIn(q, 'a.representative_id', 'representative_id')}${idIn(q, 'a.party_id', 'party_id')}),
      inv AS (${invoices(q, ' AND i.credit_party_id IS NOT NULL')}),
      b AS (SELECT asg.representative_id, inv.id, inv.net_paisa FROM asg JOIN inv ON inv.credit_party_id = asg.party_id AND inv.bdate BETWEEN asg.f AND asg.t),
      pay AS (${paid(q, 'b')}),
      pc AS (SELECT representative_id, count(DISTINCT party_id) AS n FROM asg GROUP BY representative_id)
      SELECT r.id::text AS representative_id, r.name AS representative_name, coalesce(d.level, 0)::int AS designation_level, pc.n AS parties_count,
             count(b.id) AS orders_registered, coalesce(sum(b.net_paisa), 0) AS net_paisa, coalesce(sum(pay.p), 0) AS collected_paisa
        FROM pc JOIN partners.sales_representative r ON r.tenant_id = ${q.t} AND r.id = pc.representative_id
        LEFT JOIN partners.sales_designation d ON d.tenant_id = ${q.t} AND d.id = r.designation_id
        LEFT JOIN b ON b.representative_id = r.id LEFT JOIN pay ON pay.invoice_id = b.id
       GROUP BY r.id, r.name, d.level, pc.n`,
  },
  // LD-346 (1): volume only. Orders without a referrer (SELF) are not consultant rows; tests = orderable invoice lines.
  consultant: {
    tie: 'referrer_id, department_id',
    body: (q) => `WITH inv AS (${invoices(q, ` AND i.referrer_id IS NOT NULL${idIn(q, 'i.referrer_id', 'referrer_id')}`)})
      SELECT inv.referrer_id::text AS referrer_id, coalesce(max(rd.display_name), '') AS referrer_name, coalesce(l.department_id::text, '') AS department_id,
             count(DISTINCT inv.order_id) AS orders_registered, count(*) AS tests_count
        FROM inv JOIN billing.invoice_lines l ON l.tenant_id = ${q.t} AND l.invoice_id = inv.id AND l.line_kind = 'orderable'
        LEFT JOIN catalog.v_pub_referrer_directory rd ON rd.tenant_id = ${q.t} AND rd.referrer_id = inv.referrer_id
       WHERE true${idIn(q, 'l.department_id', 'department_id')}
       GROUP BY inv.referrer_id, l.department_id`,
  },
  // [CONV] collected = ledger entries by collected_by_membership_id on business_date (reversals netted); collections = applied home collections;
  // pickups = completed home collection visits of the collector. Names come from core (labels), not SQL.
  collection_boy: {
    tie: 'collector_id',
    body: (q) => {
      const c = (col: string) => idIn(q, col, 'collector_id');
      return `WITH led AS (SELECT l.collected_by_membership_id AS m, sum(l.amount_paisa) AS amt, max(l.created_at) AS last FROM billing.ledger_entries l
           WHERE l.tenant_id = ${q.t} AND l.collected_by_membership_id IS NOT NULL AND l.business_date BETWEEN ${q.from}::date AND ${q.to}::date AND ${q.centre('l.centre_id')}${c('l.collected_by_membership_id')}
           GROUP BY 1),
        col AS (SELECT h.collected_by_membership_id AS m, count(*) AS n, max(h.collected_at) AS last FROM homecollection.collections h
           WHERE h.tenant_id = ${q.t} AND h.status = 'applied' AND ${inRange(q, 'h.collected_at')} AND ${q.centre('h.centre_id')}${c('h.collected_by_membership_id')} GROUP BY 1),
        vis AS (SELECT v.assigned_membership_id AS m, count(*) AS n, max(v.completed_at) AS last FROM homecollection.visits v
           WHERE v.tenant_id = ${q.t} AND v.status = 'completed' AND v.assigned_membership_id IS NOT NULL AND ${inRange(q, 'v.completed_at')} AND ${q.centre('v.centre_id')}${c('v.assigned_membership_id')}
           GROUP BY 1),
        ids AS (SELECT m FROM led UNION SELECT m FROM col UNION SELECT m FROM vis)
      SELECT ids.m::text AS collector_id, '' AS collector_name, coalesce(col.n, 0) AS collections_count, coalesce(vis.n, 0) AS pickups_count,
             coalesce(led.amt, 0) AS collected_paisa, coalesce(${iso('greatest(led.last, col.last, vis.last)')}, '') AS last_activity_at
        FROM ids LEFT JOIN led ON led.m = ids.m LEFT JOIN col ON col.m = ids.m LEFT JOIN vis ON vis.m = ids.m`;
    },
  },
  repeated_patient: {
    tie: 'patient_id',
    body: (q) => `WITH o AS (${orders(q)}),
      p AS (SELECT patient_id, count(*) AS n, min(d) AS f, max(d) AS l FROM o GROUP BY patient_id HAVING count(*) >= ${q.p.add(q.f.minRepeat)}::int),
      net AS (SELECT i.patient_id, sum(i.net_paisa) AS s FROM billing.invoices i
               WHERE i.tenant_id = ${q.t} AND i.status = 'issued' AND i.order_id IN (SELECT o.id FROM o JOIN p ON p.patient_id = o.patient_id) GROUP BY i.patient_id)
      SELECT p.patient_id::text AS patient_id, coalesce(pt.patient_code, '') AS patient_number, p.n AS visit_count, ${ymd('p.f')} AS first_visit_date, ${ymd('p.l')} AS last_visit_date,
             coalesce(net.s, 0) AS net_paisa
        FROM p LEFT JOIN frontdesk.patients pt ON pt.tenant_id = ${q.t} AND pt.id = p.patient_id LEFT JOIN net ON net.patient_id = p.patient_id`,
  },
  repeated_test: {
    tie: 'test_code, department_id',
    body: (q) => {
      const min = q.p.add(q.f.minRepeat);
      return `WITH o AS (${orders(q)}),
        it AS (SELECT i.code, i.department_id, o.patient_id, count(*) AS n, min(i.name) AS nm FROM frontdesk.order_items i JOIN o ON o.id = i.order_id
                WHERE i.tenant_id = ${q.t} AND i.status = 'active'${idIn(q, 'i.department_id', 'department_id')} GROUP BY i.code, i.department_id, o.patient_id)
        SELECT code AS test_code, min(nm) AS test_name, coalesce(department_id::text, '') AS department_id, sum(n) AS test_count, count(*) AS patients_count,
               count(*) FILTER (WHERE n >= ${min}::int) AS repeat_patients_count
          FROM it GROUP BY code, department_id HAVING count(*) FILTER (WHERE n >= ${min}::int) > 0`;
    },
  },
  ipd_opd: {
    tie: 'centre_id, visit_type',
    body: (q) => `WITH inv AS (${invoices(q, idIn(q, 'i.referrer_id', 'referrer_id') + idIn(q, 'i.credit_party_id', 'party_id'))}),
      lc AS (SELECT l.invoice_id, count(*) AS n FROM billing.invoice_lines l WHERE l.tenant_id = ${q.t} AND l.line_kind = 'orderable' AND l.invoice_id IN (SELECT id FROM inv) GROUP BY 1)
      SELECT ${ymd('inv.bdate')} AS business_date, inv.centre_id::text AS centre_id, coalesce(o.visit_type, '') AS visit_type, count(*) AS orders_registered,
             coalesce(sum(lc.n), 0) AS tests_count, sum(inv.gross_paisa) AS gross_paisa, sum(inv.net_paisa) AS net_paisa
        FROM inv LEFT JOIN frontdesk.orders o ON o.tenant_id = ${q.t} AND o.id = inv.order_id LEFT JOIN lc ON lc.invoice_id = inv.id
       WHERE ${q.f.visitType ? `o.visit_type = ${q.p.add(q.f.visitType)}` : 'true'}
       GROUP BY inv.bdate, inv.centre_id, o.visit_type`,
  },
  party_billing: {
    tie: 'party_id',
    body: (q) => `WITH inv AS (${invoices(q, ` AND i.credit_party_id IS NOT NULL${idIn(q, 'i.credit_party_id', 'party_id')}`)}), pay AS (${paid(q, 'inv')})
      SELECT inv.credit_party_id::text AS party_id, coalesce(max(cp.name), '') AS party_name, coalesce(min(o.billing_mode), 'credit') AS billing_mode,
             count(DISTINCT inv.order_id) AS orders_registered, sum(inv.gross_paisa) AS gross_paisa, sum(inv.discount_paisa) AS discount_paisa, sum(inv.net_paisa) AS net_paisa,
             coalesce(sum(pay.p), 0) AS paid_paisa, sum(inv.net_paisa) - coalesce(sum(pay.p), 0) AS outstanding_paisa
        FROM inv LEFT JOIN pay ON pay.invoice_id = inv.id
        LEFT JOIN frontdesk.orders o ON o.tenant_id = ${q.t} AND o.id = inv.order_id
        LEFT JOIN catalog.credit_parties cp ON cp.tenant_id = ${q.t} AND cp.id = inv.credit_party_id
       GROUP BY inv.credit_party_id`,
  },
  two_level_commission: {
    tie: 'party_id',
    body: (q) => `WITH m AS (${partyMoney(q)})
      SELECT '' AS parent_party_id, '' AS parent_party_name, m.party_id::text AS party_id, m.party_name, 1 AS level, m.n AS orders_registered,
             m.base AS net_billed_paisa, m.commission_bp, m.c AS commission_paisa FROM m`,
  },
  tds: {
    tie: 'party_id',
    body: (q) => `WITH m AS (${partyMoney(q)})
      SELECT m.party_id::text AS party_id, m.party_name, ${ymd(`${q.from}::date`)} AS period_from, ${ymd(`${q.to}::date`)} AS period_to, m.c AS commission_payable_paisa, m.tds_bp,
             ${halfUp('m.c', 'm.tds_bp')} AS tds_withheld_paisa, m.c - ${halfUp('m.c', 'm.tds_bp')} AS net_payable_paisa FROM m`,
  },
  // [CONV] sent = lab tests whose workflow or status is outsourced, or processed at a branch other than the order's branch; resulted = resulted / verified / approved.
  outsource: {
    tie: 'processing_branch_id, department_id',
    body: (q) => `SELECT coalesce(t.processing_branch_id::text, '') AS processing_branch_id, '' AS processing_lab_name, t.department_id::text AS department_id,
             count(*) AS tests_sent, count(*) FILTER (WHERE t.status IN ('resulted', 'verified', 'approved')) AS tests_resulted
        FROM lab.order_tests t LEFT JOIN lab.orders lo ON lo.tenant_id = ${q.t} AND lo.id = t.order_id
       WHERE t.tenant_id = ${q.t} AND t.status <> 'cancelled' AND ${inRange(q, 't.ordered_at')} AND ${q.centre('t.centre_id')}${idIn(q, 't.department_id', 'department_id')}
         AND (t.workflow_type = 'outsourced' OR t.status = 'outsourced' OR (t.processing_branch_id IS NOT NULL AND t.processing_branch_id IS DISTINCT FROM lo.branch_id))
       GROUP BY t.processing_branch_id, t.department_id`,
  },
};

const shortId = (id: string): string => `…${id.slice(-8)}`;
async function addLabels(ctx: MisCtx, code: string, rows: Row[]): Promise<void> {
  if (rows.length === 0) return;
  if (code === 'collection_boy' && typeof ctx.core?.memberships?.list === 'function') {
    const names = await staffLabels(ctx as LabelsContext, rows.map((r) => String(r.collector_id)));
    for (const r of rows) r.collector_name = names.get(String(r.collector_id))?.displayName ?? shortId(String(r.collector_id));
  } else if (code === 'collection_boy') for (const r of rows) r.collector_name = shortId(String(r.collector_id));
  if (code === 'outsource' && typeof ctx.core?.branches === 'function') {
    const names = await branchLabels(ctx as LabelsContext);
    for (const r of rows) r.processing_lab_name = r.processing_branch_id === '' ? 'Outside laboratory' : names.get(String(r.processing_branch_id))?.name ?? '';
  }
}

/** One page: ONE statement (+ at most one core label lookup). */
export async function runMisReport(ctx: MisCtx, code: string, a: MisArgs): Promise<MisPage> {
  const d = defOf(code);
  const range = checkMisRange(a.range);
  const f = checkMisFilters(code, a.filters);
  const limit = checkLimit(a.limit);
  const after = rankOf(code, a.cursor);
  const scopeAll = a.scope?.all === true;
  const scopeIds = scopeAll ? [] : checkUuidList([...(a.scope?.centreIds ?? [])], 'scope.centre_ids', 10_000);

  const p = new Params();
  const t = `${p.add(ctx.tenantId)}::uuid`;
  const all = p.add(scopeAll), sIds = p.add(scopeIds);
  const fIds = f.ids.centre_id ? p.add(f.ids.centre_id) : null;
  const q: Q = {
    p, t, from: p.add(range.from), to: p.add(range.to), f,
    centre: (col) => `(${all}::boolean OR ${col} = ANY(${sIds}::uuid[]))${fIds ? ` AND ${col} = ANY(${fIds}::uuid[])` : ''}`,
  };
  const s = SQL[code]!;
  const body = s.body(q);
  const order = `${d.sort.column} ${d.sort.direction === 'desc' ? 'DESC' : 'ASC'}, ${s.tie}`;
  const sql = `WITH r AS (${body}), o AS (SELECT r.*, row_number() OVER (ORDER BY ${order}) AS rank_, count(*) OVER () AS total_ FROM r)
    SELECT * FROM o WHERE rank_ > ${p.add(after)} ORDER BY rank_ LIMIT ${p.add(limit)}`;
  const raw = (await ctx.tx.query(sql, p.values)).rows;

  const total = raw.length ? Number(raw[0].total_) : 0;
  if (total > d.rowCap) {
    throw new LimsError('common.validation_failed', `The result has more than ${d.rowCap} rows: narrow the range or add a filter`,
      [{ path: 'range', code: 'common.field_invalid', message: 'Field invalid' }]);
  }
  const rows: Row[] = raw.map((r) => {
    const out: Row = {};
    for (const c of d.columns) {
      const v = r[c.name];
      if (c.type === 'string' || c.type === 'date' || c.type === 'datetime') out[c.name] = v === null || v === undefined ? '' : String(v);
      else {
        const n = Number(v ?? 0);
        if (!Number.isSafeInteger(n)) throw new RangeError(`mis report ${code}: ${c.name} is not a safe integer`);
        out[c.name] = n;
      }
    }
    return out;
  });
  await addLabels(ctx, code, rows);
  const lastRank = raw.length ? Number(raw[raw.length - 1].rank_) : 0;
  return { columns: misColumns(d), rows, ...(raw.length === limit && lastRank < total ? { next_cursor: cursorOf(code, lastRank) } : {}) };
}

/** The export source: chunks of <= chunkRows pulled lazily page by page; validation (range, filters, row cap) fails before the first chunk. */
export async function* streamMisReport(ctx: MisCtx, code: string, a: Omit<MisArgs, 'limit' | 'cursor'> & { chunkRows?: number }): AsyncGenerator<Row[]> {
  const limit = a.chunkRows ?? MAX_LIMIT;
  let cursor: string | undefined;
  do {
    const page = await runMisReport(ctx, code, { range: a.range, scope: a.scope, filters: a.filters, limit, ...(cursor ? { cursor } : {}) });
    if (page.rows.length) yield page.rows;
    cursor = page.next_cursor;
  } while (cursor);
}
