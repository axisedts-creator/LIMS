// Device-side repository for E01/E02/E03/E07/E08 (02-TRD §7.1/§7.2/§7.4; 05-SCHEMA §2). SQL on the REQUEST tx (RLS applies) with an
// explicit tenant predicate on every tenant-table statement (REQ-SEC-026). Never selects secret_sha256 (column grant CR-C7-006).
import type { Row, Tx } from './agents.repo.js';

export interface DeviceRepo {
  lockAgent(tx: Tx, tenantId: string, agentId: string): Promise<Row | undefined>;
  findAgent(tx: Tx, tenantId: string, agentId: string): Promise<Row | undefined>;
  findCredential(tx: Tx, tenantId: string, credentialId: string): Promise<Row | undefined>;
  listActiveCredentials(tx: Tx, tenantId: string, agentId: string, kind: 'device_token' | 'enrolment_code'): Promise<Row[]>;
  markCredentialUsed(tx: Tx, tenantId: string, credentialId: string, usedAtIso: string): Promise<boolean>;
  insertCredential(tx: Tx, tenantId: string, row: Row): Promise<void>;
  revokeCredential(tx: Tx, tenantId: string, credentialId: string, o: { reasonCode: string; actorId: string; replacedByCredentialId?: string }): Promise<void>;
  completeEnrolment(tx: Tx, tenantId: string, agentId: string, o: { hostFingerprintSha256: string; enrolledAt: string; agentVersion: string; launcherVersion: string; osVersion: string; actorId: string }): Promise<void>;
  getLatestConfig(tx: Tx, tenantId: string, agentId: string): Promise<Row | undefined>;
  recordHeartbeat(tx: Tx, tenantId: string, agentId: string, row: Row): Promise<void>;
  claimCommands(tx: Tx, tenantId: string, agentId: string, nowIso: string): Promise<Row[]>;
  completeCommand(tx: Tx, tenantId: string, agentId: string, commandId: string, o: { state: 'completed' | 'failed'; resultCode?: string; nowIso: string }): Promise<boolean>;
  findCommand(tx: Tx, tenantId: string, agentId: string, commandId: string): Promise<Row | undefined>;
  insertLogBundle(tx: Tx, tenantId: string, row: Row): Promise<{ id: string }>;
  findRelease(tx: Tx, releaseId: string): Promise<Row | undefined>;
}

const AGENT = `SELECT a.id, a.tenant_id, a.centre_id, a.status, a.enrolled_at, a.latest_config_version, a.version,
    CASE WHEN st.agent_id IS NULL THEN NULL ELSE jsonb_build_object('health_state', st.health_state, 'health_version', st.health_version) END AS health
  FROM instruments.agents a LEFT JOIN instruments.agent_status st ON st.tenant_id = a.tenant_id AND st.agent_id = a.id
 WHERE a.tenant_id = $1 AND a.id = $2`;
const CRED_COLS = 'id, tenant_id, centre_id, agent_id, kind, status, issued_at, expires_at, used_at, revoked_at';
const CMD_COLS = 'id, tenant_id, agent_id, kind, params, state, requested_at, delivered_at, completed_at, result_code, expires_at';
// heartbeat-owned agent_status columns (never health_state / health_version / state_changed_at / silent_instrument_ids: evaluator only)
const HB_COLS = ['last_heartbeat_at', 'agent_version', 'launcher_version', 'os_version', 'queue_depth', 'oldest_pending_age_seconds', 'queue_rejected',
  'queue_oversize', 'disk_free_mb', 'clock_offset_ms', 'clock_offset_uncertainty_ms', 'config_version_applied', 'config_state', 'update_state',
  'update_target_version', 'update_error_code', 'auth_state', 'last_ip', 'counters'] as const;

export function createDeviceRepo(): DeviceRepo {
  return {
    async lockAgent(tx, tenantId, agentId) {
      await tx.query('SELECT id FROM instruments.agents WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [tenantId, agentId]);
      return (await tx.query(AGENT, [tenantId, agentId])).rows[0];
    },
    async findAgent(tx, tenantId, agentId) {
      return (await tx.query(AGENT, [tenantId, agentId])).rows[0];
    },
    async findCredential(tx, tenantId, credentialId) {
      return (await tx.query(`SELECT ${CRED_COLS} FROM instruments.agent_credentials WHERE tenant_id = $1 AND id = $2`, [tenantId, credentialId])).rows[0];
    },
    async listActiveCredentials(tx, tenantId, agentId, kind) {
      return (await tx.query(`SELECT ${CRED_COLS} FROM instruments.agent_credentials WHERE tenant_id = $1 AND agent_id = $2 AND kind = $3 AND status = 'active'`,
        [tenantId, agentId, kind])).rows;
    },
    async markCredentialUsed(tx, tenantId, credentialId, usedAtIso) {
      const { rows } = await tx.query(
        `UPDATE instruments.agent_credentials SET status = 'used', used_at = $3, version = version + 1, updated_at = now(), updated_by = agent_id
          WHERE tenant_id = $1 AND id = $2 AND status = 'active' RETURNING id`, [tenantId, credentialId, usedAtIso]);
      return rows.length === 1;
    },
    async insertCredential(tx, tenantId, row) {
      await tx.query(
        `INSERT INTO instruments.agent_credentials (id, tenant_id, centre_id, agent_id, kind, secret_sha256, expires_at, issued_by, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $8)`,
        [row['id'], tenantId, row['centre_id'], row['agent_id'], row['kind'], Buffer.from(row['secret_sha256']), row['expires_at'] ?? null, row['issued_by']]);
    },
    async revokeCredential(tx, tenantId, credentialId, o) {
      await tx.query(
        `UPDATE instruments.agent_credentials SET status = 'revoked', revoked_at = now(), revoked_by = $3, revoke_reason_code = $4, replaced_by_credential_id = $5,
            version = version + 1, updated_at = now(), updated_by = $3
          WHERE tenant_id = $1 AND id = $2 AND status = 'active'`,
        [tenantId, credentialId, o.actorId, o.reasonCode, o.replacedByCredentialId ?? null]);
    },
    async completeEnrolment(tx, tenantId, agentId, o) {
      await tx.query(
        `UPDATE instruments.agents SET status = 'active', enrolled_at = coalesce(enrolled_at, $3), host_fingerprint_sha256 = $4,
            version = version + 1, updated_at = now(), updated_by = $5
          WHERE tenant_id = $1 AND id = $2`, [tenantId, agentId, o.enrolledAt, o.hostFingerprintSha256, o.actorId]);
      await tx.query(
        `INSERT INTO instruments.agent_status (tenant_id, agent_id, centre_id, agent_version, launcher_version, os_version, created_by, updated_by)
         SELECT a.tenant_id, a.id, a.centre_id, $3, $4, $5, $6, $6 FROM instruments.agents a WHERE a.tenant_id = $1 AND a.id = $2
         ON CONFLICT (tenant_id, agent_id) DO UPDATE SET agent_version = EXCLUDED.agent_version, launcher_version = EXCLUDED.launcher_version,
            os_version = EXCLUDED.os_version, updated_at = now(), updated_by = EXCLUDED.updated_by`,
        [tenantId, agentId, o.agentVersion, o.launcherVersion, o.osVersion, o.actorId]);
    },
    async getLatestConfig(tx, tenantId, agentId) {
      return (await tx.query(
        `SELECT id, tenant_id, centre_id, agent_id, config_version, document, signature, key_id FROM instruments.agent_config_versions
          WHERE tenant_id = $1 AND agent_id = $2 ORDER BY config_version DESC LIMIT 1`, [tenantId, agentId])).rows[0];
    },
    async recordHeartbeat(tx, tenantId, agentId, row) {
      const values = HB_COLS.map((k) => (k === 'counters' ? JSON.stringify(row[k] ?? {}) : row[k] ?? null));
      const cols = HB_COLS.join(', ');
      const params = HB_COLS.map((k, i) => (k === 'last_ip' ? `$${i + 3}::inet` : k === 'counters' ? `$${i + 3}::jsonb` : `$${i + 3}`)).join(', ');
      const set = HB_COLS.map((k) => `${k} = EXCLUDED.${k}`).join(', ');
      await tx.query(
        `INSERT INTO instruments.agent_status AS st (tenant_id, agent_id, centre_id, ${cols}, last_ip_changed_at, created_by, updated_by)
         SELECT a.tenant_id, a.id, a.centre_id, ${params}, now(), a.id, a.id FROM instruments.agents a WHERE a.tenant_id = $1 AND a.id = $2
         ON CONFLICT (tenant_id, agent_id) DO UPDATE SET ${set},
            last_ip_changed_at = CASE WHEN st.last_ip IS DISTINCT FROM EXCLUDED.last_ip THEN now() ELSE st.last_ip_changed_at END,
            updated_at = now(), updated_by = EXCLUDED.updated_by`,
        [tenantId, agentId, ...values]);
    },
    async claimCommands(tx, tenantId, agentId, nowIso) {
      await tx.query(
        `UPDATE instruments.agent_commands SET state = 'delivered', delivered_at = $3, version = version + 1, updated_at = now(), updated_by = agent_id
          WHERE tenant_id = $1 AND agent_id = $2 AND state = 'queued' AND expires_at > $3`, [tenantId, agentId, nowIso]);
      return (await tx.query(
        `SELECT ${CMD_COLS} FROM instruments.agent_commands
          WHERE tenant_id = $1 AND agent_id = $2 AND state IN ('queued', 'delivered') AND expires_at > $3 ORDER BY requested_at, id`,
        [tenantId, agentId, nowIso])).rows;
    },
    async completeCommand(tx, tenantId, agentId, commandId, o) {
      const { rows } = await tx.query(
        `UPDATE instruments.agent_commands SET state = $4, completed_at = $5, result_code = $6, version = version + 1, updated_at = now(), updated_by = agent_id
          WHERE tenant_id = $1 AND agent_id = $2 AND id = $3 AND state = 'delivered' RETURNING id`,
        [tenantId, agentId, commandId, o.state, o.nowIso, o.resultCode ?? null]);
      return rows.length === 1;
    },
    async findCommand(tx, tenantId, agentId, commandId) {
      return (await tx.query(`SELECT ${CMD_COLS} FROM instruments.agent_commands WHERE tenant_id = $1 AND agent_id = $2 AND id = $3`, [tenantId, agentId, commandId])).rows[0];
    },
    async insertLogBundle(tx, tenantId, row) {
      await tx.query(
        `INSERT INTO instruments.agent_log_bundles (id, tenant_id, centre_id, agent_id, command_id, lines, from_at_agent, to_at_agent, size_bytes, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [row['id'], tenantId, row['centre_id'], row['agent_id'], row['command_id'], row['lines'], row['from_at_agent'], row['to_at_agent'], row['size_bytes'], row['created_by']]);
      return { id: row['id'] };
    },
    async findRelease(tx, releaseId) {
      return (await tx.query(
        'SELECT id, version, channel, package_file_name, package_sha256, package_size, is_active FROM instruments.g_agent_releases WHERE id = $1', [releaseId])).rows[0];
    },
  };
}
