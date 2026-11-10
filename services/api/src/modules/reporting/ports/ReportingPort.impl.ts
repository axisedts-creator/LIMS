// ReportingPort (03-IC §4.7) — real C6 implementation. Reads go through ctx.tx only, so partner / patient visibility is the database's RLS (05-SCHEMA §4), never an
// app-side filter. issuePortalLink delegates to the portal service (C6-T20). openReleasedReportFile is the minimal version AC-15.1 needs (cases 4 and 7);
// C6-T37 adds the smart-summary snapshot and redeemPortalLinkForApp (patient visible_from is C16's, TRD §7.1).
import { LimsError, type FieldError } from '../../../core/errors.js';
import { findReleasedVersionFile, listVersions, panelNamesByVersion, type ScopeColumn } from '../repository/released.repo.js';
import { createPortalService } from '../service/portal.service.js';
import { hashToken } from '../domain/tokens.js';

type Row = Record<string, any>;
type Env = Readonly<Record<string, string | undefined>>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;
const B64URL = /^[A-Za-z0-9_-]+$/;
const E164 = /^\+[1-9]\d{6,14}$/;
const MAX_TOKEN = 4096;                                                 // LD-66: same cap as the core pre-resolver
const DEFAULT_LIMIT = 50; const MAX_LIMIT = 200;
const URL_TTL_SECONDS = 300;                                            // IC §4.7 ReleasedReportFile.signedUrl TTL ≤ 300 s
const REPORT_BUCKET = 'reports';
const SCOPES: Readonly<Record<string, ScopeColumn>> = { orderId: 'order_id', patientId: 'patient_id', partnerId: 'partner_id', centreId: 'centre_id' };
const FILTER_KEYS = new Set([...Object.keys(SCOPES), 'releasedFrom', 'releasedTo', 'includeSuperseded']);

const bad = (path: string): never => {
  throw new LimsError('common.validation_failed', undefined, [{ path, code: 'common.field_invalid', message: 'Field invalid' } satisfies FieldError]);
};
const tenantOf = (ctx: any): string => {
  if (typeof ctx?.tenantId !== 'string' || !ctx.tenantId || !ctx.tx) throw new LimsError('auth.unauthenticated');
  return ctx.tenantId;
};
const isoDate = (v: unknown): string => new Date(v as string).toISOString();

/** Cursor = base64url(`<released_at ISO>|<version id>`). released_at is app-supplied (ms precision), so the ISO round-trip loses nothing. */
const encodeCursor = (releasedAt: string, id: string) => Buffer.from(`${releasedAt}|${id}`).toString('base64url');
function decodeCursor(c: unknown): { releasedAt: string; id: string } {
  const invalid = () => new LimsError('common.invalid_cursor');
  if (typeof c !== 'string' || c.length === 0 || c.length > 256 || !B64URL.test(c)) throw invalid();
  const [releasedAt, id, ...rest] = Buffer.from(c, 'base64url').toString('utf8').split('|');
  if (rest.length || !releasedAt || !id || !ISO.test(releasedAt) || Number.isNaN(Date.parse(releasedAt)) || !UUID.test(id)) throw invalid();
  return { releasedAt, id };
}

export function createReportingPort(deps: { env: Env }) {
  const portal = createPortalService({ env: deps.env });

  return {
    /** Exactly one of orderId | patientId | partnerId | centreId; released/superseded versions only; keyset pages of 50 (max 200). */
    async getReleasedReports(ctx: any, input: { filter?: unknown; cursor?: unknown; limit?: unknown }) {
      const tenantId = tenantOf(ctx);
      const f = input?.filter as Row | undefined;
      if (typeof f !== 'object' || f === null || Array.isArray(f)) return bad('/filter');
      for (const k of Object.keys(f)) if (!FILTER_KEYS.has(k)) bad(`/filter/${k}`);
      const scoped = Object.keys(SCOPES).filter((k) => f[k] !== undefined);
      if (scoped.length !== 1) return bad('/filter');
      const scope = scoped[0]!; const value = f[scope];
      if (typeof value !== 'string' || !UUID.test(value)) return bad(`/filter/${scope}`);
      for (const k of ['releasedFrom', 'releasedTo']) if (f[k] !== undefined && (typeof f[k] !== 'string' || !ISO.test(f[k]) || Number.isNaN(Date.parse(f[k])))) bad(`/filter/${k}`);
      if (f['includeSuperseded'] !== undefined && typeof f['includeSuperseded'] !== 'boolean') bad('/filter/includeSuperseded');
      const asked = input.limit === undefined ? DEFAULT_LIMIT : input.limit;
      if (typeof asked !== 'number' || !Number.isInteger(asked) || asked < 1 || asked > MAX_LIMIT) return bad('/limit');   // 02-CV §4.3: >200 → common.validation_failed
      const limit = asked;
      const after = input.cursor === undefined ? undefined : decodeCursor(input.cursor);

      const rows = await listVersions(ctx.tx, tenantId, { column: SCOPES[scope]!, value: value.toLowerCase(), includeSuperseded: f['includeSuperseded'] === true,
        ...(f['releasedFrom'] ? { from: isoDate(f['releasedFrom']) } : {}), ...(f['releasedTo'] ? { to: isoDate(f['releasedTo']) } : {}), ...(after ? { after } : {}), limit: limit + 1 });
      const page = rows.slice(0, limit);
      const panels = await panelNamesByVersion(ctx.tx, tenantId, page.map((r) => r['id']));
      const items = page.map((r) => ({
        reportId: r['report_id'], versionNo: r['version_no'], orderId: r['order_id'], patientId: r['patient_id'], kind: r['report_kind'],
        status: r['status'] === 'superseded' ? 'superseded' : 'valid', releasedAt: isoDate(r['released_at']), panelNames: panels.get(r['id']) ?? [],
        smartSummaryAvailable: r['smart_summary_id'] !== null && r['smart_summary_id'] !== undefined,   // all-or-none CHECK (08 A4.4)
      }));
      const last = page[page.length - 1];
      return rows.length > limit && last ? { items, nextCursor: encodeCursor(isoDate(last['released_at']), last['id']) } : { items };
    },

    /** Staff (`user`) / `system` only; see portal.service.ts. */
    issuePortalLink: (ctx: any, input: any) => portal.issuePortalLink(ctx, input),

    /** AC-15.3. Partner / patient visibility is RLS on ctx.tx (05-SCHEMA §4); anything not visible (other tenant / partner / patient, not released or superseded) is the same
     *  common.not_found. smartSummary = the smart_summary_json snapshot stored on THAT version (08 A2.3); SmartReportPort is never called (07-SECURITY 8a). */
    async openReleasedReportFile(ctx: any, input: { reportId?: unknown; versionNo?: unknown }) {
      const tenantId = tenantOf(ctx);
      if (typeof input?.reportId !== 'string' || !UUID.test(input.reportId) || !Number.isInteger(input.versionNo) || (input.versionNo as number) < 1) throw new LimsError('common.not_found');
      const v = await findReleasedVersionFile(ctx.tx, tenantId, input.reportId.toLowerCase(), input.versionNo as number);
      if (!v || typeof v['pdf_object_path'] !== 'string' || !v['pdf_object_path']) throw new LimsError('common.not_found');
      if (!ctx.storage) throw new LimsError('common.internal');
      const signedUrl: string = await ctx.storage.signedUrl(REPORT_BUCKET, v['pdf_object_path'], URL_TTL_SECONDS);
      return { reportVersionId: v['id'], reportId: v['report_id'], versionNo: v['version_no'], status: v['status'] === 'superseded' ? 'superseded' : 'valid',
        contentType: 'application/pdf', byteSize: Number(v['pdf_bytes']), sha256: v['pdf_sha256'], signedUrl, expiresAt: new Date(Date.parse(ctx.now()) + URL_TTL_SECONDS * 1000).toISOString(),
        ...(v['smart_summary_json'] != null ? { smartSummary: v['smart_summary_json'] } : {}) };
    },

    /** AC-15.4. Patient actor only. Hashes token + phone (sha256 of utf8), calls the C0 DEFINER app.reporting_redeem_link_for_app (03-IC §13.3) through ctx.tx and requires its
     *  tenant_id = ctx.tenantId. Never consumes / extends / reveals the link; the DEFINER owns the only write (redeem_failures). Every failure is the same reporting.link_invalid,
     *  and ctx.commitOnError() keeps the failure counter although the call fails (08 A19 P-42). */
    async redeemPortalLinkForApp(ctx: any, input: { linkToken?: unknown; phoneE164?: unknown }) {
      const tenantId = tenantOf(ctx);
      if (ctx.actor?.type !== 'patient') throw new LimsError('auth.forbidden');
      const { linkToken, phoneE164 } = input ?? {};
      if (typeof linkToken !== 'string' || linkToken.length < 1 || linkToken.length > MAX_TOKEN || typeof phoneE164 !== 'string' || !E164.test(phoneE164)) throw new LimsError('reporting.link_invalid');
      const row = (await ctx.tx.query('SELECT tenant_id, patient_id, report_id, version_no, released_at FROM app.reporting_redeem_link_for_app($1::bytea, $2::bytea)',
        [Buffer.from(hashToken(linkToken)), Buffer.from(hashToken(phoneE164))])).rows[0];
      if (!row || row['tenant_id'] !== tenantId) { ctx.commitOnError?.(); throw new LimsError('reporting.link_invalid'); }
      return { patientId: row['patient_id'], reportId: row['report_id'], versionNo: row['version_no'], releasedAt: isoDate(row['released_at']) };
    },
  };
}
