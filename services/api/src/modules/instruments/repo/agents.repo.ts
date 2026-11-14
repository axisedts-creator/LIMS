// Agents repository for E10-E21 (02-TRD §7.3; 05-SCHEMA §7). SQL on the REQUEST tx (RLS applies) with an explicit tenant
// predicate on every tenant-table statement (REQ-SEC-026). Never selects secret_sha256 (column grant CR-C7-006): credential
// INSERTs have no RETURNING. Rows are snake_case; agents.mapper.ts turns them into DTOs.
import { LimsError } from '../../../core/errors.js';

export type Row = Record<string, any>;
export interface Tx { query(text: string, values?: unknown[]): Promise<{ rows: any[] }> }
export interface Page { rows: Row[]; nextCursor?: string }

export interface AgentsRepo {
  getCentre(tx: Tx, tenantId: string, centreId: string): Promise<{ id: string; centre_kind: string; is_active: boolean } | undefined>;
  insertAgent(tx: Tx, tenantId: string, row: Row): Promise<Row>;
  findAgent(tx: Tx, tenantId: string, agentId: string): Promise<Row | undefined>;
  /** SELECT … FOR UPDATE on the agent row; serialises concurrent E14 for one agent. */
  lockAgent(tx: Tx, tenantId: string, agentId: string): Promise<Row | undefined>;
  listAgents(tx: Tx, tenantId: string, q: Row): Promise<Page>;
  findRelease(tx: Tx, releaseId: string): Promise<{ id: string; channel: string; is_active: boolean } | undefined>;
  listReleases(tx: Tx, q: { channel?: string }): Promise<Row[]>;
  isRevokeReason(tx: Tx, code: string): Promise<boolean>;
  updateAgent(tx: Tx, tenantId: string, agentId: string, expectedVersion: number, patch: Row, actorId?: string): Promise<Row | undefined>;
  transitionAgent(tx: Tx, tenantId: string, agentId: string, expectedVersion: number, o: { status: string; reasonCode?: string; reasonText?: string; actorId: string }): Promise<Row | undefined>;
  revokeCredentials(tx: Tx, tenantId: string, agentId: string, o: { kinds: string[]; reasonCode: string; actorId: string }): Promise<string[]>;
  insertCredential(tx: Tx, tenantId: string, row: Row): Promise<void>;
  countNonRetiredInstruments(tx: Tx, tenantId: string, agentId: string): Promise<number>;
  insertCommand(tx: Tx, tenantId: string, row: Row): Promise<Row>;
  listCommands(tx: Tx, tenantId: string, agentId: string, q: Row): Promise<Page>;
  listTransitions(tx: Tx, tenantId: string, agentId: string, q: Row): Promise<Page>;
  findLogBundle(tx: Tx, tenantId: string, agentId: string, bundleId: string): Promise<Row | undefined>;
}

const HEALTH = (st: string) => `CASE WHEN ${st}.agent_id IS NULL THEN NULL ELSE jsonb_build_object(
  'health_state', ${st}.health_state, 'health_version', ${st}.health_version, 'last_heartbeat_at', ${st}.last_heartbeat_at,
  'agent_version', ${st}.agent_version, 'launcher_version', ${st}.launcher_version, 'os_version', ${st}.os_version,
  'queue_depth', ${st}.queue_depth, 'oldest_pending_age_seconds', ${st}.oldest_pending_age_seconds, 'queue_rejected', ${st}.queue_rejected,
  'queue_oversize', ${st}.queue_oversize, 'disk_free_mb', ${st}.disk_free_mb, 'clock_offset_ms', ${st}.clock_offset_ms,
  'clock_offset_uncertainty_ms', ${st}.clock_offset_uncertainty_ms, 'config_version_applied', ${st}.config_version_applied,
  'config_state', ${st}.config_state, 'update_state', ${st}.update_state, 'update_target_version', ${st}.update_target_version,
  'auth_state', ${st}.auth_state, 'last_ip', host(${st}.last_ip), 'last_ip_changed_at', ${st}.last_ip_changed_at) END AS health`;
const AGENT_COLS = `a.id, a.tenant_id, a.centre_id, a.agent_code, a.display_name, a.status, a.update_channel, a.pinned_release_id,
  coalesce(a.backlog_threshold, s.default_backlog_threshold, 500) AS backlog_threshold, a.enrolled_at, a.revoked_at, a.revoke_reason_code,
  a.retired_at, a.latest_config_version, a.version`;
const AGENT_FROM = `FROM instruments.agents a
  LEFT JOIN instruments.settings s ON s.tenant_id = a.tenant_id
  LEFT JOIN instruments.agent_status st ON st.tenant_id = a.tenant_id AND st.agent_id = a.id`;
// newest 100 credentials (Agent.credentials maxItems 100); secret_sha256 is never selected
const CREDENTIALS = `coalesce((SELECT jsonb_agg(x.c ORDER BY x.issued_at DESC, x.id DESC) FROM (
    SELECT c.id, c.issued_at, jsonb_build_object('id', c.id, 'kind', c.kind, 'status', c.status, 'issued_at', c.issued_at,
      'issued_by_display', coalesce(u.display_name, 'Unknown'), 'expires_at', c.expires_at, 'used_at', c.used_at,
      'last_used_at', c.last_used_at, 'revoked_at', c.revoked_at) AS c
    FROM instruments.agent_credentials c LEFT JOIN core.users u ON u.tenant_id = c.tenant_id AND u.id = c.issued_by
    WHERE c.tenant_id = a.tenant_id AND c.agent_id = a.id ORDER BY c.issued_at DESC, c.id DESC LIMIT 100) x), '[]'::jsonb) AS credentials`;
const COMMAND_SELECT = `SELECT c.id, c.tenant_id, c.agent_id, c.kind, c.params, c.state, c.requested_at, coalesce(u.display_name, 'Unknown') AS requested_by_display,
    c.delivered_at, c.completed_at, c.result_code, c.expires_at,
    (SELECT b.id FROM instruments.agent_log_bundles b WHERE b.tenant_id = c.tenant_id AND b.command_id = c.id ORDER BY b.created_at DESC LIMIT 1) AS log_bundle_id
  FROM instruments.agent_commands c LEFT JOIN core.users u ON u.tenant_id = c.tenant_id AND u.id = c.requested_by`;
const PATCH_COLS = ['display_name', 'update_channel', 'pinned_release_id', 'backlog_threshold'];

// ponytail: offset cursor (opaque base64url); rows shifting between pages can repeat/skip one — keyset when lists get long.
export function paging(q: Row): { limit: number; offset: number } {
  const limit = Number(q['limit'] ?? 50);
  let offset = 0;
  if (q['cursor'] !== undefined) {
    try {
      const c = JSON.parse(Buffer.from(String(q['cursor']), 'base64url').toString('utf8'));
      if (!Number.isSafeInteger(c?.o) || c.o < 0) throw new Error('bad');
      offset = c.o;
    } catch { throw new LimsError('common.invalid_cursor'); }
  }
  return { limit, offset };
}
export function paged(rows: Row[], p: { limit: number; offset: number }): Page {
  if (rows.length <= p.limit) return { rows };
  return { rows: rows.slice(0, p.limit), nextCursor: Buffer.from(JSON.stringify({ o: p.offset + p.limit })).toString('base64url') };
}

export function createAgentsRepo(): AgentsRepo {
  const repo: AgentsRepo = {
    async getCentre(tx, tenantId, centreId) {
      const { rows } = await tx.query('SELECT id, centre_kind, is_active FROM core.collection_centres WHERE tenant_id = $1 AND id = $2', [tenantId, centreId]);
      return rows[0];
    },
    async insertAgent(tx, tenantId, row) {
      await tx.query(
        `INSERT INTO instruments.agents (id, tenant_id, centre_id, agent_code, display_name, update_channel, backlog_threshold, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
        [row['id'], tenantId, row['centre_id'], row['agent_code'], row['display_name'], row['update_channel'], row['backlog_threshold'] ?? null, row['created_by']],
      );
      const out = await repo.findAgent(tx, tenantId, row['id']);
      if (!out) throw new LimsError('common.internal');
      return out;
    },
    async findAgent(tx, tenantId, agentId) {
      const { rows } = await tx.query(`SELECT ${AGENT_COLS}, ${HEALTH('st')}, ${CREDENTIALS} ${AGENT_FROM} WHERE a.tenant_id = $1 AND a.id = $2`, [tenantId, agentId]);
      return rows[0];
    },
    async lockAgent(tx, tenantId, agentId) {
      const { rows } = await tx.query(`SELECT id, centre_id, status FROM instruments.agents WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [tenantId, agentId]);
      return rows[0];
    },
    async listAgents(tx, tenantId, q) {
      const p = paging(q);
      const where = ['a.tenant_id = $1']; const values: unknown[] = [tenantId];
      const add = (sql: string, v: unknown) => { values.push(v); where.push(sql.replace('?', `$${values.length}`)); };
      if (q['centreId']) add('a.centre_id = ?', q['centreId']);
      if (q['status']?.length) add('a.status = ANY(?::text[])', q['status']);
      if (q['healthState']?.length) add(`coalesce(st.health_state, 'offline') = ANY(?::text[])`, q['healthState']);
      const order = q['sort'] === '-last_heartbeat_at' ? 'st.last_heartbeat_at DESC NULLS LAST, a.id' : 'a.agent_code, a.id';
      values.push(p.limit + 1, p.offset);
      const { rows } = await tx.query(
        `SELECT ${AGENT_COLS}, ${HEALTH('st')} ${AGENT_FROM} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT $${values.length - 1} OFFSET $${values.length}`, values);
      return paged(rows, p);
    },
    async findRelease(tx, releaseId) {
      const { rows } = await tx.query('SELECT id, channel, is_active FROM instruments.g_agent_releases WHERE id = $1', [releaseId]);
      return rows[0];
    },
    async listReleases(tx, q) {
      const { rows } = await tx.query(
        `SELECT id, version, channel, released_at, package_size, min_windows_build, notes, is_active FROM instruments.g_agent_releases
          WHERE ($1::text IS NULL OR channel = $1) ORDER BY released_at DESC, id LIMIT 200`, [q.channel ?? null]);
      return rows;
    },
    async isRevokeReason(tx, code) {
      const { rows } = await tx.query('SELECT 1 FROM instruments.g_cs_revoke_reasons WHERE code = $1 AND is_active', [code]);
      return rows.length > 0;
    },
    async updateAgent(tx, tenantId, agentId, expectedVersion, patch, actorId) {
      const cols = Object.keys(patch).filter((k) => PATCH_COLS.includes(k));   // column names never come from input
      if (!actorId) throw new LimsError('common.internal');
      const values: unknown[] = [tenantId, agentId, expectedVersion, actorId, ...cols.map((k) => patch[k])];
      const set = cols.map((k, i) => `${k} = $${i + 5}`).concat('version = version + 1', 'updated_at = now()', 'updated_by = $4');
      const { rows } = await tx.query(`UPDATE instruments.agents SET ${set.join(', ')} WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING id`, values);
      return rows[0] ? repo.findAgent(tx, tenantId, agentId) : undefined;
    },
    async transitionAgent(tx, tenantId, agentId, expectedVersion, o) {
      const set = o.status === 'revoked'
        ? `status = 'revoked', revoked_at = now(), revoked_by = $4, revoke_reason_code = $5, revoke_reason_text = $6`
        : o.status === 'retired' ? `status = 'retired', retired_at = now(), retired_by = $4, revoke_reason_code = coalesce($5, revoke_reason_code), revoke_reason_text = coalesce($6, revoke_reason_text)` : undefined;
      if (!set) throw new LimsError('common.internal');
      const { rows } = await tx.query(
        `UPDATE instruments.agents SET ${set}, version = version + 1, updated_at = now(), updated_by = $4
          WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING id`,
        [tenantId, agentId, expectedVersion, o.actorId, o.reasonCode ?? null, o.reasonText ?? null]);
      return rows[0] ? repo.findAgent(tx, tenantId, agentId) : undefined;
    },
    async revokeCredentials(tx, tenantId, agentId, o) {
      const { rows } = await tx.query(
        `UPDATE instruments.agent_credentials SET status = 'revoked', revoked_at = now(), revoked_by = $4, revoke_reason_code = $5,
            version = version + 1, updated_at = now(), updated_by = $4
          WHERE tenant_id = $1 AND agent_id = $2 AND status = 'active' AND kind = ANY($3::text[]) RETURNING id`,
        [tenantId, agentId, o.kinds, o.actorId, o.reasonCode]);
      return rows.map((r) => r.id as string);
    },
    async insertCredential(tx, tenantId, row) {
      await tx.query(
        `INSERT INTO instruments.agent_credentials (id, tenant_id, centre_id, agent_id, kind, secret_sha256, expires_at, issued_by, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $8)`,
        [row['id'], tenantId, row['centre_id'], row['agent_id'], row['kind'], Buffer.from(row['secret_sha256']), row['expires_at'] ?? null, row['issued_by']]);
    },
    async countNonRetiredInstruments(tx, tenantId, agentId) {
      const { rows } = await tx.query(`SELECT count(*)::int AS n FROM instruments.instruments WHERE tenant_id = $1 AND agent_id = $2 AND state <> 'retired'`, [tenantId, agentId]);
      return Number(rows[0]?.n ?? 0);
    },
    async insertCommand(tx, tenantId, row) {
      await tx.query(
        `INSERT INTO instruments.agent_commands (id, tenant_id, centre_id, agent_id, kind, params, requested_by, requested_at, expires_at, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $7, $7)`,
        [row['id'], tenantId, row['centre_id'], row['agent_id'], row['kind'], JSON.stringify(row['params'] ?? {}), row['requested_by'], row['requested_at'], row['expires_at']]);
      const { rows } = await tx.query(`${COMMAND_SELECT} WHERE c.tenant_id = $1 AND c.id = $2`, [tenantId, row['id']]);
      if (!rows[0]) throw new LimsError('common.internal');
      return rows[0];
    },
    async listCommands(tx, tenantId, agentId, q) {
      const p = paging(q);
      const { rows } = await tx.query(`${COMMAND_SELECT} WHERE c.tenant_id = $1 AND c.agent_id = $2 ORDER BY c.requested_at DESC, c.id DESC LIMIT $3 OFFSET $4`,
        [tenantId, agentId, p.limit + 1, p.offset]);
      return paged(rows, p);
    },
    async listTransitions(tx, tenantId, agentId, q) {
      const p = paging(q);
      const { rows } = await tx.query(
        `SELECT tenant_id, agent_id, health_version, from_state, to_state, changed_at, last_heartbeat_at, queue_depth, clock_offset_seconds, silent_instrument_ids
           FROM instruments.agent_health_transitions
          WHERE tenant_id = $1 AND agent_id = $2 AND ($3::timestamptz IS NULL OR changed_at >= $3) AND ($4::timestamptz IS NULL OR changed_at < $4)
          ORDER BY changed_at DESC, health_version DESC LIMIT $5 OFFSET $6`,
        [tenantId, agentId, q['changedAtFrom'] ?? null, q['changedAtTo'] ?? null, p.limit + 1, p.offset]);
      return paged(rows, p);
    },
    async findLogBundle(tx, tenantId, agentId, bundleId) {
      const { rows } = await tx.query(
        `SELECT id, tenant_id, agent_id, lines, from_at_agent, to_at_agent, created_at FROM instruments.agent_log_bundles
          WHERE tenant_id = $1 AND agent_id = $2 AND id = $3`, [tenantId, agentId, bundleId]);
      return rows[0];
    },
  };
  return repo;
}
