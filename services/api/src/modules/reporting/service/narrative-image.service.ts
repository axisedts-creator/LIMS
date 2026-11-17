// Narrative images, API side: N6 upload, N7 content (02-TRD §6.4; 01-PRD AC-05.3; 07-SECURITY T9, REQ-SEC-083/084/085; 08 A13 P-2).
// Bytes go through ctx.uploads.accept with re-encode + metadata strip (SVG and every non png/jpeg type -> 415) into quarantine; the worker
// (reporting.process_input_file) re-scans and publishes. N7 serves only the sanitised object. Tenant and actor come from ctx only.
// [CONV] P-10 conditional reporting.narrative.write on N7 (draft / unattached images) landed with C6-T17; attachment rules (12 images, ready only) are N3's.
import { LimsError, type FieldError } from '../../../core/errors.js';
import type { IncomingFile } from '../../../core/uploads/index.js';
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import * as repo from '../repository/narrative-image.repo.js';
import { versionsOf } from '../repository/narrative.repo.js';
import { findFile, enqueue, type Tx } from '../repository/outsourced.repo.js';
import { INPUT_BUCKET, PROCESS_TASK, safeName, type OutsourcedCtx } from './outsourced.service.js';

const MAX_BYTES = 15 * 1024 * 1024;           // 02-TRD N6
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SERVABLE = ['image/png', 'image/jpeg'];

const fail = (path: string): never => {
  throw new LimsError('common.validation_failed', undefined, [{ path, code: 'common.field_invalid', message: 'Field invalid' } satisfies FieldError]);
};
function scope(ctx: OutsourcedCtx) {
  if (typeof ctx?.tenantId !== 'string' || !UUID.test(ctx.tenantId) || typeof ctx.actor?.id !== 'string' || !ctx.tx) throw new LimsError('auth.unauthenticated');
  return { tx: ctx.tx as Tx, tenantId: ctx.tenantId, actorId: ctx.actor.id };
}
const nowIso = (ctx: OutsourcedCtx) => (typeof ctx.now === 'function' ? ctx.now() : new Date().toISOString());

const idList = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === 'string' ? v.replace(/^\{|\}$/g, '').split(',').filter(Boolean) : []);

/** N7 + reporting.narrative.write (P-10, TRD N7) while the image belongs to a draft version, or to none yet (an upload awaiting attachment);
 *  an image held only by signed / superseded versions needs report.read alone (the pipeline floor). Checked after loading the target. */
async function assertDraftReadPermission(ctx: OutsourcedCtx, tx: Tx, tenantId: string, image: any) {
  const idp = (ctx as { ports?: Record<string, any> }).ports?.['IdentityPort'];
  if (!idp || typeof idp.assertRole !== 'function') throw new LimsError('common.internal');   // fail closed
  const narrative = typeof image.narrative_report_id === 'string' ? await repo.findNarrative(tx, tenantId, image.narrative_report_id) : undefined;
  if (!narrative || narrative.tenant_id !== tenantId) throw new LimsError('common.not_found');
  const holders = (await versionsOf(tx, tenantId, narrative.id)).filter((v) => idList(v.image_file_ids).includes(image.id));
  const frozenOnly = holders.length > 0 && holders.every((v) => v.status === 'signed' || v.status === 'superseded');
  if (!frozenOnly) await idp.assertRole(ctx, { permission: 'reporting.narrative.write', centreId: narrative.centre_id });
}

export function createNarrativeImageService(deps: { newId?: () => string } = {}) {
  const newId = deps.newId ?? uuidv7;
  return {
    /** N6 — AC-05.3. Nothing is stored, persisted or queued on any rejection. */
    async upload(ctx: OutsourcedCtx, input: { narrativeId: unknown; file: unknown; caption: unknown }) {
      const { tx, tenantId, actorId } = scope(ctx);
      const caption = input?.caption;
      if (caption !== undefined && caption !== null && (typeof caption !== 'string' || caption.length > 200)) fail('/caption');
      const narrativeId = input?.narrativeId;
      if (typeof narrativeId !== 'string' || !UUID.test(narrativeId)) throw new LimsError('common.not_found');
      if (!ctx.uploads || typeof ctx.uploads.accept !== 'function') throw new LimsError('common.internal');   // fail closed (CR-C6-009)
      const narrative = await repo.findNarrative(tx, tenantId, narrativeId);
      if (!narrative || narrative.tenant_id !== tenantId) throw new LimsError('common.not_found');

      const id = newId();
      const now = nowIso(ctx);
      const quarantinePath = `${tenantId}/quarantine/${now.slice(0, 4)}/${now.slice(5, 7)}/${id}.bin`;
      const file = input.file as IncomingFile;
      // Infected -> common.upload_quarantined (422) straight from the pipeline; scanState 'unavailable' stays pending_scan for the worker.
      const accepted = await ctx.uploads.accept(file, {
        allow: ['image/png', 'image/jpeg'], maxBytes: MAX_BYTES, bucket: INPUT_BUCKET, objectPath: quarantinePath,
        images: { reencode: true, stripMetadata: true }, scan: 'required',
      });
      const row = await repo.insertImage(tx, {
        id, tenantId, centreId: narrative.centre_id, orderId: narrative.order_id, narrativeReportId: narrativeId,
        originalFilename: safeName(typeof file?.filename === 'string' ? file.filename : '', 'image.png'), declaredMime: accepted.mime,
        sizeBytes: accepted.byteSize, sha256: accepted.sha256, quarantinePath, caption: typeof caption === 'string' ? caption : null, actorId,
      });
      await enqueue(tx, PROCESS_TASK, { tenant_id: tenantId, input_file_id: id }, `pif:${id}`);
      return { image_id: row.id as string, state: row.state as string };
    },

    /** N7 — sanitised (re-encoded) bytes only, never the quarantine object; access log report.view / narrative_image. */
    async content(ctx: OutsourcedCtx, input: { imageId: unknown }) {
      const { tx, tenantId } = scope(ctx);
      if (!ctx.storage || !ctx.audit) throw new LimsError('common.internal');
      const imageId = input?.imageId;
      if (typeof imageId !== 'string' || !UUID.test(imageId)) throw new LimsError('common.not_found');
      const row = await findFile(tx, tenantId, imageId);
      if (!row || row.tenant_id !== tenantId || row.kind !== 'narrative_image') throw new LimsError('common.not_found');
      await assertDraftReadPermission(ctx, tx, tenantId, row);
      if (row.state !== 'ready' || typeof row.sanitized_object_path !== 'string' || !row.sanitized_object_path || !SERVABLE.includes(row.detected_mime)) {
        throw new LimsError('reporting.input_file_not_ready');
      }
      const bytes = await ctx.storage.read(INPUT_BUCKET, row.sanitized_object_path);
      await ctx.audit.access({ action: 'report.view', entityType: 'narrative_image', entityId: row.id, centreId: row.centre_id, outcome: 'allowed' });
      return { bytes, filename: safeName(String(row.original_filename ?? ''), 'image.png'), contentType: row.detected_mime as string };
    },
  };
}
