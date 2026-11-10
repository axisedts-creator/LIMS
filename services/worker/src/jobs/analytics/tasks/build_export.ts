// `analytics.build_export` (02-TRD §10.2 steps 1-9; max_attempts 3). System actor: RLS is tenant-wide, so the explicit effective scope handed to
// the report services is the enforcement (P8). The job runs in ONE tx (ctx.db.tx reuses it), so the build runs behind a savepoint: any failure first rolls
// back to it (also clears an aborted tx). Terminal failures and the final attempt commit 'failed' and RESOLVE (step 8a); retryable ones REJECT, the job tx
// rolls back and the committed row stays 'queued' (E6).
import { createHash } from 'node:crypto';
import { adToBs, formatBs, type IsoDate } from '../../../../../../packages/shared-ts/src/bsdate/index.js';
import { loadAnalyticsConfig } from '../../../../../api/src/modules/analytics/config.js';
import { evaluateFreshness } from '../../../../../api/src/modules/analytics/domain/freshness.js';
import { businessDateOf, resolvePeriod } from '../../../../../api/src/modules/analytics/domain/period.js';
import { getReport } from '../../../../../api/src/modules/analytics/domain/reportRegistry.js';
import { intersect } from '../../../../../api/src/modules/analytics/domain/scope.js';
import { writeCsv } from '../../../../../api/src/modules/analytics/export/CsvWriter.js';
import { type ExportMeta } from '../../../../../api/src/modules/analytics/export/layout.js';
import { buildPdfData } from '../../../../../api/src/modules/analytics/export/PdfRequest.js';
import { buildReport } from '../../../../../api/src/modules/analytics/export/reportTable.js';
import { writeXlsx } from '../../../../../api/src/modules/analytics/export/XlsxWriter.js';
import * as repo from '../../../../../api/src/modules/analytics/repository/exports.repo.js';
import { loadFamilyStates } from '../../../../../api/src/modules/analytics/repository/refresh.repo.js';
import type { TaskHandler } from '../../../core/manifest.js';
import { jobTenant } from './shared.js';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NPT_MS = (5 * 60 + 45) * 60_000;
const HOUR_MS = 3_600_000;

/** A failure that ends the export without a retry. `alert` = a C8 data/contract bug that someone must look at. */
class Terminal extends Error { constructor(readonly failure: string, readonly alert = false) { super(failure); } }
const codeOf = (e: unknown): string | undefined => (typeof (e as { code?: unknown } | null)?.code === 'string' ? (e as { code: string }).code : undefined);

const local = (iso: string): string => new Date(Date.parse(iso) + NPT_MS).toISOString().slice(0, 16).replace('T', ' ');

export const buildExportTask: TaskHandler = async (payload, jctx) => {
  const ctx = jctx as any;
  const tenantId = jobTenant(payload, jctx, 'analytics.build_export');
  const exportId = (payload as { export_id?: unknown }).export_id;
  if (typeof exportId !== 'string' || !UUID.test(exportId)) throw new TypeError('analytics.build_export: payload.export_id must be a uuid');
  const actorId: string = ctx.actor.id;
  const key = { tenantId, id: exportId, actorId };

  const row = await repo.loadForBuild(ctx.tx, { tenantId, id: exportId }); // step 1 (FOR UPDATE)
  if (!row || (row.status !== 'queued' && row.status !== 'building')) return;

  // TRD §13: ids, report code, format, counts, failure code only; telemetry never fails the job.
  const tele = (outcome: 'ready' | 'failed', extra: { rows?: number; failure_code?: string }) => {
    try {
      const f = { tenant_id: tenantId, export_id: exportId, report_code: row.report_code, format: row.format, ...extra };
      ctx.metrics?.inc?.('lims_analytics_exports_total', { tenant_id: tenantId, format: row.format, outcome });
      if (outcome === 'ready') { ctx.metrics?.observe?.('lims_analytics_export_rows', extra.rows ?? 0, { report_code: row.report_code }); ctx.log?.info?.({ event: 'analytics_export_built', ...f }); }
      else ctx.log?.error?.({ event: 'analytics_export_failed', ...f });
    } catch { /* ignore */ }
  };

  await ctx.tx.query('SAVEPOINT build_export', []);
  try {
    tele('ready', { rows: await build(ctx, row, key) });
  } catch (e) {
    await ctx.tx.query('ROLLBACK TO SAVEPOINT build_export', []);
    if (e instanceof Terminal) {
      tele('failed', { failure_code: e.failure });
      await repo.markFailed(ctx.tx, { ...key, code: e.failure });
      return;
    }
    if (ctx.attempt >= ctx.maxAttempts) {
      tele('failed', { failure_code: 'common.internal' });
      await repo.markFailed(ctx.tx, { ...key, code: 'common.internal' });
      return; // resolve so the committed 'failed' survives
    }
    throw e;
  }
};

async function build(ctx: any, row: repo.ExportRecord, key: { tenantId: string; id: string; actorId: string }): Promise<number> {
  const cfg = loadAnalyticsConfig();
  const { tenantId, id: exportId, actorId } = key;
  const report = getReport(row.report_code);

  // step 2: the requester is re-validated now, not trusted from request time (X13)
  let member: any;
  try { member = await ctx.core.membership(ctx, { membershipId: row.requested_by_membership_id }); } catch { throw new Terminal('auth.forbidden'); }
  if (!member || member.status !== 'active' || member.isActive === false || member.lockedAt) throw new Terminal('auth.forbidden');
  const perms: readonly string[] = await ctx.core.membershipPermissions(ctx, { membershipId: row.requested_by_membership_id });
  if (!perms.includes('analytics.data.export') || !perms.includes(report.permission)) throw new Terminal('auth.forbidden');
  if (report.flag) {
    const s = await ctx.ports.IdentityPort.getTenantSettings(ctx, { keys: [report.flag] });
    if (s[report.flag] !== true) throw new Terminal('common.feature_disabled'); // X19
  }

  // step 3: effective scope = snapshot ∩ current membership scope; nothing left = refused
  const scope = intersect(
    { all: row.scope_all_centres, centreIds: row.scope_centre_ids }, { all: member.allCentres === true, centreIds: member.centreIds ?? [] },
  );
  if (!scope.all && scope.centreIds.length === 0) throw new Terminal('auth.forbidden');
  await repo.markBuilding(ctx.tx, { ...key, effectiveCentreIds: scope.all ? null : scope.centreIds });

  // step 4: the same service functions as the API, with the explicit scope
  const now: string = ctx.now();
  const period = resolvePeriod(row.params as never, businessDateOf(now as never), cfg.maxRangeDays);
  const built = await buildReport(ctx, row.report_code, row.params, { period, scope, now });
  if (built.rows.length > cfg.exportMaxRows) throw new Terminal('analytics.export_too_large'); // step 5

  const meta: ExportMeta = {
    tenantDisplayName: (await ctx.core.tenant(ctx)).displayName, reportTitle: built.title, periodLabelAd: period.labelAd, periodLabelBs: period.labelBs,
    scopeLabel: await scopeLabel(ctx, scope), generatedAtLocal: local(now), exportId, exportedBy: String(member.displayName ?? ''),
    freshnessNote: await freshnessNote(ctx, tenantId, report.families, now, cfg),
  };
  const table = { meta, columns: built.columns, rows: built.rows };

  // step 6
  let bytes: Uint8Array, contentType: string;
  if (row.format === 'csv') { bytes = writeCsv(table); contentType = 'text/csv; charset=utf-8'; }
  else if (row.format === 'xlsx') { bytes = await writeXlsx(table); contentType = XLSX; }
  else { bytes = await renderPdf(ctx, buildPdfData(table), exportId); contentType = 'application/pdf'; }
  if (bytes.length > cfg.exportMaxBytes) throw new Terminal('analytics.export_too_large'); // step 7

  // step 8
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const readyAt = new Date(now);
  await repo.storeFile(ctx.tx, { ...key, content: bytes, contentType, sha256, readyAt, expiresAt: new Date(readyAt.getTime() + cfg.exportTtlHours * HOUR_MS), rowCount: built.rows.length });
  return built.rows.length;
}

/** RenderPort -> bytes; error mapping per TRD §7.2: too large -> analytics.export_too_large, outage -> retry, anything else is a C8 bug -> common.internal + alert. */
async function renderPdf(ctx: any, data: unknown, exportId: string): Promise<Uint8Array> {
  let out: { contentBase64: string; sha256: string; byteSize: number };
  try {
    out = await ctx.ports.RenderPort.renderPdf(ctx, { templateKey: 'analytics.report', data, idempotencyKey: exportId });
  } catch (e) {
    const code = codeOf(e);
    if (code === 'common.payload_too_large') throw new Terminal('analytics.export_too_large');
    if (code === undefined || code === 'reporting.render_unavailable' || code === 'common.dependency_unavailable') throw e; // retry
    throw new Terminal('common.internal', true);
  }
  const bytes = new Uint8Array(Buffer.from(out.contentBase64, 'base64'));
  if (createHash('sha256').update(bytes).digest('hex') !== out.sha256 || bytes.length !== out.byteSize) throw new Error('RenderPort answer does not match its sha256 / size'); // never ready
  return bytes;
}

async function scopeLabel(ctx: any, scope: { all: boolean; centreIds: readonly string[] }): Promise<string> {
  if (scope.all) return 'All centres';
  const names = new Map<string, string>((await ctx.core.centres(ctx, { activeOnly: false })).map((c: any) => [c.id as string, c.name as string]));
  return scope.centreIds.map((id) => names.get(id) ?? id.slice(-8)).join(', ').slice(0, 190);
}

async function freshnessNote(ctx: any, tenantId: string, families: readonly string[], now: string, cfg: ReturnType<typeof loadAnalyticsConfig>): Promise<string> {
  const states = (await loadFamilyStates(ctx.tx, { tenantId })).filter((s) => families.includes(s.family));
  const live = states.length === 0; // live-only report: current as of generation
  const times = states.map((s) => s.lastSuccessAt).filter((t): t is NonNullable<typeof t> => t !== null).sort();
  const stale = states.some((s) => evaluateFreshness(s, now as never, cfg).is_stale);
  if (live) return `Data as of ${local(now)}`;
  return `${times[0] ? `Data as of ${local(times[0])}` : 'Data not yet refreshed'}${stale ? ' (may be stale)' : ''}`;
}
