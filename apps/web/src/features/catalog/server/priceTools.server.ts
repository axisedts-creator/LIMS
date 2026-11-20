import 'server-only';
// T0D-PRICETOOLS-1 (LD-321, T0C/T0B-PRICETOOLS-1): typed calls of the seven price list tool operations of contracts/openapi/catalog.yaml.
// The SERVER parses the workbook (no spreadsheet library in the browser bundle); the BFF re-checks id shapes, file name and size, and forwards only the
// contract fields (no mass assignment). Every write lands in a DRAFT version; publishing stays publishPriceListVersion. Writes carry an Idempotency-Key.
import { randomUUID } from 'node:crypto';
import { serverFetch } from '@/core/api/server-fetch';
import { proxyDownload } from './proxyDownload';
import { bad, int, list, oneOf, str, uuid } from './shared';
import { IDEMPOTENCY_KEY_RE, MAX_PRICE_PAISA, type Page, type PriceListVersion } from './types';

export type PriceImportStatus = 'dry_run' | 'committed' | 'failed' | 'cancelled';
export interface PriceImportSummary { rows: number; added?: number; changed?: number; unchanged?: number; errors: number }
export interface PriceImportBatch {
  id: string; price_list_id: string; status: PriceImportStatus; row_count: number; error_count: number; file_sha256: string;
  summary: PriceImportSummary; result_price_list_version_id?: string; created_at: string; created_by: string;
}
export interface PriceImportRowError { row_no: number; column: string; code: string; message: string }
export interface PriceImportDryRun { batch: PriceImportBatch; errors: PriceImportRowError[] }
export interface PriceBulkResult { price_list_version_id: string; changed_count: number; unchanged_count: number }
export interface PriceComparisonRow {
  orderable_id: string; test_code: string; test_name: string;
  price_a_paisa?: number; price_b_paisa?: number; difference_paisa?: number; percent_bp?: number;
}

export const MAX_BYTES = 5 * 1024 * 1024; // dryRunPriceListImport: at most 5 MB
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const FILE_NAME_RE = /^[^\\/"\u0000-\u001f\u007f;]{1,195}\.xlsx$/i; // ends up inside a Content-Disposition header; .xlsx only (never xls / xlsm)
const CURSOR_RE = /^[A-Za-z0-9_\-=.~]{1,512}$/;
const ROUNDINGS = ['none', 'nearest_rupee', 'nearest_5', 'nearest_10'] as const;
const BP = int(-10_000, 100_000); // -100 % .. +1000 % in basis points
const C = '/v1/catalog';

const key = (k: string) => {
  if (typeof k !== 'string' || !IDEMPOTENCY_KEY_RE.test(k)) throw bad();
  return k;
};
const json = (body: unknown, idempotencyKey: string) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', 'idempotency-key': key(idempotencyKey) },
  body: JSON.stringify(body),
});
const obj = (v: unknown): Record<string, unknown> => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw bad();
  return v as Record<string, unknown>;
};

/** downloadPriceListTemplate through the BFF download proxy (the bearer stays here); bytes go back base64 (no new route). */
export async function downloadPriceListTemplate(priceListId?: string): Promise<{ ok: true; base64: string } | { ok: false; status: number }> {
  const q = priceListId === undefined ? '' : `?price_list_id=${uuid(priceListId) as string}`;
  const res = await proxyDownload(`${C}/price-list-import-template${q}`);
  if (!res.ok) return { ok: false, status: res.status };
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) return { ok: false, status: 502 };
  return { ok: true, base64: buf.toString('base64') };
}

/** dryRunPriceListImport: writes no price. The multipart body is built by hand and holds ONLY the file part. */
export async function dryRunPriceListImport(priceListId: string, form: FormData, idempotencyKey: string): Promise<PriceImportDryRun> {
  uuid(priceListId);
  key(idempotencyKey);
  if (!(form instanceof FormData)) throw bad();
  const file = form.get('file');
  if (typeof file === 'string' || file === null) throw bad();
  if (file.size < 1 || file.size > MAX_BYTES || !FILE_NAME_RE.test(file.name)) throw bad();
  const boundary = `----lims-${randomUUID()}`;
  const head = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${XLSX}\r\n\r\n`;
  const body = Buffer.concat([Buffer.from(head, 'utf8'), Buffer.from(await file.arrayBuffer()), Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')]);
  return serverFetch<PriceImportDryRun>(`${C}/price-lists/${priceListId}/import-dry-run`, {
    method: 'POST',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'idempotency-key': idempotencyKey },
    body,
  });
}

export const listPriceListImportBatches = (priceListId: string, limit = 50) =>
  serverFetch<Page<PriceImportBatch>>(`${C}/price-list-import-batches?price_list_id=${uuid(priceListId) as string}&limit=${int(1, 200)(limit) as number}`);

/** commitPriceListImport: a dry_run batch becomes a new DRAFT version (never published here). Body is exactly {change_reason}. */
export async function commitPriceListImport(batchId: string, changeReason: string, idempotencyKey: string): Promise<PriceListVersion> {
  uuid(batchId);
  const change_reason = (str(1, 500)(changeReason) as string).trim();
  return serverFetch<PriceListVersion>(`${C}/price-list-import-batches/${batchId}/commit`, json({ change_reason }, idempotencyKey));
}

/** bulkUpdatePriceListDraft: percent (basis points) or fixed amount (signed paisa), rounding, scope with its one id field. */
export async function bulkUpdatePriceListDraft(versionId: string, input: unknown, idempotencyKey: string): Promise<PriceBulkResult> {
  uuid(versionId);
  const i = obj(input);
  const kind = oneOf('percent', 'fixed_amount')(i['change_kind']);
  const scope = oneOf('all', 'department', 'listed_tests')(i['scope']);
  const body: Record<string, unknown> = { change_kind: kind };
  if (kind === 'percent') body['percent_bp'] = BP(i['percent_bp']);
  else body['amount_paisa'] = int(-MAX_PRICE_PAISA, MAX_PRICE_PAISA)(i['amount_paisa']);
  body['rounding'] = oneOf(...ROUNDINGS)(i['rounding'] ?? 'none');
  body['scope'] = scope;
  if (scope === 'department') body['department_id'] = uuid(i['department_id']);
  if (scope === 'listed_tests') {
    const ids = list(5000, uuid)(i['orderable_ids']) as string[];
    if (ids.length < 1) throw bad();
    body['orderable_ids'] = ids;
  }
  return serverFetch<PriceBulkResult>(`${C}/price-list-versions/${versionId}/bulk-update`, json(body, idempotencyKey));
}

/** copyPriceList: the source version goes into a new DRAFT of the TARGET list in the path; rounding only travels with a percent. */
export async function copyPriceList(targetPriceListId: string, input: unknown, idempotencyKey: string): Promise<PriceListVersion> {
  uuid(targetPriceListId);
  const i = obj(input);
  const body: Record<string, unknown> = { source_price_list_version_id: uuid(i['source_price_list_version_id']), mode: oneOf('replace', 'merge')(i['mode']) };
  if (i['percent_bp'] !== undefined) {
    body['percent_bp'] = BP(i['percent_bp']);
    body['rounding'] = oneOf(...ROUNDINGS)(i['rounding'] ?? 'none');
  }
  return serverFetch<PriceListVersion>(`${C}/price-lists/${targetPriceListId}/copy`, json(body, idempotencyKey));
}

/** comparePriceLists: read only, one page (cursor) at a time. */
export function comparePriceLists(versionA: string, versionB: string, cursor?: string, limit = 200) {
  const q = new URLSearchParams({ version_a_id: uuid(versionA) as string, version_b_id: uuid(versionB) as string, limit: String(int(1, 200)(limit)) });
  if (cursor !== undefined) {
    if (typeof cursor !== 'string' || !CURSOR_RE.test(cursor)) throw bad();
    q.set('cursor', cursor);
  }
  return serverFetch<Page<PriceComparisonRow>>(`${C}/price-list-comparisons?${q.toString()}`);
}
