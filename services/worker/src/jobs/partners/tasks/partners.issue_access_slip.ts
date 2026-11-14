// C13 T14 — task partners.issue_access_slip (02-TRD §8.1, 10 attempts; payload { tenant_id, access_slip_id } = what R4 enqueues; 03-APP-FLOW §5.5; 08 A2.1, A5.1, A5.2, A5.3).
// As the partners SYSTEM actor: lock the slip (FOR UPDATE, must be `requested`), ReportingPort.issuePortalLink { reportId, versionNo, channel 'print_qr', recipientKind 'patient' },
// RenderPort.renderPdf (template partners.access_slip, idempotencyKey = slip id, exactly the seven A5.1 data keys), put the PDF ONCE in partners-slips, mark the row `issued`.
// The link URL lives only in this function's memory, the render input and the PDF (ST12): it is never put in a column, job payload, log line, metric or error. This task logs nothing (port / DB errors can echo values) and rethrows port errors unchanged for the retry.
// Business refusals (report not released / superseded, template invalid, payload too large) end the slip as `failed` + the error code and RESOLVE (no retry); everything else rejects (retry) and the row stays `requested`.
// [CONV] the two *Local strings follow tenant calendarDisplay (02-TRD §8.1; IC §4): AD "13 Dec 2026, 11:45 am", BS "YYYY-MM-DD B.S., 11:45 am" (shared bsdate), AD_BS / BS_AD both, primary first; default AD.
// [CONV] storage path from ctx.now() (UTC yyyy/mm); a retry before `issued` replaces the object (08 §4.8, no ifAbsent).
// Open (C6/C0 ruling, see C13.T14-impl.md): a retry after a successful render whose DB update then fails mints a new link, and RenderPort refuses the same idempotencyKey with different data.
import { createHash } from 'node:crypto';
import type { TaskHandler } from '../../../core/manifest.js';
import { M, observe, slip as slipMetric } from '../../../../../api/src/modules/partners/service/observability.js';
import { formatBs, instantToBs, type IsoUtc } from '../../../../../../packages/shared-ts/src/bsdate/index.js';

const BUCKET = 'partners-slips';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BYTES = 10_485_760; // 05-SCHEMA §3.7a file_byte_size
const LINK_REFUSALS = new Set(['reporting.report_not_released', 'reporting.report_superseded']);
const RENDER_REFUSALS = new Set(['reporting.template_invalid', 'common.payload_too_large']);

type Row = Record<string, any>;
const codeOf = (e: unknown): string | undefined => (typeof (e as { code?: unknown } | null)?.code === 'string' ? (e as { code: string }).code : undefined);

const adLocal = (iso: string, timeZone: string): string => new Intl.DateTimeFormat('en-GB', { timeZone, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true }).format(new Date(iso));
const bsLocal = (iso: string, timeZone: string): string =>
  `${formatBs(instantToBs(new Date(iso).toISOString() as IsoUtc, timeZone), 'display')}, ${new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hour12: true }).format(new Date(iso))}`;
const local = (iso: string, timeZone: string, cal: unknown): string => {
  if (cal === 'BS') return bsLocal(iso, timeZone);
  if (cal === 'AD_BS') return `${adLocal(iso, timeZone)} (${bsLocal(iso, timeZone)})`;
  if (cal === 'BS_AD') return `${bsLocal(iso, timeZone)} (${adLocal(iso, timeZone)})`;
  return adLocal(iso, timeZone);
};

export const issueAccessSlip: TaskHandler = async (payload, ctx) => {
  const c = ctx as any;
  const tenantId = ctx.tenantId;
  const slipId = payload?.access_slip_id;
  if (typeof tenantId !== 'string' || payload?.tenant_id !== tenantId) throw new Error('partners.issue_access_slip: payload tenant differs from the job tenant context'); // REQ-SEC-024
  if (typeof slipId !== 'string' || !UUID.test(slipId)) throw new Error('partners.issue_access_slip: access_slip_id must be a UUID');
  const tx = ctx.tx;

  const slip: Row | undefined = (await tx.query('SELECT id, partner_id, report_id, version_no, order_id, state, version, created_at FROM partners.access_slips WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [tenantId, slipId])).rows[0];
  if (!slip || slip.state !== 'requested') return; // replay after issued / failed / expired, or not visible for this tenant: nothing to do
  const now = ctx.now();
  const nowDate = new Date(now);
  const next = Number(slip.version) + 1;

  const fail = async (code: string): Promise<void> => {
    await tx.query("UPDATE partners.access_slips SET state = 'failed', failure_code = $3, updated_at = $4, updated_by = $5, version = $6 WHERE tenant_id = $1 AND id = $2 AND state = 'requested'",
      [tenantId, slipId, code, nowDate, ctx.actor.id, next]);
    slipMetric(ctx, 'failed'); // T23: business end only; a throw for the queue retry is not a failure yet
  };

  let link: Row;
  try { link = await c.ports.ReportingPort.issuePortalLink(ctx, { reportId: slip.report_id, versionNo: Number(slip.version_no), channel: 'print_qr', recipientKind: 'patient' }); } catch (e) {
    const code = codeOf(e); if (code && LINK_REFUSALS.has(code)) return fail(code);
    throw e;
  }

  const line: Row | undefined = (await tx.query('SELECT registration_no, patient_full_name FROM partners.manifest_lines WHERE tenant_id = $1 AND partner_id = $2 AND order_id = $3 LIMIT 1', [tenantId, slip.partner_id, slip.order_id])).rows[0];
  const partner: Row | undefined = (await tx.query('SELECT name FROM partners.partners WHERE tenant_id = $1 AND id = $2', [tenantId, slip.partner_id])).rows[0];
  if (!line || !partner) throw new Error('partners.issue_access_slip: order line or partner of the slip not found'); // cannot happen under the FKs
  const settings = await c.ports.IdentityPort.getTenantSettings(ctx, { keys: ['timezone', 'calendarDisplay'] });
  const tz = settings?.timezone;
  const cal = settings?.calendarDisplay;
  if (typeof tz !== 'string' || !tz) throw new Error('partners.issue_access_slip: tenant timezone missing');
  const tenantDisplayName = (await c.core.tenant(ctx)).displayName;

  let pdf: Row;
  try {
    pdf = await c.ports.RenderPort.renderPdf(ctx, {
      templateKey: 'partners.access_slip', idempotencyKey: slipId,
      data: { tenantDisplayName, partnerName: partner.name, patientDisplayName: line.patient_full_name, orderRef: line.registration_no, portalUrl: link.url, expiresAtLocal: local(link.expiresAt, tz, cal), issuedAtLocal: local(now, tz, cal) },
    });
  } catch (e) {
    const code = codeOf(e); if (code && RENDER_REFUSALS.has(code)) return fail(code);
    throw e;
  }
  const bytes = Buffer.from(String(pdf.contentBase64), 'base64');
  if (bytes.length > MAX_BYTES) return fail('common.payload_too_large');
  const sha = createHash('sha256').update(bytes).digest('hex');
  if (bytes.length < 1 || sha !== pdf.sha256) throw new Error('partners.issue_access_slip: render result failed its integrity check');

  const path = `${tenantId}/access-slips/${nowDate.getUTCFullYear()}/${String(nowDate.getUTCMonth() + 1).padStart(2, '0')}/${slipId}.pdf`;
  await c.storage.put(BUCKET, path, bytes, { contentType: 'application/pdf' });
  await tx.query("UPDATE partners.access_slips SET state = 'issued', link_id = $3, link_expires_at = $4, file_path = $5, file_sha256 = $6, file_byte_size = $7, issued_at = $8, updated_at = $8, updated_by = $9, version = $10 WHERE tenant_id = $1 AND id = $2 AND state = 'requested'",
    [tenantId, slipId, link.linkId, new Date(link.expiresAt), path, sha, bytes.length, nowDate, ctx.actor.id, next]);
  // T23: issued once + request -> issued seconds (row created_at -> the job's now); labels carry no id / URL / token
  slipMetric(ctx, 'issued');
  const created = new Date(slip.created_at).getTime();
  if (Number.isFinite(created)) observe(ctx, M.slipIssueSeconds, Math.max(0, (nowDate.getTime() - created) / 1000));
};
