// Persistence helpers for building and recording signed `lims.bridge.config.v1` documents (02-TRD §5.10).
// Explicit tenant_id predicate on every tenant-owned query; runs inside the caller's request transaction.
import { LimsError } from '../../../core/errors.js';

export type Tx = { query(sql: string, params?: readonly unknown[]): Promise<{ rows: Row[] }> };
export type Row = Record<string, any>;

export interface ConfigRepo {
  nextAgentVersion(tx: Tx, tenantId: string, agentId: string, o: { initialOnly?: boolean; nowIso: string; actorId: string }): Promise<Row | undefined>;
  listAgentInstruments(tx: Tx, tenantId: string, agentId: string): Promise<Row[]>;
  getSettings(tx: Tx, tenantId: string): Promise<Row | undefined>;
  getTenantTimezone?(tx: Tx, tenantId: string): Promise<string | undefined>;
  resolveRelease(tx: Tx, o: { channel: string; pinnedReleaseId?: string | null }): Promise<Row | undefined>;
  insertConfigVersion(tx: Tx, tenantId: string, row: {
    id: string; centreId: string; agentId: string; configVersion: number; document: unknown;
    canonicalSha256: string; signature: string; keyId: string; issuedAt: string; reason: string; actorId: string;
  }): Promise<void>;
}

export function createConfigRepo(): ConfigRepo {
  return {
    async nextAgentVersion(tx, tenantId, agentId, o) {
      if (o.initialOnly) {
        const { rows } = await tx.query(
          `SELECT a.id, a.tenant_id, a.centre_id, a.update_channel, a.pinned_release_id, a.latest_config_version,
                  EXISTS (
                    SELECT 1 FROM instruments.agent_config_versions c
                     WHERE c.tenant_id = a.tenant_id AND c.agent_id = a.id AND c.config_version = a.latest_config_version
                  ) AS has_version
             FROM instruments.agents a
            WHERE a.tenant_id = $1 AND a.id = $2 AND a.status <> 'retired'
            FOR UPDATE`,
          [tenantId, agentId],
        );
        const cur = rows[0];
        if (!cur) return undefined;
        if (!cur['has_version']) return cur;
      }
      const { rows } = await tx.query(
        `UPDATE instruments.agents
            SET latest_config_version = latest_config_version + 1, updated_at = $3, updated_by = $4
          WHERE tenant_id = $1 AND id = $2 AND status <> 'retired'
          RETURNING id, tenant_id, centre_id, update_channel, pinned_release_id, latest_config_version`,
        [tenantId, agentId, o.nowIso, o.actorId],
      );
      return rows[0];
    },

    async listAgentInstruments(tx, tenantId, agentId) {
      const { rows } = await tx.query(
        `SELECT id, instrument_code, driver_code, protocol, state, cap_host_query, cap_worklist_download,
                transport, protocol_options, parser_options, file_drop, timezone, is_active
           FROM instruments.instruments
          WHERE tenant_id = $1 AND agent_id = $2 AND state IN ('commissioning', 'live', 'suspended')
          ORDER BY instrument_code ASC`,
        [tenantId, agentId],
      );
      return rows;
    },

    async getSettings(tx, tenantId) {
      const { rows } = await tx.query(
        `SELECT agent_uploaded_retention_hours, update_window_from, update_window_to
           FROM instruments.settings
          WHERE tenant_id = $1`,
        [tenantId],
      );
      return rows[0];
    },

    async getTenantTimezone(tx, tenantId) {
      const { rows } = await tx.query(
        `SELECT timezone
           FROM core.tenants
          WHERE id = $1`,
        [tenantId],
      );
      const tz = rows[0]?.['timezone'];
      return typeof tz === 'string' && tz.length > 0 ? tz : undefined;
    },

    async resolveRelease(tx, o) {
      if (o.pinnedReleaseId) {
        const { rows } = await tx.query(
          `SELECT id, version, package_sha256, package_size, signature, key_id, authenticode_publisher
             FROM instruments.g_agent_releases
            WHERE id = $1 AND is_active = true`,
          [o.pinnedReleaseId],
        );
        return rows[0];
      }
      const { rows } = await tx.query(
        `SELECT id, version, package_sha256, package_size, signature, key_id, authenticode_publisher
           FROM instruments.g_agent_releases
          WHERE channel = $1 AND is_active = true
          ORDER BY released_at DESC, id DESC
          LIMIT 1`,
        [o.channel],
      );
      return rows[0];
    },

    async insertConfigVersion(tx, tenantId, row) {
      const res = await tx.query(
        `INSERT INTO instruments.agent_config_versions
           (id, tenant_id, centre_id, agent_id, config_version, document, canonical_sha256, signature, key_id, issued_at, reason, created_by)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12)
         RETURNING id`,
        [
          row.id, tenantId, row.centreId, row.agentId, row.configVersion,
          JSON.stringify(row.document), row.canonicalSha256, row.signature, row.keyId,
          row.issuedAt, row.reason, row.actorId,
        ],
      );
      if (!res.rows[0]) throw new LimsError('common.internal');
    },
  };
}
