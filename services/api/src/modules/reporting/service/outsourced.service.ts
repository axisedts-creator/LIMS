// Outsourced intake, API side: O1 upload, O2 list, O3 confirm, O4 withdraw, O5 download, O6 items worklist (02-TRD §6.4; 01-PRD AC-04.1-04.4,
// AC-04.6; 07-SECURITY T9, A12, REQ-SEC-083/084/085). Tenant and actor come from ctx only. Bytes are accepted through ctx.uploads (CR-C6-009)
// into quarantine; only the sanitised object written by reporting.process_input_file is ever served. Errors never carry input values.
import { LimsError, type FieldError } from '../../../core/errors.js';
import type { IncomingFile } from '../../../core/uploads/index.js';
import type { BucketName } from '../../../core/storage/index.js';
// [CONV] relative import until @lims/shared-ts is a services/api dependency (same as settings.service.ts).
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import * as repo from '../repository/outsourced.repo.js';
import { listCodes } from '../repository/settings.repo.js';

export interface OutsourcedCtx {
  readonly tenantId: string;
  readonly actor: { readonly type: string; readonly id: string; readonly membershipId?: string };
  readonly tx: unknown;
  readonly now?: () => string;
  readonly uploads?: { accept(file: IncomingFile, opts: Record<string, unknown>): Promise<{ sha256: string; byteSize: number; mime: string; objectPath: string }> };
  readonly storage?: { read(bucket: BucketName, path: string): Promise<Uint8Array> };
  readonly audit?: { access(entry: Record<string, unknown>): Promise<unknown> };
  readonly metrics?: { inc(name: string, labels?: Record<string, string>): void };
}

export const INPUT_BUCKET: BucketName = 'reporting-inputs';
export const PROCESS_TASK = 'reporting.process_input_file';
export const ASSEMBLE_TASK = 'reporting.assemble_report';
const MAX_BYTES = 15 * 1024 * 1024;           // 02-CV §10.2, 02-TRD O1
const LIST_MAX = 200;                         // [CONV] O2 has no paging in 02-TRD; bounded read
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ITEM_STATES = ['awaiting_file', 'awaiting_confirmation', 'confirmed'];

const fail = (path: string, code = 'common.field_invalid', message = 'Field invalid'): never => {
  throw new LimsError('common.validation_failed', undefined, [{ path, code, message } satisfies FieldError]);
};
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
function onlyKeys(o: Record<string, unknown>, allowed: readonly string[]) {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) fail(`/${k.slice(0, 64)}`, 'common.unknown_field', 'Unknown field');
}
function version(v: unknown): number {
  if (v === undefined || v === null) throw new LimsError('common.precondition_required');
  if (!Number.isSafeInteger(v) || (v as number) < 1 || (v as number) > 2147483647) fail('/If-Match');
  return v as number;
}
function scope(ctx: OutsourcedCtx) {
  if (typeof ctx?.tenantId !== 'string' || !UUID.test(ctx.tenantId) || typeof ctx.actor?.id !== 'string' || !ctx.tx) throw new LimsError('auth.unauthenticated');
  return { tx: ctx.tx as repo.Tx, tenantId: ctx.tenantId, actorId: ctx.actor.id };
}
const nowIso = (ctx: OutsourcedCtx) => (typeof ctx.now === 'function' ? ctx.now() : new Date().toISOString());
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));
/** Client filename = P2 metadata: basename only, no separators / traversal / controls, ≤ 200 (input_files__len__ck). */
export function safeName(name: string, fallback = 'outsourced.pdf'): string {
  const base = (name.split(/[\\/]/).pop() ?? '').replace(/[^\x20-\x7e]|["\\/]/g, '_').replace(/\.{2,}/g, '_').trim();
  return (base || fallback).slice(-200);
}

/** OpenAPI InputFile: only these keys; absent optional values are omitted (the schema has no nulls). */
function body(r: any) {
  const out: Record<string, unknown> = {
    id: r.id, kind: r.kind, order_item_id: r.order_item_id, state: r.state, original_filename: r.original_filename,
    size_bytes: Number(r.size_bytes), version: r.version,
  };
  if (r.page_count != null) out['page_count'] = r.page_count;
  if (r.external_lab_name != null) out['external_lab_name'] = r.external_lab_name;
  if (r.caption != null) out['caption'] = r.caption;
  if (r.last_error_code != null) out['last_error_code'] = r.last_error_code;
  if (r.confirmed_at != null) out['confirmed_at'] = iso(r.confirmed_at);
  return out;
}
const isRejected = (r: any) => r.state === 'quarantined' || r.state === 'rejected';

export function createOutsourcedService(deps: { newId?: () => string } = {}) {
  const newId = deps.newId ?? uuidv7;

  async function ownFile(tx: repo.Tx, tenantId: string, fileId: unknown) {
    if (typeof fileId !== 'string' || !UUID.test(fileId)) throw new LimsError('common.not_found');
    const row = await repo.findFile(tx, tenantId, fileId);
    // RLS + explicit predicate already scope the read; re-checked so a missing predicate can never leak another tenant's row.
    if (!row || row.tenant_id !== tenantId || row.kind !== 'outsourced_pdf') throw new LimsError('common.not_found');
    return row;
  }
  /** Readiness changed on this item: outsourced_ready = exactly one confirmed file (02-TRD §3); flag its reports and queue (deduped) assembly. */
  async function reassemble(tx: repo.Tx, tenantId: string, orderItemId: string, actorId: string) {
    await repo.lockOrderItem(tx, tenantId, orderItemId);
    const ready = (await repo.confirmedFileIds(tx, tenantId, orderItemId)).length === 1;
    for (const reportId of await repo.setOutsourcedReady(tx, tenantId, orderItemId, ready, actorId)) {
      await repo.markNeedsAssembly(tx, tenantId, reportId, actorId);
      await repo.enqueue(tx, ASSEMBLE_TASK, { tenant_id: tenantId, report_id: reportId }, `assemble:${reportId}`);
    }
  }

  return {
    /** O1 — AC-04.1 / AC-04.2 (inline scan hit) / AC-04.6. Nothing is stored, persisted or queued on any rejection. */
    async upload(ctx: OutsourcedCtx, input: { orderItemId: unknown; file: unknown; externalLabName: unknown }) {
      const { tx, tenantId, actorId } = scope(ctx);
      const lab = input?.externalLabName;
      if (typeof lab !== 'string' || lab.trim().length === 0 || lab.length > 120) fail('/external_lab_name');
      const orderItemId = input?.orderItemId;
      if (typeof orderItemId !== 'string' || !UUID.test(orderItemId)) fail('/order_item_id');
      if (!ctx.uploads || typeof ctx.uploads.accept !== 'function') throw new LimsError('common.internal');   // fail closed (CR-C6-009)
      const item = (await repo.findOrderItems(tx, tenantId, orderItemId as string))
        .find((r) => r.item_status === 'active' && r.requires_outsourced === true);
      if (!item) throw new LimsError('common.not_found');

      const id = newId();
      const now = nowIso(ctx);
      const quarantinePath = `${tenantId}/quarantine/${now.slice(0, 4)}/${now.slice(5, 7)}/${id}.bin`;
      const file = input.file as IncomingFile;
      let accepted;
      try {
        accepted = await ctx.uploads.accept(file, { allow: ['application/pdf'], maxBytes: MAX_BYTES, bucket: INPUT_BUCKET, objectPath: quarantinePath, scan: 'required' });
      } catch (e) {
        if (e instanceof LimsError && e.code === 'common.upload_quarantined') {
          ctx.metrics?.inc('lims_reporting_sandbox_rejections_total', { reason: 'infected' });   // AC-04.2 alert metric, same as worker [CONV]
          throw new LimsError('reporting.outsourced_pdf_rejected');
        }
        throw e;
      }
      // scanState 'unavailable' is stored and stays pending_scan: the worker re-scans and never passes a file it could not scan.
      const row = await repo.insertFile(tx, {
        id, tenantId, centreId: item.centre_id, orderId: item.order_id, orderItemId: orderItemId as string,
        originalFilename: safeName(typeof file?.filename === 'string' ? file.filename : ''), declaredMime: accepted.mime,
        sizeBytes: accepted.byteSize, sha256: accepted.sha256, quarantinePath, externalLabName: lab as string, actorId,
      });
      await repo.enqueue(tx, PROCESS_TASK, { tenant_id: tenantId, input_file_id: id }, `pif:${id}`);
      return body(row);
    },

    /** O2 */
    async list(ctx: OutsourcedCtx, input: { orderItemId: unknown }) {
      const { tx, tenantId } = scope(ctx);
      const orderItemId = input?.orderItemId;
      if (typeof orderItemId !== 'string' || !UUID.test(orderItemId)) fail('/order_item_id');
      const rows = await repo.listFiles(tx, tenantId, orderItemId as string, LIST_MAX);
      return { data: rows.filter((r) => r.tenant_id === tenantId && r.order_item_id === orderItemId).map(body) };
    },

    /** O3 — AC-04.4: ready -> confirmed; the item becomes outsourced_ready and its report is queued for assembly. */
    async confirm(ctx: OutsourcedCtx, input: { fileId: unknown; expectedVersion: unknown; body: unknown }) {
      const { tx, tenantId, actorId } = scope(ctx);
      const v = version(input?.expectedVersion);
      const b = input?.body;
      if (!isObj(b)) return fail('/');
      onlyKeys(b, ['patient_match_confirmed']);
      if (b['patient_match_confirmed'] !== true) fail('/patient_match_confirmed');
      const row = await ownFile(tx, tenantId, input.fileId);
      if (row.version !== v) throw new LimsError('common.version_conflict');
      if (row.state !== 'ready') throw new LimsError(isRejected(row) ? 'reporting.outsourced_pdf_rejected' : 'reporting.input_file_not_ready');
      const done = await repo.confirmFile(tx, tenantId, row.id, v, actorId, nowIso(ctx));
      if (!done) throw new LimsError('common.version_conflict');
      await reassemble(tx, tenantId, row.order_item_id, actorId);
      return body(done);
    },

    /** O4: (ready | confirmed) -> withdrawn; common.immutable_record when the file is in a released/superseded version. */
    async withdraw(ctx: OutsourcedCtx, input: { fileId: unknown; expectedVersion: unknown; body: unknown }) {
      const { tx, tenantId, actorId } = scope(ctx);
      const b = input?.body;
      if (!isObj(b)) return fail('/');
      onlyKeys(b, ['reason_code', 'reason_text']);
      const code = b['reason_code'];
      if (typeof code !== 'string' || code.length === 0 || code.length > 64) fail('/reason_code');
      const text = b['reason_text'];
      if (text !== undefined && text !== null && (typeof text !== 'string' || text.length > 500)) fail('/reason_text');
      const v = version(input?.expectedVersion);
      const codes = await listCodes(tx, tenantId, 'outsourced_withdraw_reasons', 200);
      if (!codes.some((c) => c.code === code)) fail('/reason_code');
      const row = await ownFile(tx, tenantId, input.fileId);
      if (row.version !== v) throw new LimsError('common.version_conflict');
      if (row.state !== 'ready' && row.state !== 'confirmed') throw new LimsError('reporting.input_file_not_ready');
      if (row.state === 'confirmed' && await repo.inReleasedVersion(tx, tenantId, row.id)) throw new LimsError('common.immutable_record');
      const done = await repo.withdrawFile(tx, tenantId, row.id, v, row.state, code as string, typeof text === 'string' ? text : null, actorId);
      if (!done) throw new LimsError('common.version_conflict');
      if (row.state === 'confirmed') await reassemble(tx, tenantId, row.order_item_id, actorId);
      return body(done);
    },

    /** O5 — AC-04.3: sanitised bytes only (never the quarantine object); access log report.outsourced_view (CR-C6-008). */
    async download(ctx: OutsourcedCtx, input: { fileId: unknown }) {
      const { tx, tenantId } = scope(ctx);
      if (!ctx.storage || !ctx.audit) throw new LimsError('common.internal');
      const row = await ownFile(tx, tenantId, input?.fileId);
      if ((row.state !== 'ready' && row.state !== 'confirmed') || typeof row.sanitized_object_path !== 'string' || !row.sanitized_object_path) {
        throw new LimsError('reporting.input_file_not_ready');
      }
      const bytes = await ctx.storage.read(INPUT_BUCKET, row.sanitized_object_path);
      await ctx.audit.access({ action: 'report.outsourced_view', entityType: 'input_file', entityId: row.id, centreId: row.centre_id, outcome: 'allowed' });
      return { bytes, filename: safeName(String(row.original_filename ?? '')), contentType: 'application/pdf' };
    },

    /** O6 worklist. [CONV] test_names[] needs the catalogue port (not wired yet): returned empty. */
    async listItems(ctx: OutsourcedCtx, q: { centreId?: unknown; state?: unknown; cursor?: unknown; limit?: unknown }) {
      const { tx, tenantId } = scope(ctx);
      const centreId = q?.centreId; const state = q?.state; const limit = q?.limit === undefined ? 50 : Number(q.limit);
      if (centreId !== undefined && (typeof centreId !== 'string' || !UUID.test(centreId))) fail('/centre_id');
      if (state !== undefined && (typeof state !== 'string' || !ITEM_STATES.includes(state))) fail('/state');
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) fail('/limit');
      let afterAt: string | null = null; let afterId: string | null = null;
      if (q?.cursor !== undefined) {
        try {
          const c = JSON.parse(Buffer.from(String(q.cursor), 'base64url').toString('utf8'));
          if (typeof c?.k !== 'string' || Number.isNaN(Date.parse(c.k)) || typeof c?.i !== 'string' || !UUID.test(c.i)) throw new Error('bad');
          afterAt = c.k; afterId = c.i;
        } catch { throw new LimsError('common.invalid_cursor'); }
      }
      const rows = await repo.listOutsourcedItems(tx, tenantId, { centreId: (centreId as string) ?? null, state: (state as string) ?? null, afterAt, afterId, limit: limit + 1 });
      const pageRows = rows.slice(0, limit);
      const data = pageRows.map((r) => ({
        order_item_id: r.order_item_id, report_id: r.report_id, registration_no: r.registration_no, test_names: [] as string[],
        ...(r.latest_file_state ? { latest_file_state: r.latest_file_state } : {}), registered_at: iso(r.registered_at),
      }));
      const last = pageRows[pageRows.length - 1];
      const page: Record<string, unknown> = { limit };
      if (rows.length > limit && last) page['next_cursor'] = Buffer.from(JSON.stringify({ k: iso(last.registered_at), i: last.order_item_id })).toString('base64url');
      return { data, page };
    },
  };
}
export type OutsourcedService = ReturnType<typeof createOutsourcedService>;
