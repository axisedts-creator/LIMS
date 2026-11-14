// C12.T-12 test helpers (not a test file). Synthetic data only. Operations #49-#55: listGoodsReceipts, createGoodsReceipt, getGoodsReceipt, replaceGoodsReceiptDraft, postGoodsReceipt,
// cancelGoodsReceipt, exportGoodsReceiptsCsv. Spec: 02-TRD §4.2 / §5.4 / §5.10 / §5.11, 03-APP-FLOW §3.2 / §4.2, 01-PRD AC-06.1-06.9, 07-SECURITY P-B8 / PE-1 / PE-3 / IT-1a, contracts/openapi/inventory.yaml.
// SEAMS pinned here (the spec leaves them open; the writer may dispute through the reviewer). Same call convention, gate order and ctx stub as T-09 / T-10 / T-11 (lots / documents / purchasing helpers):
//   * `handlers[operationId](req, ctx)`; success => { status, body[, headers] }; failure => the handler THROWS a LimsError. Header keys lower-case; If-Match = `"<version>"`. Query values arrive already typed.
//   * GATE ORDER. #49 without store_id and #55: `IdentityPort.assertRole(ctx, { permission })` with NO branchId FIRST (before any tx statement and before query validation). #55 asserts BOTH
//     `inventory.report.export` (privileged, aal2) and `inventory.cost.read` (always) that way. #49 with store_id and #50: request validation (400) with the tx untouched, then the store is read
//     (unknown / branch not visible => 404) and assertRole({ permission, branchId }) => 403 (P-B8: 404 beats 403). #51-#54: path / header / body validation first (tx untouched), then the GRN is read
//     (unknown / branch not visible => 404), then assertRole({ permission, branchId: grn store's branch }) => 403 / 403 auth.mfa_required, then the state check, then If-Match (409 common.version_conflict),
//     then the body / row rules. kind = opening_balance additionally asserts `inventory.stock.adjust` (privileged: aal1 => 403 auth.mfa_required, PE-1) on #50 and #53, for the branch of the store.
//   * WIRE. Grn = header + lines (non-removed only) [+ movements on #53]; GrnSummary on lists. No tenant / audit columns ever. An exempt line carries `is_exempt: true` and NO `tax_code` key (D-70); `tax_rate_bp`
//     is on the line. `invoice_total_mismatch_paisa` appears only when supplier_invoice_total_paisa differs from the computed total. Money (every `_paisa` / `_paisa_x1e6` property and `value_basis`) is on
//     the wire only when getActor().permissions includes `inventory.cost.read` (02-TRD §6.3, PE-3).
//   * TAX. `ctx.ports.CatalogPort.getTaxRate(ctx, { taxCode, on })` as T-11 (fake in makePoCtx): called for non-exempt lines at create / replace, `on` = tenant business date of ctx.now(), never for an exempt
//     line; a LimsError thrown by the port propagates as the SAME object (P-23) and nothing is written. Posting never calls it again (the rate is a snapshot).
//   * ACCESS LOG. `ctx.audit.access(entry)` is a spy here (also run through the REAL core validator in services/api/src/core/audit/access.ts against a recording tx, so an invalid entry fails the test).
//   * CSV (#55). Result { status: 200, body: string | Buffer, headers } with content-type text/csv, content-disposition attachment (a plain .csv file name), cache-control no-store, x-content-type-options nosniff;
//     the body is UTF-8 with a BOM, RFC 4180 (CRLF), one row per POSTED GRN line whose posted_at is in [posted_at_from, posted_at_to) (inclusive from, exclusive to, CV §4.4). The header row contains at least
//     CSV_COLUMNS (the yaml example shows store_code,item_code,qty_base; the others are the Grn / line wire names).
import { LimsError } from '../../../../core/errors.js';
import { access as coreAccess } from '../../../../core/audit/access.js';
import { A, B, BR1, BR2, BR_B, LEAK, SYS, call, deadTx, expectLims, ifm, onlyKeys, rej, uid, type Req, type Tx } from './masters.helpers.js';
import { ADJUST, BENCH, COST, MOVEMENT_KEYS, addDays, costKeys, qty, ymdIn, type LotOpts } from './lots.helpers.js';
import { PO_APPROVE, PO_MANAGE, READ, hdr, idem, makePoCtx, type PoOpts, type PoStub } from './purchasing.helpers.js';

export { A, B, BR1, BR2, BR_B, LEAK, SYS, call, deadTx, expectLims, ifm, onlyKeys, rej, uid, ADJUST, BENCH, COST, MOVEMENT_KEYS, addDays, costKeys, qty, ymdIn, PO_APPROVE, PO_MANAGE, READ, hdr, idem };
export type { Req, Tx, LotOpts, PoOpts };
export const MANAGE = 'inventory.stock.manage';
export const EXPORT = 'inventory.report.export';

/** operationId -> permission the handler must assert (02-TRD §5.4). */
export const PERMISSION: Record<string, string> = {
  listGoodsReceipts: READ, createGoodsReceipt: MANAGE, getGoodsReceipt: READ, replaceGoodsReceiptDraft: MANAGE, postGoodsReceipt: MANAGE, cancelGoodsReceipt: MANAGE, exportGoodsReceiptsCsv: EXPORT,
};

export interface GrnStub extends PoStub { audit: any[] }

/** ctx for a store keeper who also purchases, may adjust and export, and sees cost: item.read, stock.manage, stock.adjust, cost.read, report.export, po.manage, po.approve; aal2; Asia/Kathmandu; fake getTaxRate. */
export function makeGrnCtx(tx: Tx, tenantId: string, o: PoOpts = {}): GrnStub {
  const st = makePoCtx(tx, tenantId, { permissions: [READ, MANAGE, ADJUST, COST, EXPORT, PO_MANAGE, PO_APPROVE], ...o });
  const port = st.ctx.ports.IdentityPort;
  const base = port.assertRole.bind(port);
  port.assertRole = async (c: unknown, req: { permission: string; branchId?: string }) => {
    await base(c, req); // records the request, rejects a missing permission with auth.forbidden, aal1 + stock.adjust / po.approve => auth.mfa_required
    if (req.permission === EXPORT && (o.aal ?? 'aal2') === 'aal1') throw new LimsError('auth.mfa_required'); // privileged (PE-1)
  };
  const audit: any[] = [];
  const recorder: Tx = { async query() { return { rows: [] }; } };
  st.ctx.audit = {
    async access(e: unknown) {
      audit.push(e);
      await coreAccess({ tenantId, requestId: 'r-t12', actor: st.ctx.actor, tx: recorder }, e as never); // throws common.internal for an entry the real core would refuse
    },
  };
  return { ...st, audit };
}

// ------------------------------------------------------------------ contract shapes (inventory.yaml components Grn / GrnSummary; 02-TRD §6.2; no tenant / audit columns ever)
export const GRN_KEYS = ['id', 'grn_no', 'kind', 'store_id', 'supplier_id', 'po_id', 'status', 'received_at', 'supplier_invoice_no', 'supplier_invoice_on', 'supplier_invoice_total_paisa', 'invoice_total_mismatch_paisa',
  'subtotal_paisa', 'discount_paisa', 'net_paisa', 'vat_paisa', 'total_paisa', 'posted_at', 'cancelled_at', 'cancel_reason_text', 'notes', 'version', 'lines', 'movements'];
export const GRN_SUMMARY_KEYS = ['id', 'grn_no', 'kind', 'store_id', 'supplier_id', 'po_id', 'status', 'received_at', 'posted_at', 'total_paisa', 'version'];
export const GRN_LINE_KEYS = ['id', 'line_no', 'item_id', 'pack_id', 'qty_packs', 'qty_base', 'unit_price_paisa', 'discount_paisa', 'tax_code', 'is_exempt', 'tax_rate_bp', 'net_paisa', 'vat_paisa', 'line_total_paisa',
  'po_line_id', 'lot_no', 'expiry_on', 'manufactured_on', 'lot_id', 'capitalised_value_paisa'];
export const GRN_NO = /^GR\d{2}\d{6}$/; // grn_no_pattern default 'GR{yy}{seq:6}' (05-SCHEMA settings)
export const CSV_COLUMNS = ['grn_no', 'store_code', 'item_code', 'lot_no', 'qty_base', 'net_paisa', 'vat_paisa', 'capitalised_value_paisa'];

// ------------------------------------------------------------------ request builders
export const gLine = (item: string, pack: string, qtyPacks: string, over: Record<string, unknown> = {}) => ({ item_id: item, pack_id: pack, qty_packs: qtyPacks, ...over });
export const newGrn = (store: string, lines: Record<string, unknown>[], over: Record<string, unknown> = {}) => ({ kind: 'purchase', store_id: store, lines, ...over });
export const openingGrn = (store: string, lines: Record<string, unknown>[], over: Record<string, unknown> = {}) => ({ kind: 'opening_balance', store_id: store, lines, ...over });
export const replaceBody = (lines: Record<string, unknown>[], over: Record<string, unknown> = {}) => ({ lines, ...over });
export const cancelGrnBody = (over: Record<string, unknown> = {}) => ({ reason_text: 'synthetic cancel', ...over });
export const window = (over: Record<string, unknown> = {}) => ({ posted_at_from: '2026-03-01T00:00:00.000Z', posted_at_to: '2026-04-01T00:00:00.000Z', ...over });

// ------------------------------------------------------------------ response helpers
/** Every key at every depth. */
export function deepKeys(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x) => deepKeys(x, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.push(k); deepKeys(x, out); }
  return out;
}
export const COST_FIELD = /_paisa(_x1e6)?$|^value_basis$/;

/** Case-insensitive header lookup on a handler result. */
export const headerOf = (r: { headers?: Record<string, string> }, name: string): string | undefined =>
  Object.entries(r.headers ?? {}).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
export const bodyText = (b: unknown): string => (typeof b === 'string' ? b : Buffer.from(b as Uint8Array).toString('utf8'));

/** RFC 4180 reader (quoted cells, doubled quotes, CR LF / LF row ends); strips one leading BOM. Rows are arrays of cells. */
export function parseCsv(text: string): string[][] {
  const s = text.startsWith('﻿') ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = []; let cell = ''; let quoted = false; let i = 0;
  while (i < s.length) {
    const c = s[i] as string;
    if (quoted) {
      if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i += 2; continue; } quoted = false; i++; continue; }
      cell += c; i++; continue;
    }
    if (c === '"' && cell === '') { quoted = true; i++; continue; }
    if (c === ',') { row.push(cell); cell = ''; i++; continue; }
    if (c === '\r' && s[i + 1] === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i += 2; continue; }
    if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++; continue; }
    cell += c; i++;
  }
  if (cell !== '' || row.length > 0) { row.push(cell); rows.push(row); }
  return rows;
}
/** Parsed CSV as objects keyed by the header row. */
export function csvObjects(text: string): { header: string[]; rows: Record<string, string>[] } {
  const [header = [], ...rest] = parseCsv(text);
  return { header, rows: rest.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? '']))) };
}
