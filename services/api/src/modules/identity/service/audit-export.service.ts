// C2-T19 audit exports (01-PRD AC-D4.1..D4.5; 02-TRD §5.9, §8; 03-APP-FLOW §2.7, §7.2; 07-SECURITY A-7, D-T22, P-3, P-10).
// Tenant, actor, membership and centre scope come from ctx only. x-permission audit.log.export is the pipeline's floor; create also needs
// all_centres = true [CONV]. Bodies follow the AuditExport schema (null fields omitted; no object_path / sha256 / filters / tenant_id).
// Error messages never carry input values.
import { idMetrics } from '../metrics.js';
import { LimsError, type FieldError } from '../../../core/errors.js';
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { createExportRepo, type ExportSource, type Filters } from '../repository/exports.repo.js';
import type { Keyset } from '../repository/audit-read.repo.js';
import { AUTH_EVENT_TYPES } from './audit-view.service.js';

type Repo = Pick<ReturnType<typeof createExportRepo>, 'lockQuota' | 'countSince' | 'estimateRows' | 'insert' | 'insertNotice' | 'enqueueJob' | 'find' | 'list' | 'consumeDownload'>;
type AccessEntry = { action: string; entityType: string; entityId?: string; outcome: 'allowed' | 'denied' };
export interface AuditExportCtx {
  readonly tenantId: string;
  readonly tx: unknown;
  readonly actor: { readonly id: string; readonly membershipId?: string };
  readonly now: () => string | Date;              // IC RequestContext.now: () => IsoUtc; a Date is tolerated
  readonly audit: { access(e: AccessEntry): Promise<unknown> };
  readonly ports: { readonly IdentityPort: {
    getActor(ctx: unknown): Promise<{ readonly centreScope?: { readonly all?: unknown } } | null | undefined>;
    assertRole(ctx: unknown, req: { permission: string }): Promise<unknown>;
  } };
  readonly download: { stream(input: any): Promise<{ status: number; headers: Record<string, string>; body: Uint8Array }> };
  readonly metrics?: { inc(name: string, labels: Record<string, string>): void };
}
type Body = Record<string, unknown>;

const TASK = 'identity.build_audit_export';
const BUCKET = 'identity-exports';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_UTC = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,6})?Z$/;
const PG_TS = /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d(\.\d{1,6})?(Z|[+-]\d\d(:?\d\d)?)$/;
const CURSOR = /^[A-Za-z0-9_-]{1,512}$/;
const DAY_MS = 86_400_000;
const MAX_SPAN_MS = 31 * DAY_MS;                 // AC-D4.3
const ROW_CAP = 500_000;                          // AC-D4.3
const USER_PER_DAY = 5, TENANT_PER_DAY = 20;      // AC-D4.4 (sliding 24 h)
const BODY_KEYS = new Set(['source', 'occurred_at_from', 'occurred_at_to', 'filters', 'format']);

const uuidOk = (s: string) => UUID.test(s);
const FILTERS: Record<ExportSource, Record<string, (s: string) => boolean>> = {
  audit_log: {
    table: (s) => s.length <= 127 && /^[a-z_]+\.[a-z_]+$/.test(s), action: (s) => s === 'insert' || s === 'update' || s === 'delete',
    row_id: uuidOk, actor_id: uuidOk, membership_id: uuidOk, centre_id: uuidOk, request_id: uuidOk, support_session_id: uuidOk,
  },
  access_log: {
    action: (s) => /^[a-z0-9_.]{1,100}$/.test(s), entity_type: (s) => /^[a-z0-9_.]{1,40}$/.test(s), entity_id: uuidOk,
    actor_id: uuidOk, membership_id: uuidOk, centre_id: uuidOk, outcome: (s) => s === 'allowed' || s === 'denied',
  },
  auth_events: { event_type: (s) => AUTH_EVENT_TYPES.has(s), membership_id: uuidOk },
};
const ALL_FILTER_KEYS = new Set(Object.values(FILTERS).flatMap((f) => Object.keys(f)));

const fail = (path: string, code = 'common.field_invalid', message = 'Field invalid'): never => {
  throw new LimsError('common.validation_failed', undefined, [{ path, code, message } satisfies FieldError]);
};
const iso = (v: unknown) => (v instanceof Date ? v : new Date(String(v))).toISOString();
const compact = <T extends Record<string, unknown>>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null)) as T;
const isObj = (v: unknown): v is Body => typeof v === 'object' && v !== null && !Array.isArray(v);

const toApi = (r: any) => compact({
  export_id: r.id, source: r.source, status: r.status, requested_by_membership_id: r.requested_by_membership_id,
  range_from: iso(r.range_from), range_to: iso(r.range_to), row_count: r.row_count, ready_at: r.ready_at ? iso(r.ready_at) : undefined,
  expires_at: r.expires_at ? iso(r.expires_at) : undefined, downloads_remaining: r.downloads_remaining, error_code: r.error_code,
  created_at: iso(r.created_at), version: r.version,
});

function parseBody(b: unknown) {
  if (!isObj(b)) return fail('');
  for (const k of Object.keys(b)) if (!BODY_KEYS.has(k)) fail('');                 // key names are input: never echoed
  const source = b['source'];
  if (source !== 'audit_log' && source !== 'access_log' && source !== 'auth_events') return fail('/source');
  if (b['format'] !== 'csv') fail('/format');
  const ts = (k: string): string => {
    const v = b[k];
    if (v === undefined || v === null || v === '') return fail(`/${k}`, 'common.field_required', 'Field required');
    return typeof v === 'string' && ISO_UTC.test(v) && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : fail(`/${k}`);
  };
  const from = ts('occurred_at_from'); const to = ts('occurred_at_to');
  if (Date.parse(to) <= Date.parse(from)) fail('/occurred_at_to');
  const filters: Filters = {};
  const raw = b['filters'];
  if (raw !== undefined) {
    if (!isObj(raw)) return fail('/filters');
    const allowed = FILTERS[source];
    for (const [k, v] of Object.entries(raw)) {
      const path = ALL_FILTER_KEYS.has(k) ? `/filters/${k}` : '/filters';
      const ok = Object.hasOwn(allowed, k) ? allowed[k] : undefined;
      if (!ok || typeof v !== 'string' || !ok(v)) fail(path);
      filters[k] = k.endsWith('_id') ? (v as string).toLowerCase() : (v as string);
    }
  }
  return { source: source as ExportSource, from, to, filters };
}

const encodeCursor = (r: any) => Buffer.from(JSON.stringify([r.cursor_at ?? iso(r.created_at), r.id])).toString('base64url');
function decodeCursor(c: unknown): Keyset {
  try {
    if (typeof c === 'string' && CURSOR.test(c)) {
      const v = JSON.parse(Buffer.from(c, 'base64url').toString('utf8'));
      if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && PG_TS.test(v[0]) && typeof v[1] === 'string' && UUID.test(v[1])) return { at: v[0], id: v[1] };
    }
  } catch { /* fall through */ }
  return fail('/cursor');
}
const exportId = (input: { exportId?: unknown }) =>
  (typeof input?.exportId === 'string' && UUID.test(input.exportId) ? input.exportId.toLowerCase() : fail('/export_id'));

const nowMs = (ctx: AuditExportCtx) => new Date(ctx.now()).getTime();

const membership = (ctx: AuditExportCtx) => {
  const m = ctx.actor?.membershipId;
  if (typeof m !== 'string') throw new LimsError('auth.forbidden');
  return m;
};

/** P-10: audit.log.read widens to every requester of the tenant; auth.forbidden = own rows only; any other failure propagates. */
async function canReadAll(ctx: AuditExportCtx): Promise<boolean> {
  try {
    await ctx.ports.IdentityPort.assertRole(ctx, { permission: 'audit.log.read' });
    return true;
  } catch (e) {
    if (e instanceof LimsError && e.code === 'auth.forbidden') return false;
    throw e;
  }
}

export function createAuditExportService(deps: { repo?: Repo; newId?: () => string } = {}) {
  const repo = deps.repo ?? createExportRepo();
  const newId = deps.newId ?? uuidv7;
  return {
    async createAuditExport(ctx: AuditExportCtx, body: unknown) {
      const prof = await ctx.ports.IdentityPort.getActor(ctx);                        // centre scope lives on ActorProfile, not ctx
      if (prof?.centreScope?.all !== true) throw new LimsError('auth.forbidden');      // D-T22 [CONV]: before any other check
      const mem = membership(ctx);
      const b = parseBody(body);
      if (Date.parse(b.to) - Date.parse(b.from) > MAX_SPAN_MS) throw new LimsError('identity.export_too_large');
      const { tx, tenantId } = ctx;
      await repo.lockQuota(tx, tenantId, mem);
      const since = new Date(nowMs(ctx) - DAY_MS);
      const limited = () => { const e = new LimsError('common.rate_limited'); e.retryAfterSeconds = 3600; return e; };   // [CONV] coarse Retry-After
      if ((await repo.countSince(tx, tenantId, { membershipId: mem, since })) >= USER_PER_DAY) throw limited();
      const tenantDay = await repo.countSince(tx, tenantId, { since });
      if (tenantDay >= TENANT_PER_DAY) throw limited();
      if ((await repo.estimateRows(tx, tenantId, { source: b.source, from: b.from, to: b.to, filters: b.filters, cap: ROW_CAP })) > ROW_CAP) {
        throw new LimsError('identity.export_too_large');
      }
      const id = newId();
      const row = await repo.insert(tx, tenantId, { id, membershipId: mem, source: b.source, filters: b.filters, rangeFrom: b.from, rangeTo: b.to, actorId: ctx.actor.id });
      await ctx.audit.access({ action: 'data.export', entityType: 'audit_export', entityId: id, outcome: 'allowed' });
      await repo.insertNotice(tx, tenantId, { kind: 'audit_export_created', subjectType: 'audit_export', subjectId: id, excludeMembershipId: mem, actorId: ctx.actor.id });
      await repo.enqueueJob(tx, { taskIdentifier: TASK, payload: { tenant_id: tenantId, export_id: id }, jobKey: `export:${id}` });
      ctx.metrics?.inc('lims_identity_audit_exports_total', { tenant_id: tenantId, source: b.source });
      // T28 backing gauge (02-TRD §13) [CONV]: "today" = the same rolling 24 h window as the rate limit above, this export included.
      idMetrics.auditExportsTenantDay(ctx, tenantId, tenantDay + 1);
      return { status: 202, body: toApi(row) };
    },

    async listAuditExports(ctx: AuditExportCtx, q: unknown) {
      const query = isObj(q) ? q : {};
      let limit = 50;
      if (query['limit'] !== undefined) {
        const l = typeof query['limit'] === 'string' && /^\d{1,4}$/.test(query['limit']) ? Number(query['limit']) : query['limit'];
        if (!Number.isInteger(l) || (l as number) < 1 || (l as number) > 200) fail('/limit');
        limit = l as number;
      }
      const after = query['cursor'] === undefined ? undefined : decodeCursor(query['cursor']);
      const mem = membership(ctx);
      const all = await canReadAll(ctx);
      const rows = await repo.list(ctx.tx, ctx.tenantId, { ...(all ? {} : { membershipId: mem }), ...(after ? { after } : {}), limit: limit + 1 });
      const more = rows.length > limit;
      const kept = more ? rows.slice(0, limit) : rows;
      return { status: 200, body: { data: kept.map(toApi), page: { limit, ...(more ? { next_cursor: encodeCursor(kept[kept.length - 1]) } : {}) } } };
    },

    async getAuditExport(ctx: AuditExportCtx, input: { exportId?: unknown }) {
      const id = exportId(input);
      const mem = membership(ctx);
      const r = await repo.find(ctx.tx, ctx.tenantId, id);
      if (!r || (r.requested_by_membership_id !== mem && !(await canReadAll(ctx)))) throw new LimsError('common.not_found');
      return { status: 200, body: toApi(r) };
    },

    /** AC-D4.5: requester only, ready, < 24 h, <= 3 downloads; atomic decrement, then bytes + access log via the core helper. */
    async downloadAuditExport(ctx: AuditExportCtx, input: { exportId?: unknown }) {
      const id = exportId(input);
      const mem = membership(ctx);
      const r = await repo.find(ctx.tx, ctx.tenantId, id);
      if (!r || r.requested_by_membership_id !== mem) throw new LimsError('common.not_found');
      const left = await repo.consumeDownload(ctx.tx, ctx.tenantId, id, { now: new Date(nowMs(ctx)), actorId: ctx.actor.id });
      if (!left || typeof left.object_path !== 'string') throw new LimsError('common.not_found');
      return ctx.download.stream({
        bucket: BUCKET, objectPath: left.object_path, filename: `audit-export-${id}.csv`, contentType: 'text/csv', scanState: 'clean',
        access: { action: 'audit_export.download', entityType: 'audit_export', entityId: id, outcome: 'allowed' },
      });
    },
  };
}
