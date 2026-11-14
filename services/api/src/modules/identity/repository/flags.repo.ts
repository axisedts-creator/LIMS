// Default SQL repo for feature flags + the tenant IRD annex view (02-TRD §5.6; 05-SCHEMA §4.7, §4.12, D-216). Every statement names tenant_id
// explicitly on top of RLS (REQ-SEC-040); the platform annex_1 row is reached only through the tenant's own ird_annex_1_record_id.
import type { FlagRow, FlagsRepo, Row } from '../service/settings.service.js';

type Tx = { query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }> };
const q = async (tx: unknown, sql: string, params: unknown[]) => (await (tx as Tx).query(sql, params)).rows;

const FLAG_SELECT = `SELECT g.code, g.description, g.scope, g.settable_by, g.requires_founder_approval, g.blocker_ref, f.is_enabled,
    (f.approval_ref IS NOT NULL) AS approval_ref_present, f.version
  FROM identity.feature_flags f JOIN identity.g_feature_flags g ON g.code = f.flag_code
  WHERE f.tenant_id = $1 AND g.is_active AND (f.flag_code = $2::text OR $2::text IS NULL) ORDER BY g.code`;

export function createFlagsRepo(): FlagsRepo {
  return {
    async listFlags(tx, t) { return (await q(tx, FLAG_SELECT, [t, null])) as FlagRow[]; },
    async findFlag(tx, t, code) { return (await q(tx, FLAG_SELECT, [t, code]))[0] as FlagRow | undefined; },
    async updateFlag(tx, t, code, v, isEnabled, actorId) {
      const hit = await q(tx, `UPDATE identity.feature_flags SET is_enabled = $4, updated_at = now(), updated_by = $5, version = version + 1
        WHERE tenant_id = $1 AND flag_code = $2 AND version = $3 RETURNING flag_code`, [t, code, v, isEnabled, actorId]);
      return hit.length ? ((await q(tx, FLAG_SELECT, [t, code]))[0] as FlagRow) : undefined;
    },
    async listIrdAnnexes(tx, t) {
      return (await q(tx, `SELECT a.id, a.tenant_id, a.annex_code, a.status, a.reference_no, a.office_name, a.counterparty_name, a.software_version,
          a.submitted_on::text AS submitted_on, a.completed_on::text AS completed_on, a.notes, a.supersedes_id, a.is_active, a.version
        FROM identity.ird_annex_records a
        WHERE a.tenant_id = $1
           OR (a.tenant_id IS NULL AND a.id = (SELECT s.ird_annex_1_record_id FROM identity.tenant_settings s WHERE s.tenant_id = $1))
        ORDER BY a.annex_code, a.id`, [t])) as Row[];
    },
  };
}
