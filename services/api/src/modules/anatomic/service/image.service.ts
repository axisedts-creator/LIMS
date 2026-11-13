// Images — I1 uploadAnatomicImage, I2 getAnatomicImageContent, I3 updateAnatomicImage, I4 deactivateAnatomicImage
// (02-TRD §4.9, §5 I1–I4, §12 access log; 01-PRD AC-12.1…12.8; 07-SECURITY REQ-SEC-083…085; 08 A17 P-19, D-66, D-67).
// Order: load through the tenant-bound repository (404) -> IdentityPort.assertRole(case centre) -> validate -> write. The original filename is never stored, logged or echoed (AC-12.5).
// Scan outcome model (P-19): AcceptedUpload.scanState clean -> ready; infected -> quarantined/'malware'; pending|unavailable -> processing + job anatomic.process_image (<= 5 attempts, worker).
// ponytail: real pipeline gaps (CR-C11-008 / CR-C2-011: JPEG re-encode, 50 MP cap) are the core's; this service passes the TRD options unchanged.
import { LimsError } from '../../../core/errors.js';
import type { HandlerResult } from '../../../core/module.js';
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { loadAnatomicConfig } from '../config.js';
import { getCase } from '../repository/cases.repo.js';
import { getSettings } from '../repository/config.repo.js';
import { getImage, insertImage, listImages, updateImage } from '../repository/images.repo.js';
import { getPart } from '../repository/parts.repo.js';
import { listReportVersions } from '../repository/versions.repo.js';
import type { Row } from '../repository/_sql.js';
import { anatomicCtx, assertAt, bad, isObj, iso, put, strict, text, UUID, uuid } from './case.service.js';
import type { AnatomicCtx } from './numbering.service.js';

type Obj = Record<string, unknown>;
type Result = HandlerResult;

const BUCKET = 'anatomic-images' as const;
const KINDS = ['gross', 'microscopy', 'other'];
const DEFAULT_MAX_IMAGES = 50;   // 05-SCHEMA settings.max_images_per_case default
const RESCAN_TASK = 'anatomic.process_image';
const config = loadAnatomicConfig();

interface ImageCtx extends AnatomicCtx {
  readonly uploads: { accept(file: unknown, opts: unknown): Promise<{ sha256: string; byteSize: number; mime: string; image?: { width: number; height: number }; scanState: string }> };
  readonly storage: { delete(bucket: string, path: string): Promise<unknown> };
  readonly download: { stream(i: unknown): Promise<Result> };
}

/** If-Match "<n>", n >= 1. Absent -> 428; malformed -> 400. */
function expectedVersion(headers: unknown): number {
  const h = isObj(headers) ? headers['if-match'] : undefined;
  if (h === undefined) throw new LimsError('common.precondition_required');
  const m = typeof h === 'string' ? /^"([1-9][0-9]{0,9})"$/.exec(h) : null;
  if (!m || Number(m[1]) > 2147483647) throw bad('/headers/if-match');
  return Number(m[1]);
}

export const imageDto = (r: Row): Obj => {
  const o: Obj = { id: r['id'], kind: r['kind'], state: r['state'], created_at: iso(r['created_at']), is_active: r['is_active'], version: Number(r['version']) };
  put(o, 'part_id', r['part_id']); put(o, 'caption', r['caption']); put(o, 'mime_type', r['mime_type']);
  put(o, 'width_px', r['width_px'] == null ? null : Number(r['width_px'])); put(o, 'height_px', r['height_px'] == null ? null : Number(r['height_px']));
  return o;
};

async function loadImage(c: AnatomicCtx, imageId: unknown): Promise<{ img: Row; cs: Row }> {
  if (typeof imageId !== 'string' || !UUID.test(imageId)) throw new LimsError('common.not_found');
  const img = await getImage(c.tx, { tenantId: c.tenantId, id: imageId });
  const cs = img && await getCase(c.tx, { tenantId: c.tenantId, caseId: img['case_id'] });
  if (!img || !cs) throw new LimsError('common.not_found');   // other tenant / unknown look the same
  return { img, cs };
}

/** part_id must be a part of THIS case (a foreign id is a validation error, never an existence answer). */
async function checkPart(c: AnatomicCtx, partId: string | undefined, cs: Row): Promise<void> {
  if (partId === undefined) return;
  const p = await getPart(c.tx, { tenantId: c.tenantId, id: partId });
  if (!p || p['case_id'] !== cs['id']) throw bad('/part_id');
}

function fields(b: Obj): { kind: string; partId?: string; caption?: string } {
  const kind = b['kind'];
  if (typeof kind !== 'string' || !KINDS.includes(kind)) throw bad('/kind');
  const partId = b['part_id'] === undefined ? undefined : uuid(b['part_id'], '/part_id');
  const caption = b['caption'] === undefined ? undefined : text(b['caption'], '/caption', 200);
  return { kind, ...(partId !== undefined ? { partId } : {}), ...(caption ? { caption } : {}) };
}

// ---- I1 uploadAnatomicImage ----
export async function uploadImage(hctx: unknown, params: unknown, body: unknown): Promise<Result> {
  const c = anatomicCtx(hctx);
  const x = hctx as ImageCtx;
  const caseId = isObj(params) ? params['case_id'] : undefined;
  if (typeof caseId !== 'string' || !UUID.test(caseId)) throw new LimsError('common.not_found');
  const cs = await getCase(c.tx, { tenantId: c.tenantId, caseId, forUpdate: true });   // row lock: serialises the limit check per case
  if (!cs) throw new LimsError('common.not_found');
  await assertAt(c, 'anatomic.case.work', cs);

  const b = strict(body, ['file', 'kind', 'part_id', 'caption']);
  const f = b['file'];
  if (!isObj(f) || typeof f['filename'] !== 'string' || typeof f['mimetype'] !== 'string' || !(f['data'] instanceof Uint8Array)) throw bad('/file');   // [CONV] core multipart part { filename, mimetype, data }
  const { kind, partId, caption } = fields(b);
  await checkPart(c, partId, cs);

  const max = Number((await getSettings(c.tx, { tenantId: c.tenantId }))?.['max_images_per_case'] ?? DEFAULT_MAX_IMAGES);
  if ((await listImages(c.tx, { tenantId: c.tenantId, caseId: cs['id'], activeOnly: true })).length >= max) throw new LimsError('anatomic.image_limit_reached');   // before the pipeline: nothing stored

  const id = uuidv7();
  const now = c.now();
  const ext = /\.jpe?g$/i.test(f['filename'].split(/[\\/]/).pop() ?? '') ? 'jpg' : 'png';   // the client filename only picks the extension; it never reaches the key
  const objectPath = `${c.tenantId}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${id}.${ext}`;   // UTC, 05-SCHEMA images__path__ck
  const acc = await x.uploads.accept({ filename: f['filename'], mimeType: f['mimetype'], bytes: f['data'] }, {
    allow: ['image/png', 'image/jpeg'], maxBytes: config.imageMaxBytes,
    images: { reencode: true, stripMetadata: true, maxMegapixels: config.imageMaxMegapixels }, scan: 'required', bucket: BUCKET, objectPath,
  });

  const clean = acc.scanState === 'clean', infected = acc.scanState === 'infected';
  const row: Row = {
    id, tenant_id: c.tenantId, centre_id: cs['centre_id'], case_id: cs['id'], kind, bucket: BUCKET, object_path: objectPath,
    state: clean ? 'ready' : infected ? 'quarantined' : 'processing', scan_state: acc.scanState, scan_attempts: 0,
    mime_type: acc.mime, byte_size: acc.byteSize, sha256: acc.sha256, created_by: c.actor.id, updated_by: c.actor.id,
  };
  if (infected) row['quarantine_reason_code'] = 'malware';
  if (partId !== undefined) row['part_id'] = partId;
  if (caption !== undefined) row['caption'] = caption;
  if (acc.image) { row['width_px'] = acc.image.width; row['height_px'] = acc.image.height; }
  try {
    const saved = await insertImage(c.tx, row);
    if (!clean && !infected) {   // same transaction as the row: no processing image without its re-scan job
      await c.tx.query('SELECT app.enqueue_job($1, $2::jsonb, $3)', [RESCAN_TASK, JSON.stringify({ tenant_id: c.tenantId, image_id: id }), `image:${id}`]);
    }
    // 02-TRD §9: lims_anatomic_image_processing_total{outcome}; C1 security alert watches outcome="quarantined"
    (hctx as { metrics?: { inc(n: string, l: object): void } }).metrics?.inc('lims_anatomic_image_processing_total', { outcome: clean ? 'ready' : infected ? 'quarantined' : 'scan_retry' });
    return { status: 201, body: imageDto(saved) };
  } catch (e) {
    await x.storage.delete(BUCKET, objectPath).catch(() => undefined);   // no orphan object when the row is refused
    throw e;
  }
}

// ---- I2 getAnatomicImageContent ----
export async function getImageContent(hctx: unknown, params: unknown): Promise<Result> {
  const c = anatomicCtx(hctx);
  const { img, cs } = await loadImage(c, isObj(params) ? params['image_id'] : undefined);
  await assertAt(c, 'anatomic.case.read', cs);
  if (img['state'] !== 'ready') throw new LimsError('common.upload_quarantined');   // processing / quarantined: never read, never served (AC-12.1, AC-12.4)
  const ext = img['mime_type'] === 'image/jpeg' ? 'jpg' : 'png';
  return (hctx as ImageCtx).download.stream({   // D-67 inline headers + one anatomic_image.view row per call
    bucket: img['bucket'], objectPath: img['object_path'], filename: `${img['id']}.${ext}`, contentType: img['mime_type'], scanState: img['scan_state'],
    inline: { reencodedImage: true },
    access: { action: 'anatomic_image.view', entityType: 'anatomic_image', entityId: img['id'], centreId: img['centre_id'], outcome: 'allowed' },
  });
}

// ---- I3 updateAnatomicImage (PUT: full replace of kind, part_id, caption) ----
export async function updateImageMeta(hctx: unknown, params: unknown, headers: unknown, body: unknown): Promise<Result> {
  const c = anatomicCtx(hctx);
  const { img, cs } = await loadImage(c, isObj(params) ? params['image_id'] : undefined);
  await assertAt(c, 'anatomic.case.work', cs);
  const version = expectedVersion(headers);
  const { kind, partId, caption } = fields(strict(body, ['kind', 'part_id', 'caption']));
  await checkPart(c, partId, cs);
  // D-66 (a)/(c): an edit on a signed_out case is fine unless the image is already in a signed version (content that was signed is never rewritten)
  const signed = (await listReportVersions(c.tx, { tenantId: c.tenantId, caseId: cs['id'] }))
    .some((v) => Array.isArray(v['images']) && v['images'].some((i: Row) => i?.['object_path'] === img['object_path']));
  if (signed) throw new LimsError('anatomic.signout_locked');
  if (Number(img['version']) !== version) throw new LimsError('common.version_conflict');
  const saved = await updateImage(c.tx, { tenantId: c.tenantId, id: img['id'], expectedVersion: version, actorId: c.actor.id, patch: { kind, part_id: partId ?? null, caption: caption ?? null } });
  if (!saved) throw new LimsError('common.version_conflict');
  return { status: 200, body: imageDto(saved) };
}

// ---- I4 deactivateAnatomicImage (soft: the object and any signed version that references it stay) ----
export async function deactivateImage(hctx: unknown, params: unknown, headers: unknown): Promise<Result> {
  const c = anatomicCtx(hctx);
  const { img, cs } = await loadImage(c, isObj(params) ? params['image_id'] : undefined);
  await assertAt(c, 'anatomic.case.work', cs);
  const version = expectedVersion(headers);
  if (Number(img['version']) !== version) throw new LimsError('common.version_conflict');
  const saved = await updateImage(c.tx, { tenantId: c.tenantId, id: img['id'], expectedVersion: version, actorId: c.actor.id, patch: { is_active: false } });
  if (!saved) throw new LimsError('common.version_conflict');
  return { status: 200, body: imageDto(saved) };
}
