// Task reporting.process_input_file (02-TRD §9; 01-PRD AC-04.2/.3/.6/.7; 07-SECURITY T9, A12, REQ-SEC-084).
// pending_scan -> scanning -> (quarantined | sanitizing) -> (ready | rejected). The worker re-scans the quarantine object itself
// (ctx.storage.read + ctx.files.scan, 08 A17 P-19). outsourced_pdf: clean bytes go to the PDF sandbox /internal/sanitize (02-TRD §5.2) and
// nothing in the reply is trusted (re-hashed, magic-checked). narrative_image (AC-05.3, REQ-SEC-085): never the sandbox; the object is
// re-encoded again by the core PNG re-encoder (tampered / non-PNG / corrupt -> rejected). Only a ctx-built tenant-first key is written.
// Scanner unavailable / sandbox transport error -> throw (queue retry, never ready). Every state move is guarded by the state it read.
import { createHash } from 'node:crypto';
import type { TaskHandler } from '../../../core/manifest.js';
import { ImageRejected, reencodePng } from '../../../../../api/src/core/uploads/image.js';
import { markImageReady } from '../../../../../api/src/modules/reporting/repository/narrative-image.repo.js';
import * as repo from '../../../../../api/src/modules/reporting/repository/outsourced.repo.js';

export type SanitizeReply =
  | { ok: true; page_count: unknown; sha256: unknown; pdf_base64: unknown }
  | { ok: false; reason: unknown };
export interface SandboxClient { sanitize(bytes: Uint8Array): Promise<SanitizeReply> }

const BUCKET = 'reporting-inputs';
const REJECTED = 'reporting.outsourced_pdf_rejected';
const IMAGE_REJECTED = 'common.upload_quarantined';            // [CONV] N6 error code (02-TRD §6.4) reused for worker-side image rejection
const KINDS = ['outsourced_pdf', 'narrative_image'];
export const METRIC = 'lims_reporting_sandbox_rejections_total';    // 02-TRD §11 {reason}; [CONV] scanner hits counted with reason 'infected'
const REASONS = ['encrypted', 'malformed', 'too_many_pages', 'timeout', 'not_pdf'];
const DEFAULT_TIMEOUT_MS = 60_000;                           // [CONV] no sanitise timeout value in 02-TRD §5.2
const MAX_BYTES = 15 * 1024 * 1024;
const MAX_PAGES = 10_000;                                    // OpenAPI InputFile.page_count maximum
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const B64 = /^[A-Za-z0-9+/]*={0,2}$/;
const ACTIVE = ['pending_scan', 'scanning', 'sanitizing'];

class SandboxTimeout extends Error { constructor() { super('sandbox_timeout'); this.name = 'TimeoutError'; } }
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** Validated sanitised output, or the rejection reason label. */
export function checkReply(reply: SanitizeReply | undefined): { bytes: Uint8Array; pages: number; sha256: string } | { reason: string } {
  if (!reply || typeof reply !== 'object') return { reason: 'invalid_output' };
  if (reply.ok !== true) return { reason: REASONS.includes(String((reply as { reason?: unknown }).reason)) ? String((reply as { reason?: unknown }).reason) : 'malformed' };
  const { page_count: pages, sha256: digest, pdf_base64: b64 } = reply;
  if (!Number.isInteger(pages) || (pages as number) < 1 || (pages as number) > MAX_PAGES) return { reason: 'invalid_output' };
  if (typeof b64 !== 'string' || b64.length === 0 || b64.length % 4 !== 0 || !B64.test(b64)) return { reason: 'invalid_output' };
  const bytes = new Uint8Array(Buffer.from(b64, 'base64'));
  const pdf = bytes.length >= 5 && Buffer.from(bytes.subarray(0, 5)).toString('latin1') === '%PDF-';
  if (!pdf || bytes.length > MAX_BYTES || typeof digest !== 'string' || sha(bytes) !== digest.toLowerCase()) return { reason: 'invalid_output' };
  return { bytes, pages: pages as number, sha256: sha(bytes) };
}

export function createProcessInputFile(o: { sandbox: SandboxClient; timeoutMs?: number }): TaskHandler {
  const timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function sanitize(bytes: Uint8Array): Promise<SanitizeReply> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        o.sandbox.sanitize(bytes),
        new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new SandboxTimeout()), timeoutMs); }),
      ]);
    } catch (e) {
      // AC-04.7: a sandbox that does not finish in time is a rejection, not a retry.
      if ((e as Error)?.name === 'TimeoutError' || (e as Error)?.name === 'AbortError') return { ok: false, reason: 'timeout' };
      throw e;
    } finally { if (timer) clearTimeout(timer); }
  }

  return async (payload, ctx) => {
    const tenantId = ctx.tenantId;
    const fileId = payload?.['input_file_id'];
    if (typeof tenantId !== 'string' || payload?.tenant_id !== tenantId || typeof fileId !== 'string' || !UUID.test(fileId)) {
      ctx.log?.warn?.({ event: 'process_input_file_skipped', reason: 'bad_payload' });
      return;
    }
    const tx = ctx.tx as repo.Tx;
    const actorId = ctx.actor.id;
    const storage = ctx.storage as { read(b: string, p: string): Promise<Uint8Array>; put(b: string, p: string, bytes: Uint8Array, opts: { contentType: string; ifAbsent?: boolean }): Promise<unknown> };
    const files = ctx.files as { scan(b: Uint8Array): Promise<string> };
    const metrics = (ctx as unknown as { metrics?: { inc(name: string, labels?: Record<string, string>): void } }).metrics;

    const row = await repo.findFile(tx, tenantId, fileId);
    if (!row || row.tenant_id !== tenantId || !KINDS.includes(row.kind) || !ACTIVE.includes(row.state)) return;   // idempotent: terminal / unknown
    let state: string = row.state;
    const reject = async (toState: 'quarantined' | 'rejected', reason: string) => {
      await repo.failFile(tx, tenantId, fileId, state, toState, row.kind === 'narrative_image' ? IMAGE_REJECTED : REJECTED, actorId);
      metrics?.inc(METRIC, { reason });
      ctx.log?.warn?.({ event: 'input_file_rejected', input_file_id: fileId, state: toState, reason });
    };

    const original = await storage.read(BUCKET, row.quarantine_object_path);
    if (state !== 'sanitizing') {
      if (state === 'pending_scan') { if (!(await repo.moveState(tx, tenantId, fileId, state, 'scanning', actorId))) return; state = 'scanning'; }
      const scan = await files.scan(original);                 // throws -> retry
      if (scan === 'infected') return reject('quarantined', 'infected');
      if (scan !== 'clean') throw new Error('scanner_unavailable');   // REQ-SEC-084 fail closed
      if (!(await repo.moveState(tx, tenantId, fileId, state, 'sanitizing', actorId))) return;
      state = 'sanitizing';
    }

    const now = ctx.now();
    const publish = async (path: string, bytes: Uint8Array, digest: string, contentType: string) => {
      try {
        await storage.put(BUCKET, path, bytes, { contentType, ifAbsent: true });
      } catch (e) {
        // Retry after a lost DB step: the write-once object may already be there. Continue only if it is byte-identical.
        const existing = await storage.read(BUCKET, path).catch(() => undefined);
        if (!existing || sha(existing) !== digest) throw e;
      }
    };

    if (row.kind === 'narrative_image') {
      // ponytail: PNG only (core re-encoder has no JPEG decoder, CR T0D-17); N6 never stores a JPEG today.
      let img;
      try { img = reencodePng(original, 40); } catch (e) { if (e instanceof ImageRejected) return reject('rejected', 'malformed'); throw e; }
      const digest = sha(img.bytes);
      const path = `${tenantId}/narrative-images/${now.slice(0, 4)}/${now.slice(5, 7)}/${fileId}.png`;
      await publish(path, img.bytes, digest, 'image/png');
      await markImageReady(tx, tenantId, fileId, { path, sha256: digest, mime: 'image/png', width: img.width, height: img.height, actorId });
      return;
    }

    const out = checkReply(await sanitize(original));
    if ('reason' in out) return reject('rejected', out.reason);
    const path = `${tenantId}/outsourced/${now.slice(0, 4)}/${now.slice(5, 7)}/${fileId}.pdf`;
    await publish(path, out.bytes, out.sha256, 'application/pdf');
    await repo.markReady(tx, tenantId, fileId, { path, sha256: out.sha256, pageCount: out.pages, mime: 'application/pdf', actorId });
  };
}
