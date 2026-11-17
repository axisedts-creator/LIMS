// Instruments / settings / observed-codes repository for E22-E32, E40-E41 (02-TRD §7.3; 05-SCHEMA §2.8, §2.9, §2.16-§2.18). SQL on the REQUEST tx (RLS applies)
// with an explicit tenant predicate on every tenant-table statement (REQ-SEC-026). g_drivers is global (no tenant). Rows are snake_case; mappers/instruments.mapper.ts
// turns them into DTOs. Column names in dynamic SET lists come from the whitelists below, never from input.
import { LimsError } from '../../../core/errors.js';
// [CONV] relative import until @lims/shared-ts is a services/api dependency (same as agents.service.ts).
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { paged, paging, type Page, type Row, type Tx } from './agents.repo.js';

export type { Row, Tx, Page };

export interface InstrumentsRepo {
  findAgent(tx: Tx, tenantId: string, agentId: string): Promise<{ id: string; tenant_id: string; centre_id: string; status: string } | undefined>;
  /** g_drivers rows (global, no tenant). */
  listDrivers(tx: Tx): Promise<Row[]>;
  /** Inserts the instrument AND its instrument_status row; duplicate (tenant_id, instrument_code) throws pg 23505. */
  insertInstrument(tx: Tx, tenantId: string, row: Row): Promise<Row>;
  findInstrument(tx: Tx, tenantId: string, id: string): Promise<Row | undefined>;
  listInstruments(tx: Tx, tenantId: string, q: Row): Promise<Page>;
  /** undefined = version mismatch. */
  updateInstrument(tx: Tx, tenantId: string, id: string, expectedVersion: number, patch: Row): Promise<Row | undefined>;
  transitionInstrument(tx: Tx, tenantId: string, id: string, expectedVersion: number, o: { state: string; actorId: string; reasonText?: string; checklist?: Row }): Promise<Row | undefined>;
  listObservedCodes(tx: Tx, tenantId: string, instrumentId: string, q: Row): Promise<Page>;
  getSettings(tx: Tx, tenantId: string): Promise<Row | undefined>;
  insertDefaultSettings(tx: Tx, tenantId: string, actorId: string): Promise<Row>;
  /** undefined = version mismatch. `row` = the four value columns + the window pair (null = cleared) + updated_by. */
  updateSettings(tx: Tx, tenantId: string, expectedVersion: number, row: Row): Promise<Row | undefined>;
  listNonRetiredAgentIds(tx: Tx, tenantId: string): Promise<string[]>;
}

const JSONB = new Set(['transport', 'protocol_options', 'parser_options', 'file_drop']);
const UPDATE_COLS = [
  'display_name', 'vendor', 'model', 'serial_no', 'software_version', 'protocol', 'driver_code', 'transport', 'protocol_options', 'parser_options', 'file_drop',
  'cap_host_query', 'cap_worklist_download', 'qc_sample_id_patterns', 'timezone', 'silence_window_minutes', 'silence_active_from', 'silence_active_to',
];
const INSERT_COLS = [
  'id', 'centre_id', 'agent_id', 'instrument_code', 'display_name', 'vendor', 'model', 'serial_no', 'software_version', 'protocol', 'driver_code', 'transport',
  'protocol_options', 'parser_options', 'file_drop', 'cap_host_query', 'cap_worklist_download', 'qc_sample_id_patterns', 'timezone', 'silence_window_minutes',
  'silence_active_from', 'silence_active_to', 'state', 'version',
];
const SETTINGS_COLS = ['default_backlog_threshold', 'backlog_max_oldest_pending_seconds', 'clock_offset_warn_seconds', 'agent_uploaded_retention_hours', 'update_window_from', 'update_window_to'];

const bind = (col: string, v: unknown): unknown => (v === undefined || v === null ? null : JSONB.has(col) ? JSON.stringify(v) : v);
const cast = (col: string, i: number) => (JSONB.has(col) ? `$${i}::jsonb` : col.startsWith('silence_active_') ? `$${i}::time` : `$${i}`);

const INSTRUMENT_SELECT = `SELECT i.id, i.tenant_id, i.centre_id, i.agent_id, a.agent_code, i.instrument_code, i.display_name, i.vendor, i.model, i.serial_no, i.software_version,
    i.protocol, i.driver_code, i.transport, i.protocol_options, i.parser_options, i.file_drop, i.cap_host_query, i.cap_worklist_download, i.qc_sample_id_patterns, i.timezone,
    i.silence_window_minutes, to_char(i.silence_active_from, 'HH24:MI') AS silence_active_from, to_char(i.silence_active_to, 'HH24:MI') AS silence_active_to,
    i.state, i.commissioned_at, i.live_at, i.live_by, u.display_name AS live_by_display, i.suspended_at, i.retired_at, i.go_live_checklist, i.state_reason_text, i.version,
    s.link_state, s.last_message_at, s.last_message_at_agent, s.last_link_error_code, s.instrument_clock_offset_seconds, s.silent_since,
    (SELECT count(*)::int FROM instruments.observed_codes o WHERE o.tenant_id = i.tenant_id AND o.instrument_id = i.id AND o.last_mapping_status = 'unmapped') AS unmapped_code_count
  FROM instruments.instruments i
  JOIN instruments.agents a ON a.tenant_id = i.tenant_id AND a.id = i.agent_id
  LEFT JOIN instruments.instrument_status s ON s.tenant_id = i.tenant_id AND s.instrument_id = i.id
  LEFT JOIN core.users u ON u.tenant_id = i.tenant_id AND u.id = i.live_by`;
const SETTINGS_SELECT = `SELECT id, tenant_id, default_backlog_threshold, backlog_max_oldest_pending_seconds, clock_offset_warn_seconds, agent_uploaded_retention_hours,
    to_char(update_window_from, 'HH24:MI') AS update_window_from, to_char(update_window_to, 'HH24:MI') AS update_window_to, version FROM instruments.settings`;

export function createInstrumentsRepo(): InstrumentsRepo {
  const repo: InstrumentsRepo = {
    async findAgent(tx, tenantId, agentId) {
      const { rows } = await tx.query('SELECT id, tenant_id, centre_id, status FROM instruments.agents WHERE tenant_id = $1 AND id = $2', [tenantId, agentId]);
      return rows[0];
    },
    async listDrivers(tx) {
      const { rows } = await tx.query(
        `SELECT code, display_name, protocol, vendor, model_pattern, status, driver_version, cap_host_query, cap_worklist_download, cap_qc, cap_attachments, cap_calibration,
                manual_title, manual_document_id, manual_revision, manual_software_version, is_active FROM instruments.g_drivers ORDER BY code`);
      return rows;
    },
    async insertInstrument(tx, tenantId, row) {
      const values: unknown[] = [tenantId, row['created_by']];
      const holes = INSERT_COLS.map((c) => { values.push(bind(c, row[c])); return cast(c, values.length); });
      await tx.query(
        `INSERT INTO instruments.instruments (tenant_id, created_by, updated_by, ${INSERT_COLS.join(', ')}) VALUES ($1, $2, $2, ${holes.join(', ')})`, values);
      await tx.query(
        `INSERT INTO instruments.instrument_status (tenant_id, instrument_id, centre_id, agent_id, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $5)`,
        [tenantId, row['id'], row['centre_id'], row['agent_id'], row['created_by']]);
      const out = await repo.findInstrument(tx, tenantId, row['id']);
      if (!out) throw new LimsError('common.internal');
      return out;
    },
    async findInstrument(tx, tenantId, id) {
      const { rows } = await tx.query(`${INSTRUMENT_SELECT} WHERE i.tenant_id = $1 AND i.id = $2`, [tenantId, id]);
      return rows[0];
    },
    async listInstruments(tx, tenantId, q) {
      const p = paging(q);
      const where = ['i.tenant_id = $1']; const values: unknown[] = [tenantId];
      const add = (sql: string, v: unknown) => { values.push(v); where.push(sql.replace('?', `$${values.length}`)); };
      if (q['centreId']) add('i.centre_id = ?', q['centreId']);
      if (q['agentId']) add('i.agent_id = ?', q['agentId']);
      if (q['state']?.length) add('i.state = ANY(?::text[])', q['state']);
      if (q['protocol']) add('i.protocol = ?', q['protocol']);
      const order = q['sort'] === '-last_message_at' ? 's.last_message_at DESC NULLS LAST, i.id' : 'i.instrument_code, i.id';
      values.push(p.limit + 1, p.offset);
      const { rows } = await tx.query(`${INSTRUMENT_SELECT} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT $${values.length - 1} OFFSET $${values.length}`, values);
      return paged(rows, p);
    },
    async updateInstrument(tx, tenantId, id, expectedVersion, patch) {
      const cols = Object.keys(patch).filter((k) => UPDATE_COLS.includes(k));
      const actor = patch['updated_by'];
      if (typeof actor !== 'string') throw new LimsError('common.internal');
      const values: unknown[] = [tenantId, id, expectedVersion, actor];
      const set = cols.map((c) => { values.push(bind(c, patch[c])); return `${c} = ${cast(c, values.length)}`; }).concat('version = version + 1', 'updated_at = now()', 'updated_by = $4');
      const { rows } = await tx.query(`UPDATE instruments.instruments SET ${set.join(', ')} WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING id`, values);
      return rows[0] ? repo.findInstrument(tx, tenantId, id) : undefined;
    },
    async transitionInstrument(tx, tenantId, id, expectedVersion, o) {
      const reason = o.reasonText ?? null;
      const byState: Record<string, string> = {
        commissioning: `state = 'commissioning', commissioned_at = now()`,
        live: o.checklist ? `state = 'live', live_at = now(), live_by = $4, go_live_checklist = $5::jsonb, state_reason_text = NULL` : `state = 'live', state_reason_text = NULL`,
        suspended: `state = 'suspended', suspended_at = now(), state_reason_text = $5`,
        retired: `state = 'retired', retired_at = now(), state_reason_text = $5`,
      };
      const set = byState[o.state];
      if (!set) throw new LimsError('common.internal');
      // an unreferenced $n makes pg fail type inference, so each variant binds exactly what it names
      const extra = o.state === 'live' ? (o.checklist ? [JSON.stringify(o.checklist)] : []) : /\$5/.test(set) ? [reason] : [];
      const { rows } = await tx.query(
        `UPDATE instruments.instruments SET ${set}, version = version + 1, updated_at = now(), updated_by = $4 WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING id`,
        [tenantId, id, expectedVersion, o.actorId, ...extra]);
      return rows[0] ? repo.findInstrument(tx, tenantId, id) : undefined;
    },
    async listObservedCodes(tx, tenantId, instrumentId, q) {
      const p = paging(q);
      const values: unknown[] = [tenantId, instrumentId, q['recordClass'] ?? null, q['mappingStatus'] ?? null, p.limit + 1, p.offset];
      const { rows } = await tx.query(
        `SELECT instrument_id, record_class, instrument_analyte_code, first_seen_at, last_seen_at, seen_count, last_mapping_status, last_analyte_id, last_mapping_checked_at
           FROM instruments.observed_codes
          WHERE tenant_id = $1 AND instrument_id = $2 AND ($3::text IS NULL OR record_class = $3) AND ($4::text IS NULL OR last_mapping_status = $4)
          ORDER BY record_class, instrument_analyte_code LIMIT $5 OFFSET $6`, values);
      return paged(rows, p);
    },
    async getSettings(tx, tenantId) {
      const { rows } = await tx.query(`${SETTINGS_SELECT} WHERE tenant_id = $1`, [tenantId]);
      return rows[0];
    },
    async insertDefaultSettings(tx, tenantId, actorId) {
      await tx.query(`INSERT INTO instruments.settings (id, tenant_id, created_by, updated_by) VALUES ($1, $2, $3, $3) ON CONFLICT (tenant_id) DO NOTHING`, [uuidv7(), tenantId, actorId]);
      const out = await repo.getSettings(tx, tenantId);
      if (!out) throw new LimsError('common.internal');
      return out;
    },
    async updateSettings(tx, tenantId, expectedVersion, row) {
      const actor = row['updated_by'];
      if (typeof actor !== 'string') throw new LimsError('common.internal');
      const values: unknown[] = [tenantId, expectedVersion, actor];
      const set = SETTINGS_COLS.map((c) => { values.push(row[c] ?? null); return `${c} = $${values.length}${c.startsWith('update_window_') ? '::time' : ''}`; })
        .concat('version = version + 1', 'updated_at = now()', 'updated_by = $3');
      const { rows } = await tx.query(`UPDATE instruments.settings SET ${set.join(', ')} WHERE tenant_id = $1 AND version = $2 RETURNING id`, values);
      return rows[0] ? repo.getSettings(tx, tenantId) : undefined;
    },
    async listNonRetiredAgentIds(tx, tenantId) {
      const { rows } = await tx.query(`SELECT id FROM instruments.agents WHERE tenant_id = $1 AND status <> 'retired' ORDER BY id`, [tenantId]);
      return rows.map((r) => r.id as string);
    },
  };
  return repo;
}
