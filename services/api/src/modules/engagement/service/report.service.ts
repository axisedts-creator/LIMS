// E22 listMyReports, E23 downloadMyReport (patient actor) over engagement.patient_reports (02-TRD §5 E22/E23, §6.2, §6.7, §9.4; 01-PRD US-EN-08.1-5; 07-SECURITY P-L1, P-L5, P-L6, E23 row).
// Read-only except the access log. Plain SQL (no JOIN); every statement binds tenant_id besides RLS. Visibility = the caller's ACTIVE links + released_at >= link.visible_from (PAT_VIS does the same in Postgres).
// [CONV] profile_id = the link id; patient_id never leaves the service. [CONV] A foreign / hidden / unknown report or version is one and the same 404 (no existence oracle), before any rate-limit or port call.
// [CONV] E23: rate limit (report_download, l:<link_id>) counts every attempt that passed the visibility check, failed ones included (03-APP-FLOW §5.2); the signed URL is fetched server-side and never leaves.
// [CONV] The file is read whole, sha256-checked against the port digest, and only then is report.download written (§9.4: only when the stream completed). Any failure throws -> the request transaction rolls back.
import { createHash } from 'node:crypto';
import { LimsError } from '../../../core/errors.js';
import { engagementMetrics } from '../metrics.js';
import { myLinks, scope, type Link, type OrdersCtx } from './orders.service.js';
import { invalid, isUuid } from './slot.service.js';

type Row = Record<string, any>;
type Out = { status: number; body?: Record<string, unknown> | Uint8Array; headers?: Record<string, string> };
export interface ReportsCtx extends OrdersCtx {
  readonly ports?: { ReportingPort?: { openReleasedReportFile(ctx: unknown, i: { reportId: string; versionNo: number }): Promise<{ sha256: string; signedUrl: string }> } };
  readonly rateLimit?: { consume(tier: string, key: string): Promise<unknown> };
  readonly audit?: { access(e: Record<string, unknown>): Promise<unknown> };
}

const MAX_ROWS = 1000; // ponytail: a patient has far fewer reports than this; paging is done over that window, move the keyset into SQL if it ever grows
const DEFAULT_LIMIT = 50, MAX_LIMIT = 200;
const CURSOR = /^[A-Za-z0-9_-]{1,400}$/;
const ms = (v: unknown): number => new Date(v as string).getTime();
const iso = (v: unknown): string => new Date(v as string).toISOString();
const obj = (v: unknown): Record<string, any> => (typeof v === 'object' && v !== null ? (v as Record<string, any>) : {});
const notFound = (): never => { throw new LimsError('common.not_found'); };
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const unavailable = (): LimsError => new LimsError('common.dependency_unavailable');

function reportDto(r: Row, link: Link): Record<string, unknown> {
  return {
    report_id: r['report_id'], version_no: Number(r['version_no']), order_id: r['order_id'], profile_id: link.id, kind: r['report_kind'], status: r['status'], released_at: iso(r['released_at']),
    panel_names: r['panel_names'] ?? [], smart_summary_available: r['smart_summary_available'] === true,
    ...(r['supersedes_version_no'] != null ? { supersedes_version_no: Number(r['supersedes_version_no']) } : {}),
  };
}
const COLS = 'report_id, version_no, order_id, patient_id, report_kind, status, released_at, panel_names, smart_summary_available, supersedes_version_no';

function parseList(q: Record<string, any>): { profileId?: string; orderId?: string; superseded: boolean; limit: number; after?: { t: number; id: string; v: number } } {
  const out: ReturnType<typeof parseList> = { superseded: false, limit: DEFAULT_LIMIT };
  if (q['profile_id'] !== undefined) { if (!isUuid(q['profile_id'])) invalid('/profile_id'); out.profileId = q['profile_id']; }
  if (q['order_id'] !== undefined) { if (!isUuid(q['order_id'])) invalid('/order_id'); out.orderId = q['order_id']; }
  if (q['include_superseded'] !== undefined) {
    const s = q['include_superseded']; if (s !== true && s !== false && s !== 'true' && s !== 'false') invalid('/include_superseded');
    out.superseded = s === true || s === 'true';
  }
  if (q['sort'] !== undefined && q['sort'] !== '-released_at') invalid('/sort');
  if (q['limit'] !== undefined) { const n = Number(q['limit']); if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) invalid('/limit'); out.limit = n; }
  if (q['cursor'] !== undefined) {
    const [t, id, v] = typeof q['cursor'] === 'string' && CURSOR.test(q['cursor']) ? Buffer.from(q['cursor'], 'base64url').toString('utf8').split('|') : [];
    if (!t || !Number.isFinite(Date.parse(t)) || !isUuid(id) || !Number.isInteger(Number(v))) invalid('/cursor');
    out.after = { t: Date.parse(t!), id: id!, v: Number(v) };
  }
  return out;
}

/** The port's own errors are folded to the two codes the TRD §6.2 table allows; anything else is a dependency failure. */
const portError = (e: unknown): LimsError => (e as { code?: unknown })?.code === 'common.not_found' ? new LimsError('common.not_found') : unavailable();

async function readFile(url: string): Promise<Buffer> {
  try {
    const res = await fetch(url);
    if (!res.ok) throw unavailable();
    return Buffer.from(await res.arrayBuffer());
  } catch { throw unavailable(); } // connection reset mid-stream, DNS, TLS ... (never echo the URL)
}

/** E24 view: only the displayed fields of the stored snapshot (SmartSummaryView is additionalProperties:false); optional parts are omitted, never null. */
function smartView(reportId: string, versionNo: number, approvedAt: unknown, s: Row): Record<string, unknown> {
  const list = (v: unknown): Row[] => (Array.isArray(v) ? v.map(obj) : []);
  const hs = obj(s['healthScore']);
  return {
    report_id: reportId, version_no: versionNo, approved_at: iso(approvedAt),
    ...(typeof hs['value'] === 'number' && typeof hs['band'] === 'string' ? { health_score: { value: hs['value'], band: hs['band'] } } : {}),
    panels: list(s['panels']).map((p) => ({ panel_code: p['panelCode'], ...(typeof p['displayName'] === 'string' ? { display_name: p['displayName'] } : {}), status: p['status'] })),
    deranged: list(s['deranged']).map((d) => ({ direction: d['direction'], severity: d['severity'], text: d['text'] })),
    advice: list(s['advice']).map((a) => ({ text: a['text'] })),
    follow_ups: list(s['followUps']).map((f) => ({ interval_days: f['intervalDays'], text: f['text'] })),
    trends: list(s['trends']).map((t) => ({ direction: t['direction'] })),
    ...(typeof s['disclaimerText'] === 'string' ? { disclaimer_text: s['disclaimerText'] } : {}),
  };
}

export function createReportService() {
  return {
    /** E24 (T-P4): the stored approved summary of one report version, from the local copy only (no port call). 404 for everything hidden: foreign / unknown report, feature off, no stored copy, not approved. */
    async smart(ctx: ReportsCtx, req: { reportId: unknown; versionNo: unknown }): Promise<Out> {
      const { tx, tenantId, membershipId } = scope(ctx);
      if (!isUuid(req.reportId)) return invalid('/report_id');
      const versionNo = typeof req.versionNo === 'number' ? req.versionNo : typeof req.versionNo === 'string' && /^\d{1,4}$/.test(req.versionNo) ? Number(req.versionNo) : NaN;
      if (!Number.isInteger(versionNo) || versionNo < 1 || versionNo > 9999) return invalid('/version_no');
      if (!ctx.audit) throw new LimsError('common.service_unavailable'); // never serve without the access log (07 rule 7)
      const links = await myLinks(tx, tenantId, membershipId);
      const r = (await tx.query('SELECT patient_id, released_at FROM engagement.patient_reports WHERE tenant_id = $1 AND report_id = $2 AND version_no = $3', [tenantId, req.reportId, versionNo])).rows[0];
      const link = r ? links.find((l) => l.patientId === r['patient_id']) : undefined;
      if (!r || !link || (link.visibleFrom && ms(r['released_at']) < ms(link.visibleFrom))) return notFound();
      const on = (await tx.query('SELECT smart_report_in_app FROM engagement.settings WHERE tenant_id = $1', [tenantId])).rows[0]?.['smart_report_in_app'] === true;
      const row = on ? (await tx.query('SELECT summary, approved_at FROM engagement.smart_summaries WHERE tenant_id = $1 AND report_id = $2 AND report_version_no = $3', [tenantId, req.reportId, versionNo])).rows[0] : undefined;
      const s = row ? obj(typeof row['summary'] === 'string' ? JSON.parse(row['summary']) : row['summary']) : undefined;
      if (!row || !s || s['status'] !== 'approved') return notFound();
      await ctx.audit.access({ action: 'smart_summary.view', entityType: 'report', entityId: req.reportId, outcome: 'allowed' });
      return { status: 200, body: smartView(req.reportId, versionNo, row['approved_at'], s), headers: { 'cache-control': 'no-store' } };
    },

    /** E22. */
    async list(ctx: ReportsCtx, req: { query: unknown }): Promise<Out> {
      const { tx, tenantId, membershipId } = scope(ctx);
      const p = parseList(obj(req.query));
      let links = await myLinks(tx, tenantId, membershipId);
      if (p.profileId) links = links.filter((l) => l.id === p.profileId); // a foreign profile_id matches nothing
      const byPatient = new Map(links.map((l) => [l.patientId, l]));
      const groups = new Map<string, Link[]>(); for (const l of links) groups.set(l.visibleFrom ?? '', [...(groups.get(l.visibleFrom ?? '') ?? []), l]);
      const found: Row[] = [];
      for (const [from, ls] of groups) {
        const vals: unknown[] = [tenantId, ls.map((l) => l.patientId)]; let extra = '';
        if (from) { vals.push(from); extra = ` AND released_at >= $${vals.length}`; }
        found.push(...(await tx.query(`SELECT ${COLS} FROM engagement.patient_reports WHERE tenant_id = $1 AND patient_id = ANY($2::uuid[])${extra} ORDER BY released_at DESC, report_id, version_no LIMIT ${MAX_ROWS}`, vals)).rows);
      }
      let rows = found.filter((r) => (p.superseded || r['status'] !== 'superseded') && (!p.orderId || r['order_id'] === p.orderId))
        .sort((a, b) => ms(b['released_at']) - ms(a['released_at']) || cmp(a['report_id'], b['report_id']) || Number(a['version_no']) - Number(b['version_no']));
      if (p.after) { const { t, id, v } = p.after; rows = rows.filter((r) => ms(r['released_at']) < t || (ms(r['released_at']) === t && (cmp(r['report_id'], id) > 0 || (r['report_id'] === id && Number(r['version_no']) > v)))); }
      const page = rows.slice(0, p.limit); const last = page[page.length - 1];
      const next = rows.length > p.limit && last ? Buffer.from(`${iso(last['released_at'])}|${last['report_id']}|${last['version_no']}`).toString('base64url') : undefined;
      return { status: 200, body: { data: page.map((r) => reportDto(r, byPatient.get(r['patient_id'])!)), page: { limit: p.limit, ...(next ? { next_cursor: next } : {}) } }, headers: { 'cache-control': 'no-store' } };
    },

    /** E23: visibility (404) -> rate limit -> port -> storage -> sha256 -> access log -> bytes. */
    async download(ctx: ReportsCtx, req: { reportId: unknown; versionNo: unknown }): Promise<Out> {
      const { tx, tenantId, membershipId } = scope(ctx);
      if (!isUuid(req.reportId)) return invalid('/report_id');
      const versionNo = Number(req.versionNo);
      if (!Number.isInteger(versionNo) || versionNo < 1 || versionNo > 9999) return invalid('/version_no');
      if (!ctx.rateLimit || !ctx.ports?.ReportingPort || !ctx.audit) throw new LimsError('common.service_unavailable'); // never serve without limiter, port and access log (REQ-SEC-099)
      const links = await myLinks(tx, tenantId, membershipId);
      const r = (await tx.query(`SELECT ${COLS} FROM engagement.patient_reports WHERE tenant_id = $1 AND report_id = $2 AND version_no = $3`, [tenantId, req.reportId, versionNo])).rows[0];
      const link = r ? links.find((l) => l.patientId === r['patient_id']) : undefined;
      if (!r || !link || (link.visibleFrom && ms(r['released_at']) < ms(link.visibleFrom))) return notFound();
      await ctx.rateLimit.consume('report_download', `l:${link.id}`); // 20 / hour / link (04 §4); 429 + Retry-After, or 503 when the backend is down (fails closed)
      let file: { sha256: string; signedUrl: string };
      try { file = await ctx.ports.ReportingPort.openReleasedReportFile(ctx, { reportId: r['report_id'], versionNo }); } catch (e) { const err = portError(e); engagementMetrics.reportDownload(ctx, err.code === 'common.not_found' ? 'not_found' : 'unavailable'); throw err; }
      let bytes: Buffer;
      try { bytes = await readFile(file.signedUrl); } catch (e) { engagementMetrics.reportDownload(ctx, 'unavailable'); throw e; }
      const digest = createHash('sha256').update(bytes).digest('hex');
      if (typeof file.sha256 !== 'string' || digest !== file.sha256.toLowerCase()) { engagementMetrics.reportDownload(ctx, 'integrity'); throw unavailable(); } // corrupted / truncated: no bytes, no access-log row (07 E23)
      await ctx.audit.access({ action: 'report.download', entityType: 'report', entityId: r['report_id'], outcome: 'allowed' });
      engagementMetrics.reportDownload(ctx, 'ok');
      return { status: 200, body: new Uint8Array(bytes), headers: {
        'content-type': 'application/pdf', 'content-disposition': `attachment; filename="report-${versionNo}.pdf"`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-length': String(bytes.length),
      } };
    },
  };
}
export type ReportService = ReturnType<typeof createReportService>;
