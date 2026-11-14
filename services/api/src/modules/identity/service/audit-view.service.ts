// C2-T18 audit / access-log / auth-event viewer (01-PRD US-D1..D3; 02-TRD §5.9; 03-APP-FLOW §7.1; 07-SECURITY P-3, C-1, D-T3).
// Tenant, actor and centre scope come from ctx only (RLS + explicit tenant_id in every statement). Input = raw snake_case query;
// output = the OpenAPI bodies (null fields omitted). Lists are metadata only; the detail logs `audit_entry.view` before it returns,
// and fails if that write fails (no unlogged PHI view). Error messages never carry input values.
import { LimsError, type FieldError } from '../../../core/errors.js';
import * as repo from '../repository/audit-read.repo.js';

export interface AuditViewCtx {
  readonly tenantId: string;
  readonly tx: repo.Tx;
  readonly audit: { access(entry: { action: string; entityType: string; entityId?: string; centreId?: string; outcome: 'allowed' | 'denied' }): Promise<void> };
}
type Query = Record<string, unknown>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_UTC = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,6})?Z$/;
const PG_TS = /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d(\.\d{1,6})?(Z|[+-]\d\d(:?\d\d)?)$/;
const CURSOR = /^[A-Za-z0-9_-]{1,512}$/;
const MAX_SPAN_MS = 31 * 86_400_000;
export const AUTH_EVENT_TYPES: ReadonlySet<string> = new Set(['login_failed', 'login_password_ok', 'login_succeeded', 'login_step_up_required', 'login_rate_limited',
  'login_blocked_locked', 'login_blocked_inactive', 'login_blocked_tenant_suspended', 'login_blocked_ip', 'mfa_verified', 'mfa_challenge_failed',
  'mfa_enrolled', 'mfa_factor_removed', 'mfa_reset', 'password_changed', 'password_reset_requested', 'recovery_link_opened',
  'password_reset_completed', 'invite_sent', 'invite_link_opened', 'invite_accepted', 'session_revoked', 'session_expired_idle',
  'session_expired_absolute', 'logout', 'refresh_failed', 'account_locked', 'account_unlocked', 'membership_deactivated',
  'membership_reactivated', 'login_ip_throttled', 'session_token_reused']);
const NIL = '00000000-0000-0000-0000-000000000000';
const MAX = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

const fail = (path: string, code = 'common.field_invalid', message = 'Field invalid'): never => {
  throw new LimsError('common.validation_failed', undefined, [{ path, code, message } satisfies FieldError]);
};
const iso = (v: unknown): string => (v instanceof Date ? v : new Date(String(v))).toISOString();
/** Drop null / undefined fields (contract: absent, never null). */
const compact = <T extends Record<string, unknown>>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null)) as T;

export function optUuid(q: Query, k: string): string | undefined {
  const v = q[k];
  if (v === undefined) return undefined;
  return typeof v === 'string' && UUID.test(v) ? v.toLowerCase() : fail(`/${k}`);
}
export function optText(q: Query, k: string, ok: (s: string) => boolean): string | undefined {
  const v = q[k];
  if (v === undefined) return undefined;
  return typeof v === 'string' && ok(v) ? v : fail(`/${k}`);
}

// Exported for the platform auth-event list (T25, "date rule as §5.9").
export interface Page { from: string; to: string; limit: number; cursor?: repo.Keyset }
/** 03-APP-FLOW §7.1: range required, from <= to, span <= 31 days; limit 1..200 (default 50); opaque keyset cursor. */
export function page(q: Query): Page {
  const ts = (k: string): string => {
    const v = q[k];
    if (v === undefined || v === null || v === '') return fail(`/${k}`, 'common.field_required', 'Field required');
    return typeof v === 'string' && ISO_UTC.test(v) && !Number.isNaN(Date.parse(v)) ? v : fail(`/${k}`);
  };
  const from = ts('occurred_at_from'); const to = ts('occurred_at_to');
  const span = Date.parse(to) - Date.parse(from);
  if (span < 0 || span > MAX_SPAN_MS) fail('/occurred_at_to');
  let limit = 50;
  if (q['limit'] !== undefined) {
    const l = typeof q['limit'] === 'string' && /^\d{1,4}$/.test(q['limit']) ? Number(q['limit']) : q['limit'];
    if (!Number.isInteger(l) || (l as number) < 1 || (l as number) > 200) fail('/limit');
    limit = l as number;
  }
  return { from, to, limit, ...(q['cursor'] === undefined ? {} : { cursor: decodeCursor(q['cursor']) }) };
}

const encodeCursor = (r: any): string => Buffer.from(JSON.stringify([r.cursor_at ?? iso(r.occurred_at), r.id])).toString('base64url');
function decodeCursor(c: unknown): repo.Keyset {
  try {
    if (typeof c === 'string' && CURSOR.test(c)) {
      const v = JSON.parse(Buffer.from(c, 'base64url').toString('utf8'));
      if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && PG_TS.test(v[0]) && typeof v[1] === 'string' && UUID.test(v[1])) return { at: v[0], id: v[1] };
    }
  } catch { /* fall through */ }
  return fail('/cursor');
}

/** Keyset start: the cursor, else a bound just outside the range (NIL / MAX are never row ids: not UUIDv7). */
export const after = (p: Page, asc: boolean): repo.Keyset => p.cursor ?? (asc ? { at: p.from, id: NIL } : { at: p.to, id: MAX });

/** Fetch limit+1, return {data, page}. */
export function paged<R>(rows: any[], limit: number, map: (r: any) => R) {
  const more = rows.length > limit;
  const kept = more ? rows.slice(0, limit) : rows;
  return { data: kept.map(map), page: { limit, ...(more ? { next_cursor: encodeCursor(kept[kept.length - 1]) } : {}) } };
}

const actor = (r: any) => compact({ type: r.actor_type, id: r.actor_id, membership_id: r.membership_id, display_name: r.display_name ?? 'Unknown actor' });
const summary = (r: any) => compact({
  audit_id: r.id, occurred_at: iso(r.occurred_at), table: `${r.schema_name}.${r.table_name}`, action: String(r.action).toLowerCase(),
  row_id: r.row_id, actor: actor(r), centre_id: r.centre_id, request_id: r.request_id, changed_columns: r.changed_columns ?? [],
  support_session_id: r.support_session_id,
});
/** AuthEvent (whitelist; email_hmac never selected nor mapped). */
export const authEvent = (r: any) => compact({
  auth_event_id: r.id, tenant_id: r.tenant_id, user_id: r.user_id, membership_id: r.membership_id, platform_staff_id: r.platform_staff_id,
  session_id: r.session_id, event_type: r.event_type, reason_code: r.reason_code, client_ip: r.client_ip, user_agent: r.user_agent,
  request_id: r.request_id, occurred_at: iso(r.occurred_at),
});
const json = (v: unknown) => (v == null ? undefined : typeof v === 'string' ? v : JSON.stringify(v));

export function createAuditViewService(_deps: object = {}) {
  return {
    async listAuditEntries(ctx: AuditViewCtx, q: Query) {
      const p = page(q);
      const sort = optText(q, 'sort', (s) => s === '-occurred_at' || s === 'occurred_at');
      const table = optText(q, 'table', (s) => s.length <= 127 && /^[a-z_]+\.[a-z_]+$/.test(s));
      // LD-64 / CR-C2-T18-a: action enum is [insert, update, delete]; actor.id omitted when actor_id IS NULL (compact()).
      const action = optText(q, 'action', (s) => s === 'insert' || s === 'update' || s === 'delete');
      const f = {
        schema_name: table?.split('.')[0], table_name: table?.split('.')[1], action: action?.toUpperCase(),
        row_id: optUuid(q, 'row_id'), actor_id: optUuid(q, 'actor_id'), membership_id: optUuid(q, 'membership_id'), centre_id: optUuid(q, 'centre_id'),
        request_id: optUuid(q, 'request_id'), support_session_id: optUuid(q, 'support_session_id'),
      };
      const asc = sort === 'occurred_at';
      const rows = await repo.listAudit(ctx.tx, { tenantId: ctx.tenantId, from: p.from, to: p.to, after: after(p, asc), limit: p.limit + 1, asc, f });
      return paged(rows, p.limit, summary);
    },

    async getAuditEntry(ctx: AuditViewCtx, input: { auditId: unknown }) {
      const id = typeof input?.auditId === 'string' && UUID.test(input.auditId) ? input.auditId.toLowerCase() : fail('/audit_id');
      const r = await repo.getAudit(ctx.tx, ctx.tenantId, id);
      if (!r) throw new LimsError('common.not_found');                      // other tenant / out of centre scope look the same
      // D-T3: log the view before any value leaves; a failed write fails the request.
      await ctx.audit.access(compact({ action: 'audit_entry.view', entityType: 'audit_entry', entityId: r.id, centreId: r.centre_id ?? undefined, outcome: 'allowed' as const }));
      return compact({ ...summary(r), old_values: json(r.old_values), new_values: json(r.new_values), client_ip: r.client_ip, user_agent: r.user_agent });
    },

    async listAccessLogEntries(ctx: AuditViewCtx, q: Query) {
      const p = page(q);
      const f = {
        action: optText(q, 'action', (s) => s.length <= 100), entity_type: optText(q, 'entity_type', (s) => s.length <= 40),
        entity_id: optUuid(q, 'entity_id'), actor_id: optUuid(q, 'actor_id'), membership_id: optUuid(q, 'membership_id'), centre_id: optUuid(q, 'centre_id'),
        outcome: optText(q, 'outcome', (s) => s === 'allowed' || s === 'denied'),
      };
      const rows = await repo.listAccess(ctx.tx, { tenantId: ctx.tenantId, from: p.from, to: p.to, after: after(p, false), limit: p.limit + 1, f });
      return paged(rows, p.limit, (r) => compact({
        id: r.id, centre_id: r.centre_id, actor_id: r.actor_id, actor_type: r.actor_type, membership_id: r.membership_id,
        support_session_id: r.support_session_id, action: r.action, entity_type: r.entity_type, entity_id: r.entity_id, purpose_code: r.purpose_code,
        outcome: r.outcome, detail: json(r.detail) ?? '{}', request_id: r.request_id, client_ip: r.client_ip, user_agent: r.user_agent,
        occurred_at: iso(r.occurred_at),
      }));
    },

    async listAuthEvents(ctx: AuditViewCtx, q: Query) {
      const p = page(q);
      const f = { event_type: optText(q, 'event_type', (s) => AUTH_EVENT_TYPES.has(s)), membership_id: optUuid(q, 'membership_id') };
      const rows = await repo.listAuth(ctx.tx, { tenantId: ctx.tenantId, from: p.from, to: p.to, after: after(p, false), limit: p.limit + 1, f });
      return paged(rows, p.limit, authEvent);
    },
  };
}
