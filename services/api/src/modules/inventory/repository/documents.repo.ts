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
export const getStockDocumentLine = (rc: RepoCtx, id: string) => getRow(rc, LINES, id);
export const listStockDocumentLines = (rc: RepoCtx, documentId: string) =>
  query(rc, 'SELECT * FROM inventory.stock_document_lines WHERE tenant_id = $1 AND document_id = $2 ORDER BY line_no, id', [documentId]);
