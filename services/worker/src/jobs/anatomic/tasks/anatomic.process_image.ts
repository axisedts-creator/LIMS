// anatomic.process_image (02-TRD §4.9 steps 2–3, §9; 08 A17 P-19; 5 attempts). Enqueued by I1 (job_key image:<id>) when the upload's scanState was pending/unavailable.
// Re-scans the STORED object (fail closed): clean -> ready; infected -> quarantined/'malware' (terminal); unavailable or scanner/store error -> scan_attempts + 1 and THROW (worker retries, then dead letter;
// the image stays `processing`, never served). A row that is no longer `processing` is a no-op (redelivery). REQ-SEC-024: only the tenant of the job claims; every statement binds tenant_id.
// Logs and errors carry ids and codes only: never a caption, object path or bytes.
import { assertBucket, assertTenantPath } from '../../../../../api/src/core/storage/index.js';
import { getImage, updateImage } from '../../../../../api/src/modules/anatomic/repository/images.repo.js';
import type { JobContext, TaskHandler } from '../../../core/manifest.js';

export const PROCESS_IMAGE = 'anatomic.process_image';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_SCANS = 5;   // images__scan__ck: scan_attempts 0..5

export async function processImage(payload: { image_id?: unknown; tenant_id?: unknown }, jobCtx: JobContext): Promise<void> {
  const ctx = jobCtx as any;
  const tenantId = ctx.tenantId;
  if (typeof tenantId !== 'string' || !UUID.test(tenantId)) throw new Error('anatomic.process_image: no tenant claims');
  if (payload?.tenant_id !== undefined && payload.tenant_id !== tenantId) throw new Error('anatomic.process_image: tenant mismatch');   // REQ-SEC-024
  const id = payload?.image_id;
  if (typeof id !== 'string' || !UUID.test(id)) throw new Error('anatomic.process_image: image_id must be a uuid');

  const img = await getImage(ctx.tx, { tenantId, id });
  if (!img) { ctx.log.warn({ event: 'process_image_not_found', image_id: id }, 'process_image_not_found'); return; }   // not visible: nothing to retry
  if (img['state'] !== 'processing') return;

  const patch = (p: Record<string, unknown>) => updateImage(ctx.tx, { tenantId, id, expectedVersion: Number(img['version']), actorId: ctx.actor.id, patch: p });

  try { assertBucket(img['bucket']); assertTenantPath(tenantId, String(img['object_path'])); } catch {
    ctx.log.error({ event: 'process_image_bad_path', image_id: id }, 'process_image_bad_path');   // corrupt row: never read outside the tenant; a retry cannot help
    return;
  }

  let verdict: 'clean' | 'infected' | 'unavailable' | 'pending';
  try {
    verdict = await ctx.files.scan(await ctx.storage.read(img['bucket'], img['object_path']));
  } catch { verdict = 'unavailable'; }

  if (verdict === 'clean') {
    await patch({ scan_state: 'clean', state: 'ready' });
    ctx.metrics?.inc('lims_anatomic_image_processing_total', { outcome: 'ready' });   // 02-TRD §9
    return;
  }
  if (verdict === 'infected') {
    await patch({ scan_state: 'infected', state: 'quarantined', quarantine_reason_code: 'malware' });
    ctx.metrics?.inc('lims_anatomic_image_processing_total', { outcome: 'quarantined' });   // C1 security alert watches this
    ctx.log.warn({ event: 'image_quarantined', image_id: id, request_id: ctx.requestId }, 'image_quarantined');   // security alert: no name, caption or content
    return;
  }
  await patch({ scan_state: 'unavailable', scan_attempts: Math.min(MAX_SCANS, Number(img['scan_attempts']) + 1) });
  ctx.metrics?.inc('lims_anatomic_image_processing_total', { outcome: 'scan_retry' });
  throw new Error('anatomic.process_image: scanner unavailable');
}

export const processImageTask: TaskHandler = (payload, ctx) => processImage(payload, ctx);
