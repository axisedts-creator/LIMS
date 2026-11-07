// IRD annex tracker repository (02-TRD §5.10; 05-SCHEMA identity.ird_annex_records / _events / _documents, identity.platform_events).
// SQL on the platform request tx (platform claims; D-T20 policies). `tenantId: null` = platform-level (Annex 1) rows; there is no "all rows" query.
// Dates leave as text 'YYYY-MM-DD'; sha256 as lower-case hex.
// [CONV] relative import until @lims/shared-ts is a services/api dependency (same as role.service).
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';

export type AnnexStatus = 'not_started' | 'in_preparation' | 'submitted' | 'completed' | 'rejected' | 'superseded';
export type AnnexCode = 'annex_1' | 'annex_2' | 'annex_3' | 'annex_7';
export interface IrdRecord {
  id: string; tenant_id: string | null; annex_code: AnnexCode; status: AnnexStatus; reference_no: string | null; office_name: string | null;
  counterparty_name: string | null; software_version: string | null; submitted_on: string | null; completed_on: string | null; notes: string | null;
  supersedes_id: string | null; is_active: boolean; version: number;
}
export interface IrdDocument {
  id: string; tenant_id: string | null; record_id: string; bucket: string; object_path: string; original_filename: string; content_type: string;
  size_bytes: number; sha256: string; scan_state: 'pending' | 'clean' | 'quarantined'; created_at: Date | string;
}
export interface InsertRecord { id: string; tenantId: string | null; annexCode: AnnexCode; status: 'not_started'; softwareVersion?: string; notes?: string; supersedesId?: string; actorId: string }
export interface TransitionFields { submittedOn?: string; completedOn?: string; referenceNo?: string }
export interface EventArg { recordId: string; tenantId: string | null; fromStatus: AnnexStatus | null; toStatus: AnnexStatus; note?: string; actorId: string; occurredAt: Date }
export interface PlatformEventArg {
  eventType: 'annex_1_changed' | 'ird_document_downloaded' | 'dead_letter_viewed'; targetType: string; targetId: string; targetTenantId: string | null; detail: Record<string, unknown>;
  actorPlatformStaffId: string; actorId: string; requestId?: string; clientIp?: string;
}
export interface DocInsert {
  id: string; tenantId: string | null; recordId: string; bucket: string; objectPath: string; originalFilename: string; contentType: string; sizeBytes: number;
  sha256: string; scanState: 'pending' | 'clean'; actorId: string;
}
export interface ListFilter { tenantId: string | null; annexCode?: string; status?: string }

export interface IrdRepo {
  list(tx: unknown, f: ListFilter): Promise<IrdRecord[]>;
  find(tx: unknown, id: string): Promise<IrdRecord | undefined>;
  insert(tx: unknown, r: InsertRecord): Promise<IrdRecord>;
  /** Optimistic lock; undefined = version mismatch. Bumps version. */
  update(tx: unknown, id: string, expectedVersion: number, set: Record<string, string>, unset: string[], actorId: string): Promise<IrdRecord | undefined>;
  transition(tx: unknown, id: string, expectedVersion: number, to: AnnexStatus, f: TransitionFields, actorId: string): Promise<IrdRecord | undefined>;
  insertEvent(tx: unknown, e: EventArg): Promise<void>;
  insertPlatformEvent(tx: unknown, e: PlatformEventArg): Promise<void>;
  insertDocument(tx: unknown, d: DocInsert): Promise<IrdDocument>;
  findDocument(tx: unknown, recordId: string, documentId: string): Promise<IrdDocument | undefined>;
  setDocumentScanState(tx: unknown, documentId: string, state: 'clean' | 'quarantined'): Promise<void>;
}

/** The only columns updateIrdAnnex may touch (IrdAnnexUpdateRequest). Column names are interpolated ONLY from this list. */
export const EDITABLE = ['reference_no', 'office_name', 'counterparty_name', 'software_version', 'notes'] as const;
const LIST_MAX = 200;   // IrdAnnexPage maxItems
const COLS = `id, tenant_id, annex_code, status, reference_no, office_name, counterparty_name, software_version,
  submitted_on::text AS submitted_on, completed_on::text AS completed_on, notes, supersedes_id, is_active, version`;
const DOC_COLS = `id, tenant_id, record_id, bucket, object_path, original_filename, content_type, size_bytes, encode(sha256, 'hex') AS sha256, scan_state, created_at`;

type Tx = { query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> };
const q = async (tx: unknown, sql: string, params: unknown[]) => (await (tx as Tx).query(sql, params)).rows;

export function createIrdRepo(): IrdRepo {
  return {
    // ponytail: hard cap 200 newest rows, no cursor; add paging if one tenant ever exceeds it (contract has none).
    list: (tx, f) => q(tx, `SELECT ${COLS} FROM identity.ird_annex_records
      WHERE tenant_id IS NOT DISTINCT FROM $1::uuid AND ($2::text IS NULL OR annex_code = $2) AND ($3::text IS NULL OR status = $3) AND is_active
      ORDER BY created_at DESC, id DESC LIMIT ${LIST_MAX}`, [f.tenantId, f.annexCode ?? null, f.status ?? null]),
    async find(tx, id) { return (await q(tx, `SELECT ${COLS} FROM identity.ird_annex_records WHERE id = $1`, [id]))[0]; },
    async insert(tx, r) {
      return (await q(tx, `INSERT INTO identity.ird_annex_records (id, tenant_id, annex_code, status, software_version, notes, supersedes_id, created_by, updated_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8) RETURNING ${COLS}`,
      [r.id, r.tenantId, r.annexCode, r.status, r.softwareVersion ?? null, r.notes ?? null, r.supersedesId ?? null, r.actorId]))[0];
    },
    async update(tx, id, v, set, unset, actorId) {
      const params: unknown[] = [id, v, actorId];
      const parts: string[] = [];
      for (const c of EDITABLE) {
        if (Object.hasOwn(set, c)) { params.push(set[c]); parts.push(`${c} = $${params.length}`); }
        else if (unset.includes(c)) parts.push(`${c} = NULL`);
      }
      return (await q(tx, `UPDATE identity.ird_annex_records SET ${[...parts, 'version = version + 1', 'updated_at = now()', 'updated_by = $3'].join(', ')}
        WHERE id = $1 AND version = $2 RETURNING ${COLS}`, params))[0];
    },
    async transition(tx, id, v, to, f, actorId) {
      return (await q(tx, `UPDATE identity.ird_annex_records SET status = $3, submitted_on = COALESCE($4::date, submitted_on),
          completed_on = COALESCE($5::date, completed_on), reference_no = COALESCE($6, reference_no),
          version = version + 1, updated_at = now(), updated_by = $7
        WHERE id = $1 AND version = $2 RETURNING ${COLS}`,
      [id, v, to, f.submittedOn ?? null, f.completedOn ?? null, f.referenceNo ?? null, actorId]))[0];
    },
    async insertEvent(tx, e) {
      await q(tx, `INSERT INTO identity.ird_annex_events (id, tenant_id, record_id, from_status, to_status, note, actor_id, occurred_at, created_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $7)`, [uuidv7(), e.tenantId, e.recordId, e.fromStatus, e.toStatus, e.note ?? null, e.actorId, e.occurredAt]);
    },
    async insertPlatformEvent(tx, e) {
      await q(tx, `INSERT INTO identity.platform_events (id, event_type, target_type, target_id, target_tenant_id, detail, actor_platform_staff_id, request_id, client_ip, created_by)
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9::inet, $10)`,
      [uuidv7(), e.eventType, e.targetType, e.targetId, e.targetTenantId, JSON.stringify(e.detail), e.actorPlatformStaffId, e.requestId ?? null, e.clientIp ?? null, e.actorId]);
    },
    async insertDocument(tx, d) {
      return (await q(tx, `INSERT INTO identity.ird_annex_documents (id, tenant_id, record_id, bucket, object_path, original_filename, content_type, size_bytes, sha256, scan_state, created_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, decode($9, 'hex'), $10, $11) RETURNING ${DOC_COLS}`,
      [d.id, d.tenantId, d.recordId, d.bucket, d.objectPath, d.originalFilename, d.contentType, d.sizeBytes, d.sha256, d.scanState, d.actorId]))[0];
    },
    async findDocument(tx, recordId, documentId) {
      return (await q(tx, `SELECT ${DOC_COLS} FROM identity.ird_annex_documents WHERE id = $1 AND record_id = $2`, [documentId, recordId]))[0];
    },
    async setDocumentScanState(tx, id, state) {
      await q(tx, `UPDATE identity.ird_annex_documents SET scan_state = $2 WHERE id = $1`, [id, state]);
    },
  };
}
