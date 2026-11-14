// C13 T13 — partner order tracking O1 (list), O2 (search), O3 (detail); shared gate / DTO helpers of the reports API (report.service.ts). 02-TRD §5.1/§5.2, 03-APP-FLOW §4.3/§4.4, 05-SCHEMA §3.7, 07-SECURITY ST2/ST13.
// Order: actor type -> IdentityPort.assertRole (partners.order.read / partners.report.read) -> partnerContext.require (partner_id from the token membership, never from a request value)
//   -> request validation (no SQL on the data tables) -> reads. Every read of a partner-owned table binds tenant_id AND partner_id (defence in depth next to RLS, ST2).
// SQL is parameterised and single-table (two-step reads, no joins): patient names, registration numbers and the search term are only ever bound values, never logged or echoed in an error (ST13).
// [CONV] cursor = offset cursor of referrer.service (listParams/page); keyset if a partner ever has tens of thousands of orders.
// [CONV] has_new_report / referrer_id filters are resolved by a first read that returns order ids, then `order_id = ANY(..)` on order_tracking (ponytail: id list, a denormalised flag if lists grow large).
import { LimsError } from '../../../core/errors.js';
import type { HandlerContext, HandlerRequest, HandlerResult } from '../../../core/module.js';
import { partnerContext, type PartnerRef } from './partner-context.service.js';
import { bad, isObj, uuidParam } from './partner-user.service.js';
import { listParams, page } from './referrer.service.js';

export type Q = { query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }> };
export type Obj = Record<string, unknown>;

export const PERM = { order: 'partners.order.read', report: 'partners.report.read' } as const;
const ISO = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
const STATUS_CSV = /^(registered|in_transit|in_lab|action_needed|partially_reported|reported|cancelled)(,(registered|in_transit|in_lab|action_needed|partially_reported|reported|cancelled)){0,6}$/;
const SORT = { '-registered_at': 'registered_at DESC, order_id DESC', '-last_event_at': 'last_event_at DESC, order_id DESC' } as const;
const SEARCH_LIMIT = 20;
const LINE_SCAN = 500; // ponytail: a search looks at the 500 newest matching lines, a narrower term when a partner has more
const TIMELINE_RANK = { registered: 0, collected: 1, in_transit: 2, received: 3, rejected: 4 } as const;

const TRK = 'SELECT order_id, line_id, manifest_id, registration_no, tracking_status, registered_at, last_event_at, report_count FROM partners.order_tracking WHERE tenant_id = $1 AND partner_id = $2';
const LINES = 'SELECT id, order_id, registration_no, partner_sample_ref, patient_full_name, patient_sex, patient_age_years, priority, referrer_id FROM partners.manifest_lines WHERE tenant_id = $1 AND partner_id = $2';
const LINE_ONE = 'SELECT id, order_id, registration_no, partner_sample_ref, patient_full_name, patient_sex, patient_age_years, priority, referrer_id, orderables_snapshot FROM partners.manifest_lines WHERE tenant_id = $1 AND partner_id = $2 AND id = $3';
const LINE_ORDERS = 'SELECT order_id FROM partners.manifest_lines WHERE tenant_id = $1 AND partner_id = $2 AND referrer_id = $3 AND order_id IS NOT NULL';
const LINE_MATCH = "SELECT order_id FROM partners.manifest_lines WHERE tenant_id = $1 AND partner_id = $2 AND order_id IS NOT NULL AND (patient_full_name ILIKE $3 ESCAPE '\\' OR partner_sample_ref = $4 OR registration_no = $4) ORDER BY id DESC LIMIT $5";
const MANIFESTS = 'SELECT id, manifest_no FROM partners.manifests WHERE tenant_id = $1 AND partner_id = $2 AND id = ANY($3::uuid[])';
const REFERRERS = 'SELECT id, display_name FROM partners.partner_referrers WHERE tenant_id = $1 AND partner_id = $2 AND id = ANY($3::uuid[])';
const NEW_ORDERS = "SELECT order_id FROM partners.order_reports WHERE tenant_id = $1 AND partner_id = $2 AND status = 'valid' AND is_new = true";
const FLAGS = "SELECT order_id FROM partners.order_reports WHERE tenant_id = $1 AND partner_id = $2 AND status = 'valid' AND is_new = true AND order_id = ANY($3::uuid[])";
const SPECIMENS = 'SELECT specimen_id, specimen_type_code, status, collected_at, in_transit_at, received_at, rejected_at, rejection_reason_code, replaces_specimen_id '
  + 'FROM partners.tracked_specimens WHERE tenant_id = $1 AND partner_id = $2 AND order_id = $3 ORDER BY collected_at, specimen_id';
export const REPORT_COLS = 'report_id, version_no, order_id, kind, status, released_at, panel_names, is_new';
const ORDER_REPORTS = `SELECT ${REPORT_COLS} FROM partners.order_reports WHERE tenant_id = $1 AND partner_id = $2 AND order_id = $3 ORDER BY released_at DESC, version_no DESC`;

const notFound = () => new LimsError('common.not_found');
export const has = (v: unknown) => v !== null && v !== undefined;
export const iso = (v: unknown): string => new Date(v as string).toISOString();
const len = (s: string) => [...s].length;

/** Actor type + permission + partnerContext. Returns the caller's partner ref; everything after it is scoped by ref.partnerId. */
export async function gate(ctx: HandlerContext, permission: string): Promise<PartnerRef> {
  if (ctx.actor?.type !== 'partner' || !ctx.tenantId || !ctx.tx || !ctx.actor.id) throw new LimsError('auth.forbidden'); // before any SQL
  await ctx.ports.IdentityPort.assertRole(ctx, { permission } as never);
  return partnerContext.require(ctx);
}

/** IsoUtc (02-CV §4.8): millisecond precision, Z only, a real calendar instant. Returns the normalised ISO string. */
export function instant(v: unknown, path: string): string {
  if (typeof v !== 'string' || !ISO.test(v)) throw bad(path);
  const ms = Date.parse(v);
  if (Number.isNaN(ms) || new Date(ms).toISOString() !== v) throw bad(path);
  return v;
}
export function flag(v: unknown, path: string): boolean {
  if (v === true || v === 'true') return true;
  if (v === false || v === 'false') return false;
  throw bad(path);
}
/** 03-APP-FLOW §4.3: a code shown as text: `EDTA_WB` -> "EDTA WB", `haemolysed` -> "Haemolysed". */
export const humanise = (code: string): string => { const s = code.replace(/_/g, ' ').trim(); return s.charAt(0).toUpperCase() + s.slice(1); };

// ---------------------------------------------------------------- DTOs (explicit allowlists; null columns omitted; no phone / note / birth date / consent / ids of the platform)
export function reportDto(r: Obj, registrationNo: string, fullName: string): Obj {
  return {
    report_id: r['report_id'], version_no: Number(r['version_no']), order_id: r['order_id'], registration_no: registrationNo, patient: { full_name: fullName },
    kind: r['kind'], status: r['status'], released_at: iso(r['released_at']), panel_names: Array.isArray(r['panel_names']) ? r['panel_names'] : [], is_new: r['is_new'] === true,
  };
}
function orderDto(t: Obj, l: Obj, manifestNo: string, referrer: string | undefined, hasNew: boolean): Obj {
  return {
    order_id: t['order_id'], registration_no: t['registration_no'] ?? l['registration_no'] ?? '', manifest: { id: t['manifest_id'], manifest_no: manifestNo }, line_id: t['line_id'],
    ...(has(l['partner_sample_ref']) ? { partner_sample_ref: l['partner_sample_ref'] } : {}),
    patient: { full_name: l['patient_full_name'], sex: l['patient_sex'], ...(has(l['patient_age_years']) ? { age_years: Number(l['patient_age_years']) } : {}) },
    priority: l['priority'], tracking_status: t['tracking_status'],
    ...(referrer !== undefined ? { referrer: { display_name: referrer } } : {}),
    registered_at: iso(t['registered_at']), last_event_at: iso(t['last_event_at']), report_count: Number(t['report_count']), has_new_report: hasNew,
  };
}

const idsOf = (rows: Obj[], key: string): string[] => [...new Set(rows.map((r) => String(r[key])))];
async function scoped(ctx: HandlerContext, ref: PartnerRef, sql: string, ...more: unknown[]): Promise<Obj[]> {
  return (await (ctx.tx as Q).query(sql, [ctx.tenantId, ref.partnerId, ...more])).rows as Obj[];
}

/** PartnerOrder DTOs of tracking rows (a row without its line / manifest cannot happen under the FKs and is dropped). */
async function hydrate(ctx: HandlerContext, ref: PartnerRef, rows: Obj[]): Promise<Obj[]> {
  if (rows.length === 0) return [];
  const lines = new Map((await scoped(ctx, ref, `${LINES} AND id = ANY($3::uuid[])`, idsOf(rows, 'line_id'))).map((l) => [String(l['id']), l]));
  const manifests = new Map((await scoped(ctx, ref, MANIFESTS, idsOf(rows, 'manifest_id'))).map((m) => [String(m['id']), String(m['manifest_no'])]));
  const refIds = idsOf([...lines.values()].filter((l) => has(l['referrer_id'])), 'referrer_id');
  const referrers = new Map(refIds.length ? (await scoped(ctx, ref, REFERRERS, refIds)).map((r) => [String(r['id']), String(r['display_name'])] as const) : []);
  const fresh = new Set((await scoped(ctx, ref, FLAGS, idsOf(rows, 'order_id'))).map((r) => String(r['order_id'])));
  const out: Obj[] = [];
  for (const t of rows) {
    const l = lines.get(String(t['line_id'])), m = manifests.get(String(t['manifest_id']));
    if (l && m !== undefined) out.push(orderDto(t, l, m, has(l['referrer_id']) ? referrers.get(String(l['referrer_id'])) : undefined, fresh.has(String(t['order_id']))));
  }
  return out;
}

// ---------------------------------------------------------------- O1
/** O1 listPartnerOrders */
export async function listOrders(req: HandlerRequest, ctx: HandlerContext): Promise<HandlerResult> {
  const ref = await gate(ctx, PERM.order);
  const { query, limit, offset } = listParams(req.query, ['tracking_status', 'manifest_id', 'referrer_id', 'registered_at_from', 'registered_at_to', 'has_new_report', 'sort', 'cursor', 'limit']);
  let order: string = SORT['-registered_at'];
  if (query['sort'] !== undefined) {
    if (typeof query['sort'] !== 'string' || !Object.hasOwn(SORT, query['sort'])) throw bad('/sort');
    order = SORT[query['sort'] as keyof typeof SORT];
  }
  const values: unknown[] = [ctx.tenantId, ref.partnerId];
  let sql = TRK;
  const and = (clause: (n: number) => string, v: unknown) => { values.push(v); sql += ` AND ${clause(values.length)}`; };
  const st = query['tracking_status'];
  if (st !== undefined) {
    if (typeof st !== 'string' || st.length > 80 || !STATUS_CSV.test(st)) throw bad('/tracking_status');
    and((n) => `tracking_status = ANY($${n}::text[])`, [...new Set(st.split(','))]);
  }
  if (query['manifest_id'] !== undefined) and((n) => `manifest_id = $${n}`, uuidParam(query, 'manifest_id'));
  if (query['registered_at_from'] !== undefined) and((n) => `registered_at >= $${n}`, instant(query['registered_at_from'], '/registered_at_from'));
  if (query['registered_at_to'] !== undefined) and((n) => `registered_at <= $${n}`, instant(query['registered_at_to'], '/registered_at_to'));
  const wantNew = query['has_new_report'] === undefined ? undefined : flag(query['has_new_report'], '/has_new_report');
  const referrerId = query['referrer_id'] === undefined ? undefined : uuidParam(query, 'referrer_id');
  const empty = (): HandlerResult => ({ status: 200, body: { data: [], page: page(limit, offset, 0) } });
  if (referrerId !== undefined) { // a foreign / unknown referrer matches no line of this partner: an empty list, never an error
    const ids = idsOf(await scoped(ctx, ref, LINE_ORDERS, referrerId), 'order_id');
    if (ids.length === 0) return empty();
    and((n) => `order_id = ANY($${n}::uuid[])`, ids);
  }
  if (wantNew !== undefined) {
    const ids = idsOf(await scoped(ctx, ref, NEW_ORDERS), 'order_id');
    if (wantNew && ids.length === 0) return empty();
    if (ids.length) and((n) => (wantNew ? `order_id = ANY($${n}::uuid[])` : `order_id <> ALL($${n}::uuid[])`), ids);
  }
  values.push(limit + 1, offset);
  const rows = (await (ctx.tx as Q).query(`${sql} ORDER BY ${order} LIMIT $${values.length - 1} OFFSET $${values.length}`, values)).rows as Obj[]; // placeholders only
  return { status: 200, body: { data: await hydrate(ctx, ref, rows.slice(0, limit)), page: page(limit, offset, rows.length) } };
}

// ---------------------------------------------------------------- O2
/** O2 searchPartnerOrders: q = patient-name prefix (case-insensitive, LIKE metacharacters literal), partner_sample_ref exact, registration_no exact. The term comes from the BODY only (REQ-SEC-098). */
export async function searchOrders(req: HandlerRequest, ctx: HandlerContext): Promise<HandlerResult> {
  const ref = await gate(ctx, PERM.order);
  if (!isObj(req.body)) throw bad('/body');
  const body = req.body;
  for (const k of Object.keys(body)) if (k !== 'q' && k !== 'limit') throw bad(`/${k}`);
  const q = body['q'];
  if (typeof q !== 'string' || len(q) < 2 || len(q) > 64) throw bad('/q');
  let limit = SEARCH_LIMIT;
  if (body['limit'] !== undefined) {
    const n = body['limit'];
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 50) throw bad('/limit');
    limit = n;
  }
  const prefix = `${q.replace(/[\\%_]/g, '\\$&')}%`;
  const ids = idsOf(await scoped(ctx, ref, LINE_MATCH, prefix, q, LINE_SCAN), 'order_id');
  if (ids.length === 0) return { status: 200, body: { data: [] } };
  const rows = await scoped(ctx, ref, `${TRK} AND order_id = ANY($3::uuid[]) ORDER BY ${SORT['-registered_at']} LIMIT $4`, ids, limit);
  return { status: 200, body: { data: await hydrate(ctx, ref, rows) } };
}

// ---------------------------------------------------------------- O3
/** O3 getPartnerOrder: unknown / other partner / other tenant -> one 404. */
export async function getOrder(req: HandlerRequest, ctx: HandlerContext): Promise<HandlerResult> {
  const ref = await gate(ctx, PERM.order);
  const orderId = uuidParam(req.params, 'order_id');
  const t = (await scoped(ctx, ref, `${TRK} AND order_id = $3`, orderId))[0];
  if (!t) throw notFound();
  const l = (await scoped(ctx, ref, LINE_ONE, t['line_id']))[0];
  const manifestNo = (await scoped(ctx, ref, MANIFESTS, [t['manifest_id']]))[0]?.['manifest_no'];
  if (!l || manifestNo === undefined) throw notFound();
  const refName = has(l['referrer_id']) ? (await scoped(ctx, ref, REFERRERS, [l['referrer_id']]))[0]?.['display_name'] : undefined;
  const specimens = await scoped(ctx, ref, SPECIMENS, orderId);
  const reports = await scoped(ctx, ref, ORDER_REPORTS, orderId);
  const regNo = String(t['registration_no'] ?? l['registration_no'] ?? ''), name = String(l['patient_full_name']);
  const hasNew = reports.some((r) => r['status'] === 'valid' && r['is_new'] === true);

  const snapshot = Array.isArray(l['orderables_snapshot']) ? (l['orderables_snapshot'] as Obj[]) : [];
  const orderables = snapshot.filter((o) => isObj(o) && typeof o['code'] === 'string' && typeof o['name'] === 'string').map((o) => ({ code: o['code'], name: o['name'] }));
  const timeline: Array<{ ms: number; rank: number; entry: Obj }> = [{ ms: new Date(t['registered_at'] as string).getTime(), rank: TIMELINE_RANK.registered, entry: { at: iso(t['registered_at']), label_key: 'partners.tracking.registered' } }];
  const specimenDtos = specimens.map((s) => {
    const display = humanise(String(s['specimen_type_code']));
    for (const [col, ev] of [['collected_at', 'collected'], ['in_transit_at', 'in_transit'], ['received_at', 'received'], ['rejected_at', 'rejected']] as const) {
      if (has(s[col])) timeline.push({ ms: new Date(s[col] as string).getTime(), rank: TIMELINE_RANK[ev], entry: { at: iso(s[col]), label_key: `partners.tracking.${ev}`, specimen_type_display: display } });
    }
    return {
      specimen_id: s['specimen_id'], specimen_type_code: s['specimen_type_code'], specimen_type_display: display, status: s['status'],
      ...(has(s['collected_at']) ? { collected_at: iso(s['collected_at']) } : {}), ...(has(s['in_transit_at']) ? { in_transit_at: iso(s['in_transit_at']) } : {}),
      ...(has(s['received_at']) ? { received_at: iso(s['received_at']) } : {}), ...(has(s['rejected_at']) ? { rejected_at: iso(s['rejected_at']) } : {}),
      ...(has(s['rejection_reason_code']) ? { rejection_reason_code: s['rejection_reason_code'], rejection_reason_display: humanise(String(s['rejection_reason_code'])) } : {}),
      ...(has(s['replaces_specimen_id']) ? { replaces_specimen_id: s['replaces_specimen_id'] } : {}),
    };
  });
  timeline.sort((a, b) => a.ms - b.ms || a.rank - b.rank);
  return {
    status: 200,
    body: {
      ...orderDto(t, l, String(manifestNo), typeof refName === 'string' ? refName : undefined, hasNew),
      orderables, specimens: specimenDtos, reports: reports.map((r) => reportDto(r, regNo, name)), timeline: timeline.map((x) => x.entry),
    },
  };
}
