// C2-T19 identity.audit_exports repository (02-TRD §5.9, §8; 03-APP-FLOW §2.7, §7.2; 05-SCHEMA identity.audit_exports / admin_notices).
// Every statement binds tenant_id = $1 on top of RLS (REQ-SEC-024). Optional filters are `($n IS NULL OR col = $n)` with fixed positions.
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import type { Keyset, Tx } from './audit-read.repo.js';

export type ExportSource = 'audit_log' | 'access_log' | 'auth_events';
export type Filters = Record<string, string>;
const NOTICE_TTL = '30 days';                      // 05-SCHEMA §9 admin_notices.expires_at [CONV] as support.service

// Filter key -> [column, pg type]. `table` is split into schema_name/table_name; audit action is stored upper-case.
const ESTIMATE: Record<ExportSource, { from: string; cols: Array<[string, string, (f: Filters) => string | undefined]> }> = {
  audit_log: {
    from: 'audit.audit_log',
    cols: [['schema_name', 'text', (f) => f['table']?.split('.')[0]], ['table_name', 'text', (f) => f['table']?.split('.')[1]],
      ['action', 'text', (f) => f['action']?.toUpperCase()], ['row_id', 'uuid', (f) => f['row_id']], ['actor_id', 'uuid', (f) => f['actor_id']],
      ['membership_id', 'uuid', (f) => f['membership_id']], ['centre_id', 'uuid', (f) => f['centre_id']], ['request_id', 'uuid', (f) => f['request_id']],
      ['support_session_id', 'uuid', (f) => f['support_session_id']]],
  },
  access_log: {
    from: 'audit.access_log',
    cols: [['action', 'text', (f) => f['action']], ['entity_type', 'text', (f) => f['entity_type']], ['entity_id', 'uuid', (f) => f['entity_id']],
      ['actor_id', 'uuid', (f) => f['actor_id']], ['membership_id', 'uuid', (f) => f['membership_id']], ['centre_id', 'uuid', (f) => f['centre_id']],
      ['outcome', 'text', (f) => f['outcome']]],
  },
  auth_events: { from: 'identity.auth_events', cols: [['event_type', 'text', (f) => f['event_type']], ['membership_id', 'uuid', (f) => f['membership_id']]] },
};
const estimateSql = (s: ExportSource) => {
  const d = ESTIMATE[s];
  const where = d.cols.map(([c, t], i) => `($${i + 4}::${t} IS NULL OR ${c} = $${i + 4})`).join(' AND ');
  return `SELECT count(*)::int AS n FROM (SELECT 1 FROM ${d.from} WHERE tenant_id = $1 AND occurred_at >= $2::timestamptz AND occurred_at < $3::timestamptz
    AND ${where} LIMIT $${d.cols.length + 4}) s`;
};

const COLS = `id, tenant_id, requested_by_membership_id, source, range_from, range_to, status, row_count, object_path, downloads_remaining,
  ready_at, expires_at, error_code, version, created_at, created_at::text AS cursor_at`;

export function createExportRepo() {
  const q = async (tx: unknown, text: string, values: unknown[]) => (await (tx as Tx).query(text, values)).rows;
  return {
    /** Transaction-scoped lock on the tenant's export quota: serialises the per-user and per-tenant counts. */
    async lockQuota(tx: unknown, tenantId: string, _membershipId: string): Promise<void> {
      await q(tx, `SELECT pg_advisory_xact_lock(hashtextextended('identity.audit_export_quota:' || $1::text, 0))`, [tenantId]);
    },
    async countSince(tx: unknown, tenantId: string, o: { membershipId?: string; since: Date }): Promise<number> {
      const r = await q(tx, `SELECT count(*)::int AS n FROM identity.audit_exports
        WHERE tenant_id = $1 AND created_at >= $2::timestamptz AND ($3::uuid IS NULL OR requested_by_membership_id = $3)`, [tenantId, o.since, o.membershipId ?? null]);
      return Number(r[0]?.n ?? 0);
    },
    async estimateRows(tx: unknown, tenantId: string, o: { source: ExportSource; from: string; to: string; filters: Filters; cap: number }): Promise<number> {
      const vals = ESTIMATE[o.source].cols.map(([, , get]) => get(o.filters) ?? null);
      const r = await q(tx, estimateSql(o.source), [tenantId, o.from, o.to, ...vals, o.cap + 1]);
      return Number(r[0]?.n ?? 0);
    },
    async insert(tx: unknown, tenantId: string, r: { id: string; membershipId: string; source: ExportSource; filters: Filters; rangeFrom: string; rangeTo: string; actorId: string }) {
      return (await q(tx, `INSERT INTO identity.audit_exports (id, tenant_id, requested_by_membership_id, source, filters, range_from, range_to, created_by, updated_by)
        VALUES ($1, $2, $3, $4, $5::jsonb, $6::timestamptz, $7::timestamptz, $8, $8) RETURNING ${COLS}`,
      [r.id, tenantId, r.membershipId, r.source, JSON.stringify(r.filters), r.rangeFrom, r.rangeTo, r.actorId]))[0];
    },
    /** One tenant-wide notice; the requester is pre-listed in dismissed_by so only the OTHER admins see it [CONV]. */
    async insertNotice(tx: unknown, tenantId: string, n: { kind: string; subjectType: string; subjectId: string; excludeMembershipId: string; actorId: string }) {
      await q(tx, `INSERT INTO identity.admin_notices (id, tenant_id, kind, subject_type, subject_id, dismissed_by, expires_at, created_by, updated_by)
        VALUES ($1, $2, $3, $4, $5, ARRAY[$6::uuid], now() + $7::interval, $8, $8)`,
      [uuidv7(), tenantId, n.kind, n.subjectType, n.subjectId, n.excludeMembershipId, NOTICE_TTL, n.actorId]);
    },
    async enqueueJob(tx: unknown, j: { taskIdentifier: string; payload: unknown; jobKey: string }) {
      await q(tx, 'SELECT app.enqueue_job($1, $2::jsonb, $3)', [j.taskIdentifier, JSON.stringify(j.payload), j.jobKey]);
    },
    async find(tx: unknown, tenantId: string, id: string) {
      return (await q(tx, `SELECT ${COLS} FROM identity.audit_exports WHERE tenant_id = $1 AND id = $2::uuid`, [tenantId, id]))[0];
    },
    async list(tx: unknown, tenantId: string, o: { membershipId?: string; after?: Keyset; limit: number }) {
      return q(tx, `SELECT ${COLS} FROM identity.audit_exports
        WHERE tenant_id = $1 AND ($2::uuid IS NULL OR requested_by_membership_id = $2)
          AND ($3::timestamptz IS NULL OR (created_at, id) < ($3::timestamptz, $4::uuid))
        ORDER BY created_at DESC, id DESC LIMIT $5`, [tenantId, o.membershipId ?? null, o.after?.at ?? null, o.after?.id ?? null, o.limit]);
    },
    /** Atomic: one conditional UPDATE; undefined when nothing is left / not ready / expired. */
    async consumeDownload(tx: unknown, tenantId: string, id: string, o: { now: Date; actorId: string }) {
      return (await q(tx, `UPDATE identity.audit_exports SET downloads_remaining = downloads_remaining - 1, last_downloaded_at = $3,
          version = version + 1, updated_at = now(), updated_by = $4
        WHERE tenant_id = $1 AND id = $2::uuid AND status = 'ready' AND downloads_remaining > 0 AND expires_at > $3
        RETURNING ${COLS}`, [tenantId, id, o.now, o.actorId]))[0];
    },
  };
}
export type ExportRepo = ReturnType<typeof createExportRepo>;
