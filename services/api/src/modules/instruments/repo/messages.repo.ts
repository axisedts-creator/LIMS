// Read-only repository for E33-E36 / E42 (02-TRD §6.8; 05-SCHEMA §2.8-§2.12). SQL on the REQUEST tx with an explicit tenant predicate on every statement
// (REQ-SEC-026); staff RLS hides other centres' rows. No INSERT/UPDATE/DELETE exists here: the E35 preview parse writes nothing.
// List/search selects never touch raw_bytes or sample_barcode columns of the result (barcode is only a predicate on E34).
import { paged, paging } from './agents.repo.js';

type Row = Record<string, any>;
export interface MessagesRepo {
  listMessages(tx: any, tenantId: string, q: { receivedAtFrom: string; receivedAtTo: string; instrumentId?: string; agentId?: string; centreId?: string; messageKind?: string[]; latestOutcome?: string[]; hasUnmapped?: boolean; hasQc?: boolean; cursor?: string; limit: number }): Promise<{ rows: Row[]; nextCursor?: string }>;
  searchMessages(tx: any, tenantId: string, q: { sampleBarcode: string; receivedAtFrom?: string; receivedAtTo?: string; instrumentId?: string; limit: number }): Promise<Row[]>;
  findMessage(tx: any, tenantId: string, messageId: string): Promise<Row | undefined>;
  getMessageRawBytes(tx: any, tenantId: string, messageId: string): Promise<Row | undefined>;
  listRuns(tx: any, tenantId: string, messageId: string): Promise<Row[]>;
  listRecords(tx: any, tenantId: string, messageId: string, runNo: number): Promise<Row[]>;
  findAttachmentByMessage(tx: any, tenantId: string, messageId: string): Promise<Row | undefined>;
  listRejections(tx: any, tenantId: string, q: { receivedAtFrom: string; receivedAtTo: string; agentId?: string; reason?: string; cursor?: string; limit: number }): Promise<{ rows: Row[]; nextCursor?: string }>;
}

const SUMMARY = `m.id, m.tenant_id, m.instrument_id, i.instrument_code, m.agent_id, m.centre_id, m.protocol, m.message_kind, m.received_at, m.captured_at, m.size_bytes,
  jsonb_build_object('run_no', lr.run_no, 'kind', lr.kind, 'outcome', lr.outcome, 'patient_records', lr.patient_records, 'qc_records', lr.qc_records,
    'calibrator_records', lr.calibrator_records, 'unmapped_records', lr.unmapped_records, 'emitted_events', lr.emitted_events) AS latest_run`;
const FROM = `FROM instruments.messages m
  JOIN instruments.instruments i ON i.tenant_id = m.tenant_id AND i.id = m.instrument_id
  JOIN LATERAL (SELECT * FROM instruments.processing_runs r WHERE r.tenant_id = m.tenant_id AND r.message_id = m.id ORDER BY r.run_no DESC LIMIT 1) lr ON true`;

export function createMessagesRepo(): MessagesRepo {
  return {
    async listMessages(tx, tenantId, q) {
      const p = paging(q);
      const v: unknown[] = [tenantId, q.receivedAtFrom, q.receivedAtTo];
      const w = ['m.tenant_id = $1', 'm.received_at >= $2', 'm.received_at < $3'];
      const add = (sql: string, val: unknown) => { v.push(val); w.push(sql.replace('?', `$${v.length}`)); };
      if (q.instrumentId !== undefined) add('m.instrument_id = ?', q.instrumentId);
      if (q.agentId !== undefined) add('m.agent_id = ?', q.agentId);
      if (q.centreId !== undefined) add('m.centre_id = ?', q.centreId);
      if (q.messageKind !== undefined) add('m.message_kind = ANY(?::text[])', q.messageKind);
      if (q.latestOutcome !== undefined) add('lr.outcome = ANY(?::text[])', q.latestOutcome);
      if (q.hasUnmapped !== undefined) add('(lr.unmapped_records > 0) = ?::boolean', q.hasUnmapped);
      if (q.hasQc !== undefined) add('(lr.qc_records > 0) = ?::boolean', q.hasQc);
      v.push(p.limit + 1, p.offset);
      const { rows } = await tx.query(
        `SELECT ${SUMMARY} ${FROM} WHERE ${w.join(' AND ')} ORDER BY m.received_at DESC, m.id DESC LIMIT $${v.length - 1} OFFSET $${v.length}`, v);
      return paged(rows, p);
    },
    async searchMessages(tx, tenantId, q) {
      const v: unknown[] = [tenantId, q.sampleBarcode];
      const w = ['m.tenant_id = $1'];
      const add = (sql: string, val: unknown) => { v.push(val); w.push(sql.replace('?', `$${v.length}`)); };
      if (q.receivedAtFrom !== undefined) add('m.received_at >= ?', q.receivedAtFrom);
      if (q.receivedAtTo !== undefined) add('m.received_at < ?', q.receivedAtTo);
      if (q.instrumentId !== undefined) add('m.instrument_id = ?', q.instrumentId);
      v.push(q.limit);
      return (await tx.query(
        `SELECT ${SUMMARY} ${FROM}
          WHERE ${w.join(' AND ')} AND EXISTS (SELECT 1 FROM instruments.message_records mr WHERE mr.tenant_id = m.tenant_id AND mr.message_id = m.id AND mr.sample_barcode = $2)
          ORDER BY m.received_at DESC, m.id DESC LIMIT $${v.length}`, v)).rows;
    },
    async findMessage(tx, tenantId, messageId) {
      return (await tx.query(
        `SELECT ${SUMMARY}, m.message_control_id, m.message_key_kind, m.warnings, i.driver_code, i.timezone, i.parser_options, i.qc_sample_id_patterns
           ${FROM} WHERE m.tenant_id = $1 AND m.id = $2`, [tenantId, messageId])).rows[0];
    },
    async getMessageRawBytes(tx, tenantId, messageId) {
      return (await tx.query('SELECT id, tenant_id, centre_id, raw_bytes, raw_sha256, size_bytes FROM instruments.messages WHERE tenant_id = $1 AND id = $2', [tenantId, messageId])).rows[0];
    },
    async listRuns(tx, tenantId, messageId) {
      return (await tx.query(
        `SELECT r.id, r.tenant_id, r.run_no, r.kind, r.driver_code, r.driver_version, r.outcome, r.error_code, r.error_reason, r.patient_records, r.qc_records, r.calibrator_records,
                r.host_query_records, r.unmapped_records, r.skipped_no_barcode_records, r.emitted_events, r.skipped_records, r.reason_code, r.reason_text, r.actor_type, r.created_at,
                CASE WHEN r.actor_type = 'user' THEN u.display_name END AS actor_display
           FROM instruments.processing_runs r LEFT JOIN core.users u ON u.tenant_id = r.tenant_id AND u.id = r.created_by AND r.actor_type = 'user'
          WHERE r.tenant_id = $1 AND r.message_id = $2 ORDER BY r.run_no`, [tenantId, messageId])).rows;
    },
    async listRecords(tx, tenantId, messageId, runNo) {
      return (await tx.query(
        `SELECT mr.id, mr.tenant_id, r.run_no, mr.record_seq, mr.record_class, mr.sample_barcode, mr.control_id_raw, mr.record_kind, mr.instrument_analyte_code, mr.mapping_status,
                mr.analyte_id, mr.test_id, mr.value_raw, mr.unit_raw, mr.instrument_flags, mr.instrument_result_time, mr.is_rerun, mr.emit_status, mr.event_id, mr.port_outcome,
                mr.port_reason_code, mr.port_result_id, mr.source_record_id, mr.warnings
           FROM instruments.message_records mr JOIN instruments.processing_runs r ON r.tenant_id = mr.tenant_id AND r.id = mr.run_id
          WHERE mr.tenant_id = $1 AND mr.message_id = $2 AND r.run_no = $3 ORDER BY mr.record_seq`, [tenantId, messageId, runNo])).rows;
    },
    async findAttachmentByMessage(tx, tenantId, messageId) {
      return (await tx.query(
        `SELECT id, centre_id, message_id, instrument_id, mime_type, size_bytes, original_file_name, scan_state
           FROM instruments.attachments WHERE tenant_id = $1 AND message_id = $2`, [tenantId, messageId])).rows[0];
    },
    async listRejections(tx, tenantId, q) {
      const p = paging(q);
      const v: unknown[] = [tenantId, q.receivedAtFrom, q.receivedAtTo];
      const w = ['tenant_id = $1', 'received_at >= $2', 'received_at < $3'];
      if (q.agentId !== undefined) { v.push(q.agentId); w.push(`agent_id = $${v.length}`); }
      if (q.reason !== undefined) { v.push(q.reason); w.push(`reason_code = $${v.length}`); }
      v.push(p.limit + 1, p.offset);
      const { rows } = await tx.query(
        `SELECT id, tenant_id, received_at, agent_id, claimed_instrument_id, agent_message_id, reason_code, size_bytes, raw_sha256
           FROM instruments.message_rejections WHERE ${w.join(' AND ')} ORDER BY received_at DESC, id DESC LIMIT $${v.length - 1} OFFSET $${v.length}`, v);
      return paged(rows, p);
    },
  };
}
