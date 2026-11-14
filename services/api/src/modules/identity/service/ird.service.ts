// IRD annex tracker, platform side (02-TRD §5.10; 03-APP-FLOW §2.5 IR1-IR8; 01-PRD AC-E3.1-E3.3; 08 A25 D-215; 07-SECURITY D-T20, P-2, P-19).
// Every operation runs PlatformAuthz.assertPlatform before any repo / upload call. Readiness (AC-E3.4, D-216) is SETTINGS_SQL in core-admin.repo.ts.
// Annex 1 (platform-level) changes write platform_events 'annex_1_changed' with a non-PHI detail (no note / reference / free text).
import { LimsError, type FieldError } from '../../../core/errors.js';
import { contentDisposition } from '../../../core/storage/download.js';
// [CONV] relative import until @lims/shared-ts is a services/api dependency (same as role.service).
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { STATES, canTransition, type AnnexStatus } from '../domain/ird-annex.state.js';
import { PlatformAuthz } from '../platform/authz.js';
import { EDITABLE, createIrdRepo, type IrdDocument, type IrdRecord, type IrdRepo, type PlatformEventArg, type TransitionFields } from '../repository/ird.repo.js';

const READ = 'platform.tenant.read';
const MANAGE = 'platform.tenant.manage';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CODES = ['annex_1', 'annex_2', 'annex_3', 'annex_7'] as const;
const BUCKET = 'identity-assets';
const MAX_DOC_BYTES = 15 * 1024 * 1024;                          // 02-TRD §5.10 PDF/PNG/JPEG <= 15 MB = ird_annex_documents__size__ck
const NPT_OFFSET_MS = (5 * 60 + 45) * 60_000;                    // [CONV] "today" = Asia/Kathmandu date of ctx.now() (platform ctx has no tenant tz)
const LIMITS: Readonly<Record<(typeof EDITABLE)[number], [number, number]>> = {
  reference_no: [1, 100], office_name: [1, 200], counterparty_name: [1, 200], software_version: [1, 40], notes: [0, 2000],
};

export interface IrdCtx {
  readonly actor: { readonly type: string; readonly id: string };
  readonly platformRole: string;
  readonly platformStaffId: string;
  readonly aal?: string;
  readonly requestId?: string;
  readonly clientIp?: string;
  readonly tx: unknown;
  readonly now?: () => Date;
  readonly commitOnError?: () => void;
  // core request helpers; absent -> TypeError -> 500 (fail closed)
  readonly uploads: { accept(file: unknown, opts: unknown): Promise<any> };
  readonly files: { scan(bytes: Uint8Array): Promise<string> };
  readonly storage: { read(bucket: any, objectPath: string): Promise<Uint8Array>; delete(bucket: any, objectPath: string): Promise<void> };
}
export interface Result { status: number; body: any; version?: number; headers?: Record<string, string> }

const failAt = (path: string): never => {
  throw new LimsError('common.validation_failed', undefined, [{ path, code: 'common.field_invalid', message: 'Field invalid' } satisfies FieldError]);
};
const uuidAt = (v: unknown, path: string): string => (typeof v === 'string' && UUID.test(v) ? v : failAt(path));
const strLen = (v: unknown, lo: number, hi: number): v is string => typeof v === 'string' && v.length >= lo && v.length <= hi;
const filled = (v: unknown, hi: number): v is string => typeof v === 'string' && v.trim() !== '' && v.length <= hi;
const oneOf = <T extends string>(v: unknown, list: readonly T[]): v is T => typeof v === 'string' && (list as readonly string[]).includes(v);
const isDate = (s: unknown): s is string =>
  typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
function expected(v: unknown): number {
  if (v === undefined || v === null) throw new LimsError('common.precondition_required');
  return Number.isSafeInteger(v) && (v as number) >= 1 && (v as number) <= 2147483647 ? (v as number) : failAt('/If-Match');
}

/** IrdAnnexRecord: absent optional fields omitted (never null); is_active is not on the wire. */
function toBody(r: IrdRecord) {
  const opt: Record<string, unknown> = {
    tenant_id: r.tenant_id, reference_no: r.reference_no, office_name: r.office_name, counterparty_name: r.counterparty_name,
    software_version: r.software_version, submitted_on: r.submitted_on, completed_on: r.completed_on, notes: r.notes, supersedes_id: r.supersedes_id,
  };
  return {
    record_id: r.id, annex_code: r.annex_code, status: r.status,
    ...Object.fromEntries(Object.entries(opt).filter(([, v]) => v !== null && v !== undefined)), version: r.version,
  };
}
const docBody = (d: IrdDocument) => ({
  document_id: d.id, record_id: d.record_id, original_filename: d.original_filename, content_type: d.content_type, size_bytes: d.size_bytes,
  sha256: d.sha256, scan_state: d.scan_state, created_at: new Date(d.created_at).toISOString(),
});

/** Authz first (P-8), then the ctx fields the operation relies on. */
function guard(ctx: IrdCtx, permission: string) {
  PlatformAuthz.assertPlatform(ctx, permission);
  if (typeof ctx.platformStaffId !== 'string' || !ctx.tx) throw new LimsError('auth.unauthenticated');
  const now = ctx.now ? ctx.now() : new Date();
  return { tx: ctx.tx, actorId: ctx.actor.id, now, today: new Date(now.getTime() + NPT_OFFSET_MS).toISOString().slice(0, 10) };
}

export function createIrdService(deps: { repo?: IrdRepo; newId?: () => string } = {}) {
  const repo = deps.repo ?? createIrdRepo();
  const newId = deps.newId ?? uuidv7;

  const platformEvent = (ctx: IrdCtx, e: Pick<PlatformEventArg, 'eventType' | 'targetType' | 'targetId' | 'targetTenantId' | 'detail'>) =>
    repo.insertPlatformEvent(ctx.tx, {
      ...e, actorPlatformStaffId: ctx.platformStaffId, actorId: ctx.actor.id,
      ...(typeof ctx.requestId === 'string' ? { requestId: ctx.requestId } : {}), ...(typeof ctx.clientIp === 'string' ? { clientIp: ctx.clientIp } : {}),
    });
  /** D-215: only platform-level Annex 1 rows; detail carries ids / statuses / column names only. */
  const annex1Changed = (ctx: IrdCtx, r: IrdRecord, detail: Record<string, unknown>) =>
    r.tenant_id === null && r.annex_code === 'annex_1'
      ? platformEvent(ctx, { eventType: 'annex_1_changed', targetType: 'ird_annex_record', targetId: r.id, targetTenantId: null, detail: { record_id: r.id, ...detail } })
      : Promise.resolve();
  const found = async (tx: unknown, id: string) => {
    const r = await repo.find(tx, id);
    if (!r) throw new LimsError('common.not_found');
    return r;
  };

  return {
    async listPlatformIrdAnnexes(ctx: IrdCtx, input: Record<string, unknown> = {}): Promise<Result> {
      const s = guard(ctx, READ);
      const i = isObj(input) ? input : {};
      const tenantId = i['tenantId'] === undefined ? null : uuidAt(i['tenantId'], '/tenant_id');
      if (i['annexCode'] !== undefined && !oneOf(i['annexCode'], CODES)) failAt('/annex_code');
      if (i['status'] !== undefined && !oneOf(i['status'], STATES)) failAt('/status');
      const rows = await repo.list(s.tx, {
        tenantId, ...(i['annexCode'] !== undefined ? { annexCode: i['annexCode'] as string } : {}), ...(i['status'] !== undefined ? { status: i['status'] as string } : {}),
      });
      return { status: 200, body: { data: rows.map(toBody) } };
    },

    /** Platform-level Annex 1 only (IR1); tenant / annex / status are never taken from the input. */
    async createPlatformIrdAnnex(ctx: IrdCtx, input: Record<string, unknown> = {}): Promise<Result> {
      const s = guard(ctx, MANAGE);
      const i = isObj(input) ? input : {};
      if (!strLen(i['softwareVersion'], 1, 40)) failAt('/software_version');
      if (i['notes'] !== undefined && !strLen(i['notes'], 0, 2000)) failAt('/notes');
      const row = await repo.insert(s.tx, {
        id: newId(), tenantId: null, annexCode: 'annex_1', status: 'not_started', softwareVersion: i['softwareVersion'] as string,
        ...(i['notes'] !== undefined ? { notes: i['notes'] as string } : {}), actorId: s.actorId,
      });
      await repo.insertEvent(s.tx, { recordId: row.id, tenantId: null, fromStatus: null, toStatus: 'not_started', actorId: s.actorId, occurredAt: s.now });
      await annex1Changed(ctx, row, { action: 'created', to_status: 'not_started' });
      return { status: 201, body: toBody(row), version: row.version };
    },

    async updateIrdAnnex(ctx: IrdCtx, input: Record<string, unknown> = {}): Promise<Result> {
      const s = guard(ctx, MANAGE);
      const i = isObj(input) ? input : {};
      const id = uuidAt(i['recordId'], '/record_id');
      const v = expected(i['expectedVersion']);
      const patch = isObj(i['patch']) ? i['patch'] : failAt('/');
      const set: Record<string, string> = {};
      for (const [k, val] of Object.entries(patch)) {
        if (k === 'unset') continue;
        if (!oneOf(k, EDITABLE)) failAt(`/${k}`);
        const [lo, hi] = LIMITS[k as (typeof EDITABLE)[number]];
        if (!strLen(val, lo, hi)) failAt(`/${k}`);
        set[k] = val as string;
      }
      const unset = patch['unset'] === undefined ? [] : patch['unset'];
      if (!Array.isArray(unset) || unset.length > 5) failAt('/unset');
      for (const u of unset as unknown[]) if (!oneOf(u, EDITABLE) || Object.hasOwn(set, u)) failAt('/unset');
      const row = await found(s.tx, id);
      if (row.status === 'completed' && (unset as string[]).includes('reference_no')) failAt('/unset');   // ird_annex_records__completed__ck -> 400, not 500
      const up = await repo.update(s.tx, id, v, set, unset as string[], s.actorId);
      if (!up) throw new LimsError('common.version_conflict');
      await annex1Changed(ctx, up, { action: 'updated', fields: [...Object.keys(set), ...(unset as string[])] });
      return { status: 200, body: toBody(up), version: up.version };
    },

    /** IR2-IR8. Edge check beats field checks (AC-E3.3). IR7 creates the successor in the same request tx and returns it [CONV]. */
    async transitionIrdAnnex(ctx: IrdCtx, input: Record<string, unknown> = {}): Promise<Result> {
      const s = guard(ctx, MANAGE);
      const i = isObj(input) ? input : {};
      const id = uuidAt(i['recordId'], '/record_id');
      const v = expected(i['expectedVersion']);
      const to = oneOf(i['toStatus'], STATES) ? (i['toStatus'] as AnnexStatus) : failAt('/to_status');
      const note = i['note'];
      const row = await found(s.tx, id);
      if (row.version !== v) throw new LimsError('common.version_conflict');
      if (!canTransition(row.status, to)) throw new LimsError('identity.annex_invalid_transition');
      if (note !== undefined && !strLen(note, 0, 1000)) failAt('/note');
      const f: TransitionFields = {};
      if (to === 'submitted') {                                                                         // IR3, 08 A13 P-1
        if (!isDate(i['submittedOn']) || i['submittedOn'] > s.today) failAt('/submitted_on');
        f.submittedOn = i['submittedOn'] as string;
      } else if (to === 'completed') {                                                                  // IR4
        if (!filled(i['referenceNo'], 100)) failAt('/reference_no');
        if (!isDate(i['completedOn']) || row.submitted_on === null || i['completedOn'] < row.submitted_on) failAt('/completed_on');
        f.completedOn = i['completedOn'] as string; f.referenceNo = i['referenceNo'] as string;
      } else if (to === 'rejected' && !filled(note, 1000)) failAt('/note');                              // IR5

      const up = await repo.transition(s.tx, id, v, to, f, s.actorId);
      if (!up) throw new LimsError('common.version_conflict');
      await repo.insertEvent(s.tx, {
        recordId: id, tenantId: row.tenant_id, fromStatus: row.status, toStatus: to, ...(typeof note === 'string' && note !== '' ? { note } : {}), actorId: s.actorId, occurredAt: s.now,
      });
      if (to !== 'superseded') {
        await annex1Changed(ctx, up, { action: 'transition', from_status: row.status, to_status: to });
        return { status: 200, body: toBody(up), version: up.version };
      }
      // IR7: old row is superseded FIRST (partial unique index on non-superseded rows), then the successor.
      const next = await repo.insert(s.tx, { id: newId(), tenantId: row.tenant_id, annexCode: row.annex_code, status: 'not_started', supersedesId: row.id, actorId: s.actorId });
      await repo.insertEvent(s.tx, { recordId: next.id, tenantId: next.tenant_id, fromStatus: null, toStatus: 'not_started', actorId: s.actorId, occurredAt: s.now });
      await annex1Changed(ctx, up, { action: 'transition', from_status: row.status, to_status: to, successor_id: next.id });
      return { status: 200, body: toBody(next), version: next.version };
    },

    /** 02-CV §10.2 accept(); key = {tenant_id|platform}/ird/{record_id}/{uuid}.{ext} from the RECORD (never the caller). P-19: scanner down -> pending, re-scan on download. */
    async uploadIrdAnnexDocument(ctx: IrdCtx, input: Record<string, unknown> = {}): Promise<Result> {
      const s = guard(ctx, MANAGE);
      const i = isObj(input) ? input : {};
      const recordId = uuidAt(i['recordId'], '/record_id');
      const file = i['file'];
      if (!isObj(file) || !strLen(file['filename'], 1, 200) || typeof file['mimeType'] !== 'string' || !(file['bytes'] instanceof Uint8Array)) failAt('/file');
      const filename = (file as Record<string, unknown>)['filename'] as string;
      const row = await found(s.tx, recordId);
      const id = newId();
      const ext = /\.png$/i.test(filename) ? 'png' : /\.jpe?g$/i.test(filename) ? 'jpg' : 'pdf';
      const objectPath = `${row.tenant_id ?? 'platform'}/ird/${row.id}/${id}.${ext}`;
      const acc = await ctx.uploads.accept(file, { allow: ['application/pdf', 'image/png', 'image/jpeg'], maxBytes: MAX_DOC_BYTES, bucket: BUCKET, objectPath, scan: 'required' });
      const scanState = acc.scanState === 'clean' ? 'clean' : 'pending';
      let d: IrdDocument;
      try {
        d = await repo.insertDocument(s.tx, {
          id, tenantId: row.tenant_id, recordId: row.id, bucket: BUCKET, objectPath, originalFilename: filename, contentType: acc.mime,
          sizeBytes: acc.byteSize, sha256: acc.sha256, scanState, actorId: s.actorId,
        });
        await annex1Changed(ctx, row, { action: 'document_uploaded', document_id: id });
      } catch (e) {
        await ctx.storage.delete(BUCKET, objectPath).catch(() => undefined);   // no orphan object when the row is refused
        throw e;
      }
      return { status: 201, body: docBody(d) };
    },

    /** P-2 bytes via ctx.storage.read + P-2 headers (no access_log); P-19 pending re-scanned here (fail closed); EVERY call -> platform_events ird_document_downloaded. */
    async downloadIrdAnnexDocument(ctx: IrdCtx, input: Record<string, unknown> = {}): Promise<Result> {
      const s = guard(ctx, READ);
      const i = isObj(input) ? input : {};
      const recordId = uuidAt(i['recordId'], '/record_id');
      const documentId = uuidAt(i['documentId'], '/document_id');
      const d = await repo.findDocument(s.tx, recordId, documentId);
      if (!d) throw new LimsError('common.not_found');
      const event = (outcome: 'allowed' | 'denied') => platformEvent(ctx, {
        eventType: 'ird_document_downloaded', targetType: 'ird_annex_document', targetId: d.id, targetTenantId: d.tenant_id, detail: { record_id: d.record_id, outcome },
      });
      let state: string = d.scan_state;
      if (state === 'pending') {
        const verdict = await ctx.storage.read(d.bucket, d.object_path).then((b) => ctx.files.scan(b)).catch(() => 'unavailable');
        if (verdict === 'clean' || verdict === 'infected') {
          state = verdict === 'clean' ? 'clean' : 'quarantined';
          await repo.setDocumentScanState(s.tx, d.id, state as 'clean' | 'quarantined');
        }
      }
      if (state !== 'clean') {
        await event('denied');
        ctx.commitOnError?.();                                        // keep the event + quarantined state across the 422
        throw new LimsError('common.upload_quarantined');
      }
      // [CONV] not ctx.download.stream: it always writes access_log (needs tenantId; 02-TRD §9 says platform_events only). Same P-2 headers.
      const body = await ctx.storage.read(d.bucket, d.object_path);
      await event('allowed');
      return {
        status: 200, body,
        headers: {
          'content-type': d.content_type, 'content-disposition': contentDisposition('attachment', d.original_filename),
          'x-content-type-options': 'nosniff', 'cache-control': 'no-store', 'content-length': String(body.length),
        },
      };
    },
  };
}
