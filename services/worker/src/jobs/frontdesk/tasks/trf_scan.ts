// frontdesk.trf_scan (02-TRD §10, 5 attempts; 07-SECURITY REQ-SEC-024/083-085; 08 A13 P-2). Enqueued by uploadTrf with job_key = attachment_id, tenant scope.
// Scans the STORED quarantine object (fail closed): clean -> move to {tenant}/{yyyy}/{mm}/{id} (05-SCHEMA object_path), row `clean` (the only place that may set it); hit -> `quarantined` (never moved, deleted or served);
// scanner / store unavailable -> throw (graphile retries), on the last attempt `failed` (the UI offers a re-upload). Final states stay final: a redelivery is a no-op.
// ponytail: no qpdf sanitise step (needs the sandbox helper), so `sanitized` stays false; sha256 is immutable (mutable-columns trigger) and already that of the stored bytes (F20 hashes what accept() stored).
// Logs and metrics carry ids and codes only: never a file name or content (P2). REQ-SEC-024: acts only on the tenant of the job claims; every statement binds tenant_id.
import { assertBucket, assertTenantPath } from '../../../../../api/src/core/storage/index.js';
import type { TaskHandler } from '../../../core/manifest.js';

export const TRF_SCAN = 'frontdesk.trf_scan';
const METRIC = 'lims_frontdesk_trf_scans_total';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const trfScan: TaskHandler = async (payload, jobCtx) => {
  const ctx = jobCtx as any;
  const tenantId = ctx.tenantId;
  if (typeof tenantId !== 'string' || !UUID.test(tenantId) || payload?.tenant_id !== tenantId) {
    ctx.log?.warn?.({ event: 'trf_scan_skipped', reason: 'bad_payload' });
    return;
  }
  const id = payload.attachment_id;
  if (typeof id !== 'string' || !UUID.test(id)) throw new Error('frontdesk.trf_scan: attachment_id must be a uuid');

  const tx = ctx.tx; const actorId = ctx.actor.id;
  const a = (await tx.query('SELECT * FROM frontdesk.trf_attachments WHERE tenant_id = $1 AND id = $2', [tenantId, id])).rows[0];
  if (!a) { ctx.log.warn({ event: 'trf_scan_not_found', attachment_id: id }, 'trf_scan_not_found'); return; }   // not visible: nothing to retry
  if (a.scan_state !== 'pending') return;

  const setState = (state: 'clean' | 'quarantined' | 'failed', objectPath?: string) => tx.query(
    `UPDATE frontdesk.trf_attachments SET scan_state = $3, scanned_at = $4::timestamptz, object_path = COALESCE($5, object_path), version = version + 1, updated_at = $4::timestamptz, updated_by = $6
      WHERE tenant_id = $1 AND id = $2 AND scan_state = 'pending'`, [tenantId, id, state, ctx.now(), objectPath ?? null, actorId]);
  const fail = async (reason: string, retryable: boolean): Promise<void> => {
    if (retryable && ctx.attempt < ctx.maxAttempts) throw new Error(`frontdesk.trf_scan: ${reason}`);          // graphile retries; nothing was written
    await setState('failed');
    ctx.metrics.inc(METRIC, { outcome: 'failed' });
    ctx.log.error({ event: 'trf_scan_failed', attachment_id: id, reason }, 'trf_scan_failed');
  };

  const from = String(a.object_path);
  try { assertBucket(a.bucket); assertTenantPath(tenantId, from); } catch { return fail('object_path_invalid', false); }   // a corrupt row never reads outside the tenant
  const created = new Date(a.created_at);
  const to = `${tenantId}/${created.getUTCFullYear()}/${String(created.getUTCMonth() + 1).padStart(2, '0')}/${id}`;

  let bytes: Uint8Array; let src = from;
  try { bytes = await ctx.storage.read(a.bucket, from); } catch {
    try { bytes = await ctx.storage.read(a.bucket, to); src = to; } catch { return fail('object_unreadable', true); }   // a previous attempt may have moved it before its tx failed
  }
  const verdict = await ctx.files.scan(bytes).catch((): 'unavailable' => 'unavailable');
  if (verdict === 'unavailable') return fail('scanner_unavailable', true);                                          // fail closed: never clean

  if (verdict === 'clean') {
    if (src !== to) await ctx.storage.move(a.bucket, from, to);
    await setState('clean', to);
    ctx.metrics.inc(METRIC, { outcome: 'clean' });
    return;
  }
  await setState('quarantined');
  ctx.metrics.inc(METRIC, { outcome: 'quarantined' });
  ctx.log.warn({ event: 'trf_quarantined', attachment_id: id, request_id: ctx.requestId }, 'trf_quarantined');      // security alert: no file, name or content
};
