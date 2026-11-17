// reporting.input_files (kind outsourced_pdf) + the readiness writes of O3/O4 (02-TRD §6.4, §9; 05-SCHEMA input_files, report_order_items, reports).
// Shared by the API service (O1-O6) and the worker task reporting.process_input_file. REQ-SEC-024: explicit tenant_id on every statement.
// Static SQL only; every value is a parameter. State moves are guarded in SQL (version or expected state) so concurrent writers lose cleanly.
import type { Tx } from './settings.repo.js';

export type { Tx };
// Rows are full input_files rows (`*`); the service maps them to the OpenAPI InputFile, so internal columns never reach a response.

/** report_order_items rows of one order item (one per report). Status / requires_outsourced are checked by the caller. */
export async function findOrderItems(tx: Tx, tenantId: string, orderItemId: string): Promise<any[]> {
  const { rows } = await tx.query(`SELECT report_id, order_id, order_item_id, centre_id, item_status, requires_outsourced
    FROM reporting.report_order_items WHERE tenant_id = $1 AND order_item_id = $2`, [tenantId, orderItemId]);
  return rows;
}

export async function insertFile(tx: Tx, r: {
  id: string; tenantId: string; centreId: string; orderId: string; orderItemId: string; originalFilename: string; declaredMime: string;
  sizeBytes: number; sha256: string; quarantinePath: string; externalLabName: string; actorId: string;
}): Promise<any> {
  const { rows } = await tx.query(`INSERT INTO reporting.input_files (id, tenant_id, centre_id, order_id, order_item_id, kind, state,
      original_filename, declared_mime, size_bytes, sha256_original, quarantine_object_path, external_lab_name, created_by, updated_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $14) RETURNING *`,
  [r.id, r.tenantId, r.centreId, r.orderId, r.orderItemId, 'outsourced_pdf', 'pending_scan', r.originalFilename, r.declaredMime,
    r.sizeBytes, r.sha256, r.quarantinePath, r.externalLabName, r.actorId]);
  return rows[0];
}

export async function findFile(tx: Tx, tenantId: string, id: string): Promise<any | undefined> {
  const { rows } = await tx.query(`SELECT * FROM reporting.input_files WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  return rows[0];
}

export async function listFiles(tx: Tx, tenantId: string, orderItemId: string, limit: number): Promise<any[]> {
  const { rows } = await tx.query(`SELECT * FROM reporting.input_files
    WHERE tenant_id = $1 AND order_item_id = $2 AND kind = $3 ORDER BY created_at DESC, id DESC LIMIT $4`,
  [tenantId, orderItemId, 'outsourced_pdf', limit]);
  return rows.slice(0, limit);
}

/** Serialises concurrent confirm/withdraw on one item so the confirmed-count below is not stale under READ COMMITTED. */
export async function lockOrderItem(tx: Tx, tenantId: string, orderItemId: string): Promise<void> {
  await tx.query(`SELECT 1 FROM reporting.report_order_items WHERE tenant_id = $1 AND order_item_id = $2 FOR UPDATE`,
    [tenantId, orderItemId]);
}

export async function confirmedFileIds(tx: Tx, tenantId: string, orderItemId: string): Promise<string[]> {
  const { rows } = await tx.query(`SELECT id FROM reporting.input_files WHERE tenant_id = $1 AND order_item_id = $2 AND state = $3`,
    [tenantId, orderItemId, 'confirmed']);
  return rows.map((r) => r.id);
}

/** O4 guard: the file is attached to a released/superseded report version (snapshot is immutable; 02-TRD O4, content_snapshot.outsourcedAttachments). */
export async function inReleasedVersion(tx: Tx, tenantId: string, inputFileId: string): Promise<boolean> {
  const { rows } = await tx.query(`SELECT 1 FROM reporting.report_versions WHERE tenant_id = $1 AND status IN ('released', 'superseded')
      AND content_snapshot->'outsourcedAttachments' @> jsonb_build_array(jsonb_build_object('inputFileId', $2::text)) LIMIT 1`,
  [tenantId, inputFileId]);
  return rows.length > 0;
}

/** O3: ready -> confirmed, only at the expected version. undefined = lost the race / stale. */
export async function confirmFile(tx: Tx, tenantId: string, id: string, expectedVersion: number, actorId: string, at: string): Promise<any | undefined> {
  const { rows } = await tx.query(`UPDATE reporting.input_files SET state = $5, confirmed_by = $6, confirmed_at = $7::timestamptz,
      version = version + 1, updated_by = $6, updated_at = now()
    WHERE tenant_id = $1 AND id = $2 AND version = $3 AND state = $4 RETURNING *`,
  [tenantId, id, expectedVersion, 'ready', 'confirmed', actorId, at]);
  return rows[0];
}

/** O4: (ready | confirmed) -> withdrawn, only at the expected version and from the state the caller saw. */
export async function withdrawFile(tx: Tx, tenantId: string, id: string, expectedVersion: number, fromState: string,
  reasonCode: string, reasonText: string | null, actorId: string): Promise<any | undefined> {
  const { rows } = await tx.query(`UPDATE reporting.input_files SET state = $5, withdrawn_reason_code = $6, withdrawn_reason_text = $7,
      version = version + 1, updated_by = $8, updated_at = now()
    WHERE tenant_id = $1 AND id = $2 AND version = $3 AND state = $4 RETURNING *`,
  [tenantId, id, expectedVersion, fromState, 'withdrawn', reasonCode, reasonText, actorId]);
  return rows[0];
}

/** Worker: state move guarded by the state it read (idempotent re-runs, no lost update). */
export async function moveState(tx: Tx, tenantId: string, id: string, from: string, to: string, actorId: string): Promise<any | undefined> {
  const { rows } = await tx.query(`UPDATE reporting.input_files SET state = $4, version = version + 1, updated_by = $5, updated_at = now()
    WHERE tenant_id = $1 AND id = $2 AND state = $3 RETURNING *`, [tenantId, id, from, to, actorId]);
  return rows[0];
}

/** Worker: terminal failure (quarantined | rejected) with the error code; no sanitised fields. */
export async function failFile(tx: Tx, tenantId: string, id: string, from: string, to: string, errorCode: string, actorId: string): Promise<any | undefined> {
  const { rows } = await tx.query(`UPDATE reporting.input_files SET state = $4, last_error_code = $5, version = version + 1, updated_by = $6, updated_at = now()
    WHERE tenant_id = $1 AND id = $2 AND state = $3 RETURNING *`, [tenantId, id, from, to, errorCode, actorId]);
  return rows[0];
}

/** Worker: sanitizing -> ready with the sanitised object facts. */
export async function markReady(tx: Tx, tenantId: string, id: string, r: { path: string; sha256: string; pageCount: number; mime: string; actorId: string }): Promise<any | undefined> {
  const { rows } = await tx.query(`UPDATE reporting.input_files SET state = $4, sanitized_object_path = $5, sanitized_sha256 = $6, page_count = $7,
      detected_mime = $8, last_error_code = $9, version = version + 1, updated_by = $10, updated_at = now()
    WHERE tenant_id = $1 AND id = $2 AND state = $3 RETURNING *`,
  [tenantId, id, 'sanitizing', 'ready', r.path, r.sha256, r.pageCount, r.mime, null, r.actorId]);
  return rows[0];
}

/** Sets outsourced_ready on the item's active rows; returns the affected report ids. */
export async function setOutsourcedReady(tx: Tx, tenantId: string, orderItemId: string, ready: boolean, actorId: string): Promise<string[]> {
  const { rows } = await tx.query(`UPDATE reporting.report_order_items SET outsourced_ready = $3, version = version + 1, updated_by = $4, updated_at = now()
    WHERE tenant_id = $1 AND order_item_id = $2 AND item_status = $5 RETURNING report_id`, [tenantId, orderItemId, ready, actorId, 'active']);
  return [...new Set(rows.map((r) => r.report_id as string))];
}

export async function markNeedsAssembly(tx: Tx, tenantId: string, reportId: string, actorId: string): Promise<void> {
  await tx.query(`UPDATE reporting.reports SET needs_assembly = true, needs_assembly_since = COALESCE(needs_assembly_since, now()),
      updated_by = $3, updated_at = now() WHERE tenant_id = $1 AND id = $2`, [tenantId, reportId, actorId]);
}

/** app.enqueue_job (05-SCHEMA §10): checks registry + tenant claim. */
export async function enqueue(tx: Tx, identifier: string, payload: Record<string, unknown>, jobKey: string): Promise<void> {
  await tx.query('SELECT app.enqueue_job($1, $2::jsonb, $3)', [identifier, JSON.stringify(payload), jobKey]);
}

/** O6 (02-TRD §6.4): outsourced items with their latest non-withdrawn file, keyset by (registered_at, order_item_id) DESC. */
export async function listOutsourcedItems(tx: Tx, tenantId: string, f: {
  centreId: string | null; state: string | null; afterAt: string | null; afterId: string | null; limit: number;
}): Promise<any[]> {
  const { rows } = await tx.query(`SELECT ri.order_item_id, ri.report_id, r.registration_no, r.registered_at, lf.state AS latest_file_state
    FROM reporting.report_order_items ri
    JOIN reporting.reports r ON r.tenant_id = ri.tenant_id AND r.id = ri.report_id
    LEFT JOIN LATERAL (SELECT x.state FROM reporting.input_files x
        WHERE x.tenant_id = ri.tenant_id AND x.order_item_id = ri.order_item_id AND x.kind = 'outsourced_pdf' AND x.state <> 'withdrawn'
        ORDER BY x.created_at DESC, x.id DESC LIMIT 1) lf ON true
    WHERE ri.tenant_id = $1 AND ri.requires_outsourced AND ri.item_status = 'active'
      AND ($2::uuid IS NULL OR ri.centre_id = $2::uuid)
      AND ($3::text IS NULL OR (CASE WHEN lf.state = 'confirmed' THEN 'confirmed' WHEN lf.state = 'ready' THEN 'awaiting_confirmation'
                                     ELSE 'awaiting_file' END) = $3::text)
      AND ($4::timestamptz IS NULL OR (r.registered_at, ri.order_item_id) < ($4::timestamptz, $5::uuid))
    ORDER BY r.registered_at DESC, ri.order_item_id DESC LIMIT $6`,
  [tenantId, f.centreId, f.state, f.afterAt, f.afterId, f.limit]);
  return rows;
}
