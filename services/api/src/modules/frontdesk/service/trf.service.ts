// TRF F20 uploadTrf / F21 getTrfAttachment / F21a getTrfAttachmentContent (02-TRD §2, §5.1, §6.3; 03-APP-FLOW §1.4; PRD US-FD-09.1-5; 07-SECURITY REQ-SEC-034/035/083-085, A11, A20; 08 R12b, A13 P-2).
// F20: the ONLY writer of the object is ctx.uploads.accept (magic bytes, 413/415, PNG re-encode without metadata, scan). The row stays `pending` under the quarantine key {tenant}/q/{yyyy}/{mm}/{id} (05-SCHEMA trf_attachments.object_path);
// the worker frontdesk.trf_scan is the only one that may set `clean` and move the object. A scanner outage never blocks the upload (the worker decides later).
// F21a: bytes go through the API (ctx.download.stream: scan gate, P-2 headers, trf.view access-log row); no Storage URL is ever produced. Not found / other tenant / out of centre scope = 404.
// Logs: this service logs nothing (file names are P2). Time is ctx.now(). Ctx shape ASSUMED as in the reporting upload handlers: uploads, storage, download (+ the PatientCtx basics).
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { LimsError } from '../../../core/errors.js';
import { contentDisposition } from '../../../core/storage/download.js';
import { loadFrontdeskConfig } from '../config.js';
import type { IncomingFile, UploadAcceptOptions } from '../../../core/uploads/index.js';
import { isoUtc } from '../mappers/patient.dto.js';
import { getOrderById } from '../repository/orders.repo.js';
import { getTrfAttachmentById, insertTrfAttachment } from '../repository/trf.repo.js';
import type { FRONTDESK_PERMISSIONS as P } from '../permissions.js';
import { bad, isObj, patientCtx, strict, type PatientCtx } from './patient.service.js';

interface TrfCtx extends PatientCtx {
  readonly uploads: { accept(file: IncomingFile, opts: UploadAcceptOptions): Promise<{ objectPath: string; sha256: string; byteSize: number; mime: string }> };
  readonly storage: { delete(bucket: 'frontdesk-trf', path: string): Promise<void> };
  readonly download: { stream(input: object): Promise<{ status: number; headers: Record<string, string>; body: Uint8Array }> };
  readonly core?: { membership?: (c: unknown, i: { membershipId: string }) => Promise<{ displayName: string }> };
}
type Row = Record<string, any>;

const UPLOAD: typeof P.trfUpload = 'frontdesk.trf.upload';
const READ: typeof P.orderRead = 'frontdesk.order.read';
const BUCKET = 'frontdesk-trf' as const;
const SIZE_CAP = 15728640;                                               // DB trf_attachments__size__ck; LIMS_FRONTDESK_TRF_MAX_BYTES may only lower it
const ALLOW = ['application/pdf', 'image/jpeg', 'image/png'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEADER_MAX = 255;                                                  // frontdesk.yaml F21a Content-Disposition maxLength

function trfCtx(c: unknown): TrfCtx {
  const x = patientCtx(c) as TrfCtx;
  if (typeof x.uploads?.accept !== 'function' || typeof x.storage?.delete !== 'function' || typeof x.download?.stream !== 'function') throw new LimsError('common.internal');
  return x;
}

/** Display name of the caller and whether a centre is inside their scope (no scope = no centre: fail closed). */
async function caller(c: TrfCtx) {
  const a = (await c.ports.IdentityPort.getActor(c)) as { displayName?: string; centreScope?: { all?: boolean; centreIds?: readonly string[] } };
  const s = a.centreScope;
  return { displayName: String(a.displayName ?? ''), inScope: (centreId: unknown) => s?.all === true || (s?.centreIds ?? []).includes(centreId as string) };
}

/** Only the last path segment, no control characters (they would reach a response header); P2: never logged. */
function cleanName(v: string): string {
  const n = (v.split(/[\\/]/).pop() ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (n.length === 0 || [...n].length > 255) throw bad('/file');
  return n;
}

/** Shrink the stem until the whole Content-Disposition header fits the contract (255); keeps the extension. */
function fitName(name: string): string {
  const well = (name as string & { toWellFormed?: () => string }).toWellFormed?.() ?? name;
  if (contentDisposition('attachment', well).length <= HEADER_MAX) return well;
  const dot = well.lastIndexOf('.');
  const ext = dot > 0 && well.length - dot <= 6 ? well.slice(dot) : '';
  const stem = Array.from(ext ? well.slice(0, dot) : well);
  while (stem.length > 1 && contentDisposition('attachment', stem.join('') + ext).length > HEADER_MAX) stem.pop();
  return stem.join('') + ext;
}

async function displayName(c: TrfCtx, membershipId: string): Promise<string> {
  const look = c.core?.membership;
  if (!look) return '';
  try { return (await look(c, { membershipId })).displayName.slice(0, 200); } catch (e) { if (e instanceof LimsError && e.code === 'common.not_found') return ''; throw e; }
}

const dto = (r: Row, uploadedBy: string) => ({
  id: r['id'], ...(r['order_id'] != null ? { order_id: r['order_id'] } : {}), mime_type: r['mime_type'], size_bytes: Number(r['size_bytes']), scan_state: r['scan_state'],
  uploaded_at: isoUtc(r['created_at']), uploaded_by: { membership_id: r['created_by'], display_name: uploadedBy }, original_filename: r['original_filename'] ?? '',
});

// ======================= F20 uploadTrf =======================
export async function uploadTrf(hctx: unknown, body: unknown): Promise<{ status: number; body: unknown }> {
  const c = trfCtx(hctx);
  await c.ports.IdentityPort.assertRole(c, { permission: UPLOAD });
  const b = strict(body, ['file', 'centre_id', 'order_id']);
  const f = b['file'];
  if (!isObj(f) || !(f['bytes'] instanceof Uint8Array) || typeof f['filename'] !== 'string' || typeof f['mimeType'] !== 'string') throw bad('/file');
  const centreId = b['centre_id'], orderId = b['order_id'];
  if (typeof centreId !== 'string' || !UUID.test(centreId)) throw bad('/centre_id');
  if (orderId !== undefined && (typeof orderId !== 'string' || !UUID.test(orderId))) throw bad('/order_id');
  const name = cleanName(f['filename']);

  const who = await caller(c);
  if (!who.inScope(centreId)) throw new LimsError('auth.forbidden');                    // REQ-SEC-017
  if (orderId !== undefined) {                                                           // A11: validated BEFORE any byte is stored
    const o = await getOrderById(c.tx, c.tenantId, orderId);
    if (!o || !who.inScope(o['centre_id'])) throw new LimsError('common.not_found');
    if (o['centre_id'] !== centreId) throw bad('/order_id');
  }

  const id = uuidv7(); const now = c.now();
  const objectPath = `${c.tenantId}/q/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${id}`;   // server-generated: the client name never reaches the key
  const up = await c.uploads.accept({ filename: name, mimeType: f['mimeType'], bytes: f['bytes'] },
    { allow: ALLOW, maxBytes: Math.min(loadFrontdeskConfig().trfMaxBytes, SIZE_CAP), bucket: BUCKET, objectPath, images: { reencode: true, stripMetadata: true }, scan: 'required' });
  try {
    const by = c.actor.membershipId ?? c.actor.id;                                       // [CONV] created_by holds the membership id (as orders / flags)
    const row = await insertTrfAttachment(c.tx, c.tenantId, { id, centre_id: centreId, order_id: orderId ?? null, object_path: up.objectPath, original_filename: name,
      mime_type: up.mime, size_bytes: up.byteSize, sha256: up.sha256, created_by: by, updated_by: by });
    await c.tx.query('SELECT app.enqueue_job($1, $2::jsonb, $3)', ['frontdesk.trf_scan', JSON.stringify({ tenant_id: c.tenantId, attachment_id: id }), id]);
    return { status: 201, body: dto(row, who.displayName.slice(0, 200)) };
  } catch (e) {
    await c.storage.delete(BUCKET, up.objectPath).catch(() => undefined);              // the tx rolls back: leave no orphan object
    throw e;
  }
}

// ======================= F21 / F21a =======================
async function loadVisible(c: TrfCtx, params: unknown): Promise<Row> {
  await c.ports.IdentityPort.assertRole(c, { permission: READ });
  const id = isObj(params) ? params['attachment_id'] : undefined;
  const row = typeof id === 'string' && UUID.test(id) ? await getTrfAttachmentById(c.tx, c.tenantId, id) : null;
  if (!row || !(await caller(c)).inScope(row['centre_id'])) throw new LimsError('common.not_found');   // A11: same answer for missing, foreign tenant and out-of-scope centre
  return row;
}

export async function getTrfAttachment(hctx: unknown, params: unknown): Promise<{ status: number; body: unknown }> {
  const c = trfCtx(hctx);
  const row = await loadVisible(c, params);
  return { status: 200, body: dto(row, await displayName(c, row['created_by'])) };
}

/** Only a `clean` TRF is served (the row state is the gate, never a fresh scan); every successful call writes one trf.view access-log row. */
export async function getTrfAttachmentContent(hctx: unknown, params: unknown): Promise<{ status: number; headers: Record<string, string>; body: Uint8Array }> {
  const c = trfCtx(hctx);
  const row = await loadVisible(c, params);
  return c.download.stream({ bucket: row['bucket'], objectPath: row['object_path'], filename: fitName(String(row['original_filename'] || 'trf')), contentType: row['mime_type'],
    scanState: row['scan_state'], access: { action: 'trf.view', entityType: 'trf_attachment', entityId: row['id'], centreId: row['centre_id'], outcome: 'allowed' } });
}
