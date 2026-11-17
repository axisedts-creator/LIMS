// Exports, API side (02-TRD §10.1 request, §10.3 download; PRD US-17.1/.4/.5/.6/.7/.8; 07-SECURITY E1-E4, E7, P9, X2, X14, X16).
// Handlers authorise first (assertRole); everything here runs on the caller's user transaction (RLS: own exports only).
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { LimsError } from '../../../core/errors.js';
import { contentDisposition } from '../../../core/storage/download.js';
import { loadAnalyticsConfig } from '../config.js';
import { businessDateOf } from '../domain/period.js';
import { toExportDto } from '../mappers/exports.dto.js';
import * as repo from '../repository/exports.repo.js';
import { checkReportParams } from '../export/reportTable.js';
import { checkInt, checkUuidList, invalidField } from './reports.service.js';

type Ctx = {
  tenantId: string; now(): string; tx: repo.ExportsTx;
  actor: { id: string; membershipId?: string | undefined };
  audit: { access(e: object): Promise<unknown> };
};

const FORMATS = ['xlsx', 'csv', 'pdf'] as const;
const STATUSES = ['queued', 'building', 'ready', 'failed', 'expired'] as const;
const PARAM_KEYS = ['business_date_from', 'business_date_to', 'bs_month', 'fiscal_year_bs', 'centre_id', 'branch_id', 'group_by', 'filters'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export interface CreateBody { report_code: string; format: (typeof FORMATS)[number]; params: Record<string, unknown> }

/** X2: closed body shape. `report_code` is only a bounded string here: the registry decides unknown (404). */
export function parseCreateBody(body: unknown): CreateBody {
  if (!isObj(body) || Object.keys(body).some((k) => !['report_code', 'format', 'params'].includes(k))) throw invalidField('body');
  const { report_code: code, format, params } = body;
  if (typeof code !== 'string' || code.length < 1 || code.length > 32) throw invalidField('report_code');
  if (typeof format !== 'string' || !(FORMATS as readonly string[]).includes(format)) throw invalidField('format');
  if (!isObj(params)) throw invalidField('params');
  return { report_code: code, format: format as CreateBody['format'], params };
}

/** ExportParams (closed object, 4,096 B cap = exports__params_size__ck). Period / scope values are validated by resolvePeriod / resolveScope. */
export function checkParams(code: string, params: Record<string, unknown>): void {
  if (Object.keys(params).some((k) => !PARAM_KEYS.includes(k)) || Buffer.byteLength(JSON.stringify(params), 'utf8') > 4096) throw invalidField('params');
  for (const k of ['business_date_from', 'business_date_to', 'bs_month', 'fiscal_year_bs', 'group_by']) {
    if (params[k] !== undefined && (typeof params[k] !== 'string' || (params[k] as string).length > 32)) throw invalidField(`params.${k}`);
  }
  checkUuidList(params.centre_id, 'params.centre_id', 20);
  checkUuidList(params.branch_id, 'params.branch_id', 20);
  if (params.filters !== undefined && !isObj(params.filters)) throw invalidField('params.filters');
  checkReportParams(code, params);
}

const rateLimited = (seconds: number): LimsError => Object.assign(new LimsError('common.rate_limited'), { retryAfterSeconds: Math.max(1, Math.ceil(seconds)) });
const NPT_MS = (5 * 60 + 45) * 60_000;

/** Quota (TRD §10.1 step 5) then insert, audit, enqueue. The advisory lock is held until commit: count + insert are one critical section per tenant (X16). */
export async function createExport(
  ctx: Ctx, a: { body: CreateBody; scope: { all: boolean; centreIds: readonly string[] }; from: string; to: string },
) {
  const membershipId = ctx.actor.membershipId;
  if (!membershipId) throw new LimsError('auth.forbidden');
  const cfg = loadAnalyticsConfig();
  const now = Date.parse(ctx.now());

  await repo.lockQuota(ctx.tx, ctx.tenantId);
  const user = await repo.countUserHour(ctx.tx, { tenantId: ctx.tenantId, membershipId });
  if (user.count >= cfg.exportsPerUserHour) {
    throw rateLimited(user.oldest ? (user.oldest.getTime() + 3_600_000 - now) / 1000 : 3600); // until the oldest falls out of the hour
  }
  const day = businessDateOf(ctx.now() as never);
  const tenant = await repo.countTenantDay(ctx.tx, { tenantId: ctx.tenantId, day });
  if (tenant.count >= cfg.exportsPerTenantDay) {
    const nextMidnight = (Math.floor((now + NPT_MS) / 86_400_000) + 1) * 86_400_000 - NPT_MS; // next Asia/Kathmandu midnight
    throw rateLimited((nextMidnight - now) / 1000);
  }

  const row = await repo.insertExport(ctx.tx, {
    id: uuidv7(), tenantId: ctx.tenantId, membershipId, reportCode: a.body.report_code, format: a.body.format, params: a.body.params,
    scopeAll: a.scope.all, scopeCentreIds: a.scope.all ? [] : a.scope.centreIds, downloadsAllowed: cfg.exportDownloads, actorId: ctx.actor.id,
  });
  await ctx.audit.access({
    action: 'data.export', entityType: 'analytics_export', entityId: row.id, outcome: 'allowed',
    detail: { report_code: a.body.report_code, format: a.body.format, phase: 'request', from: a.from, to: a.to },
  });
  await ctx.tx.query('SELECT app.enqueue_job($1, $2::jsonb, $3)', ['analytics.build_export', JSON.stringify({ tenant_id: ctx.tenantId, export_id: row.id }), row.id]);
  return toExportDto(row);
}

const own = (ctx: Ctx): string => {
  if (!ctx.actor.membershipId) throw new LimsError('auth.forbidden');
  return ctx.actor.membershipId;
};
const idOf = (v: unknown): string => {
  if (typeof v !== 'string' || !UUID.test(v)) throw invalidField('export_id');
  return v;
};

export async function getExport(ctx: Ctx, exportId: unknown) {
  const row = await repo.getOwn(ctx.tx, { tenantId: ctx.tenantId, membershipId: own(ctx), id: idOf(exportId) });
  if (!row) throw new LimsError('common.not_found'); // another user's / another tenant's / unknown: one shape (P9)
  return toExportDto(row);
}

export async function listExports(ctx: Ctx, q: Record<string, any>) {
  const limit = checkInt(q.limit, 'limit', 1, 50, 20);
  const raw = q.status === undefined ? [] : Array.isArray(q.status) ? q.status : typeof q.status === 'string' ? q.status.split(',') : null;
  if (raw === null || raw.length > 5 || raw.some((s: unknown) => !(STATUSES as readonly string[]).includes(s as string))) throw invalidField('status');
  let after: { requestedAt: string; id: string } | undefined;
  if (q.cursor !== undefined) {
    try {
      const c = JSON.parse(Buffer.from(String(q.cursor), 'base64url').toString('utf8'));
      if (typeof c?.t !== 'string' || Number.isNaN(Date.parse(c.t)) || !UUID.test(c?.id)) throw new Error('bad');
      after = { requestedAt: c.t, id: c.id };
    } catch { throw new LimsError('common.invalid_cursor'); }
  }
  const rows = await repo.listOwn(ctx.tx, { tenantId: ctx.tenantId, membershipId: own(ctx), statuses: raw, limit: limit + 1, after });
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const next = rows.length > limit && last ? Buffer.from(JSON.stringify({ t: new Date(last.requested_at).toISOString(), id: last.id })).toString('base64url') : undefined;
  return { data: page.map(toExportDto), page: { limit, ...(next ? { next_cursor: next } : {}) } };
}

const EXT = { xlsx: 'xlsx', csv: 'csv', pdf: 'pdf' } as const;
const day = (v: unknown, dflt: string): string => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : dflt);

/** TRD §10.3. Order: own row (404) -> state (409/410) -> atomic counter (410) -> file -> access log (a failed write fails the call: no un-logged bytes). */
export async function downloadExport(ctx: Ctx, exportId: unknown) {
  const membershipId = own(ctx);
  const id = idOf(exportId);
  const row = await repo.getOwn(ctx.tx, { tenantId: ctx.tenantId, membershipId, id });
  if (!row) throw new LimsError('common.not_found');
  if (row.status === 'queued' || row.status === 'building') throw new LimsError('analytics.export_not_ready');
  if (row.status !== 'ready') throw new LimsError('analytics.export_unavailable');

  const claimed = await repo.claimDownload(ctx.tx, { tenantId: ctx.tenantId, id, actorId: ctx.actor.id, membershipId });
  if (!claimed) throw new LimsError('analytics.export_unavailable'); // expired or limit reached (also the loser of a race, X14)
  const file = await repo.readFile(ctx.tx, { tenantId: ctx.tenantId, id });
  if (!file) throw new LimsError('analytics.export_unavailable'); // purged between the two statements; the tx rolls the counter back

  await ctx.audit.access({
    action: 'data.export', entityType: 'analytics_export', entityId: id, outcome: 'allowed',
    detail: { phase: 'download', rows: Number(claimed.row_count ?? 0), sha256_prefix8: file.sha256.slice(0, 8) },
  });
  const requestedDay = new Date(claimed.requested_at).toISOString().slice(0, 10);
  const from = day(claimed.params.business_date_from, requestedDay), to = day(claimed.params.business_date_to, requestedDay);
  // P-2: attachment + nosniff + no-store; the name is generated from the registry code and dates, never from stored free text. Never a signed URL.
  return {
    status: 200, body: file.content as Uint8Array,
    headers: {
      'content-type': file.content_type, 'content-disposition': contentDisposition('attachment', `${claimed.report_code}_${from}_${to}.${EXT[claimed.format]}`),
      'x-content-type-options': 'nosniff', 'cache-control': 'no-store', 'content-length': String(file.content.length),
    },
  };
}
