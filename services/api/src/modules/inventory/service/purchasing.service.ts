// C12.T-11 purchase orders #80-#89 (02-TRD §4.2, §5.5, §5.11; 03-APP-FLOW §3.1 P1-P9; PRD AC-05.1-05.8, AC-20.4; 07-SECURITY P-B2 / P-B8 / P-T1-P-T4, PE-1 / PE-3; 08 A2.2, A4.1, A17 D-70, D-71, P-8, P-23).
// Order on #83-#87, always: row lock + read (404 unknown / other tenant) -> branch visible (404) -> assertRole({permission, branchId}) (403 / 403 auth.mfa_required) -> transition (409 inventory.po_invalid_transition)
//   -> If-Match (409 common.version_conflict) -> body rules (422 inventory.reason_required, 403 inventory.po_self_approval_forbidden, 400 no lines).
// Money is computed here only through domain/money.ts (BigInt, round half up, 02-TRD §4.2); a client total is not in any schema (AC-05.1). The port is asked for rates BEFORE any write, so a failure (P-23: the same
// LimsError object, e.g. catalog.tax_config_missing) leaves no PO, no line and no consumed number.
// [CONV] LD-140 is UI-only and does not apply here.
// [CONV] numbering skips a number already taken in the tenant (a counter behind imported numbers must not fail a create); ponytail: 50 probes, then common.internal.
// [CONV] D-70: tax_code NULL <=> exempt line (rate 0, getTaxRate never called); the wire carries is_exempt and omits tax_code. A fixture / imported line with a NULL tax_code therefore reads as exempt.
// [CONV] D-71: replace soft-removes every current line (removed_at / removed_by) and inserts the request lines as 1..n; nothing is ever deleted.
// [CONV] manual create: a line without an explicit price and without a supplier-item price is refused (400 /lines/i/unit_price_paisa); #88 prices such a line 0 (a draft the clerk completes).
// [CONV] #88: an item is judged "open_po_exists" when a draft / approved / sent / partially_received PO of the store has a current line of the item; with item_ids only the requested items are reported; a requested item
//   without an active reorder setting is reported as not_below_reorder (a foreign / unknown id is ignored); a setting without reorder_qty_base is reported as not_below_reorder (nothing to order).
// [CONV] open_qty_base = qty_base - received_qty_base (never below 0), and 0 on a closed-short line.
import { LimsError } from '../../../core/errors.js';
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import type { HandlerContext } from '../../../core/module.js';
import { computeLine, computeTotals, type LineAmounts } from '../domain/money.js';
import { formatNumber, periodKey } from '../domain/numbering.js';
import { assertTransition } from '../domain/po.state.js';
import { formatScaled, packToBase, scaled } from '../domain/quantity.js';
import { assertZone, nowMs, ymdIn } from '../domain/tenantTime.js';
import { fieldError, invalid } from '../handlers/items.schemas.js';
import type { PoDraftInput, PoLineInput, PoListQuery, ReasonInput, ReorderInput, SentInput } from '../handlers/purchasing.schemas.js';
import { toPoDto, toPoPrintViewDto, toPoSummaryDto } from '../mappers/purchaseOrder.dto.js';
import { listReasons, listTaxCodes } from '../repository/codedSets.repo.js';
import { allocateNumber } from '../repository/counters.repo.js';
import { getItem, getPack } from '../repository/items.repo.js';
import { insertPo, insertPoLine, removePoLine, updatePo, updatePoLine } from '../repository/purchaseOrders.repo.js';
import { ensureSettings } from '../repository/settings.repo.js';
import { getStore } from '../repository/stores.repo.js';
import { getSupplier } from '../repository/suppliers.repo.js';
import { type RepoCtx, type Row, Q, first, isUuid, query } from '../repository/_base.js';
import { PERMISSIONS } from '../permissions.js';
import { assertStoreAccess, listVisibleBranchIds } from './scope.service.js';

type Dto = Record<string, unknown>;
type Scope = Parameters<typeof assertStoreAccess>[0];
const rcOf = (ctx: HandlerContext): RepoCtx => ({ tx: ctx.tx as RepoCtx['tx'], tenantId: ctx.tenantId as string, actorId: ctx.actor?.id as string });
const sc = (ctx: HandlerContext): Scope => ctx as unknown as Scope;
const notFound = (): LimsError => new LimsError('common.not_found');
const READ = PERMISSIONS.itemRead;
const MANAGE = PERMISSIONS.poManage;
const APPROVE = PERMISSIONS.poApprove;
const COST = PERMISSIONS.costRead;
const DEFAULT_TAX = 'VAT';
const OPEN_STATUSES = ['draft', 'approved', 'sent', 'partially_received'];

// ---------------------------------------------------------------- wire helpers: null is never sent (CV §4.2), timestamps are ISO, bigint money is a number
const MONEY = /_paisa(_x1e6)?$/;
export function wire(row: Row): Row {
  const o: Row = {};
  for (const [k, v] of Object.entries(row)) {
    if (v === null || v === undefined) continue;
    o[k] = v instanceof Date ? v.toISOString() : MONEY.test(k) ? Number(v) : v;
  }
  return o;
}
export const permissionsOf = async (ctx: HandlerContext): Promise<readonly string[]> => (await (ctx.ports.IdentityPort as any).getActor(ctx)).permissions ?? [];

export async function clock(ctx: HandlerContext): Promise<{ nowIso: string; today: string; tz: string }> {
  const s = await (ctx.ports.IdentityPort as any).getTenantSettings(ctx, { keys: ['timezone'] });
  const tz = assertZone(s?.timezone);
  const now = nowMs((ctx as any).now());
  return { nowIso: new Date(now).toISOString(), today: ymdIn(now, tz), tz };
}

// `*, to_char(...) AS expected_on`: the later column wins, so `date` reaches the wire as 'YYYY-MM-DD' (a JS Date would shift with the server zone).
const PO_SQL = "SELECT *, to_char(expected_on, 'YYYY-MM-DD') AS expected_on FROM inventory.purchase_orders WHERE tenant_id = $1 AND id = $2";
const loadPo = (rc: RepoCtx, id: string): Promise<Row | null> => first(rc, PO_SQL, [id]);
const listLines = (rc: RepoCtx, poId: string): Promise<Row[]> =>
  query(rc, 'SELECT * FROM inventory.purchase_order_lines WHERE tenant_id = $1 AND po_id = $2 AND removed_at IS NULL ORDER BY line_no, id', [poId]);

export async function assertBranch(ctx: HandlerContext, branchId: string, permission: string): Promise<void> {
  const v = await listVisibleBranchIds(sc(ctx));
  if (!(v.all || v.branchIds.includes(branchId))) throw notFound(); // 404 before 403 (P-B8)
  await ctx.ports.IdentityPort.assertRole(ctx, { permission, branchId });
}
/** Write path: the row lock queues two requests on one PO; the loser re-reads the new status (-> 409). */
async function lockPo(ctx: HandlerContext, rc: RepoCtx, id: string, permission: string): Promise<Row> {
  const po = await first(rc, `${PO_SQL} FOR UPDATE`, [id]);
  if (po === null) throw notFound();
  await assertBranch(ctx, po['branch_id'], permission);
  return po;
}
const checkVersion = (po: Row, ifMatch: number): void => { if (po['version'] !== ifMatch) throw new LimsError('common.version_conflict'); };

/** The Po as the contract shows it: current lines only, cost keys only with inventory.cost.read (PE-3). */
async function view(ctx: HandlerContext, rc: RepoCtx, id: string): Promise<Dto> {
  const po = await loadPo(rc, id);
  if (po === null) throw notFound();
  const lines = (await listLines(rc, id)).map((l) => {
    const open = l['is_closed_short'] === true ? 0n : scaled(l['qty_base'], 6) - scaled(l['received_qty_base'], 6);
    return wire({ ...l, is_exempt: l['tax_code'] === null, open_qty_base: formatScaled(open > 0n ? open : 0n, 6) });
  });
  const grns = await query(rc, 'SELECT * FROM inventory.goods_receipts WHERE tenant_id = $1 AND po_id = $2 ORDER BY created_at, id', [id]);
  return toPoDto({ ...wire(po), lines, ...(grns.length === 0 ? {} : { receipts: grns.map(wire) }) }, await permissionsOf(ctx));
}

// ---------------------------------------------------------------- #80 list
const cursorOf = (id: string): string => Buffer.from(JSON.stringify({ i: id })).toString('base64url');
function cursorId(cursor: string): string {
  let id: unknown;
  try { id = (JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { i?: unknown } | null)?.i; } catch { /* 400 below */ }
  if (!isUuid(id)) throw invalid(fieldError('/cursor'));
  return id;
}
export async function listPurchaseOrders(ctx: HandlerContext, f: PoListQuery): Promise<Dto> {
  const rc = rcOf(ctx);
  const q = new Q();
  let w = '';
  const v = await listVisibleBranchIds(sc(ctx));
  if (!v.all) w += ` AND branch_id = ANY(${q.p([...v.branchIds])}::uuid[])`; // P-B1
  if (f.status !== undefined) w += ` AND status = ${q.p(f.status)}`;
  if (f.supplier_id !== undefined) w += ` AND supplier_id = ${q.p(f.supplier_id)}`;
  if (f.branch_id !== undefined) w += ` AND branch_id = ${q.p(f.branch_id)}`; // an invisible branch simply yields nothing (no oracle)
  if (f.created_at_from !== undefined) w += ` AND created_at >= ${q.p(f.created_at_from)}::timestamptz`;
  if (f.created_at_to !== undefined) w += ` AND created_at <= ${q.p(f.created_at_to)}::timestamptz`;
  if (f.cursor !== undefined) w += ` AND id < ${q.p(cursorId(f.cursor))}::uuid`;
  const rows = await query(rc, `SELECT *, to_char(expected_on, 'YYYY-MM-DD') AS expected_on FROM inventory.purchase_orders WHERE tenant_id = $1${w} ORDER BY id DESC LIMIT ${q.p(f.limit + 1)}`, q.vals); // ponytail: keyset on the uuid
  const data = rows.slice(0, f.limit);
  const perms = await permissionsOf(ctx);
  return {
    data: data.map((r) => toPoSummaryDto(wire(r), perms)),
    page: { limit: f.limit, ...(rows.length > f.limit ? { next_cursor: cursorOf(data[data.length - 1]!['id']) } : {}) },
  };
}

// ---------------------------------------------------------------- #82 get
export async function getPurchaseOrder(ctx: HandlerContext, id: string): Promise<Dto> {
  const rc = rcOf(ctx);
  const po = await loadPo(rc, id);
  if (po === null) throw notFound();
  await assertBranch(ctx, po['branch_id'], READ);
  return view(ctx, rc, id);
}

// ---------------------------------------------------------------- lines: validation + money, shared by #81, #83 and #88
export interface ResolvedLine {
  item_id: string; pack_id: string; qty_packs: string; qty_in_base: string; qty_base: string; price: number; discount: number; code: string | null;
}
export interface PricedLine extends ResolvedLine { rate: number; amounts: LineAmounts }

/** Item / pack / price / tax-code resolution for one request line (no port call, no write). `i` is the line index used for the error path. */
export async function resolveLine(rc: RepoCtx, supplierId: string | null, l: PoLineInput, i: number, taxCodes: ReadonlySet<string>, memo: Map<string, Row | null>): Promise<ResolvedLine> {
  const cached = async (key: string, load: () => Promise<Row | null>): Promise<Row | null> => { if (!memo.has(key)) memo.set(key, await load()); return memo.get(key)!; };
  const item = await cached(`i|${l.item_id}`, () => getItem(rc, l.item_id));
  if (item === null) throw notFound();
  if (item['is_active'] !== true) throw new LimsError('inventory.item_inactive');
  const pack = await cached(`p|${l.pack_id}`, () => getPack(rc, l.pack_id));
  if (pack === null) throw notFound();
  if (pack['item_id'] !== l.item_id) throw new LimsError('inventory.uom_mismatch');
  if (pack['is_active'] !== true) throw invalid(fieldError(`/lines/${i}/pack_id`));
  const si = await cached(`s|${l.item_id}|${l.pack_id}`, () => first(rc, 'SELECT last_unit_price_paisa, default_tax_code FROM inventory.supplier_items WHERE tenant_id = $1 AND supplier_id = $2 AND item_id = $3 AND pack_id = $4 AND is_active', [supplierId, l.item_id, l.pack_id]));
  const price = l.unit_price_paisa ?? (si?.['last_unit_price_paisa'] == null ? null : Number(si['last_unit_price_paisa']));
  if (price === null) throw invalid(fieldError(`/lines/${i}/unit_price_paisa`));
  let code: string | null = null;
  if (!l.is_exempt) {
    code = l.tax_code ?? si?.['default_tax_code'] ?? item['default_tax_code'] ?? DEFAULT_TAX; // supplier item -> item -> VAT (TRD #81)
    if (!taxCodes.has(code as string)) throw invalid(fieldError(`/lines/${i}/tax_code`)); // inactive / unknown in the tenant coded set
  }
  let qtyBase: string;
  try { qtyBase = packToBase(l.qty_packs, pack['qty_in_base']); } catch { throw invalid(fieldError(`/lines/${i}/qty_packs`)); }
  return { item_id: l.item_id, pack_id: l.pack_id, qty_packs: l.qty_packs, qty_in_base: pack['qty_in_base'], qty_base: qtyBase, price, discount: l.discount_paisa ?? 0, code };
}

/** One `getTaxRate` per distinct non-exempt code, `on` = the tenant business date; a port error propagates as the SAME object (P-23). */
export async function fetchRates(ctx: HandlerContext, codes: Iterable<string | null>, on: string): Promise<Map<string, number>> {
  const rates = new Map<string, number>();
  for (const code of new Set(codes)) {
    if (code === null) continue;
    const r = await (ctx.ports as any).CatalogPort.getTaxRate(ctx, { taxCode: code, on });
    const bp = r?.ratePercentBasisPoints;
    if (!Number.isInteger(bp) || bp < 0 || bp > 10000) throw new LimsError('common.internal', 'tax rate out of range');
    rates.set(code, bp);
  }
  return rates;
}

export function price(lines: readonly ResolvedLine[], rates: ReadonlyMap<string, number>): PricedLine[] {
  return lines.map((l, n) => {
    const rate = l.code === null ? 0 : rates.get(l.code)!;
    try { return { ...l, rate, amounts: computeLine({ qtyPacks: l.qty_packs, unitPricePaisa: l.price, discountPaisa: l.discount, taxRateBp: rate }) }; }
    catch (e) { if (e instanceof LimsError && e.code === 'common.validation_failed') throw invalid(fieldError(`/lines/${n}/discount_paisa`)); throw e; } // discount > gross is refused, never clamped (§4.2)
  });
}
export const totalsOf = (lines: readonly PricedLine[]) => {
  const t = computeTotals(lines.map((l) => ({ ...l.amounts, discountPaisa: l.discount })));
  return { subtotal_paisa: t.subtotalPaisa, discount_paisa: t.discountPaisa, net_paisa: t.netPaisa, vat_paisa: t.vatPaisa, total_paisa: t.totalPaisa };
};
const insertLines = async (rc: RepoCtx, poId: string, lines: readonly PricedLine[]): Promise<void> => {
  for (const [n, l] of lines.entries()) {
    await insertPoLine(rc, {
      id: uuidv7(), po_id: poId, line_no: n + 1, item_id: l.item_id, pack_id: l.pack_id, qty_packs: l.qty_packs, qty_in_base_snapshot: l.qty_in_base, qty_base: l.qty_base,
      unit_price_paisa: l.price, discount_paisa: l.discount, tax_code: l.code, tax_rate_bp: l.rate, net_paisa: l.amounts.netPaisa, vat_paisa: l.amounts.vatPaisa, line_total_paisa: l.amounts.totalPaisa,
    });
  }
};
export const activeTaxCodes = async (rc: RepoCtx): Promise<Set<string>> => new Set((await listTaxCodes(rc)).map((r) => r['code'] as string));

async function nextNumber(rc: RepoCtx, today: string): Promise<string> {
  const pattern = (await ensureSettings(rc))['po_no_pattern'] as string;
  const period = periodKey(pattern, today);
  for (let n = 0; n < 50; n++) {
    const no = formatNumber(pattern, today, await allocateNumber(rc, 'po', period));
    if ((await first(rc, 'SELECT 1 AS x FROM inventory.purchase_orders WHERE tenant_id = $1 AND po_no = $2', [no])) === null) return no;
  }
  throw new LimsError('common.internal');
}

/** Supplier and store of a draft: unknown -> 404, inactive -> 400 at the field. The store's scope was decided by the caller. */
export async function assertActiveSupplier(rc: RepoCtx, supplierId: string): Promise<void> {
  const s = await getSupplier(rc, supplierId);
  if (s === null) throw notFound();
  if (s['is_active'] !== true) throw invalid(fieldError('/supplier_id'));
}

// ---------------------------------------------------------------- #81 create
export async function createPurchaseOrder(ctx: HandlerContext, input: PoDraftInput): Promise<Dto> {
  const rc = rcOf(ctx);
  const store = await assertStoreAccess(sc(ctx), input.store_id, MANAGE); // 404 invisible / unknown -> 403 (P-B8)
  if (store['is_active'] !== true) throw invalid(fieldError('/store_id'));
  await assertActiveSupplier(rc, input.supplier_id);
  const taxCodes = await activeTaxCodes(rc);
  const memo = new Map<string, Row | null>();
  const resolved: ResolvedLine[] = [];
  for (const [i, l] of input.lines.entries()) resolved.push(await resolveLine(rc, input.supplier_id, l, i, taxCodes, memo));
  const { today } = await clock(ctx);
  const lines = price(resolved, await fetchRates(ctx, resolved.map((l) => l.code), today)); // the port is asked before anything is written
  const id = uuidv7();
  await insertPo(rc, {
    id, po_no: await nextNumber(rc, today), branch_id: store['branch_id'], store_id: store['id'], supplier_id: input.supplier_id, status: 'draft', source: 'manual',
    expected_on: input.expected_on ?? null, notes: input.notes ?? null, ...totalsOf(lines),
  });
  await insertLines(rc, id, lines);
  return view(ctx, rc, id);
}

// ---------------------------------------------------------------- #83 replace draft (D-71, §5.11)
export async function replacePurchaseOrderDraft(ctx: HandlerContext, id: string, ifMatch: number, input: PoDraftInput): Promise<Dto> {
  const rc = rcOf(ctx);
  const po = await lockPo(ctx, rc, id, MANAGE);
  assertTransition(po['status'], 'draft');
  checkVersion(po, ifMatch);
  const store = await assertStoreAccess(sc(ctx), input.store_id, MANAGE); // the draft may move to another visible store
  if (store['is_active'] !== true) throw invalid(fieldError('/store_id'));
  await assertActiveSupplier(rc, input.supplier_id);
  const taxCodes = await activeTaxCodes(rc);
  const memo = new Map<string, Row | null>();
  const resolved: ResolvedLine[] = [];
  for (const [i, l] of input.lines.entries()) resolved.push(await resolveLine(rc, input.supplier_id, l, i, taxCodes, memo));
  const { today } = await clock(ctx);
  const lines = price(resolved, await fetchRates(ctx, resolved.map((l) => l.code), today)); // everything is validated BEFORE a line is removed
  for (const l of await listLines(rc, id)) await removePoLine(rc, l['id'], l['version']);
  await insertLines(rc, id, lines);
  await updatePo(rc, id, ifMatch, {
    branch_id: store['branch_id'], store_id: store['id'], supplier_id: input.supplier_id, expected_on: input.expected_on ?? null, notes: input.notes ?? null, ...totalsOf(lines),
  });
  return view(ctx, rc, id);
}

// ---------------------------------------------------------------- #84 approve (AC-05.2, AC-05.3, PE-1)
export async function approvePurchaseOrder(ctx: HandlerContext, id: string, ifMatch: number): Promise<Dto> {
  const rc = rcOf(ctx);
  const po = await lockPo(ctx, rc, id, APPROVE); // privileged: the port answers auth.mfa_required below aal2
  assertTransition(po['status'], 'approved');
  checkVersion(po, ifMatch);
  if (po['created_by'] === rc.actorId && (await ensureSettings(rc))['po_self_approval_allowed'] !== true) throw new LimsError('inventory.po_self_approval_forbidden');
  if ((await listLines(rc, id)).length === 0) throw invalid(fieldError('/lines')); // P3: at least one line
  await updatePo(rc, id, ifMatch, { status: 'approved', approved_at: (await clock(ctx)).nowIso, approved_by: rc.actorId });
  return view(ctx, rc, id);
}

// ---------------------------------------------------------------- #85 mark sent (AC-05.4)
export async function markPurchaseOrderSent(ctx: HandlerContext, id: string, ifMatch: number, input: SentInput): Promise<Dto> {
  const rc = rcOf(ctx);
  const po = await lockPo(ctx, rc, id, MANAGE);
  assertTransition(po['status'], 'sent');
  checkVersion(po, ifMatch);
  await updatePo(rc, id, ifMatch, { status: 'sent', sent_at: (await clock(ctx)).nowIso, sent_by: rc.actorId, sent_channel: input.sent_channel, sent_reference: input.sent_reference });
  return view(ctx, rc, id);
}

const reasonOk = async (rc: RepoCtx, group: string, code: string): Promise<boolean> => (await listReasons(rc, group)).some((r) => r['code'] === code);

// ---------------------------------------------------------------- #86 cancel (AC-05.5)
export async function cancelPurchaseOrder(ctx: HandlerContext, id: string, ifMatch: number, input: ReasonInput & { reason_code: string }): Promise<Dto> {
  const rc = rcOf(ctx);
  const po = await lockPo(ctx, rc, id, MANAGE);
  if (po['status'] === 'approved' || po['status'] === 'sent') await assertBranch(ctx, po['branch_id'], APPROVE); // privileged (PE-1); read under the row lock, so a racing approve cannot skip it
  assertTransition(po['status'], 'cancelled');
  // 03-APP-FLOW §3.1 P7 / AC-05.5: approved/sent -> cancelled only while no posted GRN references the PO
  if ((po['status'] === 'approved' || po['status'] === 'sent')
    && (await first(rc, "SELECT 1 AS x FROM inventory.goods_receipts WHERE tenant_id = $1 AND po_id = $2 AND status = 'posted'", [id])) !== null) throw new LimsError('inventory.po_invalid_transition');
  checkVersion(po, ifMatch);
  if (!(await reasonOk(rc, 'po_cancel', input.reason_code))) throw new LimsError('inventory.reason_required');
  await updatePo(rc, id, ifMatch, { status: 'cancelled', cancelled_at: (await clock(ctx)).nowIso, cancelled_by: rc.actorId, cancel_reason_code: input.reason_code, cancel_reason_text: input.reason_text });
  return view(ctx, rc, id);
}

// ---------------------------------------------------------------- #87 close (AC-05.6)
export async function closePurchaseOrder(ctx: HandlerContext, id: string, ifMatch: number, input: ReasonInput): Promise<Dto> {
  const rc = rcOf(ctx);
  const po = await lockPo(ctx, rc, id, MANAGE);
  assertTransition(po['status'], 'closed');
  checkVersion(po, ifMatch);
  const open = (await listLines(rc, id)).filter((l) => l['is_closed_short'] !== true && scaled(l['received_qty_base'], 6) < scaled(l['qty_base'], 6));
  if ((open.length > 0 && input.reason_code === undefined) || (input.reason_code !== undefined && !(await reasonOk(rc, 'po_close', input.reason_code)))) throw new LimsError('inventory.reason_required');
  for (const l of open) await updatePoLine(rc, l['id'], l['version'], { is_closed_short: true }); // lifecycle column: allowed while the PO is partially_received (tg_line_guard)
  await updatePo(rc, id, ifMatch, { status: 'closed', closed_at: (await clock(ctx)).nowIso, closed_by: rc.actorId, close_reason_code: input.reason_code, close_reason_text: input.reason_text });
  return view(ctx, rc, id);
}

// ---------------------------------------------------------------- #88 from reorder (AC-20.4)
type Skip = 'no_preferred_supplier' | 'no_pack' | 'not_below_reorder' | 'open_po_exists';
const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

export async function createPurchaseOrdersFromReorder(ctx: HandlerContext, input: ReorderInput): Promise<Dto> {
  const rc = rcOf(ctx);
  const store = await assertStoreAccess(sc(ctx), input.store_id, MANAGE);
  const wanted = input.item_ids === undefined ? undefined : [...new Set(input.item_ids)];
  const skipped: { item_id: string; reason: Skip }[] = [];
  const q = new Q();
  const settings = await query(rc, `SELECT s.item_id, s.reorder_qty_base, s.preferred_supplier_id, i.is_active AS item_active, i.default_tax_code,
         (coalesce((SELECT sum(b.qty_base) FROM inventory.stock_balances b WHERE b.tenant_id = s.tenant_id AND b.store_id = s.store_id AND b.item_id = s.item_id), 0) < s.reorder_level_base) AS below
      FROM inventory.store_item_settings s JOIN inventory.items i ON i.tenant_id = s.tenant_id AND i.id = s.item_id
     WHERE s.tenant_id = $1 AND s.store_id = ${q.p(store['id'])} AND s.is_active AND s.is_stocked AND s.reorder_level_base IS NOT NULL${wanted === undefined ? '' : ` AND s.item_id = ANY(${q.p(wanted)}::uuid[])`}
     ORDER BY s.item_id`, q.vals);
  if (wanted !== undefined) { // a requested item without an active reorder setting: reported when it exists in this tenant, ignored otherwise
    const have = new Set(settings.map((s) => s['item_id'] as string));
    const missing = wanted.filter((w) => !have.has(w));
    if (missing.length > 0) {
      const known = new Set((await query(rc, 'SELECT id FROM inventory.items WHERE tenant_id = $1 AND id = ANY($2::uuid[])', [missing])).map((r) => r['id'] as string));
      for (const m of missing) if (known.has(m)) skipped.push({ item_id: m, reason: 'not_below_reorder' });
    }
  }
  const live = settings.filter((s) => s['item_active'] === true); // an inactive item is never ordered (no reason in the contract enum: left out)
  const candidates: Row[] = [];
  for (const s of live) {
    if (s['below'] !== true || s['reorder_qty_base'] === null) skipped.push({ item_id: s['item_id'], reason: 'not_below_reorder' });
    else candidates.push(s);
  }
  const supplierIds = [...new Set(candidates.flatMap((s) => (s['preferred_supplier_id'] ? [s['preferred_supplier_id'] as string] : [])))];
  const okSuppliers = new Set(supplierIds.length === 0 ? [] : (await query(rc, 'SELECT id FROM inventory.suppliers WHERE tenant_id = $1 AND is_active AND id = ANY($2::uuid[])', [supplierIds])).map((r) => r['id'] as string));
  const withSupplier: Row[] = [];
  for (const s of candidates) { if (okSuppliers.has(s['preferred_supplier_id'])) withSupplier.push(s); else skipped.push({ item_id: s['item_id'], reason: 'no_preferred_supplier' }); }
  const ids = withSupplier.map((s) => s['item_id'] as string);
  const openIds = new Set(ids.length === 0 ? [] : (await query(rc, `SELECT DISTINCT l.item_id FROM inventory.purchase_order_lines l JOIN inventory.purchase_orders p ON p.tenant_id = l.tenant_id AND p.id = l.po_id
      WHERE l.tenant_id = $1 AND p.store_id = $2 AND p.status = ANY($3::text[]) AND l.removed_at IS NULL AND l.item_id = ANY($4::uuid[])`, [store['id'], OPEN_STATUSES, ids])).map((r) => r['item_id'] as string));
  const packs = ids.length === 0 ? [] : await query(rc, `SELECT si.supplier_id, si.item_id, si.pack_id, si.last_unit_price_paisa, si.default_tax_code, p.qty_in_base, p.is_purchase_default
      FROM inventory.supplier_items si JOIN inventory.item_packs p ON p.tenant_id = si.tenant_id AND p.id = si.pack_id AND p.item_id = si.item_id
     WHERE si.tenant_id = $1 AND si.is_active AND p.is_active AND si.item_id = ANY($2::uuid[]) AND si.supplier_id = ANY($3::uuid[]) ORDER BY si.id`, [ids, supplierIds]);

  const taxCodes = await activeTaxCodes(rc);
  const bySupplier = new Map<string, ResolvedLine[]>();
  for (const s of withSupplier) {
    if (openIds.has(s['item_id'])) { skipped.push({ item_id: s['item_id'], reason: 'open_po_exists' }); continue; }
    const mine = packs.filter((p) => p['supplier_id'] === s['preferred_supplier_id'] && p['item_id'] === s['item_id']);
    // the item's purchase-default pack if it has an active supplier item, else the active one with the largest qty_in_base (AC-20.4)
    const pick = mine.find((p) => p['is_purchase_default'] === true) ?? mine.reduce<Row | null>((b, p) => (b === null || scaled(p['qty_in_base'], 6) > scaled(b['qty_in_base'], 6) ? p : b), null);
    if (pick === null) { skipped.push({ item_id: s['item_id'], reason: 'no_pack' }); continue; }
    const code = pick['default_tax_code'] ?? s['default_tax_code'] ?? DEFAULT_TAX;
    if (!taxCodes.has(code)) throw invalid(fieldError('/item_ids')); // the chosen code is not usable in this tenant: refuse the run rather than invent a code
    const packsNeeded = ceilDiv(scaled(s['reorder_qty_base'], 6), scaled(pick['qty_in_base'], 6)); // whole packs, rounded UP; an exact multiple adds nothing
    const qtyPacks = packsNeeded.toString();
    const list = bySupplier.get(s['preferred_supplier_id']) ?? [];
    list.push({
      item_id: s['item_id'], pack_id: pick['pack_id'], qty_packs: qtyPacks, qty_in_base: pick['qty_in_base'], qty_base: packToBase(qtyPacks, pick['qty_in_base']),
      price: pick['last_unit_price_paisa'] === null ? 0 : Number(pick['last_unit_price_paisa']), discount: 0, code,
    });
    bySupplier.set(s['preferred_supplier_id'], list);
  }

  const { today } = await clock(ctx);
  const rates = await fetchRates(ctx, [...bySupplier.values()].flat().map((l) => l.code), today); // P-23: a failure aborts the whole run before any write
  const created: Dto[] = [];
  const perms = await permissionsOf(ctx);
  for (const [supplierId, resolved] of bySupplier) {
    const lines = price(resolved, rates);
    const id = uuidv7();
    const po = await insertPo(rc, { id, po_no: await nextNumber(rc, today), branch_id: store['branch_id'], store_id: store['id'], supplier_id: supplierId, status: 'draft', source: 'reorder', ...totalsOf(lines) });
    await insertLines(rc, id, lines);
    created.push(toPoSummaryDto(wire({ ...po, expected_on: null }), perms));
  }
  return { created, skipped };
}

// ---------------------------------------------------------------- #89 print view (money-only: inventory.cost.read, 02-TRD §6.3)
export async function getPurchaseOrderPrintView(ctx: HandlerContext, id: string): Promise<Dto> {
  const rc = rcOf(ctx);
  const po = await loadPo(rc, id);
  if (po === null) throw notFound();
  await assertBranch(ctx, po['branch_id'], READ);
  await ctx.ports.IdentityPort.assertRole(ctx, { permission: COST, branchId: po['branch_id'] });
  const core = ctx.core as unknown as { tenant(c: unknown): Promise<{ displayName: string }>; branch(c: unknown, i: { branchId: string }): Promise<{ name: string }> };
  const [tenant, branch, supplier, lines] = await Promise.all([
    core.tenant(ctx), core.branch(ctx, { branchId: po['branch_id'] }), getSupplier(rc, po['supplier_id']),
    query(rc, `SELECT l.line_no, i.item_code, i.name AS item_name, k.label AS pack_label, l.qty_packs, l.unit_price_paisa, l.discount_paisa, l.tax_code, (l.tax_code IS NULL) AS is_exempt, l.line_total_paisa
        FROM inventory.purchase_order_lines l
        JOIN inventory.items i ON i.tenant_id = l.tenant_id AND i.id = l.item_id
        JOIN inventory.item_packs k ON k.tenant_id = l.tenant_id AND k.id = l.pack_id
       WHERE l.tenant_id = $1 AND l.po_id = $2 AND l.removed_at IS NULL ORDER BY l.line_no, l.id`, [id]),
  ]);
  return toPoPrintViewDto({ ...wire(po), is_draft: po['status'] === 'draft', tenant_display_name: tenant.displayName, branch_name: branch.name, supplier: wire(supplier ?? {}), lines: lines.map(wire) }, await permissionsOf(ctx));
}
