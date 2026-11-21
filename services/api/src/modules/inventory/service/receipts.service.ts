// C12.T-12 goods receipts #49-#55 (02-TRD §4.2, §5.4, §5.10, §5.11; 03-APP-FLOW §3.2 G1-G4, §4.2; PRD AC-06.1-06.9; 07-SECURITY P-B1 / P-B8, PE-1 / PE-3; 08 A4.1, A17 D-70, D-71, P-8, P-9, P-23).
// Order on #51-#54, always: row read (404 unknown / other tenant) -> branch visible (404) -> assertRole({permission, branchId}) (403 / 403 auth.mfa_required) -> transition (409 inventory.document_invalid_transition)
//   -> If-Match (409 common.version_conflict) -> body / row rules. #53 locks in one direction only: GRN row -> PO row + lines -> lots -> balances (ledger) -> PO lines / supplier items.
// Money is computed only through domain/money.ts via the T-11 helpers (BigInt, round half up); the port is asked for rates BEFORE any write (P-23: a failure leaves nothing behind).
// [CONV] LD-140 is UI-only and does not apply here.
// [CONV] #50 / #52 defaults as T-11 PO lines (price: supplier item; tax code: line > supplier item > item > VAT); the supplier is taken from the PO when omitted, another one is 400 /supplier_id; a PO of another store is 400 /po_id;
//   a po_line_id must be a current line of that PO for the same item (400 /lines/i/po_line_id). An opening balance takes neither supplier nor PO; a purchase takes a supplier or a PO.
// [CONV] #52 on a POSTED GRN is 409 common.immutable_record (AC-06.5), on a cancelled one 409 inventory.document_invalid_transition. A replace is a full replace of the optional header fields (omitted = cleared), except received_at (omitted = kept).
// [CONV] #53: movements are stamped with the post time (occurred_at = now, business_date = tenant date of now); expiry_on >= the tenant date of received_at (literal AC-06.9); an existing lot with a NULL expiry keeps it (correction goes via #33);
//   the lot's last_receipt_* is set from every line (opening balances included), latest wins; the supplier item's last_unit_price_paisa is set for purchases only (an existing row; none is created).
// [CONV] #55: both permissions are asserted tenant-wide first (handler); a store_id is only checked for visibility (404); more than exportMaxRows rows => 422 inventory.export_too_large; one access-log row per success, never on a refusal.
import { LimsError } from '../../../core/errors.js';
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import type { HandlerContext } from '../../../core/module.js';
import { loadInventoryConfig } from '../config.js';
import { toCsv } from '../domain/csv.js';
import { assertTransition } from '../domain/grn.state.js';
import { capitalisedValuePaisa } from '../domain/money.js';
import { formatNumber, periodKey } from '../domain/numbering.js';
import { assertTransition as assertPoTransition, type PoStatus } from '../domain/po.state.js';
import { formatScaled, scaled } from '../domain/quantity.js';
import { nowMs, ymdIn } from '../domain/tenantTime.js';
import { fieldError, invalid } from '../handlers/items.schemas.js';
import type { GrnCreateInput, GrnDraftInput, GrnExportQuery, GrnLineInput, GrnListQuery } from '../handlers/receipts.schemas.js';
import { toGrnDto, toGrnSummaryDto } from '../mappers/goodsReceipt.dto.js';
import { allocateNumber } from '../repository/counters.repo.js';
import { insertGrn, insertGrnLine, listGrnLines, removeGrnLine, updateGrn, updateGrnLine } from '../repository/goodsReceipts.repo.js';
import { getItem } from '../repository/items.repo.js';
import { updateLot } from '../repository/lots.repo.js';
import { updatePo, updatePoLine } from '../repository/purchaseOrders.repo.js';
import { ensureSettings } from '../repository/settings.repo.js';
import { getStore } from '../repository/stores.repo.js';
import { type RepoCtx, type Row, Q, first, isUuid, query } from '../repository/_base.js';
import { PERMISSIONS } from '../permissions.js';
import { assertNotCounting } from './documents.service.js';
import { post as ledgerPost, type Movement } from './ledger.service.js';
import { type PricedLine, activeTaxCodes, assertActiveSupplier, assertBranch, clock, fetchRates, permissionsOf, price as priceLines, resolveLine, totalsOf, wire } from './purchasing.service.js';
import { assertStoreAccess, listVisibleBranchIds } from './scope.service.js';

type Dto = Record<string, unknown>;
type Scope = Parameters<typeof assertStoreAccess>[0];
const rcOf = (ctx: HandlerContext): RepoCtx => ({ tx: ctx.tx as RepoCtx['tx'], tenantId: ctx.tenantId as string, actorId: ctx.actor?.id as string });
const sc = (ctx: HandlerContext): Scope => ctx as unknown as Scope;
const notFound = (): LimsError => new LimsError('common.not_found');
const READ = PERMISSIONS.itemRead;
const MANAGE = PERMISSIONS.stockManage;
const ADJUST = PERMISSIONS.stockAdjust;
const RECEIVABLE = new Set(['approved', 'sent', 'partially_received']);

// ---------------------------------------------------------------- reads: `date` columns reach the wire as 'YYYY-MM-DD' (a JS Date would shift with the server zone); the later column wins
const HEAD_SQL = (lock: boolean): string => `SELECT g.*, to_char(g.supplier_invoice_on, 'YYYY-MM-DD') AS supplier_invoice_on, s.branch_id
    FROM inventory.goods_receipts g JOIN inventory.stores s ON s.tenant_id = g.tenant_id AND s.id = g.store_id WHERE g.tenant_id = $1 AND g.id = $2${lock ? ' FOR UPDATE OF g' : ''}`;
const LINES_SQL = `SELECT l.*, to_char(l.expiry_on, 'YYYY-MM-DD') AS expiry_on, to_char(l.manufactured_on, 'YYYY-MM-DD') AS manufactured_on, (l.tax_code IS NULL) AS is_exempt
    FROM inventory.goods_receipt_lines l WHERE l.tenant_id = $1 AND l.grn_id = $2 AND l.removed_at IS NULL ORDER BY l.line_no, l.id`;
const MOVEMENTS_SQL = `SELECT m.id, m.occurred_at, to_char(m.business_date, 'YYYY-MM-DD') AS business_date, m.store_id, m.item_id, m.lot_id, lt.lot_no, m.movement_kind, m.qty_base, m.balance_qty_after,
      m.value_paisa, m.value_basis, m.doc_type, m.doc_id, m.reason_code
    FROM inventory.stock_movements m
    JOIN inventory.goods_receipt_lines gl ON gl.tenant_id = m.tenant_id AND gl.id = m.doc_line_id
    LEFT JOIN inventory.lots lt ON lt.tenant_id = m.tenant_id AND lt.id = m.lot_id
   WHERE m.tenant_id = $1 AND m.doc_type = 'goods_receipt' AND m.doc_id = $2 ORDER BY gl.line_no, m.id`;

/** The Grn as the contract shows it: current lines only, movements once posted, cost keys only with inventory.cost.read (PE-3). */
async function view(ctx: HandlerContext, rc: RepoCtx, id: string): Promise<Dto> {
  const g = await first(rc, HEAD_SQL(false), [id]);
  if (g === null) throw notFound();
  const lines = (await query(rc, LINES_SQL, [id])).map(wire);
  const head = wire(g);
  if (g['supplier_invoice_total_paisa'] !== null && BigInt(g['supplier_invoice_total_paisa']) !== BigInt(g['total_paisa'])) {
    const d = BigInt(g['supplier_invoice_total_paisa']) - BigInt(g['total_paisa']);
    head['invoice_total_mismatch_paisa'] = Number(d < 0n ? -d : d); // informational, never an error (TRD §4.2)
  }
  const movements = g['status'] === 'posted' ? (await query(rc, MOVEMENTS_SQL, [id])).map((m) => ({ ...wire(m), doc_no: g['grn_no'] })) : undefined;
  return toGrnDto({ ...head, lines, ...(movements === undefined ? {} : { movements }) }, await permissionsOf(ctx));
}

/** Write path: the row lock queues two requests on one GRN; the loser re-reads the new status (-> 409). */
async function lockGrn(ctx: HandlerContext, rc: RepoCtx, id: string, permission: string): Promise<Row> {
  const g = await first(rc, HEAD_SQL(true), [id]);
  if (g === null) throw notFound();
  await assertBranch(ctx, g['branch_id'], permission);
  return g;
}
const checkVersion = (g: Row, ifMatch: number): void => { if (g['version'] !== ifMatch) throw new LimsError('common.version_conflict'); };

// ---------------------------------------------------------------- #49 list
const KEY_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const cursorOf = (r: Row): string => Buffer.from(JSON.stringify({ r: r['cursor_key'], i: r['id'] })).toString('base64url');
function decodeCursor(cursor: string): { r: string; i: string } {
  let c: { r?: unknown; i?: unknown } | null | undefined;
  try { c = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { r?: unknown; i?: unknown } | null; } catch { /* 400 below */ }
  const r = c?.r;
  const i = c?.i;
  if (typeof r !== 'string' || !KEY_AT.test(r) || !isUuid(i)) throw invalid(fieldError('/cursor'));
  return { r, i };
}

export async function listGoodsReceipts(ctx: HandlerContext, f: GrnListQuery): Promise<Dto> {
  const rc = rcOf(ctx);
  if (f.store_id !== undefined) await assertStoreAccess(sc(ctx), f.store_id, READ); // 404 invisible / unknown -> 403
  const q = new Q();
  let w = '';
  if (f.store_id !== undefined) w += ` AND g.store_id = ${q.p(f.store_id)}`;
  else { // P-B1: without a store the list covers the visible branches only
    const v = await listVisibleBranchIds(sc(ctx));
    if (!v.all) w += ` AND g.store_id IN (SELECT id FROM inventory.stores WHERE tenant_id = $1 AND branch_id = ANY(${q.p([...v.branchIds])}::uuid[]))`;
  }
  if (f.status !== undefined) w += ` AND g.status = ${q.p(f.status)}`;
  if (f.supplier_id !== undefined) w += ` AND g.supplier_id = ${q.p(f.supplier_id)}`;
  if (f.po_id !== undefined) w += ` AND g.po_id = ${q.p(f.po_id)}`;
  if (f.received_at_from !== undefined) w += ` AND g.received_at >= ${q.p(f.received_at_from)}::timestamptz`;
  if (f.received_at_to !== undefined) w += ` AND g.received_at <= ${q.p(f.received_at_to)}::timestamptz`;
  if (f.cursor !== undefined) { const c = decodeCursor(f.cursor); w += ` AND (g.received_at, g.id) < (${q.p(c.r)}::timestamptz, ${q.p(c.i)}::uuid)`; }
  // cursor_key keeps the microseconds a JS Date would drop
  const rows = await query(rc, `SELECT g.*, to_char(g.received_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_key FROM inventory.goods_receipts g
      WHERE g.tenant_id = $1${w} ORDER BY g.received_at DESC, g.id DESC LIMIT ${q.p(f.limit + 1)}`, q.vals);
  const data = rows.slice(0, f.limit);
  const perms = await permissionsOf(ctx);
  return { data: data.map((r) => toGrnSummaryDto(wire(r), perms)), page: { limit: f.limit, ...(rows.length > f.limit ? { next_cursor: cursorOf(data[data.length - 1]!) } : {}) } };
}

// ---------------------------------------------------------------- #51 get
export async function getGoodsReceipt(ctx: HandlerContext, id: string): Promise<Dto> {
  const rc = rcOf(ctx);
  const g = await first(rc, HEAD_SQL(false), [id]);
  if (g === null) throw notFound();
  await assertBranch(ctx, g['branch_id'], READ);
  return view(ctx, rc, id);
}

// ---------------------------------------------------------------- #50 / #52: validation + money, shared
interface DraftLine extends PricedLine { po_line_id: string | null; lot_no: string | null; expiry_on: string | null; manufactured_on: string | null }
interface Prepared { supplierId: string | null; poId: string | null; lines: DraftLine[]; totals: ReturnType<typeof totalsOf> }

/** Supplier / PO link / lines of a draft: every refusal here happens before anything is written. */
async function prepare(ctx: HandlerContext, rc: RepoCtx, ck: { today: string }, kind: string, storeId: string, input: GrnDraftInput): Promise<Prepared> {
  let supplierId = input.supplier_id ?? null;
  const poId = input.po_id ?? null;
  let poLines: Row[] = [];
  if (kind === 'opening_balance') { // AC-06.7: no supplier, no PO
    if (supplierId !== null) throw invalid(fieldError('/supplier_id'));
    if (poId !== null) throw invalid(fieldError('/po_id'));
  } else {
    if (poId === null && (await ensureSettings(rc))['grn_without_po_allowed'] === false) throw invalid(fieldError('/po_id')); // AC-06.6
    if (poId !== null) {
      const po = await first(rc, 'SELECT id, store_id, supplier_id, status FROM inventory.purchase_orders WHERE tenant_id = $1 AND id = $2', [poId]);
      if (po === null) throw notFound();
      if (po['store_id'] !== storeId) throw invalid(fieldError('/po_id'));
      if (!RECEIVABLE.has(po['status'])) throw new LimsError('inventory.po_invalid_transition');
      if (supplierId !== null && supplierId !== po['supplier_id']) throw invalid(fieldError('/supplier_id'));
      supplierId = po['supplier_id'];
      poLines = await query(rc, 'SELECT id, item_id FROM inventory.purchase_order_lines WHERE tenant_id = $1 AND po_id = $2 AND removed_at IS NULL', [poId]);
    }
    if (supplierId === null) throw invalid(fieldError('/supplier_id'));
    await assertActiveSupplier(rc, supplierId);
  }
  const taxCodes = await activeTaxCodes(rc);
  const memo = new Map<string, Row | null>();
  const resolved = [];
  for (const [i, l] of input.lines.entries()) {
    if (l.po_line_id !== undefined && !poLines.some((p) => p['id'] === l.po_line_id && p['item_id'] === l.item_id)) throw invalid(fieldError(`/lines/${i}/po_line_id`));
    resolved.push(await resolveLine(rc, supplierId, l, i, taxCodes, memo));
  }
  const priced = priceLines(resolved, await fetchRates(ctx, resolved.map((l) => l.code), ck.today)); // the port is asked before anything is written
  const lines = priced.map((p, i): DraftLine => {
    const l = input.lines[i] as GrnLineInput;
    return { ...p, po_line_id: l.po_line_id ?? null, lot_no: l.lot_no ?? null, expiry_on: l.expiry_on ?? null, manufactured_on: l.manufactured_on ?? null };
  });
  return { supplierId, poId, lines, totals: totalsOf(priced) };
}

const insertLines = async (rc: RepoCtx, grnId: string, lines: readonly DraftLine[]): Promise<void> => {
  for (const [n, l] of lines.entries()) {
    await insertGrnLine(rc, {
      id: uuidv7(), grn_id: grnId, line_no: n + 1, po_line_id: l.po_line_id, item_id: l.item_id, pack_id: l.pack_id, qty_packs: l.qty_packs, qty_in_base_snapshot: l.qty_in_base, qty_base: l.qty_base,
      lot_no: l.lot_no, expiry_on: l.expiry_on, manufactured_on: l.manufactured_on, unit_price_paisa: l.price, discount_paisa: l.discount, tax_code: l.code, tax_rate_bp: l.rate,
      net_paisa: l.amounts.netPaisa, vat_paisa: l.amounts.vatPaisa, line_total_paisa: l.amounts.totalPaisa,
    });
  }
};

async function nextGrnNo(rc: RepoCtx, today: string): Promise<string> {
  const pattern = (await ensureSettings(rc))['grn_no_pattern'] as string;
  const period = periodKey(pattern, today);
  for (let n = 0; n < 50; n++) { // a counter behind imported numbers must not fail a create; ponytail: 50 probes, then common.internal
    const no = formatNumber(pattern, today, await allocateNumber(rc, 'grn', period));
    if ((await first(rc, 'SELECT 1 AS x FROM inventory.goods_receipts WHERE tenant_id = $1 AND grn_no = $2', [no])) === null) return no;
  }
  throw new LimsError('common.internal');
}

// ---------------------------------------------------------------- #50 create
export async function createGoodsReceipt(ctx: HandlerContext, input: GrnCreateInput): Promise<Dto> {
  const rc = rcOf(ctx);
  const store = await assertStoreAccess(sc(ctx), input.store_id, MANAGE); // 404 invisible / unknown -> 403 (P-B8)
  if (input.kind === 'opening_balance') await ctx.ports.IdentityPort.assertRole(ctx, { permission: ADJUST, branchId: store['branch_id'] }); // privileged (PE-1)
  if (store['is_active'] !== true) throw invalid(fieldError('/store_id'));
  const ck = await clock(ctx);
  const p = await prepare(ctx, rc, ck, input.kind, store['id'], input);
  const id = uuidv7();
  await insertGrn(rc, {
    id, grn_no: await nextGrnNo(rc, ck.today), kind: input.kind, store_id: store['id'], supplier_id: p.supplierId, po_id: p.poId, status: 'draft', received_at: input.received_at ?? ck.nowIso,
    supplier_invoice_no: input.supplier_invoice_no ?? null, supplier_invoice_on: input.supplier_invoice_on ?? null, supplier_invoice_total_paisa: input.supplier_invoice_total_paisa ?? null,
    notes: input.notes ?? null, ...p.totals,
  });
  await insertLines(rc, id, p.lines);
  return view(ctx, rc, id);
}

// ---------------------------------------------------------------- #52 replace draft (D-71, §5.11)
export async function replaceGoodsReceiptDraft(ctx: HandlerContext, id: string, ifMatch: number, input: GrnDraftInput): Promise<Dto> {
  const rc = rcOf(ctx);
  const g = await lockGrn(ctx, rc, id, MANAGE);
  if (g['status'] === 'posted') throw new LimsError('common.immutable_record'); // AC-06.5
  assertTransition(g['status'], 'draft');
  checkVersion(g, ifMatch);
  const p = await prepare(ctx, rc, await clock(ctx), g['kind'], g['store_id'], input); // everything is validated BEFORE a line is removed
  for (const l of await listGrnLines(rc, id)) await removeGrnLine(rc, l['id'], l['version']);
  await insertLines(rc, id, p.lines);
  await updateGrn(rc, id, ifMatch, {
    supplier_id: p.supplierId, po_id: p.poId, received_at: input.received_at, supplier_invoice_no: input.supplier_invoice_no ?? null, supplier_invoice_on: input.supplier_invoice_on ?? null,
    supplier_invoice_total_paisa: input.supplier_invoice_total_paisa ?? null, notes: input.notes ?? null, ...p.totals,
  });
  return view(ctx, rc, id);
}

// ---------------------------------------------------------------- #53 post (03-APP-FLOW §4.2)
/** One lot row per (item, lot_no) under a row lock; a different non-null expiry is a 400 at the line (08 A13 P-1: a lot has one expiry). */
async function upsertLot(rc: RepoCtx, i: number, l: Row): Promise<Row> {
  const SEL = "SELECT *, to_char(expiry_on, 'YYYY-MM-DD') AS expiry_on FROM inventory.lots WHERE tenant_id = $1 AND item_id = $2 AND lot_no = $3 FOR UPDATE";
  let lot = await first(rc, SEL, [l['item_id'], l['lot_no']]);
  if (lot === null) {
    lot = await first(rc, `INSERT INTO inventory.lots (id, tenant_id, item_id, lot_no, expiry_on, manufactured_on, status, created_by, updated_by)
        VALUES ($2, $1, $3, $4, $5::date, $6::date, 'available', $7, $7) ON CONFLICT (tenant_id, item_id, lot_no) DO NOTHING RETURNING *, to_char(expiry_on, 'YYYY-MM-DD') AS expiry_on`,
    [uuidv7(), l['item_id'], l['lot_no'], l['expiry_on'], l['manufactured_on'], rc.actorId]);
    lot ??= await first(rc, SEL, [l['item_id'], l['lot_no']]); // lost a race with a parallel receipt of the same lot
  }
  if (lot === null) throw new LimsError('common.internal');
  if (lot['expiry_on'] !== null && l['expiry_on'] !== null && lot['expiry_on'] !== l['expiry_on']) throw invalid(fieldError(`/lines/${i}/expiry_on`));
  return lot;
}

export async function postGoodsReceipt(ctx: HandlerContext, id: string, ifMatch: number): Promise<Dto> {
  const rc = rcOf(ctx);
  const g = await lockGrn(ctx, rc, id, MANAGE); // 1: lock the GRN row
  if (g['kind'] === 'opening_balance') await ctx.ports.IdentityPort.assertRole(ctx, { permission: ADJUST, branchId: g['branch_id'] }); // privileged (PE-1)
  assertTransition(g['status'], 'posted'); // draft only (a second post: 409)
  checkVersion(g, ifMatch);
  await assertNotCounting(rc, g['store_id']); // 2
  const ck = await clock(ctx);
  const settings = await ensureSettings(rc);
  const lines = await query(rc, LINES_SQL, [id]);
  if (lines.length === 0) throw invalid(fieldError('/lines'));

  // 3: PO-linked -> lock the PO and its lines; status receivable; cumulative quantity within tolerance
  const take = new Map<string, bigint>();
  let po: Row | null = null;
  const poLines = new Map<string, Row>();
  if (g['po_id'] !== null) {
    po = await first(rc, 'SELECT * FROM inventory.purchase_orders WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [g['po_id']]);
    if (po === null) throw notFound();
    // a PO that a parallel post just completed ('received') answers over_receipt below, not a state error (the quantity is the real reason); draft / closed / cancelled are state errors
    if (!RECEIVABLE.has(po['status']) && po['status'] !== 'received') throw new LimsError('inventory.po_invalid_transition');
    for (const l of await query(rc, 'SELECT * FROM inventory.purchase_order_lines WHERE tenant_id = $1 AND po_id = $2 AND removed_at IS NULL ORDER BY line_no, id FOR UPDATE', [g['po_id']])) poLines.set(l['id'], l);
    for (const [i, l] of lines.entries()) {
      if (l['po_line_id'] === null) continue;
      if (!poLines.has(l['po_line_id'])) throw invalid(fieldError(`/lines/${i}/po_line_id`));
      take.set(l['po_line_id'], (take.get(l['po_line_id']) ?? 0n) + scaled(l['qty_base'], 6));
    }
    const tol = BigInt(settings['over_receipt_tolerance_bp'] ?? 0);
    for (const [pid, q] of take) {
      const pl = poLines.get(pid) as Row;
      if ((scaled(pl['received_qty_base'], 6) + q) * 10000n > scaled(pl['qty_base'], 6) * (10000n + tol)) throw new LimsError('inventory.over_receipt');
    }
    if (po['status'] === 'received') throw new LimsError('inventory.po_invalid_transition'); // within tolerance, but the PO is already complete
  }

  // 4: lots (tracking rules, expiry, upsert) and the value of each line (TRD §4.2)
  const receivedOn = ymdIn(nowMs(g['received_at']), ck.tz);
  const items = new Map<string, Row>();
  const lotOf: (Row | null)[] = [];
  for (const [i, l] of lines.entries()) {
    if (!items.has(l['item_id'])) {
      const found = await getItem(rc, l['item_id']);
      if (found === null) throw notFound();
      items.set(l['item_id'], found);
    }
    const item = items.get(l['item_id']) as Row;
    if (item['is_lot_tracked'] !== true) { lotOf.push(null); continue; }
    if (l['lot_no'] === null) throw invalid(fieldError(`/lines/${i}/lot_no`));
    if (item['requires_expiry'] === true && l['expiry_on'] === null) throw invalid(fieldError(`/lines/${i}/expiry_on`));
    if (l['expiry_on'] !== null && l['expiry_on'] < receivedOn) throw new LimsError('inventory.lot_expired'); // AC-06.9
    if (l['expiry_on'] !== null && l['manufactured_on'] !== null && l['manufactured_on'] > l['expiry_on']) throw invalid(fieldError(`/lines/${i}/manufactured_on`));
    lotOf.push(await upsertLot(rc, i, l));
  }
  const lotIds = lotOf.map((l) => (l === null ? null : (l['id'] as string)));
  const caps = lines.map((l) => capitalisedValuePaisa({ netPaisa: Number(l['net_paisa']), vatPaisa: Number(l['vat_paisa']) }, settings['vat_in_cost'] === true)); // AC-06.4
  for (const [i, l] of lines.entries()) await updateGrnLine(rc, l['id'], l['version'], { lot_id: lotIds[i], capitalised_value_paisa: caps[i] });

  // 5: ledger
  const kind = g['kind'] === 'opening_balance' ? 'opening_balance' : 'receive';
  const movements: Movement[] = lines.map((l, i) => ({ store_id: g['store_id'], item_id: l['item_id'], lot_id: lotIds[i] ?? null, kind, qty_base: l['qty_base'], value_hint: caps[i] as number, doc_line_id: l['id'] }));
  await ledgerPost(rc, { doc_type: 'goods_receipt', doc_id: id, occurred_at: ck.nowIso, business_date: ck.today, movements }); // alert checks run inside

  // 6: lots.last_receipt_* (latest wins), PO lines + status (P5), supplier item price (purchase)
  const latest = new Map<string, Row>(lotOf.flatMap((l) => (l === null ? [] : [[l['id'], l] as [string, Row]])));
  for (const [i, l] of lines.entries()) {
    const lotId = lotIds[i];
    if (lotId === null || lotId === undefined) continue;
    latest.set(lotId, await updateLot(rc, lotId, (latest.get(lotId) as Row)['version'], { last_receipt_qty_base: l['qty_base'], last_receipt_value_paisa: caps[i] }));
  }
  if (po !== null) {
    for (const [pid, q] of take) {
      const pl = poLines.get(pid) as Row;
      poLines.set(pid, await updatePoLine(rc, pid, pl['version'], { received_qty_base: formatScaled(scaled(pl['received_qty_base'], 6) + q, 6) }));
    }
    const done = [...poLines.values()].every((pl) => pl['is_closed_short'] === true || scaled(pl['received_qty_base'], 6) >= scaled(pl['qty_base'], 6));
    // P5: a GRN without po_line_id lines leaves a PO with nothing received in its current status
    const anyReceived = [...poLines.values()].some((pl) => pl['is_closed_short'] !== true && scaled(pl['received_qty_base'], 6) > 0n);
    const next = done ? 'received' : anyReceived ? 'partially_received' : (po['status'] as PoStatus);
    if (next !== po['status']) { assertPoTransition(po['status'], next); await updatePo(rc, po['id'], po['version'], { status: next }); }
  }
  if (g['kind'] === 'purchase') {
    for (const l of lines) {
      await query(rc, `UPDATE inventory.supplier_items SET last_unit_price_paisa = $5::bigint, version = version + 1, updated_at = now(), updated_by = $6
          WHERE tenant_id = $1 AND supplier_id = $2 AND item_id = $3 AND pack_id = $4 AND last_unit_price_paisa IS DISTINCT FROM $5::bigint`, [g['supplier_id'], l['item_id'], l['pack_id'], l['unit_price_paisa'], rc.actorId]);
    }
  }

  // 7: posted
  await updateGrn(rc, id, ifMatch, { status: 'posted', posted_at: ck.nowIso, posted_by: rc.actorId });
  return view(ctx, rc, id);
}

// ---------------------------------------------------------------- #54 cancel (a draft only)
export async function cancelGoodsReceipt(ctx: HandlerContext, id: string, ifMatch: number, input: { reason_text: string }): Promise<Dto> {
  const rc = rcOf(ctx);
  const g = await lockGrn(ctx, rc, id, MANAGE);
  assertTransition(g['status'], 'cancelled');
  checkVersion(g, ifMatch);
  await updateGrn(rc, id, ifMatch, { status: 'cancelled', cancelled_at: (await clock(ctx)).nowIso, cancelled_by: rc.actorId, cancel_reason_text: input.reason_text });
  return view(ctx, rc, id);
}

// ---------------------------------------------------------------- #55 CSV export (§5.10)
const CSV_HEADER = ['grn_no', 'kind', 'posted_at', 'store_code', 'supplier_code', 'supplier_name', 'item_code', 'lot_no', 'expiry_on', 'qty_base', 'unit_price_paisa', 'discount_paisa', 'tax_code', 'tax_rate_bp',
  'net_paisa', 'vat_paisa', 'capitalised_value_paisa'];
const money = (v: unknown): bigint | null => (v === null || v === undefined ? null : BigInt(v as string));

export async function exportGoodsReceiptsCsv(ctx: HandlerContext, f: GrnExportQuery): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  const rc = rcOf(ctx);
  const audit = (ctx as unknown as { audit?: { access?: (e: Record<string, unknown>) => Promise<void> } }).audit;
  if (typeof audit?.access !== 'function') throw new LimsError('common.internal'); // the access-log row is mandatory
  const v = await listVisibleBranchIds(sc(ctx));
  const q = new Q();
  let w = ` AND g.posted_at >= ${q.p(f.posted_at_from)}::timestamptz AND g.posted_at < ${q.p(f.posted_at_to)}::timestamptz`; // half-open window (CV §4.4)
  if (f.store_id !== undefined) {
    const s = await getStore(rc, f.store_id);
    if (s === null || !(v.all || v.branchIds.includes(s['branch_id']))) throw notFound(); // 404 before anything is read (P-B8)
    w += ` AND g.store_id = ${q.p(f.store_id)}`;
  } else if (!v.all) w += ` AND s.branch_id = ANY(${q.p([...v.branchIds])}::uuid[])`; // P-B1
  const max = (await loadInventoryConfig()).exportMaxRows;
  const rows = await query(rc, `SELECT g.grn_no, g.kind, g.posted_at, s.store_code, sup.supplier_code, sup.name AS supplier_name, i.item_code, l.lot_no, to_char(l.expiry_on, 'YYYY-MM-DD') AS expiry_on,
        l.qty_base, l.unit_price_paisa, l.discount_paisa, l.tax_code, l.tax_rate_bp, l.net_paisa, l.vat_paisa, l.capitalised_value_paisa
      FROM inventory.goods_receipts g
      JOIN inventory.goods_receipt_lines l ON l.tenant_id = g.tenant_id AND l.grn_id = g.id AND l.removed_at IS NULL
      JOIN inventory.stores s ON s.tenant_id = g.tenant_id AND s.id = g.store_id
      JOIN inventory.items i ON i.tenant_id = l.tenant_id AND i.id = l.item_id
      LEFT JOIN inventory.suppliers sup ON sup.tenant_id = g.tenant_id AND sup.id = g.supplier_id
     WHERE g.tenant_id = $1 AND g.status = 'posted'${w} ORDER BY g.posted_at, g.grn_no, l.line_no LIMIT ${q.p(max + 1)}`, q.vals);
  if (rows.length > max) throw new LimsError('inventory.export_too_large');
  const body = toCsv(CSV_HEADER, rows.map((r) => [r['grn_no'], r['kind'], (r['posted_at'] as Date).toISOString(), r['store_code'], r['supplier_code'], r['supplier_name'], r['item_code'], r['lot_no'], r['expiry_on'],
    r['qty_base'], money(r['unit_price_paisa']), money(r['discount_paisa']), r['tax_code'], r['tax_rate_bp'], money(r['net_paisa']), money(r['vat_paisa']), money(r['capitalised_value_paisa'])]));
  await audit.access({ action: 'data.export', entityType: 'inventory_grn_export', outcome: 'allowed', detail: { row_count: rows.length, posted_at_from: f.posted_at_from, posted_at_to: f.posted_at_to, ...(f.store_id === undefined ? {} : { store_id: f.store_id }) } });
  return {
    status: 200, body,
    headers: {
      'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="goods-receipts-${f.posted_at_from.slice(0, 10)}-${f.posted_at_to.slice(0, 10)}.csv"`,
      'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
    },
  };
}
