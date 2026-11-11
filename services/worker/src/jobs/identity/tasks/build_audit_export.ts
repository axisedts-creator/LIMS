// identity.build_audit_export (02-TRD §8 row; 03-APP-FLOW §2.7, §7.2; 01-PRD AC-D4.2, AC-D4.6; 07-SECURITY A-13, D-T4, P-3, P-4; 08 A13 P-9).
// Payload {tenant_id, export_id}; everything else is read from identity.audit_exports under the job's tenant claims (explicit tenant_id = $1
// on every statement too). Metadata columns only (no old/new values, no access detail, no raw user agent). Cells: shared neutraliseFormula
// (P-9), then RFC 4180 quoting. Source rows in keyset batches of 5,000 (no OFFSET); > 500,000 rows -> failed identity.export_too_large.
// [CONV] occurred_at_local = A.D. wall time in Asia/Kathmandu (CV §4.8 default); tenant timezone / B.S. display is an open point.
import { neutraliseFormula } from '../../../../../../packages/shared-ts/src/spreadsheet/index.js';   // = @lims/shared-ts/spreadsheet (not linked in worker yet)
import type { TaskHandler } from '../../../core/manifest.js';

export const BUILD_AUDIT_EXPORT = 'identity.build_audit_export';
const BUCKET = 'identity-exports';
const BATCH = 5_000;
const ROW_CAP = 500_000;
const MAX_SPAN_MS = 31 * 86_400_000;
const TTL_MS = 24 * 3_600_000;
const NIL = '00000000-0000-0000-0000-000000000000';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCAL = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Kathmandu', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });

type Row = Record<string, any>;
type Source = 'audit_log' | 'access_log' | 'auth_events';
const uuidOk = (s: string) => UUID.test(s);
const word = (max: number) => (s: string) => s.length <= max && /^[a-z0-9_.]+$/.test(s);

const iso = (v: unknown) => (v instanceof Date ? v : new Date(String(v))).toISOString();
const local = (v: unknown) => LOCAL.format(v instanceof Date ? v : new Date(String(v)));
function uaFamily(ua: unknown): string {
  if (typeof ua !== 'string' || ua === '') return '';
  for (const [re, name] of [[/\bEdg\//, 'Edge'], [/\bOPR\//, 'Opera'], [/\bFirefox\//, 'Firefox'], [/\bChrome\//, 'Chrome'], [/\bSafari\//, 'Safari']] as const) if (re.test(ua)) return name;
  return 'Other';
}

interface Def {
  from: string;                                                   // FROM clause incl. the display-name join
  select: string;
  filters: Array<[key: string, col: string, type: string, ok: (s: string) => boolean, val: (s: string) => string]>;
  header: string[];
  cells: (r: Row) => unknown[];
}
const same = (s: string) => s;
const DEFS: Record<Source, Def> = {
  audit_log: {
    from: `audit.audit_log a LEFT JOIN core.users u ON u.tenant_id = a.tenant_id AND u.id = a.actor_id AND a.actor_type = 'user'`,
    select: `a.id, a.occurred_at, a.occurred_at::text AS cursor_at, a.schema_name, a.table_name, a.action, a.row_id, a.actor_type, a.actor_id,
      a.membership_id, u.display_name AS actor_display_name, a.centre_id, a.request_id, a.support_session_id, a.changed_columns`,
    filters: [
      ['table', 'a.schema_name', 'text', (s) => s.length <= 127 && /^[a-z_]+\.[a-z_]+$/.test(s), (s) => s.split('.')[0]!],
      ['table', 'a.table_name', 'text', () => true, (s) => s.split('.')[1]!],
      ['action', 'a.action', 'text', (s) => s === 'insert' || s === 'update' || s === 'delete', (s) => s.toUpperCase()],
      ['row_id', 'a.row_id', 'uuid', uuidOk, same], ['actor_id', 'a.actor_id', 'uuid', uuidOk, same], ['membership_id', 'a.membership_id', 'uuid', uuidOk, same],
      ['centre_id', 'a.centre_id', 'uuid', uuidOk, same], ['request_id', 'a.request_id', 'uuid', uuidOk, same], ['support_session_id', 'a.support_session_id', 'uuid', uuidOk, same],
    ],
    header: ['audit_id', 'occurred_at_utc', 'occurred_at_local', 'table', 'action', 'row_id', 'actor_type', 'actor_id', 'membership_id', 'actor_display_name', 'centre_id', 'request_id', 'support_session_id', 'changed_columns'],
    cells: (r) => [r.id, iso(r.occurred_at), local(r.occurred_at), `${r.schema_name}.${r.table_name}`, String(r.action ?? '').toLowerCase(), r.row_id, r.actor_type, r.actor_id,
      r.membership_id, r.actor_display_name ?? r.display_name, r.centre_id, r.request_id, r.support_session_id, Array.isArray(r.changed_columns) ? r.changed_columns.join(';') : r.changed_columns],
  },
  access_log: {
    from: `audit.access_log a LEFT JOIN core.users u ON u.tenant_id = a.tenant_id AND u.id = a.actor_id AND a.actor_type = 'user'`,
    select: `a.id, a.occurred_at, a.occurred_at::text AS cursor_at, a.action, a.entity_type, a.entity_id, a.actor_type, a.actor_id, a.membership_id,
      u.display_name AS actor_display_name, a.centre_id, a.request_id, a.support_session_id`,
    filters: [
      ['action', 'a.action', 'text', word(100), same], ['entity_type', 'a.entity_type', 'text', word(40), same], ['entity_id', 'a.entity_id', 'uuid', uuidOk, same],
      ['actor_id', 'a.actor_id', 'uuid', uuidOk, same], ['membership_id', 'a.membership_id', 'uuid', uuidOk, same], ['centre_id', 'a.centre_id', 'uuid', uuidOk, same],
      ['outcome', 'a.outcome', 'text', (s) => s === 'allowed' || s === 'denied', same],
    ],
    header: ['access_id', 'occurred_at_utc', 'occurred_at_local', 'event_type', 'entity_type', 'entity_id', 'actor_type', 'actor_id', 'membership_id', 'actor_display_name', 'centre_id', 'request_id', 'support_session_id'],
    cells: (r) => [r.id, iso(r.occurred_at), local(r.occurred_at), r.action, r.entity_type, r.entity_id, r.actor_type, r.actor_id, r.membership_id,
      r.actor_display_name ?? r.display_name, r.centre_id, r.request_id, r.support_session_id],
  },
  auth_events: {
    from: `identity.auth_events a LEFT JOIN core.users u ON u.tenant_id = a.tenant_id AND u.id = a.user_id`,
    select: `a.id, a.occurred_at, a.occurred_at::text AS cursor_at, a.event_type, a.membership_id, u.display_name AS actor_display_name, a.reason_code,
      a.client_ip, a.user_agent`,
    filters: [['event_type', 'a.event_type', 'text', word(30), same], ['membership_id', 'a.membership_id', 'uuid', uuidOk, same]],
    header: ['event_id', 'occurred_at_utc', 'occurred_at_local', 'event_type', 'membership_id', 'actor_display_name', 'reason_code', 'client_ip', 'user_agent_family'],
    cells: (r) => [r.id, iso(r.occurred_at), local(r.occurred_at), r.event_type, r.membership_id, r.actor_display_name ?? r.display_name, r.reason_code,
      r.client_ip, uaFamily(r.user_agent)],
  },
};
// $1 tenant, $2 from, $3 to, $4/$5 keyset, $6.. filters, last = limit. Fixed text: no input is ever spliced in.
const where = (d: Def, first: number) => d.filters.map(([, col, type], i) => `($${first + i}::${type} IS NULL OR ${col} = $${first + i})`).join(' AND ');
const batchSql = (d: Def) => `SELECT ${d.select} FROM ${d.from}
  WHERE a.tenant_id = $1 AND a.occurred_at >= $2::timestamptz AND a.occurred_at < $3::timestamptz AND (a.occurred_at, a.id) > ($4::timestamptz, $5::uuid)
    AND ${where(d, 6)}
  ORDER BY a.occurred_at ASC, a.id ASC LIMIT $${6 + d.filters.length}`;
const countSql = (d: Def) => `SELECT count(*)::int AS n FROM (SELECT 1 FROM ${d.from}
  WHERE a.tenant_id = $1 AND a.occurred_at >= $2::timestamptz AND a.occurred_at < $3::timestamptz AND ${where(d, 4)}
  LIMIT $${4 + d.filters.length}) s`;

/** RFC 4180: quote when the cell holds a quote, comma, CR or LF; quotes doubled. Injection guard = shared neutraliseFormula. */
const cell = (v: unknown) => {
  const s = neutraliseFormula(v == null ? '' : v instanceof Date ? v.toISOString() : String(v));
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};
const line = (cells: unknown[]) => `${cells.map(cell).join(',')}\r\n`;

/** Stored filters re-validated per source; returns the bound values in filter order, or undefined when anything is off. */
function filterValues(d: Def, filters: unknown): Array<string | null> | undefined {
  if (filters == null) filters = {};
  if (typeof filters !== 'object' || Array.isArray(filters)) return undefined;
  const f = filters as Record<string, unknown>;
  for (const [k, v] of Object.entries(f)) {
    const defs = d.filters.filter(([key]) => key === k);
    if (!defs.length || typeof v !== 'string' || !defs.every(([, , , ok]) => ok(v))) return undefined;
  }
  return d.filters.map(([key, , , , val]) => (typeof f[key] === 'string' ? val(f[key] as string) : null));
}

export const buildAuditExport: TaskHandler = async (payload, jobCtx) => {
  const ctx = jobCtx as any;
  const tenantId = ctx.tenantId;
  const exportId = (payload as Row | undefined)?.['export_id'];
  if (typeof tenantId !== 'string' || !UUID.test(tenantId) || (payload as Row | undefined)?.['tenant_id'] !== tenantId || typeof exportId !== 'string' || !UUID.test(exportId)) {
    ctx.log?.warn?.({ event: 'build_audit_export_skipped', reason: 'bad_payload' });
    return;
  }
  const q = async (sql: string, v: unknown[]) => (await ctx.tx.query(sql, v)) as { rows: Row[] };
  const actorId = ctx.actor?.id;

  const job = (await q(`SELECT id, tenant_id, source, filters, range_from, range_to, status FROM identity.audit_exports
    WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [tenantId, exportId])).rows[0];
  if (!job || job.tenant_id !== tenantId || (job.status !== 'queued' && job.status !== 'building')) {
    ctx.log?.info?.({ event: 'build_audit_export_skipped', export_id: exportId, reason: job ? 'not_pending' : 'not_found' });
    return;
  }
  const fail = async (code: string) => {
    await q(`UPDATE identity.audit_exports SET status = 'failed', error_code = $3, version = version + 1, updated_at = now(), updated_by = $4
      WHERE tenant_id = $1 AND id = $2 AND status IN ('queued', 'building')`, [tenantId, exportId, code, actorId]);
    ctx.log?.warn?.({ event: 'build_audit_export_failed', export_id: exportId, error_code: code });
  };

  const d = Object.hasOwn(DEFS, job.source) ? DEFS[job.source as Source] : undefined;
  const fv = d && filterValues(d, job.filters);
  const from = new Date(job.range_from), to = new Date(job.range_to);
  const span = to.getTime() - from.getTime();
  if (!d || !fv || !(span > 0)) return fail('common.validation_failed');
  if (span > MAX_SPAN_MS) return fail('identity.export_too_large');

  await q(`UPDATE identity.audit_exports SET status = 'building', version = version + 1, updated_at = now(), updated_by = $3
    WHERE tenant_id = $1 AND id = $2 AND status IN ('queued', 'building')`, [tenantId, exportId, actorId]);

  const n = Number((await q(countSql(d), [tenantId, job.range_from, job.range_to, ...fv, ROW_CAP + 1])).rows[0]?.n ?? 0);
  if (n > ROW_CAP) return fail('identity.export_too_large');

  const parts: string[] = [line(d.header)];
  const sql = batchSql(d);
  let rows = 0;
  let after: [unknown, string] = [job.range_from, NIL];
  for (;;) {
    const batch = (await q(sql, [tenantId, job.range_from, job.range_to, after[0], after[1], ...fv, BATCH])).rows;
    rows += batch.length;
    if (rows > ROW_CAP) return fail('identity.export_too_large');              // the estimate was wrong
    for (const r of batch) parts.push(line(d.cells(r)));
    if (batch.length < BATCH) break;
    const last = batch[batch.length - 1]!;
    after = [last.cursor_at ?? last.occurred_at, last.id];
  }

  // ponytail: whole CSV in memory (cap 500k metadata rows); stream to storage if that outgrows the worker.
  const bytes = new TextEncoder().encode(parts.join(''));
  const now = new Date(ctx.now());
  const path = `${tenantId}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${exportId}.csv`;
  const put = await ctx.storage.put(BUCKET, path, bytes, { contentType: 'text/csv' });   // deterministic path: a retry overwrites its own object
  await q(`UPDATE identity.audit_exports SET status = 'ready', object_path = $3, sha256 = $4, size_bytes = $5, row_count = $6, ready_at = $7, expires_at = $8,
      version = version + 1, updated_at = now(), updated_by = $9
    WHERE tenant_id = $1 AND id = $2 AND status = 'building'`,
  [tenantId, exportId, path, Buffer.from(put.sha256, 'hex'), put.byteSize, rows, now, new Date(now.getTime() + TTL_MS), actorId]);
  ctx.log?.info?.({ event: 'build_audit_export_ready', export_id: exportId, row_count: rows });
};
