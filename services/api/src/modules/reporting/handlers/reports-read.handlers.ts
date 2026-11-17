// R1-R5 staff read endpoints (02-TRD §6.1/§6.2/§12.1; AC-08.4; REQ-SEC-017/080/081; P-10 for the R2 barcode). Schema, auth and x-permission (reporting.report.read) are enforced by the
// core pipeline; these handlers re-check what they need (fail closed), are pure reads, never echo input, and never log PHI. Centre scoping = RLS `__tenant_centre` (unknown id == other centre == 404).
import { LimsError, type FieldError } from '../../../core/errors.js';
import type { Handler, HandlerContext, HandlerRequest } from '../../../core/module.js';
import { displayStatus, toDetail, toSummary, toVersionSummary } from '../mappers/report.mapper.js';
import * as Q from '../repository/reports-read.repo.js';
import { findReportRefs, listCriticalAlertDeliveries } from '../repository/delivery.repo.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
// LD-74: strict round-trip check so nothing Postgres rejects (22008: year 0, 2026-02-30, month 13, day 00, ...) reaches SQL.
// Shape by regex, rebuild with Date.UTC and compare every part; 24:00:00 is accepted (PG accepts it) and handled explicitly.
const STAMP_PARTS = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-](\d{2}):(\d{2}))$/;
const realStamp = (k: string): boolean => {
  const p = STAMP_PARTS.exec(k);
  if (!p) return false;
  const [y, mo, d, h, mi, s, oh, om] = p.slice(1).map((x) => (x === undefined ? 0 : Number(x))) as number[];
  if (y! < 1 || y! > 9999 || oh! > 23 || om! > 59) return false;
  const midnight24 = h === 24;
  if (midnight24 && (mi !== 0 || s !== 0)) return false;
  const t = new Date(Date.UTC(2000, 0, 1));
  t.setUTCFullYear(y!, mo! - 1, d!);                    // setUTCFullYear: Date.UTC alone maps years 0-99 to 1900+
  t.setUTCHours(midnight24 ? 0 : h!, mi!, s!);
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo! - 1 || t.getUTCDate() !== d
    || t.getUTCHours() !== (midnight24 ? 0 : h) || t.getUTCMinutes() !== mi || t.getUTCSeconds() !== s) return false;
  const instant = Date.parse(k);                        // offset / 24:00 can still shift the real instant out of PG's 1..9999 range
  if (Number.isNaN(instant)) return false;
  const iy = new Date(instant).getUTCFullYear();
  return iy >= 1 && iy <= 9999;
};
const STATUSES = new Set(['awaiting_content', 'assembling', 'rendering', 'render_failed', 'held', 'ready_to_release', 'released', 'cancelled']);
const QUERY_KEYS = new Set(['display_status', 'family', 'centre_id', 'registered_at_from', 'registered_at_to', 'released_at_from', 'released_at_to', 'has_review_flag', 'sort', 'cursor', 'limit']);
const SORTS = { '-updated_at': 'updated_at', registered_at: 'registered_at', '-released_at': 'first_released_at' } as const;
const SEARCH_KEYS = ['registration_no', 'order_id', 'patient_id', 'barcode'];
const SCAN_BATCH = 200; const SCAN_MAX = 5000;        // ponytail: display_status is derived (latest version), so a status filter scans keyset batches in memory; a materialised column would remove this
const SEARCH_MAX = 50;
const CA_KEYS = new Set(['centre_id', 'since', 'cursor', 'limit']);
const DAY_MS = 86_400_000;

type Ctx = { tenantId: string; actor: { id: string; type?: string }; tx: { query(sql: string, v: unknown[]): Promise<{ rows: any[] }> }; ports?: Record<string, any>;
  storage?: { read(bucket: 'reports', path: string): Promise<Uint8Array> }; audit?: { access(e: Record<string, unknown>): Promise<unknown> } };
const obj = (v: unknown): Record<string, any> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, any>) : {});
const invalid = (path: string): LimsError => new LimsError('common.validation_failed', undefined, [{ path, code: 'common.field_invalid', message: 'Field invalid' } satisfies FieldError]);

function staff(hctx: HandlerContext): Ctx {
  const c = hctx as unknown as Partial<Ctx>;
  if (typeof c.tenantId !== 'string' || typeof c.actor?.id !== 'string' || !c.tx) throw new LimsError('auth.unauthenticated');
  if (c.actor.type !== 'user') throw new LimsError('auth.forbidden');         // staff endpoints: no device / portal actors
  return c as Ctx;
}
const idOr404 = (v: unknown): string => { if (typeof v !== 'string' || !UUID.test(v)) throw new LimsError('common.not_found'); return v; };
const str = (q: Record<string, any>, k: string): string | undefined => { const v = q[k]; if (v === undefined) return undefined; if (typeof v !== 'string') throw invalid(`/${k}`); return v; };
const stamp = (q: Record<string, any>, k: string): string | undefined => { const v = str(q, k); if (v === undefined) return undefined; if (!ISO_TS.test(v) || !realStamp(v)) throw invalid(`/${k}`); return new Date(v).toISOString(); };
const opt = (k: string, v: string | undefined) => (v === undefined ? {} : { [k]: v });
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

function parseList(raw: unknown) {
  const q = obj(raw);
  for (const k of Object.keys(q)) if (!QUERY_KEYS.has(k)) throw invalid('/');              // PHI (name, registration_no, ...) is never a query param
  const ds = q['display_status'];
  let statuses: Set<string> | undefined;
  if (ds !== undefined) {
    const parts = (Array.isArray(ds) ? ds : [ds]).flatMap((x) => { if (typeof x !== 'string') throw invalid('/display_status'); return x.split(','); });
    if (parts.length === 0 || !parts.every((x) => STATUSES.has(x))) throw invalid('/display_status');
    statuses = new Set(parts);
  }
  const family = str(q, 'family'); if (family !== undefined && family !== 'laboratory' && family !== 'narrative') throw invalid('/family');
  const centreId = str(q, 'centre_id'); if (centreId !== undefined && !UUID.test(centreId)) throw invalid('/centre_id');
  const flag = q['has_review_flag'];
  if (flag !== undefined && flag !== 'true' && flag !== 'false' && typeof flag !== 'boolean') throw invalid('/has_review_flag');
  const sortKey = str(q, 'sort') ?? '-updated_at'; if (!Object.hasOwn(SORTS, sortKey)) throw invalid('/sort');
  const sortCol = SORTS[sortKey as keyof typeof SORTS];
  const lim = q['limit'] === undefined ? 50 : typeof q['limit'] === 'number' ? q['limit'] : typeof q['limit'] === 'string' && /^\d{1,3}$/.test(q['limit']) ? Number(q['limit']) : NaN;
  if (!Number.isInteger(lim) || lim < 1 || lim > 200) throw invalid('/limit');
  let after: { k: string; i: string } | undefined;
  if (q['cursor'] !== undefined) {
    try {
      const raw64 = q['cursor'];
      if (typeof raw64 !== 'string' || raw64.length > 512) throw new Error('bad');
      const c = JSON.parse(Buffer.from(raw64, 'base64url').toString('utf8'));
      if (typeof c?.k !== 'string' || !ISO_TS.test(c.k) || !realStamp(c.k) || typeof c?.i !== 'string' || !UUID.test(c.i) || c.s !== sortKey) throw new Error('bad');
      after = { k: c.k, i: c.i };
    } catch { throw new LimsError('common.invalid_cursor'); }
  }
  const filter: Q.ReportFilter = {
    ...(family ? { family } : {}), ...(centreId ? { centreId } : {}), ...opt('registeredFrom', stamp(q, 'registered_at_from')), ...opt('registeredTo', stamp(q, 'registered_at_to')),
    ...opt('releasedFrom', stamp(q, 'released_at_from')), ...opt('releasedTo', stamp(q, 'released_at_to')), ...(flag === undefined ? {} : { reviewFlag: flag === true || flag === 'true' }),
    sortCol, ...(after ? { after } : {}),
  };
  return { filter, statuses, limit: lim, sortKey };
}

const groupBy = (rows: any[], key: string) => { const m = new Map<string, any[]>(); for (const r of rows) { const l = m.get(r[key]); if (l) l.push(r); else m.set(r[key], [r]); } return m; };
// µs-precision keyset key from SQL `to_char(...) AS sort_key` (timestamptz is µs; a ms ISO string would drop/repeat same-ms rows). Never mapped out.
const keyOf = (r: any) => r['sort_key'] as string;

/** Summaries for already-selected report rows (3 statements: reports done, versions, items). */
async function summaries(c: Ctx, rows: any[]): Promise<any[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r['id']);
  const [vs, its] = [groupBy(await Q.selectVersionStates(c.tx, c.tenantId, ids), 'report_id'), groupBy(await Q.selectItemFlags(c.tx, c.tenantId, ids), 'report_id')];
  return rows.map((r) => toSummary(r, vs.get(r['id']) ?? [], its.get(r['id']) ?? []));
}

export const reportsReadHandlers: Readonly<Record<string, Handler>> = Object.freeze({
  // R1 — delivery-free summaries from the snapshot columns; no port call.
  listReports: async (req: HandlerRequest, hctx: HandlerContext) => {
    const c = staff(hctx); const { filter, statuses, limit, sortKey } = parseList(req.query);
    const batch = statuses ? SCAN_BATCH : limit + 1; const picked: any[] = []; let after = filter.after; let scanned = 0; let more = false; let cursorRow: any;
    for (;;) {
      const rows = await Q.selectReportPage(c.tx, c.tenantId, { ...filter, ...(after ? { after } : {}) }, batch);
      const vs = statuses && rows.length ? groupBy(await Q.selectVersionStates(c.tx, c.tenantId, rows.map((r) => r['id'])), 'report_id') : undefined;
      for (const r of rows) {
        if (statuses && !statuses.has(displayStatus(r, vs!.get(r['id']) ?? []).status)) continue;
        picked.push(r);
        if (picked.length > limit) { more = true; cursorRow = picked[limit - 1]; break; }
      }
      if (more || rows.length < batch) break;
      const last = rows[rows.length - 1]; after = { k: keyOf(last), i: last['id'] }; scanned += rows.length;
      if (scanned >= SCAN_MAX) { more = true; cursorRow = last; break; }
    }
    const data = await summaries(c, picked.slice(0, limit));
    const page: Record<string, unknown> = { limit };
    if (more && cursorRow) page['next_cursor'] = b64({ k: keyOf(cursorRow), i: cursorRow['id'], s: sortKey });
    return { status: 200, body: { data, page } };
  },

  // R2 — exactly one key. The barcode is resolved by the lab as the user (P-10: needs lab.specimen.read too) and never stored or searched in reporting.*.
  searchReports: async (req: HandlerRequest, hctx: HandlerContext) => {
    const c = staff(hctx); const b = obj(req.body);
    const keys = Object.keys(b);
    if (Array.isArray(req.body) || keys.length !== 1 || !SEARCH_KEYS.includes(keys[0]!)) throw invalid('/');
    const key = keys[0]!; const val = b[key];
    if (typeof val !== 'string' || val.length < 1) throw invalid(`/${key}`);
    if ((key === 'registration_no' || key === 'barcode') && val.length > 20) throw invalid(`/${key}`);
    if ((key === 'order_id' || key === 'patient_id') && !UUID.test(val)) throw invalid(`/${key}`);
    let rows: any[];
    if (key === 'barcode') {
      const idp = c.ports?.['IdentityPort']; const lab = c.ports?.['lab'];
      if (typeof idp?.assertRole !== 'function' || typeof lab?.lookupSpecimens !== 'function') throw new LimsError('common.internal');     // fail closed
      await idp.assertRole(c, { permission: 'lab.specimen.read' });
      const specimens: Array<{ orderId: string }> = await lab.lookupSpecimens(c, { barcode: val });
      const orderIds = [...new Set(specimens.map((s) => s.orderId))];
      rows = orderIds.length ? await Q.selectReportsBy(c.tx, c.tenantId, 'order_ids', orderIds, SEARCH_MAX) : [];
    } else rows = await Q.selectReportsBy(c.tx, c.tenantId, key as 'registration_no' | 'order_id' | 'patient_id', val, SEARCH_MAX);
    return { status: 200, body: { data: await summaries(c, rows) } };
  },

  // R3 — summary + items + versions + delivery counts (one single-table statement); access log report.view (P-3).
  getReport: async (req: HandlerRequest, hctx: HandlerContext) => {
    const c = staff(hctx); const id = idOr404(obj(req.params)['report_id']);
    if (!c.audit) throw new LimsError('common.internal');
    const r = await Q.selectReportById(c.tx, c.tenantId, id);
    if (!r) throw new LimsError('common.not_found');
    const [versions, items, deliveries] = [await Q.selectVersionsOfReport(c.tx, c.tenantId, id), await Q.selectItemFlags(c.tx, c.tenantId, [id]), await Q.selectDeliveryStatuses(c.tx, c.tenantId, id)];
    await c.audit.access({ action: 'report.view', entityType: 'report', entityId: id, centreId: r['centre_id'], outcome: 'allowed' });
    return { status: 200, body: toDetail(r, versions, items, deliveries) };
  },

  getReportVersion: async (req: HandlerRequest, hctx: HandlerContext) => {
    const c = staff(hctx); const v = await Q.selectVersionById(c.tx, c.tenantId, idOr404(obj(req.params)['report_version_id']));
    if (!v) throw new LimsError('common.not_found');
    return { status: 200, body: toVersionSummary(v) };
  },

  // R5 — released: reporting.report.read is the floor; unreleased (or no PDF): only holders of reporting.report.release (draft view), else 409 reporting.report_not_released.
  downloadReportVersionPdf: async (req: HandlerRequest, hctx: HandlerContext) => {
    const c = staff(hctx); const v = await Q.selectVersionById(c.tx, c.tenantId, idOr404(obj(req.params)['report_version_id']));
    if (!v) throw new LimsError('common.not_found');
    if (!c.storage || !c.audit) throw new LimsError('common.internal');
    if (v['released_at'] == null) {
      const idp = c.ports?.['IdentityPort'];
      if (typeof idp?.assertRole !== 'function') throw new LimsError('common.internal');
      try { await idp.assertRole(c, { permission: 'reporting.report.release' }); } catch (e) {
        if ((e as { code?: string })?.code === 'auth.forbidden') throw new LimsError('reporting.report_not_released');
        throw e;
      }
    }
    const path = v['pdf_object_path'];
    if (typeof path !== 'string' || !path) throw new LimsError('reporting.report_not_released');   // rendering / render_failed: nothing to serve
    if (!path.startsWith(`${c.tenantId}/`)) throw new LimsError('common.internal');                // never read outside the caller's tenant prefix
    const bytes = await c.storage.read('reports', path);
    await c.audit.access({ action: 'report.download', entityType: 'report_version', entityId: v['id'], centreId: v['centre_id'], outcome: 'allowed' });
    return {
      status: 200, body: bytes, headers: {
        'content-type': 'application/pdf', 'content-disposition': `attachment; filename="report-v${Number(v['version_no'])}.pdf"`,   // version_no only: no patient / registration data in the name
        'x-content-type-options': 'nosniff', 'cache-control': 'no-store', 'content-security-policy': 'sandbox', 'content-length': String(bytes.length),
      },
    };
  },
  // R18 — critical alerts panel (02-TRD §6.1 CriticalAlert; AC-14.3; review fix #16). Grouped from critical_value_alert deliveries by critical_event_id; no value / name / destination.
  // ponytail: the whole window (<= 7 days) is grouped and paged in memory; a GROUP BY statement if the panel ever holds thousands of alerts.
  listCriticalAlerts: async (req: HandlerRequest, hctx: HandlerContext) => {
    const c = staff(hctx); const q = obj(req.query);
    for (const k of Object.keys(q)) if (!CA_KEYS.has(k)) throw invalid('/');
    const centreId = str(q, 'centre_id'); if (centreId !== undefined && !UUID.test(centreId)) throw invalid('/centre_id');
    const now = Date.parse(String((hctx as any).now?.() ?? new Date().toISOString()));
    const since = stamp(q, 'since') ?? new Date(now - DAY_MS).toISOString();
    if (Date.parse(since) < now - 7 * DAY_MS) throw invalid('/since');
    const lim = q['limit'] === undefined ? 50 : typeof q['limit'] === 'string' && /^\d{1,3}$/.test(q['limit']) ? Number(q['limit']) : NaN;
    if (!Number.isInteger(lim) || lim < 1 || lim > 200) throw invalid('/limit');
    let after: { k: string; i: string } | undefined;
    if (q['cursor'] !== undefined) {
      try {
        const raw = q['cursor']; if (typeof raw !== 'string' || raw.length > 512) throw new Error('bad');
        const cur = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
        if (typeof cur?.k !== 'string' || !ISO_TS.test(cur.k) || !realStamp(cur.k) || typeof cur?.i !== 'string' || !UUID.test(cur.i)) throw new Error('bad');
        after = { k: cur.k, i: cur.i };
      } catch { throw new LimsError('common.invalid_cursor'); }
    }
    const iso = (v: unknown) => new Date(v as string).toISOString();
    const groups = new Map<string, any[]>();
    for (const d of await listCriticalAlertDeliveries(c.tx, c.tenantId, since, centreId ?? null)) {
      const g = groups.get(d['related_entity_id']); if (g) g.push(d); else groups.set(d['related_entity_id'], [d]);
    }
    const all = [...groups].map(([id, rows]) => {
      rows.sort((a, b) => iso(a['created_at']).localeCompare(iso(b['created_at'])) || String(a['id']).localeCompare(String(b['id'])));
      return { id, k: iso(rows[0]['created_at']), rows };
    }).sort((a, b) => b.k.localeCompare(a.k) || b.id.localeCompare(a.id))
      .filter((a) => !after || a.k < after.k || (a.k === after.k && a.id < after.i));
    const pageRows = all.slice(0, lim);
    const reportIds = [...new Set(pageRows.map((a) => a.rows.find((r) => r['report_id'])?.['report_id']).filter(Boolean))] as string[];
    const refs = new Map((reportIds.length ? await findReportRefs(c.tx, c.tenantId, reportIds) : []).map((r) => [r.id, r]));
    const data = pageRows.map((a) => {
      const ref = refs.get(a.rows.find((r) => r['report_id'])?.['report_id']);
      return {
        critical_event_id: a.id, ...(ref ? { report_id: ref.id, order_id: ref.order_id, registration_no: ref.registration_no } : {}), centre_id: a.rows[0]['centre_id'], alerted_at: a.k,
        recipients: a.rows.map((r) => ({ recipient_kind: r['recipient_kind'], ...(r['recipient_kind'] === 'staff' && r['recipient_id'] ? { membership_id: r['recipient_id'] } : {}),
          status: r['status'], ...(r['failure_code'] ? { failure_code: r['failure_code'] } : {}) })),
      };
    });
    const page: Record<string, unknown> = { limit: lim };
    if (all.length > lim) { const last = pageRows[lim - 1]!; page['next_cursor'] = b64({ k: last.k, i: last.id }); }
    return { status: 200, body: { data, page } };
  },
});
