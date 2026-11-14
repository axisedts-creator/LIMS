// C2-T19 test helpers (not a test file). Synthetic data only. Fixes the SEAMS the spec leaves open - the writer must match them or raise a dispute:
//
//   ../service/audit-export.service.ts   exports `createAuditExportService(deps?: { repo?: ExportRepo; newId?: () => string })` ->
//        { createAuditExport(ctx, body), listAuditExports(ctx, query), getAuditExport(ctx, {exportId}), downloadAuditExport(ctx, {exportId}) }, each returning
//        `{ status, body, headers? }` (same convention as role/ird services). DEFAULT repo = repository/exports.repo.ts (SQL on ctx.tx, explicit tenant_id on every
//        statement); tests inject the FakeRepo below. `body` for create = the RAW snake_case JSON body (the service validates it again, like audit-view.service).
//   ctx (tenant request ctx) = { tenantId, actor{type,id,membershipId}, requestId, tx, now() (Date or IsoUtc string), audit{access(entry)},
//        ports{IdentityPort{getActor(ctx)->ActorProfile{centreScope{all,centreIds}}, assertRole(ctx,{permission})}}, download{stream(input)}, metrics?{inc(name,labels)}, log }.
//        Tenant/actor/membership come ONLY from ctx. There is NO ctx.centreScope (IC RequestContext has none).
//   Permission audit.log.export is the pipeline's x-permission floor (contract test). In the service: createAuditExport FIRST requires
//        (await ctx.ports.IdentityPort.getActor(ctx)).centreScope.all === true (CONV); getActor rejection propagates.
//   listAuditExports/getAuditExport P-10 branch: `ctx.ports.IdentityPort.assertRole(ctx, { permission: 'audit.log.read' })` resolves -> other requesters' rows are
//        visible; rejects with LimsError auth.forbidden -> own rows only (NOT an error); any other rejection propagates.
//   Download = `ctx.download.stream({ bucket:'identity-exports', objectPath, filename, contentType:'text/csv', scanState:'clean', access:{ action:'audit_export.download',
//        entityType:'audit_export', entityId, outcome:'allowed' } })` (core helper writes the access-log row AFTER the bytes were read).
//   Access log on create: ctx.audit.access({ action:'data.export', entityType:'audit_export', entityId, outcome:'allowed' }) (02-TRD §9).
//   Job: repo.enqueueJob(tx, { taskIdentifier:'identity.build_audit_export', payload:{ tenant_id, export_id }, jobKey:`export:${export_id}` }) (02-TRD §8 row).
//   Metric: ctx.metrics?.inc('lims_identity_audit_exports_total', { tenant_id, source }).
import { vi } from 'vitest';
import { LimsError } from '../../../core/errors.js';
import { createDownload } from '../../../core/storage/download.js';

export const idN = (n: number) => `0190a000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
export const TENANT_A = idN(0xa1), TENANT_B = idN(0xb1);
export const USER = idN(0xd1), MEM = idN(0xd2);           // the requester
export const USER2 = idN(0xd3), MEM2 = idN(0xd4);         // another admin of tenant A
export const REQ_ID = idN(0xe1), CENTRE_A1 = idN(0xc1);
export const NOW = new Date('2026-11-08T06:00:00.000Z');
export const H = 3_600_000, DAY = 86_400_000;
export const rejection = async (p: unknown): Promise<any> => { try { await (typeof p === 'function' ? (p as () => unknown)() : p); } catch (e) { return e; } throw new Error('expected rejection, got success'); };

export interface ExRow {
  id: string; tenant_id: string; requested_by_membership_id: string; source: 'audit_log' | 'access_log' | 'auth_events'; filters: Record<string, string>;
  range_from: Date; range_to: Date; status: 'queued' | 'building' | 'ready' | 'failed' | 'expired'; row_count: number | null; object_path: string | null;
  sha256: Buffer | null; size_bytes: number | null; downloads_remaining: number; ready_at: Date | null; expires_at: Date | null; last_downloaded_at: Date | null;
  error_code: string | null; version: number; created_at: Date; created_by: string; updated_at: Date; updated_by: string;
}
let seq = 0x1000;
export const nextExId = () => idN(seq++);
export const exRow = (o: Partial<ExRow> = {}): ExRow => {
  const id = o.id ?? nextExId();
  return {
    id, tenant_id: TENANT_A, requested_by_membership_id: MEM, source: 'audit_log', filters: {}, range_from: new Date('2026-10-01T00:00:00.000Z'),
    range_to: new Date('2026-10-08T00:00:00.000Z'), status: 'queued', row_count: null, object_path: null, sha256: null, size_bytes: null, downloads_remaining: 3,
    ready_at: null, expires_at: null, last_downloaded_at: null, error_code: null, version: 1, created_at: new Date(NOW.getTime() - H), created_by: USER,
    updated_at: new Date(NOW.getTime() - H), updated_by: USER, ...o,
  };
};
/** A ready export whose object exists in the fake storage (see makeEnv({ files })). */
export const readyRow = (o: Partial<ExRow> = {}): ExRow => {
  const id = o.id ?? nextExId();
  const tenant = o.tenant_id ?? TENANT_A;
  return exRow({
    id, status: 'ready', row_count: 2, object_path: `${tenant}/2026/11/${id}.csv`, sha256: Buffer.alloc(32, 7), size_bytes: 64, ready_at: new Date(NOW.getTime() - H),
    expires_at: new Date(NOW.getTime() + 23 * H), version: 3, ...o,
  });
};
export const CSV_BYTES = new TextEncoder().encode('audit_id,occurred_at_utc\r\nx,2026-10-01T00:00:00.000Z\r\n');

export const validBody = (o: Record<string, unknown> = {}) => ({
  source: 'audit_log', occurred_at_from: '2026-10-01T00:00:00.000Z', occurred_at_to: '2026-10-31T00:00:00.000Z', filters: { table: 'core.roles' }, format: 'csv', ...o,
});

export interface Call { method: string; tx: unknown; tenantId: string; args: any[] }
export interface Keyset { at: string; id: string }

export class FakeRepo {
  rows: ExRow[] = [];
  calls: Call[] = [];
  events: string[] = [];
  notices: any[] = [];
  jobs: any[] = [];
  estimate = 10;
  quotaLocks = 0;
  failOn: string | undefined;
  private rec(method: string, tx: unknown, tenantId: string, args: any[]) {
    this.calls.push({ method, tx, tenantId, args }); this.events.push(method);
    if (this.failOn === method) throw new Error(`injected failure in ${method}`);
  }
  inserted = () => this.calls.filter((c) => c.method === 'insert');

  async lockQuota(tx: unknown, tenantId: string, membershipId: string): Promise<void> { this.rec('lockQuota', tx, tenantId, [membershipId]); this.quotaLocks++; }
  /** exports of the tenant created at or after `since`; per requester when membershipId is given */
  async countSince(tx: unknown, tenantId: string, o: { membershipId?: string; since: Date }): Promise<number> {
    this.rec('countSince', tx, tenantId, [o]);
    return this.rows.filter((r) => r.tenant_id === tenantId && r.created_at >= o.since && (o.membershipId === undefined || r.requested_by_membership_id === o.membershipId)).length;
  }
  /** matching source rows in [from, to), never more than cap + 1 (a LIMIT cap+1 count) */
  async estimateRows(tx: unknown, tenantId: string, o: { source: string; from: string; to: string; filters: Record<string, string>; cap: number }): Promise<number> {
    this.rec('estimateRows', tx, tenantId, [o]);
    return Math.min(this.estimate, o.cap + 1);
  }
  async insert(tx: unknown, tenantId: string, r: { id: string; membershipId: string; source: ExRow['source']; filters: Record<string, string>; rangeFrom: string; rangeTo: string; actorId: string }): Promise<ExRow> {
    this.rec('insert', tx, tenantId, [r]);
    const row = exRow({ id: r.id, tenant_id: tenantId, requested_by_membership_id: r.membershipId, source: r.source, filters: r.filters, range_from: new Date(r.rangeFrom), range_to: new Date(r.rangeTo), created_at: NOW, updated_at: NOW, created_by: r.actorId, updated_by: r.actorId });
    this.rows.push(row);
    return row;
  }
  /** in-app notice for every active admin except the requester (admin_notices kind audit_export_created; no PHI) */
  async insertNotice(tx: unknown, tenantId: string, n: { kind: string; subjectType: string; subjectId: string; excludeMembershipId: string; actorId: string }): Promise<void> {
    this.rec('insertNotice', tx, tenantId, [n]); this.notices.push({ tenantId, ...n });
  }
  async enqueueJob(tx: unknown, j: { taskIdentifier: string; payload: unknown; jobKey: string }): Promise<void> {
    this.rec('enqueueJob', tx, tenantId_(tx), [j]); this.jobs.push(j);
  }
  async find(tx: unknown, tenantId: string, id: string): Promise<ExRow | undefined> {
    this.rec('find', tx, tenantId, [id]);
    return this.rows.find((r) => r.tenant_id === tenantId && r.id === id);
  }
  /** newest first (created_at DESC, id DESC); `membershipId` set -> only that requester's rows; `after` = exclusive keyset; returns at most `limit` rows */
  async list(tx: unknown, tenantId: string, o: { membershipId?: string; after?: Keyset; limit: number }): Promise<ExRow[]> {
    this.rec('list', tx, tenantId, [o]);
    const key = (r: ExRow) => `${r.created_at.toISOString()}|${r.id}`;
    return this.rows.filter((r) => r.tenant_id === tenantId && (o.membershipId === undefined || r.requested_by_membership_id === o.membershipId))
      .sort((a, b) => (key(a) < key(b) ? 1 : -1)).filter((r) => !o.after || key(r) < `${o.after.at}|${o.after.id}`).slice(0, o.limit);
  }
  /** ATOMIC: only if status = 'ready' AND downloads_remaining > 0 AND expires_at > now: decrements, stamps last_downloaded_at, returns the new row; else undefined */
  async consumeDownload(tx: unknown, tenantId: string, id: string, o: { now: Date; actorId: string }): Promise<ExRow | undefined> {
    this.rec('consumeDownload', tx, tenantId, [id, o]);
    const r = this.rows.find((x) => x.tenant_id === tenantId && x.id === id);
    if (!r || r.status !== 'ready' || r.downloads_remaining <= 0 || !r.expires_at || r.expires_at <= o.now) return undefined;
    r.downloads_remaining -= 1; r.last_downloaded_at = o.now; r.version += 1; r.updated_by = o.actorId;
    return { ...r };
  }
}
const tenantId_ = (tx: any) => (tx && typeof tx === 'object' && typeof tx.tenantId === 'string' ? tx.tenantId : TENANT_A);

export interface EnvOpts {
  tenantId?: string; membershipId?: string; actorId?: string; centreAll?: boolean; readGrant?: 'yes' | 'no' | Error;
  files?: Record<string, Uint8Array>; failAccess?: boolean; metrics?: boolean;
  isoClock?: boolean;   // ctx.now() returns an ISO string (IC shape) instead of a Date
}
export function makeEnv(rows: ExRow[] = [], o: EnvOpts = {}) {
  const repo = new FakeRepo();
  repo.rows = rows.map((r) => ({ ...r }));
  const tx = { name: 'tx', tenantId: o.tenantId ?? TENANT_A, query: vi.fn(async () => ({ rows: [] })) };
  const accessWrites: any[] = [];
  const asserted: any[] = [];
  const metricCalls: any[] = [];
  const files = new Map<string, Uint8Array>(Object.entries(o.files ?? {}));
  const reads: Array<{ bucket: string; path: string }> = [];
  const tenantId = o.tenantId ?? TENANT_A;
  const audit = {
    access: vi.fn(async (e: any) => {
      if (o.failAccess) throw new Error('access log unavailable');
      accessWrites.push(e); repo.events.push(`access:${e.action}`);
    }),
  };
  const storage = {
    async read(bucket: string, path: string): Promise<Uint8Array> {
      reads.push({ bucket, path }); repo.events.push('storage.read');
      if (bucket !== 'identity-exports' || !path.startsWith(`${tenantId}/`)) throw new LimsError('common.not_found');
      const b = files.get(path);
      if (!b) throw new LimsError('common.not_found');
      return b;
    },
  };
  const getActorState: { profile: any; error?: Error } = {
    profile: { centreScope: { all: o.centreAll ?? true, centreIds: o.centreAll === false ? [CENTRE_A1] : [] } },
  };
  const grant = o.readGrant ?? 'no';
  const ctx: any = {
    operationId: 'x', tenantId, requestId: REQ_ID, clientIp: '203.0.113.9', tx,
    actor: { type: 'user', id: o.actorId ?? USER, membershipId: o.membershipId ?? MEM },
    now: o.isoClock ? () => NOW.toISOString() : () => new Date(NOW),   // IC RequestContext.now is () => IsoUtc (string); the Date shape is tolerated too
    audit, storage, download: createDownload({ storage, audit }),
    ports: {
      IdentityPort: {
        // IC IdentityPort.getActor(ctx) -> ActorProfile; centreScope lives ONLY here, never on ctx. Tests mutate `profile` / set `getActorError`.
        getActor: vi.fn(async () => {
          if (getActorState.error) throw getActorState.error;
          return getActorState.profile;
        }),
        assertRole: vi.fn(async (_c: unknown, req: any) => {
          asserted.push(req);
          if (grant instanceof Error) throw grant;
          if (grant === 'no') throw new LimsError('auth.forbidden');
        }),
      },
    },
    log: { info() {}, warn() {}, error() {} },
    ...(o.metrics === false ? {} : { metrics: { inc: (...a: unknown[]) => { metricCalls.push(a); } } }),
  };
  let n = 0x7000;
  const newId = () => idN(n++);
  return { ctx, actor: getActorState, repo, tx, accessWrites, asserted, metricCalls, reads, files, newId, deps: { repo, newId } };
}

export const readIdentitySpec = async (): Promise<any> => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { parse } = await import('yaml');
  return parse(readFileSync(join(import.meta.dirname, '../../../../../../contracts/openapi/identity.yaml'), 'utf8'));
};
