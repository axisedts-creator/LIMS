// Repository for E06 / E37 (02-TRD §6.8; 05-SCHEMA §2.15). SQL on the REQUEST tx with an explicit tenant predicate on every statement (REQ-SEC-026).
// [CONV] reuses the T09 IngestRepo as is, except findInstrument: it also needs `file_drop` (capability check).
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { createIngestRepo, type IngestRepo } from './ingest.repo.js';

type Row = Record<string, any>;
export interface AttachmentsRepo extends IngestRepo {
  insertAttachment(tx: any, tenantId: string, row: Row): Promise<{ id: string }>;
  findAttachmentByMessage(tx: any, tenantId: string, messageId: string): Promise<Row | undefined>;
}

export function createAttachmentsRepo(): AttachmentsRepo {
  const base = createIngestRepo();
  return {
    ...base,
    async findInstrument(tx, tenantId, instrumentId) {
      return (await tx.query(
        `SELECT id, tenant_id, centre_id, agent_id, protocol, driver_code, state, timezone, transport, file_drop
           FROM instruments.instruments WHERE tenant_id = $1 AND id = $2`, [tenantId, instrumentId])).rows[0];
    },
    async insertAttachment(tx, tenantId, r) {
      const id = (r['id'] as string | undefined) ?? uuidv7();
      await tx.query(
        `INSERT INTO instruments.attachments (id, tenant_id, centre_id, message_id, instrument_id, bucket, object_path, sha256, mime_type, size_bytes, original_file_name, scan_state, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [id, tenantId, r['centre_id'], r['message_id'], r['instrument_id'], r['bucket'], r['object_path'], r['sha256'], r['mime_type'], r['size_bytes'], r['original_file_name'],
          r['scan_state'], r['created_by'], r['updated_by']]);
      return { id };
    },
    async findAttachmentByMessage(tx, tenantId, messageId) {
      return (await tx.query(
        `SELECT id, centre_id, message_id, instrument_id, bucket, object_path, sha256, mime_type, size_bytes, original_file_name, scan_state, scan_attempts, version
           FROM instruments.attachments WHERE tenant_id = $1 AND message_id = $2`, [tenantId, messageId])).rows[0];
    },
  };
}
