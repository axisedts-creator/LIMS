// Repository for E38 / E39 (02-TRD §6.7; 05-SCHEMA §2.11-§2.12). SQL on the REQUEST tx with an explicit tenant predicate on every statement (REQ-SEC-026);
// staff RLS hides other centres' rows. processing_runs and message_records are class A: INSERT only, no update/delete method exists (the record of a re-match stays untouched).
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { createMessagesRepo } from './messages.repo.js';

type Row = Record<string, any>;
export interface ReprocessRepo {
  findMessage(tx: any, tenantId: string, messageId: string): Promise<Row | undefined>;
  getMessageRawBytes(tx: any, tenantId: string, messageId: string): Promise<Row | undefined>;
  findRecord(tx: any, tenantId: string, recordId: string): Promise<Row | undefined>;
  insertRun(tx: any, tenantId: string, row: Row): Promise<{ id: string }>;
  insertRecords(tx: any, tenantId: string, rows: Row[]): Promise<Row[]>;
}

const COUNTERS = ['patient_records', 'qc_records', 'calibrator_records', 'host_query_records', 'unmapped_records', 'skipped_no_barcode_records', 'emitted_events', 'skipped_records'] as const;
const REC_COLS = ['centre_id', 'message_id', 'run_id', 'instrument_id', 'record_seq', 'record_class', 'sample_barcode', 'control_id_raw', 'control_lot_raw', 'control_level',
  'record_kind', 'instrument_analyte_code', 'mapping_status', 'analyte_id', 'test_id', 'value_raw', 'value_numeric', 'unit_raw', 'instrument_flags', 'instrument_result_time',
  'instrument_clock_offset_seconds', 'is_rerun', 'organism', 'ast', 'result_key_sha256', 'emit_status', 'event_id', 'port_outcome', 'port_reason_code', 'port_result_id',
  'source_record_id', 'detail', 'warnings', 'created_by'] as const;
const JSONB = new Set<string>(['organism', 'ast', 'detail']);
const ARRAYS = new Set<string>(['instrument_flags', 'warnings']);
const CHUNK = 500;                                       // 36 params per row, well below the 65,535 bind limit
const n = (v: unknown) => (v === undefined ? null : v);

export function createReprocessRepo(): ReprocessRepo {
  const messages = createMessagesRepo();
  return {
    async findMessage(tx, tenantId, messageId) {
      return (await tx.query(
        `SELECT m.id, m.tenant_id, m.instrument_id, m.centre_id, m.agent_id, m.protocol, m.message_kind, m.received_at, m.captured_at,
                i.driver_code, i.timezone, i.parser_options, i.qc_sample_id_patterns, i.state AS instrument_state,
                jsonb_build_object('run_no', lr.run_no, 'kind', lr.kind, 'outcome', lr.outcome) AS latest_run
           FROM instruments.messages m
           JOIN instruments.instruments i ON i.tenant_id = m.tenant_id AND i.id = m.instrument_id
           JOIN LATERAL (SELECT * FROM instruments.processing_runs r WHERE r.tenant_id = m.tenant_id AND r.message_id = m.id ORDER BY r.run_no DESC LIMIT 1) lr ON true
          WHERE m.tenant_id = $1 AND m.id = $2`, [tenantId, messageId])).rows[0];
    },
    getMessageRawBytes: messages.getMessageRawBytes,
    async findRecord(tx, tenantId, recordId) {
      return (await tx.query(
        `SELECT mr.*, r.run_no, r.driver_code AS run_driver_code, r.driver_version AS run_driver_version FROM instruments.message_records mr JOIN instruments.processing_runs r ON r.tenant_id = mr.tenant_id AND r.id = mr.run_id
          WHERE mr.tenant_id = $1 AND mr.id = $2`, [tenantId, recordId])).rows[0];
    },
    async insertRun(tx, tenantId, r) {
      const id = uuidv7();
      await tx.query(
        `INSERT INTO instruments.processing_runs (id, tenant_id, centre_id, message_id, run_no, kind, driver_code, driver_version, outcome, error_code, error_reason,
            ${COUNTERS.join(', ')}, reason_code, reason_text, actor_type, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,${COUNTERS.map((_, i) => `$${12 + i}`).join(',')},$20,$21,$22,$23)`,
        [id, tenantId, r['centre_id'], r['message_id'], r['run_no'], r['kind'], r['driver_code'], r['driver_version'], r['outcome'], n(r['error_code']), n(r['error_reason']),
          ...COUNTERS.map((c) => r[c] ?? 0), r['reason_code'], n(r['reason_text']), r['actor_type'], r['created_by']]);
      return { id };
    },
    async insertRecords(tx, tenantId, rows) {
      const out: Row[] = [];
      for (let i = 0; i < rows.length; i += CHUNK) {
        const chunk = rows.slice(i, i + CHUNK);
        const values: unknown[] = [];
        const tuples = chunk.map((r) => {
          const id = uuidv7(); out.push({ ...r, id });
          const base = values.length;
          values.push(id, tenantId, ...REC_COLS.map((c) => (JSONB.has(c) ? (r[c] === undefined ? (c === 'detail' ? '{}' : null) : JSON.stringify(r[c])) : ARRAYS.has(c) ? (r[c] ?? []) : n(r[c]))));
          return `(${[...Array(REC_COLS.length + 2).keys()].map((k) => `$${base + k + 1}${k >= 2 && JSONB.has(REC_COLS[k - 2]!) ? '::jsonb' : ''}`).join(',')})`;
        });
        await tx.query(`INSERT INTO instruments.message_records (id, tenant_id, ${REC_COLS.join(', ')}) VALUES ${tuples.join(',')}`, values);
      }
      return out;
    },
  };
}
