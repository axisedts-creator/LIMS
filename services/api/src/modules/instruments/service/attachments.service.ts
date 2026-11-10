// E06 submitAttachment + E37 downloadInstrumentAttachment (02-TRD §6.8, §7.2; 01-PRD AC-12.3..12.6; 07-SECURITY S-08, S-11, AB8, REQ-SEC-083..085, A13 P-2).
// E06: the ONLY writer of the object is ctx.uploads.accept (magic bytes, size, PNG re-encode without metadata, scan). The row stays `pending`: the worker
// (`instruments.scan_attachment`) scans again, moves the object out of quarantine and is the only one that may set `clean` and emit the event.
// E37: bytes go through the API (ctx.download.stream); no Storage URL is ever produced (no Storage URL is ever produced).
// Logs carry codes and ids only: never a barcode, file name or content (02-CV §9.2).
import { createHash } from 'node:crypto';
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { LimsError } from '../../../core/errors.js';
import { assertTenantPath } from '../../../core/storage/index.js';
import { contentDisposition } from '../../../core/storage/download.js';
import type { IncomingFile } from '../../../core/uploads/index.js';
import { capturedAt as correctedTime } from '../domain/instrumentTime.js';
import { getDriver } from '../drivers/registry.js';
import { createAttachmentsRepo, type AttachmentsRepo } from '../repo/attachments.repo.js';
import { isUuid } from './agents.service.js';
import { deviceScope, type DeviceCtx, type DeviceResult } from './enrolment.service.js';

type Row = Record<string, any>;
export interface AttachmentsCtx extends DeviceCtx {
  readonly uploads?: { accept(file: IncomingFile, opts: Row): Promise<{ sha256: string; byteSize: number; mime: string; objectPath: string; bucket: string }> };
  readonly storage?: { delete(bucket: any, path: string): Promise<void> };
  readonly download?: { stream(input: Row): Promise<any> };
  readonly ports?: { readonly IdentityPort?: { assertRole(ctx: unknown, r: { permission: string; centreId?: string }): Promise<unknown> } };
  readonly log?: { warn(o: Record<string, unknown>, msg: string): void };
}
export interface AttachmentsDeps { repo?: AttachmentsRepo }

const BUCKET = 'instruments-attachments' as const;
const MAX_BYTES = 15 * 1024 * 1024;
const ALLOW = ['application/pdf', 'image/png', 'image/jpeg'] as const;
const EXT: Readonly<Record<string, string>> = { pdf: 'pdf', png: 'png', jpg: 'jpg', jpeg: 'jpg' };
const HEX64 = /^[0-9a-f]{64}$/;
const HEADER_MAX = 255;                                  // contracts/openapi/instruments.yaml E37 200 headers maxLength
const READ_PERMISSION = 'instruments.message.read';
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const obj = (v: unknown): Row => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Row) : {});
const invalid = () => new LimsError('common.validation_failed');
const isUniqueViolation = (e: unknown) => (e as { code?: unknown })?.code === '23505';
const iso = (v: unknown) => new Date(v as string).toISOString();

/** Canonical JSON (sorted keys) of the capture metadata: the `raw_bytes` of a file_drop message (never the file itself). */
const canonical = (m: Row) => JSON.stringify(Object.fromEntries(Object.keys(m).sort().filter((k) => m[k] !== undefined).map((k) => [k, m[k]])));

/** Shrink the stem until the whole Content-Disposition header fits the contract (255). Keeps the extension. */
function fitName(name: string): string {
  const well = (name as string & { toWellFormed?: () => string }).toWellFormed?.() ?? name;
  if (contentDisposition('attachment', well).length <= HEADER_MAX) return well;
  const dot = well.lastIndexOf('.');
  const ext = dot > 0 && well.length - dot <= 6 ? well.slice(dot) : '';
  const stem = Array.from(dot > 0 && ext ? well.slice(0, dot) : well);
  while (stem.length > 1 && contentDisposition('attachment', stem.join('') + ext).length > HEADER_MAX) stem.pop();
  return stem.join('') + ext;
}

export function createAttachmentsService(deps: AttachmentsDeps = {}) {
  const repo = deps.repo ?? createAttachmentsRepo();

  return {
    /** E06 — `metadata` is the snake_case object of the multipart `metadata` part. */
    async submitAttachment(ctx: AttachmentsCtx, input: { metadata?: unknown; file?: IncomingFile }): Promise<DeviceResult> {
      const sc = deviceScope(ctx, 'device_token');
      const { tx, tenantId, agentId } = sc;
      const m = obj(input?.metadata); const file = input?.file;
      if (!ctx.uploads || !ctx.storage) throw new LimsError('common.internal');
      if (!isUuid(m['agent_message_id']) || !isUuid(m['instrument_id']) || typeof m['file_name'] !== 'string' || m['file_name'].length < 1 || m['file_name'].length > 255
        || typeof m['file_sha256'] !== 'string' || !HEX64.test(m['file_sha256']) || !(file?.bytes instanceof Uint8Array)) throw invalid();
      const amid = m['agent_message_id'] as string; const fileSha = m['file_sha256'] as string;

      // instrument checks (TRD §6.4 steps 2-3): RLS-visible, bound to this agent, receivable, file drop configured
      const ins = await repo.findInstrument(tx, tenantId, m['instrument_id']);
      if (!ins || (ins['tenant_id'] !== undefined && ins['tenant_id'] !== tenantId)) throw new LimsError('instruments.instrument_unknown');
      if (ins['agent_id'] !== agentId) throw new LimsError('instruments.device_mismatch');
      if (!['commissioning', 'live', 'suspended'].includes(ins['state'])) throw new LimsError('instruments.instrument_unknown');
      const fileDrop = ins['protocol'] === 'file_drop' || (obj(ins['file_drop'])['enabled'] !== undefined && obj(ins['file_drop'])['enabled'] !== false);
      if (!fileDrop) throw new LimsError('instruments.capability_not_supported');
      const driver = getDriver(ins['driver_code']);
      if (!driver) throw new LimsError('common.internal');

      // same file dropped twice at the same time: serialise on the dedupe key (a no-op on the in-memory fakes)
      await (tx as { query(t: string, v: unknown[]): Promise<unknown> }).query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`${tenantId}:${ins['id']}:${fileSha}`]);

      const attachmentId = uuidv7();
      const duplicate = async (originalId: string, reason: 'agent_message_id' | 'message_key'): Promise<DeviceResult> => {
        await repo.insertDuplicate(tx, tenantId, { centre_id: ins['centre_id'], agent_id: agentId, instrument_id: ins['id'], original_message_id: originalId, agent_message_id: amid, reason });
        const a = await repo.findAttachmentByMessage(tx, tenantId, originalId);
        // ponytail: `a` is only missing in a lock-less race (never on Postgres, which serialises above); answer with the id this request generated
        return { status: 202, body: { outcome: 'duplicate', instrument_message_id: originalId, attachment_id: a?.['id'] ?? attachmentId, scan_state: a?.['scan_state'] ?? 'pending' } };
      };
      const l1 = await repo.findMessageByAgentKey(tx, tenantId, agentId, amid);
      if (l1) return duplicate(l1.id, 'agent_message_id');

      // integrity: the declared hash/size must be those of the received bytes
      if (sha256(file.bytes) !== fileSha || (m['file_size'] !== undefined && m['file_size'] !== file.bytes.length)) throw invalid();
      const same = await repo.findMessageByKey(tx, tenantId, ins['id'], fileSha);
      if (same) return duplicate(same.id, 'message_key');

      // the object: accept() checks magic/extension/size, re-encodes PNG, scans (fail closed) and writes under the quarantine prefix
      const now = new Date(ctx.now?.() ?? new Date());
      const yyyy = String(now.getUTCFullYear()); const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
      const ext = EXT[(file.filename.split('.').pop() ?? '').toLowerCase()] ?? 'bin';       // an unknown extension is refused by accept() (415)
      const objectPath = `${tenantId}/q/${yyyy}/${mm}/${attachmentId}.${ext}`;
      const up = await ctx.uploads.accept(file, { allow: ALLOW, maxBytes: MAX_BYTES, bucket: BUCKET, objectPath, images: { reencode: true, stripMetadata: true }, scan: 'required' });

      try {
        const raw = Buffer.from(canonical({ file_name: m['file_name'], file_sha256: fileSha, file_size: m['file_size'], file_mtime_agent: m['file_mtime_agent'], barcode: m['barcode'],
          captured_at_agent: m['captured_at_agent'], instrument_id: ins['id'], agent_message_id: amid }), 'utf8');
        const captured = correctedTime(String(m['captured_at_agent']), Number(m['clock_offset_ms']));
        let stored: { id: string; received_at: string };
        try {
          stored = await repo.insertMessage(tx, tenantId, { instrument_id: ins['id'], centre_id: ins['centre_id'], agent_id: agentId, agent_message_id: amid, protocol: 'file_drop', message_kind: 'attachment',
            message_key: fileSha, message_key_kind: 'sha256', message_control_id: null, raw_bytes: raw, raw_sha256: sha256(raw), size_bytes: raw.length,
            captured_at_agent: m['captured_at_agent'], agent_clock_offset_ms: m['clock_offset_ms'], captured_at: captured, link_meta: {}, warnings: [], created_by: agentId });
        } catch (e) {
          if (!isUniqueViolation(e)) throw e;
          // lost a unique-key race: the winner's message is the original. Never a 500; drop our object.
          await ctx.storage.delete(BUCKET, objectPath).catch(() => undefined);
          const won = (await repo.findMessageByAgentKey(tx, tenantId, agentId, amid)) ?? (await repo.findMessageByKey(tx, tenantId, ins['id'], fileSha));
          if (!won) throw e;
          return await duplicate(won.id, (await repo.findMessageByAgentKey(tx, tenantId, agentId, amid)) ? 'agent_message_id' : 'message_key');
        }
        const run = await repo.insertRun(tx, tenantId, { centre_id: ins['centre_id'], message_id: stored.id, run_no: 1, kind: 'live', driver_code: driver.code, driver_version: driver.version.slice(0, 32),
          outcome: 'parsed', error_code: null, error_reason: null, patient_records: 1, actor_type: 'device', created_by: agentId });
        // [CONV] the attachment record's analyte code is the capture code configured on the instrument (transport for protocol file_drop, else file_drop)
        const code = obj(ins['transport'])['attachment_instrument_code'] ?? obj(ins['file_drop'])['attachment_instrument_code'];
        await repo.insertRecords(tx, tenantId, [{ centre_id: ins['centre_id'], message_id: stored.id, run_id: run.id, instrument_id: ins['id'], record_seq: 1, record_class: 'patient', record_kind: 'attachment',
          sample_barcode: typeof m['barcode'] === 'string' ? m['barcode'] : null, instrument_analyte_code: typeof code === 'string' ? code : null, mapping_status: 'unmapped', emit_status: 'pending_scan', created_by: agentId }]);
        await repo.insertAttachment(tx, tenantId, { id: attachmentId, centre_id: ins['centre_id'], message_id: stored.id, instrument_id: ins['id'], bucket: up.bucket, object_path: up.objectPath, sha256: up.sha256,
          mime_type: up.mime, size_bytes: up.byteSize, original_file_name: m['file_name'], scan_state: 'pending', created_by: agentId, updated_by: agentId });
        await repo.recordInstrumentActivity(tx, tenantId, ins['id'], { lastMessageAt: iso(stored.received_at), lastMessageAtAgent: iso(m['captured_at_agent']), actorId: agentId });
        await (tx as { query(t: string, v: unknown[]): Promise<unknown> }).query('SELECT app.enqueue_job($1, $2::jsonb, $3)',
          ['instruments.scan_attachment', JSON.stringify({ tenant_id: tenantId, attachment_id: attachmentId }), attachmentId]);
        return { status: 202, body: { outcome: 'accepted', instrument_message_id: stored.id, attachment_id: attachmentId, scan_state: 'pending' } };
      } catch (e) {
        await ctx.storage.delete(BUCKET, objectPath).catch(() => undefined);     // the tx rolls back: do not leave an orphan object
        throw e;
      }
    },

    /** E37 — streams the stored object; only a `clean` attachment is served (core download gate), every call is access-logged. */
    async downloadInstrumentAttachment(ctx: AttachmentsCtx, input: { instrumentMessageId?: unknown }): Promise<any> {
      if (typeof ctx?.tenantId !== 'string' || !isUuid(ctx.tenantId) || typeof ctx.actor?.id !== 'string' || !ctx.tx) throw new LimsError('auth.unauthenticated');
      const assertRole = ctx.ports?.IdentityPort?.assertRole;
      if (typeof assertRole !== 'function' || !ctx.download) throw new LimsError('common.internal');       // fail closed
      const id = input?.instrumentMessageId;
      if (!isUuid(id)) throw new LimsError('common.not_found');
      const a = await repo.findAttachmentByMessage(ctx.tx, ctx.tenantId, id);
      if (!a) throw new LimsError('common.not_found');                                                      // none, RLS-hidden or another tenant: 404
      await assertRole.call(ctx.ports!.IdentityPort, ctx, { permission: READ_PERMISSION, centreId: a['centre_id'] });
      assertTenantPath(ctx.tenantId, a['object_path']);                                                     // a corrupt row never reads outside the caller tenant
      return ctx.download.stream({ bucket: a['bucket'], objectPath: a['object_path'], filename: fitName(String(a['original_file_name'])), contentType: a['mime_type'], scanState: a['scan_state'],
        access: { action: 'instrument_message.attachment_view', entityType: 'instrument_message', entityId: id, centreId: a['centre_id'], outcome: 'allowed' } });
    },
  };
}
export type AttachmentsService = ReturnType<typeof createAttachmentsService>;
