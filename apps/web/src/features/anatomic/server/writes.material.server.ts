import 'server-only';
// C11 T-20 writes: blocks, slides, stain orders, movements, images (04-UI-UX §4.2.3-5, §4.4). Every id is validated (REQ-SEC-026/027), bodies are rebuilt
// field by field (no mass assignment), row versions go in If-Match, required idempotency keys are forwarded. LD-140 (2026-11-13): no UI in this file.
import { randomUUID } from 'node:crypto';
import { serverFetch } from '@/core/api/server-fetch';
import { bad, idemKey, ifMatch, jsonInit, uuid } from './shared';
import type {
  AddBlocksInput, AddSlidesInput, AssessmentInput, Block, BulkResult, CaseImage, CompleteStainInput, ImageKind, ImageMetaInput, MovementInput, MovementKind, MovementOutcome, MovementReason,
  OrderStainInput, Slide, StainOrder,
} from './types';

const API = '/v1/anatomic';
const STAIN = /^[A-Za-z0-9_.:-]{1,64}$/; // body schema of createAnatomicStainOrder / createAnatomicSlides
const IMAGE_KINDS: readonly ImageKind[] = ['gross', 'microscopy', 'other'];
const MOVEMENTS: readonly MovementKind[] = ['stored', 'retrieved', 'sent_out', 'returned', 'discarded'];
const REASONS: readonly MovementReason[] = ['second_opinion', 'external_stain', 'consultation', 'retention_expired', 'other'];

const str = (v: unknown, min: number, max: number) => {
  if (typeof v !== 'string' || v.length < min || v.length > max) throw bad();
  return v;
};
const opt = (v: unknown, max: number) => (v === undefined ? undefined : str(v, 0, max));
const int = (v: unknown, min: number, max: number) => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw bad();
  return v;
};
const idList = (ids: unknown) => {
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 200) throw bad();
  return ids.map(uuid);
};
const guard = (v: number, key: string) => ({ 'if-match': ifMatch(v), 'idempotency-key': idemKey(key) });

/** createAnatomicBlocks (M1). */
export function addBlocks(caseId: string, input: AddBlocksInput, key: string) {
  const note = opt(input.note, 200);
  const body = { part_id: uuid(input.part_id), count: int(input.count, 1, 50), ...(note ? { note } : {}) };
  return serverFetch<{ blocks: Block[] }>(`${API}/cases/${uuid(caseId)}/blocks`, jsonInit('POST', body, { 'idempotency-key': idemKey(key) }));
}

/** createAnatomicSlides (M3): exactly one of block_id / part_id. */
export function addSlides(caseId: string, input: AddSlidesInput, key: string) {
  if ((input.block_id === undefined) === (input.part_id === undefined)) throw bad();
  const where = input.block_id !== undefined ? { block_id: uuid(input.block_id) } : { part_id: uuid(input.part_id) };
  if (!STAIN.test(input.stain_code)) throw bad();
  const body = { ...where, stain_code: input.stain_code, count: int(input.count, 1, 20) };
  return serverFetch<{ slides: Slide[] }>(`${API}/cases/${uuid(caseId)}/slides`, jsonInit('POST', body, { 'idempotency-key': idemKey(key) }));
}

/** markAnatomicSlidesReady (M4), ≤ 200 ids (REQ-SEC-100). */
export const markSlidesReady = (ids: string[], key: string) =>
  serverFetch<{ results: BulkResult[] }>(`${API}/slides/bulk-mark-ready`, jsonInit('POST', { ids: idList(ids) }, { 'idempotency-key': idemKey(key) }));

/** saveAnatomicSlideAssessment (M5): cytology slides. */
export function saveAssessment(slideId: string, v: number, input: AssessmentInput) {
  if (typeof input.include_in_report !== 'boolean') throw bad();
  const code = opt(input.adequacy_code, 64);
  const finding = opt(input.finding_text, 2000);
  const body = { ...(code ? { adequacy_code: code } : {}), ...(finding ? { finding_text: finding } : {}), include_in_report: input.include_in_report };
  return serverFetch<Slide>(`${API}/slides/${uuid(slideId)}/assessment`, jsonInit('PUT', body, { 'if-match': ifMatch(v) }));
}

/** createAnatomicStainOrder (M6). */
export function orderStain(caseId: string, input: OrderStainInput, key: string) {
  if (!STAIN.test(input.stain_code)) throw bad();
  if (input.block_id !== undefined && input.part_id !== undefined) throw bad();
  const note = opt(input.note, 500);
  const body = {
    stain_code: input.stain_code,
    ...(input.block_id !== undefined ? { block_id: uuid(input.block_id) } : {}),
    ...(input.part_id !== undefined ? { part_id: uuid(input.part_id) } : {}),
    ...(note ? { note } : {}),
    ...(input.addon_order_item_id !== undefined ? { addon_order_item_id: uuid(input.addon_order_item_id) } : {}),
  };
  return serverFetch<StainOrder>(`${API}/cases/${uuid(caseId)}/stain-orders`, jsonInit('POST', body, { 'idempotency-key': idemKey(key) }));
}

const stainPath = (id: string, op: string) => `${API}/stain-orders/${uuid(id)}/${op}`;

/** startAnatomicStainOrder (M7). */
export const startStain = (id: string, v: number, key: string) => serverFetch<StainOrder>(stainPath(id, 'start'), { method: 'POST', headers: guard(v, key) });

/** completeAnatomicStainOrder (M8): creates the stained slides, ready. */
export function completeStain(id: string, v: number, input: CompleteStainInput, key: string) {
  const lot = opt(input.reagent_lot, 64);
  if (input.performed_at !== undefined && (typeof input.performed_at !== 'string' || Number.isNaN(Date.parse(input.performed_at)))) throw bad();
  const body = { slide_count: int(input.slide_count, 1, 20), ...(lot ? { reagent_lot: lot } : {}), ...(input.performed_at ? { performed_at: input.performed_at } : {}) };
  return serverFetch<{ stain_order: StainOrder; slides: Slide[] }>(stainPath(id, 'complete'), jsonInit('POST', body, guard(v, key)));
}

/** cancelAnatomicStainOrder (M9): a free-text reason is required. */
export const cancelStain = (id: string, v: number, reason: string, key: string) =>
  serverFetch<StainOrder>(stainPath(id, 'cancel'), jsonInit('POST', { reason_text: str(reason, 1, 500) }, guard(v, key)));

/** linkAnatomicAddonItem (M10). */
export const linkAddon = (id: string, v: number, orderItemId: string, key: string) =>
  serverFetch<StainOrder>(stainPath(id, 'link-addon'), jsonInit('POST', { order_item_id: uuid(orderItemId) }, guard(v, key)));

/** recordAnatomicMovements (M11): one object_kind per call, ≤ 200 ids; the API re-checks the conditional fields (location / destination / reason). */
export function recordMovements(input: MovementInput, key: string) {
  if (!['block', 'slide'].includes(input.object_kind) || !MOVEMENTS.includes(input.movement)) throw bad();
  if (input.reason_code !== undefined && !REASONS.includes(input.reason_code)) throw bad();
  const loc = opt(input.location_text, 120);
  const dest = opt(input.destination_text, 200);
  const note = opt(input.note, 500);
  const body = {
    object_kind: input.object_kind,
    object_ids: idList(input.object_ids),
    movement: input.movement,
    ...(loc ? { location_text: loc } : {}),
    ...(dest ? { destination_text: dest } : {}),
    ...(input.reason_code ? { reason_code: input.reason_code } : {}),
    ...(note ? { note } : {}),
  };
  return serverFetch<{ results: MovementOutcome[] }>(`${API}/movements`, jsonInit('POST', body, { 'idempotency-key': idemKey(key) }));
}

/**
 * uploadAnatomicImage (I1) for the Images tab. The original file name is not forwarded (REQ-SEC-098); the API re-checks type, size and scan (REQ-SEC-083).
 * The multipart body is built from bytes: every field is validated first (enum / UUID), so no value can inject a header or a part.
 */
export async function uploadImage(caseId: string, form: FormData, key: string) {
  const file = form.get('file');
  if (!(file instanceof Blob) || !['image/png', 'image/jpeg'].includes(file.type) || file.size === 0 || file.size > 15 * 1024 * 1024) throw bad();
  const kind = form.get('kind');
  if (!IMAGE_KINDS.includes(kind as ImageKind)) throw bad();
  const part = form.get('part_id');
  const fields: [string, string][] = [['kind', kind as string], ...(part ? ([['part_id', uuid(part)]] as [string, string][]) : [])];

  const boundary = `lims-${randomUUID()}`;
  const text = (s: string) => Buffer.from(s, 'utf8');
  const body = Buffer.concat([
    ...fields.map(([name, value]) => text(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`)),
    text(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="image"\r\nContent-Type: ${file.type}\r\n\r\n`),
    Buffer.from(await file.arrayBuffer()),
    text(`\r\n--${boundary}--\r\n`),
  ]);
  return serverFetch<CaseImage>(`${API}/cases/${uuid(caseId)}/images`, {
    method: 'POST',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'idempotency-key': idemKey(key) },
    body,
  });
}

/** updateAnatomicImage (I3). */
export function updateImage(imageId: string, v: number, input: ImageMetaInput) {
  if (!IMAGE_KINDS.includes(input.kind)) throw bad();
  const caption = opt(input.caption, 200);
  const body = { kind: input.kind, ...(input.part_id ? { part_id: uuid(input.part_id) } : {}), ...(caption ? { caption } : {}) };
  return serverFetch<CaseImage>(`${API}/images/${uuid(imageId)}`, jsonInit('PUT', body, { 'if-match': ifMatch(v) }));
}

/** deactivateAnatomicImage (I4). */
export const deactivateImage = (imageId: string, v: number, key: string) =>
  serverFetch<CaseImage>(`${API}/images/${uuid(imageId)}/deactivate`, { method: 'POST', headers: guard(v, key) });
