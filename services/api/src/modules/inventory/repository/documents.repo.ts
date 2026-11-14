// inventory.stock_documents / stock_document_lines (05 §2.19, class A: append-only). NO update / remove export (05 §4.4).
import { type Row, type RepoCtx, Q, getRow, insertRow, limitOf, query, table } from './_base.js';

const DOCS = table('stock_documents', 'A', ['doc_no', 'doc_kind', 'store_id', 'occurred_at', 'issued_to_kind', 'department_id', 'instrument_id', 'supplier_id', 'grn_id',
  'reason_code', 'reason_text', 'container_id']);
const LINES = table('stock_document_lines', 'A', ['document_id', 'line_no', 'item_id', 'lot_id', 'direction', 'qty_base', 'value_paisa', 'reason_code']);

export const insertStockDocument = (rc: RepoCtx, row: Row) => insertRow(rc, DOCS, row);
export const getStockDocument = (rc: RepoCtx, id: string) => getRow(rc, DOCS, id);
export function listStockDocuments(rc: RepoCtx, f: { storeId: string; docKind?: string; limit?: number }): Promise<Row[]> {
  const q = new Q();
  const store = q.p(f.storeId);
  const kind = f.docKind !== undefined ? ` AND doc_kind = ${q.p(f.docKind)}` : '';
  return query(rc, `SELECT * FROM inventory.stock_documents WHERE tenant_id = $1 AND store_id = ${store}${kind} ORDER BY occurred_at DESC, id LIMIT ${q.p(limitOf(f.limit))}`, q.vals);
}

export const insertStockDocumentLine = (rc: RepoCtx, row: Row) => insertRow(rc, LINES, row);
/** T-26 perf: all lines of one document in ONE statement (200-line post <= 1.5 s). Same columns / audit as insertStockDocumentLine. */
export async function insertStockDocumentLines(rc: RepoCtx, rows: readonly Row[]): Promise<void> {
  if (rows.length === 0) return;
  const col = (k: string) => rows.map((r) => r[k] ?? null);
  await query(rc, `INSERT INTO inventory.stock_document_lines (tenant_id, created_by, id, document_id, line_no, item_id, lot_id, direction, qty_base, value_paisa, reason_code)
    SELECT $1, $2::uuid, * FROM unnest($3::uuid[], $4::uuid[], $5::int[], $6::uuid[], $7::uuid[], $8::text[], $9::numeric[], $10::bigint[], $11::text[])`,
  [rc.actorId, col('id'), col('document_id'), col('line_no'), col('item_id'), col('lot_id'), col('direction'), col('qty_base'), col('value_paisa'), col('reason_code')]);
}
export const getStockDocumentLine =(rc: RepoCtx, id: string) => getRow(rc, LINES, id);
export const listStockDocumentLines = (rc: RepoCtx, documentId: string) =>
  query(rc, 'SELECT * FROM inventory.stock_document_lines WHERE tenant_id = $1 AND document_id = $2 ORDER BY line_no, id', [documentId]);
