// Print service: R10 createReportPrint, R11 getReportPrint, R12 downloadReportPrintPdf, R13 createBulkPrint, T5 previewReportTemplate
// (02-TRD §6.2/§6.4/§9; 05-SCHEMA §2.14; 01-PRD AC-12.1-12.4, AC-13.1; 07-SECURITY A15, REQ-SEC-100, P-10; 08 D-37, review fix #5 / #36).
// Schema, auth, x-permission and Idempotency-Key are enforced by the core pipeline; this code re-checks what it needs (fail closed), never echoes input, never logs PHI.
// - A single LETTERHEAD print of a RELEASED version stores no file (state ready at once; R12 streams the canonical PDF). Everything else renders reporting.render_print.
// - A draft print (unreleased version) needs reporting.report.release on top of print (D-37) and always renders a file with draft_watermark.
// - ASSUMED [CONV]: the working centre (bulk / preview `centre_id`) is ctx.centreId; expires_at = ctx.now() + 24 h computed in JS; jobs carry {tenant_id, print_job_id}, 5 attempts.
import { LimsError } from '../../../core/errors.js';
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { insertDeliveryRow } from '../repository/delivery.repo.js';
import * as repo from '../repository/print.repo.js';
import * as templates from '../repository/templates.repo.js';

const ENQUEUE = 'SELECT app.enqueue_job($1, $2::jsonb, $3, $4, $5)';
export const RENDER_PRINT_TASK = 'reporting.render_print';
export const BULK_PRINT_TASK = 'reporting.build_bulk_print';
export const PRINT_MAX_ATTEMPTS = 5;
const TTL_MS = 24 * 3_600_000;
const PRINTS_BUCKET = 'reporting-prints';

export interface PrintCtx {
  readonly tenantId: string; readonly actor: { readonly type?: string; readonly id: string; readonly centreId?: string }; readonly tx: repo.Tx; readonly centreId?: string;
  readonly ports?: Record<string, any>; readonly now?: () => string;
  readonly storage?: { read(bucket: any, path: string): Promise<Uint8Array> }; readonly audit?: { access(e: Record<string, unknown>): Promise<unknown> };
}
type Variant = 'letterhead' | 'plain';

const nowMs = (c: PrintCtx) => Date.parse(String(typeof c.now === 'function' ? c.now() : new Date().toISOString()));
const iso = (v: unknown) => new Date(v as string).toISOString();
const workingCentre = (c: PrintCtx): string => {
  const id = c.centreId ?? c.actor.centreId;
  if (typeof id !== 'string' || id === '') throw new LimsError('common.internal');       // fail closed: no working centre
  return id;
};
const needAudit = (c: PrintCtx) => { if (!c.audit) throw new LimsError('common.internal'); return c.audit; };
async function enqueue(c: PrintCtx, task: string, printId: string): Promise<void> {
  await c.tx.query(ENQUEUE, [task, JSON.stringify({ tenant_id: c.tenantId, print_job_id: printId }), `print:${printId}`, null, PRINT_MAX_ATTEMPTS]);
}
/** PrintJob (02-TRD §6.1): allowlisted keys, no null; never object_path / sha256 / creator. */
export function toPrintJob(r: Record<string, any>) {
  const excluded: string[] = Array.isArray(r['excluded_ids']) ? r['excluded_ids'] : [];
  return {
    id: r['id'], state: r['state'], variant: r['variant'], copies: Number(r['copies']), expires_at: iso(r['expires_at']),
    ...(excluded.length ? { excluded_ids: excluded } : {}), ...(r['error_code'] ? { error_code: r['error_code'] } : {}),
  };
}

/** D-37: the draft gate. Only auth.forbidden becomes report_not_released; any other failure (aal, outage) propagates. */
async function assertDraftPrint(c: PrintCtx): Promise<void> {
  const idp = c.ports?.['IdentityPort'];
  if (typeof idp?.assertRole !== 'function') throw new LimsError('common.internal');
  try { await idp.assertRole(c, { permission: 'reporting.report.release' }); } catch (e) {
    if ((e as { code?: string })?.code === 'auth.forbidden') throw new LimsError('reporting.report_not_released');
    throw e;
  }
}

/** R10. 201 PrintJob. */
export async function createReportPrint(c: PrintCtx, versionId: string, variant: Variant, copies: number) {
  const audit = needAudit(c);
  const v = await repo.findVersionForPrint(c.tx, c.tenantId, versionId);
  if (!v) throw new LimsError('common.not_found');
  const draft = v['released_at'] == null;
  if (draft) await assertDraftPrint(c);
  const noFile = !draft && variant === 'letterhead';
  const id = uuidv7(); const expiresAt = new Date(nowMs(c) + TTL_MS).toISOString();
  await repo.insertPrint(c.tx, { id, tenantId: c.tenantId, centreId: v['centre_id'], kind: 'single', versionIds: [versionId], excludedIds: [], templateVersionId: v['template_version_id'] ?? null,
    variant, copies, draftWatermark: draft, state: noFile ? 'ready' : 'rendering', expiresAt, actorId: c.actor.id });
  const at = new Date(nowMs(c));
  await insertDeliveryRow(c.tx, { id: uuidv7(), tenantId: c.tenantId, centreId: v['centre_id'], channel: 'print', purpose: 'report_ready', templateCode: null, recipientKind: 'patient',
    recipientId: v['patient_id'] ?? null, destinationMasked: null, destinationSha256: null, destinationE164: null, params: {}, idempotencyKey: `${id}:print`, relatedType: 'report',
    relatedId: v['report_id'], reportId: v['report_id'], reportVersionNo: Number(v['version_no']), status: 'sent', failureCode: null, queuedAt: null, sentAt: at, suppressedAt: null, actorId: c.actor.id });
  if (!noFile) await enqueue(c, RENDER_PRINT_TASK, id);
  await audit.access({ action: 'report.print', entityType: 'report_version', entityId: versionId, centreId: v['centre_id'], outcome: 'allowed' });
  return { status: 201, body: toPrintJob({ id, state: noFile ? 'ready' : 'rendering', variant, copies, expires_at: expiresAt }) };
}

/** R11. */
export async function getReportPrint(c: PrintCtx, printId: string) {
  const p = await repo.findPrint(c.tx, c.tenantId, printId);
  if (!p) throw new LimsError('common.not_found');
  return { status: 200, body: toPrintJob(p) };
}

/** R12. Letterhead single (no own file) streams the canonical version PDF; every other print streams its own file. Never outside the tenant prefix. */
export async function downloadReportPrintPdf(c: PrintCtx, printId: string) {
  const p = await repo.findPrint(c.tx, c.tenantId, printId);
  if (!p) throw new LimsError('common.not_found');
  if (!c.storage) throw new LimsError('common.internal');
  const audit = needAudit(c);
  if (p['state'] === 'expired' || Date.parse(iso(p['expires_at'])) <= nowMs(c)) throw new LimsError('reporting.print_not_ready');
  if (p['state'] !== 'ready') throw new LimsError('reporting.print_not_ready');     // rendering | failed
  let bucket: string; let path: unknown;
  if (p['object_path'] == null && p['kind'] === 'single' && !p['draft_watermark']) {
    const v = await repo.findVersionForPrint(c.tx, c.tenantId, (p['report_version_ids'] as string[])[0]!);
    if (!v) throw new LimsError('common.not_found');
    bucket = 'reports'; path = v['pdf_object_path'];
  } else { bucket = PRINTS_BUCKET; path = p['object_path']; }
  if (typeof path !== 'string' || !path.startsWith(`${c.tenantId}/`)) throw new LimsError('common.internal');   // never read outside the caller's tenant prefix
  const bytes = await c.storage.read(bucket, path);
  await audit.access({ action: 'report.download', entityType: 'print_job', entityId: p['id'], centreId: p['centre_id'], outcome: 'allowed' });
  return {
    status: 200, body: bytes, headers: {
      'content-type': 'application/pdf', 'content-disposition': `attachment; filename="print-${p['id']}.pdf"`,   // ids only: no patient data in the name
      'x-content-type-options': 'nosniff', 'cache-control': 'no-store', 'content-security-policy': 'sandbox', 'content-length': String(bytes.length),
    },
  };
}

/** R13 (REQ-SEC-100 privileged: assertRole carries auth.mfa_required). Unreleased / unknown / out-of-scope ids are excluded and listed; none printable -> report_not_released. */
export async function createBulkPrint(c: PrintCtx, ids: string[], variant: Variant) {
  const idp = c.ports?.['IdentityPort'];
  if (typeof idp?.assertRole !== 'function') throw new LimsError('common.internal');
  const audit = needAudit(c); const centreId = workingCentre(c);
  await idp.assertRole(c, { permission: 'reporting.report.bulk_download' });
  const found = new Set((await repo.findVersionsForPrint(c.tx, c.tenantId, ids)).filter((v) => v['released_at'] != null).map((v) => v['id'] as string));
  const included = ids.filter((i) => found.has(i)); const excluded = ids.filter((i) => !found.has(i));
  if (included.length === 0) throw new LimsError('reporting.report_not_released');
  const id = uuidv7(); const expiresAt = new Date(nowMs(c) + TTL_MS).toISOString();
  await repo.insertPrint(c.tx, { id, tenantId: c.tenantId, centreId, kind: 'bulk', versionIds: included, excludedIds: excluded, templateVersionId: null, variant, copies: 1,
    draftWatermark: false, state: 'rendering', expiresAt, actorId: c.actor.id });
  await enqueue(c, BULK_PRINT_TASK, id);
  await audit.access({ action: 'report.bulk_download', entityType: 'print_job', entityId: id, centreId, outcome: 'allowed', detail: { count: included.length } });
  return { status: 202, body: toPrintJob({ id, state: 'rendering', variant, copies: 1, expires_at: expiresAt, excluded_ids: excluded }) };
}

/** T5 (AC-13.1). The template's DRAFT version when one exists, else its current published one; synthetic data only (the worker renders a sample, no report is read). */
export async function previewReportTemplate(c: PrintCtx, templateId: string, variant: Variant) {
  const centreId = workingCentre(c);
  const t = await templates.findTemplate(c.tx, c.tenantId, templateId);
  if (!t) throw new LimsError('common.not_found');
  const versions = await templates.versionsOf(c.tx, c.tenantId, templateId);
  const pick = versions.find((v) => v['status'] === 'draft') ?? versions.find((v) => v['id'] === t['current_version_id']);
  if (!pick) throw new LimsError('common.not_found');
  const id = uuidv7(); const expiresAt = new Date(nowMs(c) + TTL_MS).toISOString();
  await repo.insertPrint(c.tx, { id, tenantId: c.tenantId, centreId, kind: 'template_preview', versionIds: [], excludedIds: [], templateVersionId: pick['id'], variant, copies: 1,
    draftWatermark: false, state: 'rendering', expiresAt, actorId: c.actor.id });
  await enqueue(c, RENDER_PRINT_TASK, id);
  return { status: 202, body: toPrintJob({ id, state: 'rendering', variant, copies: 1, expires_at: expiresAt }) };
}
