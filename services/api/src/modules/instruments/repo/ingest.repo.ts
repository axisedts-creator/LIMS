// Repository for E04 submitMessageBatch (02-TRD §6.4; 05-SCHEMA §2.8-§2.14). SQL on the REQUEST tx (device RLS applies: the device sees its own
// centre only) with an explicit tenant predicate on every statement (REQ-SEC-026). messages / processing_runs / message_records /
// message_duplicates / message_rejections are INSERT-only (class A).
// [CONV] ids are generated here (uuidv7); received_at = now() = transaction time.
// [CONV] seam shape (and why `tx` is `any`): the fake world in __tests__/ingest.helpers.ts implements the same interface.
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';

type Row = Record<string, any>;
export interface IngestRepo {
  findInstrument(tx: any, tenantId: string, instrumentId: string): Promise<Row | undefined>;
  findMessageByAgentKey(tx: any, tenantId: string, agentId: string, agentMessageId: string): Promise<{ id: string } | undefined>;
  findMessageByKey(tx: any, tenantId: string, instrumentId: string, messageKey: string): Promise<{ id: string; raw_sha256: string } | undefined>;
  insertMessage(tx: any, tenantId: string, row: Row): Promise<{ id: string; received_at: string }>;
  insertDuplicate(tx: any, tenantId: string, row: Row): Promise<void>;
  insertRejection(tx: any, tenantId: string, row: Row): Promise<void>;
  insertRun(tx: any, tenantId: string, row: Row): Promise<{ id: string }>;
  insertRecords(tx: any, tenantId: string, rows: Row[]): Promise<void>;
  upsertObservedCodes(tx: any, tenantId: string, rows: Row[]): Promise<void>;
  recordInstrumentActivity(tx: any, tenantId: string, instrumentId: string, o: { lastMessageAt: string; lastMessageAtAgent: string; instrumentClockOffsetSeconds?: number | null; actorId: string }): Promise<void>;
}
/** E05 adds one read: the stored query bytes, to rebuild the reply on an agent-key duplicate (02-TRD §6.6). */
export interface HostQueryRepo extends IngestRepo {
  findMessageRaw(tx: any, tenantId: string, messageId: string): Promise<{ raw_bytes: Buffer; raw_sha256: string } | undefined>;
}

const RUN_COUNTERS = ['patient_records', 'qc_records', 'calibrator_records', 'host_query_records', 'unmapped_records', 'skipped_no_barcode_records', 'emitted_events', 'skipped_records'] as const;
// message_records columns after (id, tenant_id); the order is the order of $n placeholders
const REC_COLS = ['centre_id', 'message_id', 'run_id', 'instrument_id', 'record_seq', 'record_class', 'sample_barcode', 'control_id_raw', 'control_lot_raw', 'control_level',
  'record_kind', 'instrument_analyte_code', 'mapping_status', 'analyte_id', 'test_id', 'value_raw', 'value_numeric', 'unit_raw', 'instrument_flags', 'instrument_result_time',
  'instrument_clock_offset_seconds', 'is_rerun', 'organism', 'ast', 'result_key_sha256', 'emit_status', 'event_id', 'detail', 'warnings', 'created_by'] as const;
const JSONB = new Set(['organism', 'ast', 'detail']);
const REC_CHUNK = 500;                                   // 31 params per row, well below the 65,535 bind limit
const n = (v: unknown) => (v === undefined ? null : v);

export function createIngestRepo(): HostQueryRepo {
  return {
    async findInstrument(tx, tenantId, instrumentId) {
      return (await tx.query(
        `SELECT id, tenant_id, centre_id, agent_id, protocol, driver_code, state, cap_host_query, timezone, parser_options, qc_sample_id_patterns
           FROM instruments.instruments WHERE tenant_id = $1 AND id = $2`, [tenantId, instrumentId])).rows[0];
    },
    async findMessageByAgentKey(tx, tenantId, agentId, agentMessageId) {
      return (await tx.query('SELECT id FROM instruments.messages WHERE tenant_id = $1 AND agent_id = $2 AND agent_message_id = $3', [tenantId, agentId, agentMessageId])).rows[0];
    },
    async findMessageByKey(tx, tenantId, instrumentId, messageKey) {
      return (await tx.query('SELECT id, raw_sha256 FROM instruments.messages WHERE tenant_id = $1 AND instrument_id = $2 AND message_key = $3', [tenantId, instrumentId, messageKey])).rows[0];
    },
    async findMessageRaw(tx, tenantId, messageId) {
      return (await tx.query('SELECT raw_bytes, raw_sha256 FROM instruments.messages WHERE tenant_id = $1 AND id = $2', [tenantId, messageId])).rows[0];
    },
    async insertMessage(tx, tenantId, r) {
      const id = uuidv7();
      const { rows } = await tx.query(
        `INSERT INTO instruments.messages (id, tenant_id, centre_id, instrument_id, agent_id, agent_message_id, protocol, message_kind, message_key, message_key_kind, message_control_id,
            raw_bytes, raw_sha256, size_bytes, captured_at_agent, agent_clock_offset_ms, captured_at, link_meta, warnings, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb,$19,$20) RETURNING received_at`,
        [id, tenantId, r['centre_id'], r['instrument_id'], r['agent_id'], r['agent_message_id'], r['protocol'], r['message_kind'], r['message_key'], r['message_key_kind'],
          n(r['message_control_id']), r['raw_bytes'], r['raw_sha256'], r['size_bytes'], r['captured_at_agent'], r['agent_clock_offset_ms'], r['captured_at'],
          JSON.stringify(r['link_meta'] ?? {}), r['warnings'] ?? [], r['created_by']]);
      return { id, received_at: rows[0].received_at };
    },
    async insertDuplicate(tx, tenantId, r) {
      await tx.query(
        `INSERT INTO instruments.message_duplicates (id, tenant_id, centre_id, agent_id, instrument_id, original_message_id, agent_message_id, reason, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$4)`,
        [uuidv7(), tenantId, r['centre_id'], r['agent_id'], r['instrument_id'], r['original_message_id'], r['agent_message_id'], r['reason']]);
    },
    async insertRejection(tx, tenantId, r) {
      // centre = the calling AGENT's centre (review #6), never the claimed instrument's
      await tx.query(
        `INSERT INTO instruments.message_rejections (id, tenant_id, centre_id, agent_id, claimed_instrument_id, agent_message_id, reason_code, raw_bytes, raw_sha256, size_bytes, created_by)
         SELECT $1::uuid, a.tenant_id, a.centre_id, a.id, $4::uuid, $5::uuid, $6::text, $7::bytea, $8::text, $9::int, a.id FROM instruments.agents a WHERE a.tenant_id = $2 AND a.id = $3`,
        [uuidv7(), tenantId, r['agent_id'], r['claimed_instrument_id'], r['agent_message_id'], r['reason_code'], n(r['raw_bytes']), r['raw_sha256'], r['size_bytes']]);
    },
    async insertRun(tx, tenantId, r) {
      const id = uuidv7();
      await tx.query(
        `INSERT INTO instruments.processing_runs (id, tenant_id, centre_id, message_id, run_no, kind, driver_code, driver_version, outcome, error_code, error_reason,
            ${RUN_COUNTERS.join(', ')}, actor_type, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,${RUN_COUNTERS.map((_, i) => `$${12 + i}`).join(',')},$20,$21)`,
        [id, tenantId, r['centre_id'], r['message_id'], r['run_no'], r['kind'], r['driver_code'], r['driver_version'], r['outcome'], n(r['error_code']), n(r['error_reason']),
          ...RUN_COUNTERS.map((c) => r[c] ?? 0), r['actor_type'], r['created_by']]);
      return { id };
    },
    async insertRecords(tx, tenantId, rows) {
      for (let i = 0; i < rows.length; i += REC_CHUNK) {
        const chunk = rows.slice(i, i + REC_CHUNK);
        const values: unknown[] = [];
        const tuples = chunk.map((r) => {
          const base = values.length;
          values.push(uuidv7(), tenantId, ...REC_COLS.map((c) => (JSONB.has(c) ? (r[c] === undefined ? (c === 'detail' ? '{}' : null) : JSON.stringify(r[c])) : c === 'instrument_flags' || c === 'warnings' ? (r[c] ?? []) : n(r[c]))));
          return `(${[...Array(REC_COLS.length + 2).keys()].map((k) => `$${base + k + 1}${REC_COLS[k - 2] && JSONB.has(REC_COLS[k - 2]!) ? '::jsonb' : ''}`).join(',')})`;
        });
        await tx.query(`INSERT INTO instruments.message_records (id, tenant_id, ${REC_COLS.join(', ')}) VALUES ${tuples.join(',')}`, values);
      }
    },
    async upsertObservedCodes(tx, tenantId, rows) {
      if (rows.length === 0) return;
      const values: unknown[] = [];
      const tuples = [...rows].sort((a, b) => `${a['record_class']}\0${a['instrument_analyte_code']}`.localeCompare(`${b['record_class']}\0${b['instrument_analyte_code']}`)).map((r) => {
        const b = values.length;
        values.push(tenantId, r['instrument_id'], r['centre_id'], r['record_class'], r['instrument_analyte_code'], r['mapping_status'], n(r['analyte_id']), r['count'] ?? 1, r['actor_id']);
        return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},now(),now(),$${b + 8},$${b + 6},$${b + 7},now(),$${b + 9},$${b + 9})`;
      });
      await tx.query(
        `INSERT INTO instruments.observed_codes (tenant_id, instrument_id, centre_id, record_class, instrument_analyte_code, first_seen_at, last_seen_at, seen_count,
            last_mapping_status, last_analyte_id, last_mapping_checked_at, created_by, updated_by)
         VALUES ${tuples.join(',')}
         ON CONFLICT (tenant_id, instrument_id, record_class, instrument_analyte_code) DO UPDATE SET
            last_seen_at = now(), seen_count = instruments.observed_codes.seen_count + EXCLUDED.seen_count, last_mapping_status = EXCLUDED.last_mapping_status,
            last_analyte_id = EXCLUDED.last_analyte_id, last_mapping_checked_at = now(), updated_at = now(), updated_by = EXCLUDED.updated_by`, values);
    },
    async recordInstrumentActivity(tx, tenantId, instrumentId, o) {
      await tx.query(
        `INSERT INTO instruments.instrument_status (tenant_id, instrument_id, centre_id, agent_id, last_message_at, last_message_at_agent, instrument_clock_offset_seconds, created_by, updated_by)
         SELECT i.tenant_id, i.id, i.centre_id, i.agent_id, $3::timestamptz, $4::timestamptz, $5::int, $6::uuid, $6::uuid FROM instruments.instruments i WHERE i.tenant_id = $1 AND i.id = $2
         ON CONFLICT (tenant_id, instrument_id) DO UPDATE SET
            last_message_at = GREATEST(instrument_status.last_message_at, EXCLUDED.last_message_at), last_message_at_agent = EXCLUDED.last_message_at_agent,
            instrument_clock_offset_seconds = COALESCE(EXCLUDED.instrument_clock_offset_seconds, instrument_status.instrument_clock_offset_seconds),
            updated_at = now(), updated_by = EXCLUDED.updated_by`,
        [tenantId, instrumentId, o.lastMessageAt, o.lastMessageAtAgent, o.instrumentClockOffsetSeconds ?? null, o.actorId]);
    },
  };
}
