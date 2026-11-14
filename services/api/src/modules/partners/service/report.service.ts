// C13 T13 — partner reports R1 (list), R2 (mark seen), R3 (download). 02-TRD §5.2, §10.2 (report_download_daily_cap_per_user), §11, §13; 03-APP-FLOW §4.4, §5.4; 05-SCHEMA §3.7; 07-SECURITY ST2, ST11, ST13;
// 03-INTERFACE-CATALOG §4.7 ReportingPort.openReleasedReportFile (CR-C13-005). Gate, DTO and validation helpers are shared with tracking.service.ts.
// R3 order: gate -> params -> own order_reports row (tenant + partner bound) else 404 + denied access log, committed (ctx.commitOnError), no port call, no fetch
//   -> ctx.rateLimit.consume('report_download', partner_user:<id>:report:<report_id>) -> daily cap (increment first, atomic; over the cap -> 429 and the request rolls the increment back)
//   -> ReportingPort.openReleasedReportFile(REQUEST ctx: partner claims, never a system actor) -> fetch of the signed URL -> sha256 of the bytes must equal the port's sha256 (ST11)
//   -> allowed access log -> 200 with the bytes. A hash mismatch / storage failure throws, so the increment is rolled back and no allowed row exists; the signed URL is never logged or put in an error.
// [CONV] a port common.not_found for an own row is a denied attempt (404 + denied log, committed); the committed request keeps the cap increment made before the port call (own cap only, harmless).
// [CONV] metrics via ctx.metrics?.inc (not on the request ctx yet): lims_partners_report_downloads_total{outcome=allowed|denied|rate_limited}.
// [CONV] ponytail: the PDF is buffered (OpenAPI maxLength 100 MB) so its hash is known before the first byte leaves; stream through the core download helper if files outgrow that.
import { createHash } from 'node:crypto';
import { LimsError } from '../../../core/errors.js';
import type { HandlerContext, HandlerRequest, HandlerResult } from '../../../core/module.js';
import { bad, closed, isObj, uuidParam } from './partner-user.service.js';
import { listParams, page } from './referrer.service.js';
import { flag, gate, instant, PERM, REPORT_COLS, reportDto, type Obj, type Q } from './tracking.service.js';

const DEFAULT_DAILY_CAP = 500; // 02-TRD §10.2
const MAX_BYTES = 104_857_600; // OpenAPI downloadPartnerReport maxLength
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const METRIC = 'lims_partners_report_downloads_total';

const REPORTS = `SELECT ${REPORT_COLS} FROM partners.order_reports WHERE tenant_id = $1 AND partner_id = $2`;
const LINE_NAMES = 'SELECT order_id, registration_no, patient_full_name FROM partners.manifest_lines WHERE tenant_id = $1 AND partner_id = $2 AND order_id = ANY($3::uuid[])';
const ONE_REPORT = 'SELECT order_id, receiving_centre_id FROM partners.order_reports WHERE tenant_id = $1 AND partner_id = $2 AND report_id = $3 AND version_no = $4';
const TRACKING_NO = 'SELECT registration_no FROM partners.order_tracking WHERE tenant_id = $1 AND partner_id = $2 AND order_id = $3';
const SETTINGS = 'SELECT report_download_daily_cap_per_user FROM partners.settings WHERE tenant_id = $1';
const COUNT_SQL = 'INSERT INTO partners.download_counters (tenant_id, partner_user_id, day, partner_id, count, created_by, updated_by) VALUES ($1, $2, $3::date, $4, 1, $5, $5) '
  + 'ON CONFLICT (tenant_id, partner_user_id, day) DO UPDATE SET count = partners.download_counters.count + 1, updated_at = now(), updated_by = $5 RETURNING count';
const SEEN_SQL = 'UPDATE partners.order_reports SET is_new = false, seen_at = $3, seen_by = $4, updated_at = now(), updated_by = $4 WHERE tenant_id = $1 AND partner_id = $2 AND is_new = true AND (report_id, version_no) IN ';

const notFound = () => new LimsError('common.not_found');
const metric = (ctx: HandlerContext, outcome: 'allowed' | 'denied' | 'rate_limited') => {
  (ctx as { metrics?: { inc?(name: string, labels?: Obj): void } }).metrics?.inc?.(METRIC, { outcome });
};
const version = (v: unknown, path: string): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^[0-9]{1,5}$/.test(v) ? Number(v) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > 10000) throw bad(path);
  return n;
};

// ---------------------------------------------------------------- R1
/** R1 listPartnerReports */
export async function listReports(req: HandlerRequest, ctx: HandlerContext): Promise<HandlerResult> {
  const ref = await gate(ctx, PERM.report);
  const { query, limit, offset } = listParams(req.query, ['released_at_from', 'released_at_to', 'is_new', 'include_superseded', 'sort', 'cursor', 'limit']);
  if (query['sort'] !== undefined && query['sort'] !== '-released_at') throw bad('/sort');
  const values: unknown[] = [ctx.tenantId, ref.partnerId];
  let sql = REPORTS;
  const and = (clause: (n: number) => string, v: unknown) => { values.push(v); sql += ` AND ${clause(values.length)}`; };
  if (query['released_at_from'] !== undefined) and((n) => `released_at >= $${n}`, instant(query['released_at_from'], '/released_at_from'));
  if (query['released_at_to'] !== undefined) and((n) => `released_at <= $${n}`, instant(query['released_at_to'], '/released_at_to'));
  if (query['is_new'] !== undefined) and((n) => `is_new = $${n}`, flag(query['is_new'], '/is_new'));
  const superseded = query['include_superseded'] === undefined ? false : flag(query['include_superseded'], '/include_superseded');
  if (!superseded) sql += " AND status = 'valid'";
  values.push(limit + 1, offset);
  const tx = ctx.tx as Q;
  const rows = (await tx.query(`${sql} ORDER BY released_at DESC, report_id DESC, version_no DESC LIMIT $${values.length - 1} OFFSET $${values.length}`, values)).rows as Obj[]; // placeholders only
  const shown = rows.slice(0, limit);
  const lines = new Map<string, Obj>();
  if (shown.length) for (const l of (await tx.query(LINE_NAMES, [ctx.tenantId, ref.partnerId, [...new Set(shown.map((r) => String(r['order_id'])))]])).rows as Obj[]) lines.set(String(l['order_id']), l);
  const data = shown.flatMap((r) => { const l = lines.get(String(r['order_id'])); return l ? [reportDto(r, String(l['registration_no'] ?? ''), String(l['patient_full_name']))] : []; }); // no line: cannot happen under the FKs
  return { status: 200, body: { data, page: page(limit, offset, rows.length) } };
}

// ---------------------------------------------------------------- R2
/** R2 markPartnerReportsSeen: only the caller's own, still-new versions change; foreign / unknown / already-seen ids are skipped and never revealed. */
export async function markSeen(req: HandlerRequest, ctx: HandlerContext): Promise<HandlerResult> {
  const ref = await gate(ctx, PERM.report);
  const list = closed(req.body, ['report_versions'])['report_versions'];
  if (!Array.isArray(list) || list.length < 1 || list.length > 200) throw bad('/report_versions');
  const pairs = new Map<string, [string, number]>();
  list.forEach((item, i) => {
    const o = closed(item, ['report_id', 'version_no']);
    const id = o['report_id'];
    if (typeof id !== 'string' || !UUID.test(id)) throw bad(`/report_versions/${i}/report_id`);
    const n = o['version_no'];
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 10000) throw bad(`/report_versions/${i}/version_no`);
    pairs.set(`${id.toLowerCase()}:${n}`, [id.toLowerCase(), n]);
  });
  const values: unknown[] = [ctx.tenantId, ref.partnerId, ctx.now(), ctx.actor!.id];
  const tuples = [...pairs.values()].map(([id, n]) => { values.push(id, n); return `($${values.length - 1}::uuid, $${values.length})`; });
  const { rows } = await (ctx.tx as Q).query(`${SEEN_SQL}(${tuples.join(', ')}) RETURNING report_id`, values);
  return { status: 200, body: { updated: rows.length } };
}

// ---------------------------------------------------------------- R3
/** Denied: indistinguishable 404 + denied access log, committed even though the request fails (REQ-SEC-100, AB-download). entityId stays out: the version of an unknown / foreign report is not known. */
async function deny(ctx: HandlerContext, centreId?: unknown): Promise<never> {
  metric(ctx, 'denied');
  if (!ctx.audit) throw new LimsError('common.internal');
  await ctx.audit.access({ action: 'report.download', entityType: 'report_version', outcome: 'denied', ...(typeof centreId === 'string' ? { centreId } : {}) });
  ctx.commitOnError?.();
  throw notFound();
}
async function dailyCap(ctx: HandlerContext, partnerId: string, partnerUserId: string): Promise<void> {
  const tx = ctx.tx as Q;
  const s = (await tx.query(SETTINGS, [ctx.tenantId])).rows[0]?.['report_download_daily_cap_per_user'];
  const cap = typeof s === 'number' && Number.isInteger(s) && s >= 0 ? s : DEFAULT_DAILY_CAP;
  const day = new Date(ctx.now() as string).toISOString().slice(0, 10); // ctx.now() date (UTC)
  const n = Number((await tx.query(COUNT_SQL, [ctx.tenantId, partnerUserId, day, partnerId, ctx.actor!.id])).rows[0]?.['count']);
  if (!Number.isFinite(n)) throw new LimsError('common.internal');
  if (n > cap) { metric(ctx, 'rate_limited'); throw new LimsError('common.rate_limited'); } // the failing request rolls the increment back
}
/** Bytes of the signed URL. Any failure -> dependency_unavailable WITHOUT cause / URL (the URL is a credential). */
async function fetchBytes(url: string): Promise<Uint8Array> {
  let res: Response;
  try { res = await fetch(url); } catch { throw new LimsError('common.dependency_unavailable'); }
  if (!res.ok) throw new LimsError('common.dependency_unavailable');
  let bytes: Uint8Array;
  try { bytes = new Uint8Array(await res.arrayBuffer()); } catch { throw new LimsError('common.dependency_unavailable'); }
  if (bytes.byteLength > MAX_BYTES) throw new LimsError('common.internal');
  return bytes;
}

/** R3 downloadPartnerReport */
export async function downloadReport(req: HandlerRequest, ctx: HandlerContext): Promise<HandlerResult> {
  const ref = await gate(ctx, PERM.report);
  const reportId = uuidParam(req.params, 'report_id');
  const versionNo = version(isObj(req.params) ? req.params['version_no'] : undefined, '/version_no');
  const tx = ctx.tx as Q;
  const own = (await tx.query(ONE_REPORT, [ctx.tenantId, ref.partnerId, reportId, versionNo])).rows[0] as Obj | undefined;
  if (!own) return deny(ctx); // unknown / unreleased / other partner / other tenant: one answer
  if (!ctx.rateLimit || !ctx.audit) throw new LimsError('common.internal'); // fail closed
  try { await ctx.rateLimit.consume('report_download', `partner_user:${ref.partnerUserId}:report:${reportId}`); } catch (e) {
    if (e instanceof LimsError && e.code === 'common.rate_limited') metric(ctx, 'rate_limited');
    throw e;
  }
  await dailyCap(ctx, ref.partnerId, ref.partnerUserId);

  let file: Obj;
  try { file = await ctx.ports.ReportingPort.openReleasedReportFile(ctx, { reportId, versionNo }) as Obj; } catch (e) {
    if (e instanceof LimsError && e.code === 'common.not_found') return deny(ctx, own['receiving_centre_id']);
    throw e; // C6 down etc.: propagates unchanged
  }
  const versionId = file['reportVersionId'], expected = file['sha256'], url = file['signedUrl'];
  if (typeof url !== 'string' || typeof expected !== 'string' || typeof versionId !== 'string' || file['reportId'] !== reportId || file['versionNo'] !== versionNo) throw new LimsError('common.internal');
  const bytes = await fetchBytes(url);
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expected.toLowerCase()) { // ST11: nothing is returned; ids only in the log
    ctx.log.error({ event: 'report_hash_mismatch', report_id: reportId, version_no: versionNo, report_version_id: versionId });
    throw new LimsError('common.internal');
  }
  await ctx.audit.access({ action: 'report.download', entityType: 'report_version', entityId: versionId, outcome: 'allowed', ...(typeof own['receiving_centre_id'] === 'string' ? { centreId: own['receiving_centre_id'] } : {}) });
  metric(ctx, 'allowed');
  const no = String((await tx.query(TRACKING_NO, [ctx.tenantId, ref.partnerId, own['order_id']])).rows[0]?.['registration_no'] ?? '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40);
  return {
    status: 200,
    headers: {
      'content-type': 'application/pdf', 'content-disposition': `attachment; filename="report-${no || 'report'}-v${versionNo}.pdf"`,
      'x-content-type-options': 'nosniff', 'cache-control': 'no-store', 'x-lims-sha256': actual,
    },
    body: bytes,
  };
}
