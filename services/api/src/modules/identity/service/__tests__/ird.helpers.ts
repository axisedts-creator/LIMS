// T23 test helpers (not a test file). Synthetic data only. Fixes the SEAMS the spec leaves open - the writer must match them or raise a dispute:
//
//   ../ird.service.ts   exports `createIrdService(deps?: { repo?: IrdRepo; newId?: () => string })` ->
//                       { listPlatformIrdAnnexes, createPlatformIrdAnnex, updateIrdAnnex, transitionIrdAnnex, uploadIrdAnnexDocument, downloadIrdAnnexDocument },
//                       each `(ctx, input) => Promise<{ status, body, version?, headers? }>` (same convention as support/settings.service). The DEFAULT repo is
//                       repository/ird.repo.ts (SQL on ctx.tx); tests inject the fake below. Every op calls PlatformAuthz.assertPlatform ITSELF before any repo call:
//                       list + download = `platform.tenant.read`; create/update/transition/upload = `platform.tenant.manage` (superadmin only, aal2).
//   ctx (platform request ctx, as T21) = { actor{type:'user',id}, platformRole, platformStaffId, platformSessionId, aal, requestId, clientIp, tx, now(), db, log,
//        commitOnError(), uploads{accept}, files{scan}, storage{read,delete}, download{stream} }  - NO tenantId. `uploads`/`files`/`storage` here are fakes (the core
//        storage binds ONE tenant path prefix; the platform ctx spans tenants + 'platform', so the path rule is the SERVICE's: `{tenant_id|platform}/ird/{record_id}/{id}.{ext}`).
//   inputs (camelCase): list{tenantId?,annexCode?,status?} - create{softwareVersion,notes?} - update{recordId,expectedVersion|undefined,patch(snake wire incl. unset[])}
//        - transition{recordId,expectedVersion|undefined,toStatus,submittedOn?,completedOn?,referenceNo?,note?} - upload{recordId,file{filename,mimeType,bytes}}
//        - download{recordId,documentId}
//   bodies = IrdAnnexPage / IrdAnnexRecord / IrdAnnexDocument of contracts/openapi/identity.yaml (additionalProperties:false, no nulls: absent optional fields OMITTED;
//        record id is `record_id`, dates `YYYY-MM-DD`). Download returns the core `ctx.download.stream` output ({status:200, headers, body}).
import { vi } from 'vitest';
import { LimsError } from '../../../../core/errors.js';
import { createDownload } from '../../../../core/storage/download.js';

export const idN = (n: number) => `0190a000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
export const TENANT_A = idN(0xa1), TENANT_B = idN(0xb1);
export const STAFF_USER = idN(0xd1), STAFF_ID = idN(0xd2), PSESSION = idN(0xe2), REQ_ID = idN(0xe1);
export const NOW = new Date('2026-11-08T06:00:00.000Z');   // 2026-11-08 11:45 Asia/Kathmandu -> "today" = 2026-11-08 on both calendars of the UTC/NPT day
export const TODAY = '2026-11-08';
export const rejection = async (p: unknown): Promise<any> => { try { await (typeof p === 'function' ? (p as () => unknown)() : p); } catch (e) { return e; } throw new Error('expected rejection, got success'); };

export type Status = 'not_started' | 'in_preparation' | 'submitted' | 'completed' | 'rejected' | 'superseded';
export type Code = 'annex_1' | 'annex_2' | 'annex_3' | 'annex_7';
export const STATUSES: Status[] = ['not_started', 'in_preparation', 'submitted', 'completed', 'rejected', 'superseded'];
export interface Rec {
  id: string; tenant_id: string | null; annex_code: Code; status: Status; reference_no: string | null; office_name: string | null; counterparty_name: string | null;
  software_version: string | null; submitted_on: string | null; completed_on: string | null; notes: string | null; supersedes_id: string | null; is_active: boolean; version: number;
}
let rseq = 0x100;
export const nextRecId = () => idN(rseq++);
export const rec = (o: Partial<Rec> = {}): Rec => ({
  id: nextRecId(), tenant_id: TENANT_A, annex_code: 'annex_2', status: 'not_started', reference_no: null, office_name: null, counterparty_name: null, software_version: null,
  submitted_on: null, completed_on: null, notes: null, supersedes_id: null, is_active: true, version: 1, ...o,
});
/** A record in `status` whose date/reference columns satisfy the 05-SCHEMA CHECKs for that status. */
export const recIn = (status: Status, o: Partial<Rec> = {}): Rec => rec({
  status, version: 3,
  ...(['submitted', 'completed', 'rejected', 'superseded'].includes(status) ? { submitted_on: '2026-11-01' } : {}),
  ...(status === 'completed' || status === 'superseded' ? { completed_on: '2026-11-03', reference_no: 'REF-OLD-1' } : {}),
  ...o,
});
export const platformRec = (status: Status, o: Partial<Rec> = {}): Rec => recIn(status, { tenant_id: null, annex_code: 'annex_1', software_version: '1.0.0', ...o });

export interface Doc { id: string; tenant_id: string | null; record_id: string; bucket: string; object_path: string; original_filename: string; content_type: string; size_bytes: number; sha256: string; scan_state: 'pending' | 'clean' | 'quarantined'; created_at: Date }
export const doc = (recordId: string, o: Partial<Doc> = {}): Doc => {
  const id = o.id ?? nextRecId(); const tenant = o.tenant_id === undefined ? TENANT_A : o.tenant_id;
  return { id, tenant_id: tenant, record_id: recordId, bucket: 'identity-assets', object_path: `${tenant ?? 'platform'}/ird/${recordId}/${id}.pdf`, original_filename: 'annex.pdf',
    content_type: 'application/pdf', size_bytes: 12, sha256: 'ab'.repeat(32), scan_state: 'clean', created_at: NOW, ...o };
};

export interface InsertRecord { id: string; tenantId: string | null; annexCode: Code; status: 'not_started'; softwareVersion?: string; notes?: string; supersedesId?: string; actorId: string }
export interface TransitionFields { submittedOn?: string; completedOn?: string; referenceNo?: string }
export interface EventArg { recordId: string; tenantId: string | null; fromStatus: Status | null; toStatus: Status; note?: string; actorId: string; occurredAt: Date }
export interface PlatformEventArg { eventType: 'annex_1_changed' | 'ird_document_downloaded'; targetType: string; targetId: string; targetTenantId: string | null; detail: Record<string, unknown>;
  actorPlatformStaffId: string; requestId?: string; clientIp?: string }
export interface DocInsert { id: string; tenantId: string | null; recordId: string; bucket: string; objectPath: string; originalFilename: string; contentType: string; sizeBytes: number; sha256: string; scanState: 'pending' | 'clean'; actorId: string }
export interface ListFilter { tenantId: string | null; annexCode?: string; status?: string }

/** IrdRepo seam. Every method takes the request tx first. `tenantId: null` = platform-level (Annex 1) rows; there is NO "all rows" query. */
export interface IrdRepo {
  list(tx: unknown, f: ListFilter): Promise<Rec[]>;
  find(tx: unknown, id: string): Promise<Rec | undefined>;
  insert(tx: unknown, r: InsertRecord): Promise<Rec>;
  /** `set` = snake column -> value (already validated), `unset` = columns to NULL. Optimistic lock; undefined = version mismatch. Bumps version. */
  update(tx: unknown, id: string, expectedVersion: number, set: Record<string, string>, unset: string[], actorId: string): Promise<Rec | undefined>;
  /** status change + the date/reference columns given. Optimistic lock; undefined = version mismatch. Bumps version. */
  transition(tx: unknown, id: string, expectedVersion: number, to: Status, f: TransitionFields, actorId: string): Promise<Rec | undefined>;
  insertEvent(tx: unknown, e: EventArg): Promise<void>;
  insertPlatformEvent(tx: unknown, e: PlatformEventArg): Promise<void>;
  insertDocument(tx: unknown, d: DocInsert): Promise<Doc>;
  findDocument(tx: unknown, recordId: string, documentId: string): Promise<Doc | undefined>;
  /** the P-19 re-scan outcome; platform UPDATE policy (the only mutable column) */
  setDocumentScanState(tx: unknown, documentId: string, state: 'clean' | 'quarantined'): Promise<void>;
}

export function makeRepo(seed: { records?: Rec[]; docs?: Doc[] } = {}) {
  const records: Rec[] = (seed.records ?? []).map((r) => ({ ...r }));
  const docs: Doc[] = (seed.docs ?? []).map((d) => ({ ...d }));
  const events: EventArg[] = []; const platformEvents: PlatformEventArg[] = []; const order: string[] = [];
  const calls: Array<{ m: string; tx: unknown; args: unknown[] }> = [];
  const fail: Record<string, Error | undefined> = {};
  const track = (m: string, tx: unknown, ...args: unknown[]) => { calls.push({ m, tx, args }); if (fail[m]) throw fail[m]; };
  const w = (m: string) => order.push(m);
  const cp = (r: Rec): Rec => ({ ...r });
  const repo: IrdRepo = {
    async list(tx, f) {
      track('list', tx, f);
      return records.filter((r) => (f.tenantId === null ? r.tenant_id === null : r.tenant_id === f.tenantId) && (!f.annexCode || r.annex_code === f.annexCode) && (!f.status || r.status === f.status)).map(cp);
    },
    async find(tx, id) { track('find', tx, id); const r = records.find((x) => x.id === id); return r && cp(r); },
    async insert(tx, a) {
      track('insert', tx, a); w('insert');
      const r = rec({ id: a.id, tenant_id: a.tenantId, annex_code: a.annexCode, status: a.status, software_version: a.softwareVersion ?? null, notes: a.notes ?? null, supersedes_id: a.supersedesId ?? null });
      records.push(r); return cp(r);
    },
    async update(tx, id, v, set, unset, actorId) {
      track('update', tx, id, v, set, unset, actorId); w('update');
      const r = records.find((x) => x.id === id); if (!r || r.version !== v) return undefined;
      Object.assign(r, set); for (const u of unset) (r as any)[u] = null; r.version += 1; return cp(r);
    },
    async transition(tx, id, v, to, f, actorId) {
      track('transition', tx, id, v, to, f, actorId); w('transition');
      const r = records.find((x) => x.id === id); if (!r || r.version !== v) return undefined;
      Object.assign(r, { status: to, ...(f.submittedOn ? { submitted_on: f.submittedOn } : {}), ...(f.completedOn ? { completed_on: f.completedOn } : {}), ...(f.referenceNo ? { reference_no: f.referenceNo } : {}) });
      r.version += 1; return cp(r);
    },
    async insertEvent(tx, e) { track('insertEvent', tx, e); w('insertEvent'); events.push({ ...e }); },
    async insertPlatformEvent(tx, e) { track('insertPlatformEvent', tx, e); w('insertPlatformEvent'); platformEvents.push({ ...e }); },
    async insertDocument(tx, d) {
      track('insertDocument', tx, d); w('insertDocument');
      const x = doc(d.recordId, { id: d.id, tenant_id: d.tenantId, bucket: d.bucket, object_path: d.objectPath, original_filename: d.originalFilename, content_type: d.contentType, size_bytes: d.sizeBytes, sha256: d.sha256, scan_state: d.scanState });
      docs.push(x); return { ...x };
    },
    async findDocument(tx, recordId, documentId) { track('findDocument', tx, recordId, documentId); const d = docs.find((x) => x.id === documentId && x.record_id === recordId); return d && { ...d }; },
    async setDocumentScanState(tx, id, state) { track('setDocumentScanState', tx, id, state); w('setDocumentScanState'); const d = docs.find((x) => x.id === id); if (d) d.scan_state = state; },
  };
  return { repo, records, docs, events, platformEvents, order, calls, fail, by: (m: string) => calls.filter((c) => c.m === m), rowOf: (id: string) => records.find((r) => r.id === id)!, docOf: (id: string) => docs.find((d) => d.id === id)! };
}
export type FakeRepo = ReturnType<typeof makeRepo>;

export type ScanMode = 'clean' | 'infected' | 'unavailable' | 'throw';
export interface AcceptOpts { allow: string[]; maxBytes: number; bucket: string; objectPath: string; scan: string; images?: unknown }
/** Platform ctx with fake uploads/files/storage and the REAL core download helper over the fake storage (headers are the core's, P-2). */
export function makeCtx(o: Record<string, unknown> = {}, bytesByPath: Record<string, Uint8Array> = {}) {
  const tx = { __tx: 'T23-request-tx' };
  const scanMode = { v: 'clean' as ScanMode };
  const acceptMode = { v: 'clean' as 'clean' | 'unavailable' | Error };
  const stored = new Map<string, Uint8Array>(Object.entries(bytesByPath));
  const scan = vi.fn(async (_b: Uint8Array) => { if (scanMode.v === 'throw') throw new Error('scanner down'); return scanMode.v === 'infected' ? ('infected' as const) : scanMode.v === 'unavailable' ? ('unavailable' as const) : ('clean' as const); });
  const accept = vi.fn(async (file: { filename: string; mimeType: string; bytes: Uint8Array }, opts: AcceptOpts) => {
    if (acceptMode.v instanceof Error) throw acceptMode.v;
    if (!(file?.bytes instanceof Uint8Array) || typeof file.filename !== 'string' || typeof file.mimeType !== 'string') throw new LimsError('common.unsupported_media_type');   // as core accept()
    stored.set(opts.objectPath, file.bytes);
    const mime = /\.pdf$/i.test(file.filename) ? 'application/pdf' : /\.png$/i.test(file.filename) ? 'image/png' : 'image/jpeg';
    return { objectId: idN(0x7777), bucket: opts.bucket, objectPath: opts.objectPath, sha256: 'cd'.repeat(32), byteSize: file.bytes.length, mime, scanState: acceptMode.v === 'unavailable' ? ('unavailable' as const) : ('clean' as const) };
  });
  const read = vi.fn(async (_bucket: string, path: string) => { const b = stored.get(path); if (!b) throw new Error(`fake storage: no object ${path}`); return b; });
  const remove = vi.fn(async (_bucket: string, path: string) => { stored.delete(path); });
  const audit = vi.fn(async () => undefined);
  const download = createDownload({ storage: { read } as never, audit: { access: audit } });
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const commitOnError = vi.fn();
  const ctx: any = {
    actor: { type: 'user', id: STAFF_USER }, platformRole: 'platform_superadmin', platformStaffId: STAFF_ID, platformSessionId: PSESSION, aal: 'aal2',
    requestId: REQ_ID, clientIp: '203.0.113.9', tx, now: () => NOW, log, commitOnError, db: { withTenantScope: vi.fn() },
    uploads: { accept }, files: { scan }, storage: { read, delete: remove }, download, ...o,
  };
  return { ctx, tx, scan, scanMode, accept, acceptMode, read, remove, stored, audit, commitOnError, log };
}
export const SUPPORT = { platformRole: 'platform_support' };
export const bytes = (s: string) => new TextEncoder().encode(s);
export const PDF = () => ({ filename: 'annex-2.pdf', mimeType: 'application/pdf', bytes: bytes('%PDF-1.4 synthetic') });
