// C12.T-10 stock documents #41-#48 (02-TRD §5.3, §4.4 FEFO, §4.7 tenant time; 03-APP-FLOW §4.3; PRD AC-08.x, AC-09.1, AC-11.x; 07-SECURITY P-B1 / P-B2 / P-B8, PE-1..PE-3; 08 A17 D-75).
// Order inside a write, always: scope (assertStoreAccess: 404 invisible -> 403) -> count lock -> line validation -> reasons -> FEFO split -> header -> ledger.post -> lines.
// Money is never computed here (TRD §4.3): the ledger values every movement (D-75 inbound into a negative unlotted row included); a document line carries |movement value|.
// [CONV] LD-140 is UI-only and does not apply here.
// [CONV] the header is inserted BEFORE the ledger post (bad supplier / GRN / department / instrument fail before any stock moves), the lines AFTER it (value_paisa is only known then; stock_movements.doc_line_id has no FK).
// [CONV] FEFO split: one document line per lot used, in FEFO order (08 A17 D-71 style); a lot-less INBOUND line (return / adjustment in) posts to the item's unlotted row, which is what D-75 values.
// [CONV] an outbound from an unlotted row (item not lot tracked) is refused when the row would end below 0: the ledger lets unlotted rows go negative (consumption), a manual document must not.
// [CONV] count lock (settings.count_locks_store + an open count) applies to #43, #44, #48 only (the contract lists store_locked_for_count for those three).
// [CONV] usability of an EXPLICIT lot (available, not expired in tenant time) is checked for #43 / #44 only; wastage, supplier return, adjustment and expiry write-off act on any lot.
// ponytail: the FEFO candidates are read unlocked; a parallel issue that drains a lot between the read and the post makes the ledger answer insufficient_stock (409) although a later lot might have covered it.
// ponytail: created_by_display is not sent on the document's movements (optional in the contract); #35 has it.
import { LimsError } from '../../../core/errors.js';
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import type { HandlerContext } from '../../../core/module.js';
import { type FefoCandidate, suggestFefo } from '../domain/fefo.js';
import { formatNumber, periodKey } from '../domain/numbering.js';
import { formatScaled, packToBase, parseBaseQty, scaled } from '../domain/quantity.js';
import { assertZone, nowMs, ymdIn } from '../domain/tenantTime.js';
import { fieldError, invalid } from '../handlers/items.schemas.js';
import type { DocInput, DocLineInput, DocListQuery, WriteOffInput } from '../handlers/documents.schemas.js';
import { toStockDocumentDto } from '../mappers/stockDocument.dto.js';
import { listReasons } from '../repository/codedSets.repo.js';
import { allocateNumber } from '../repository/counters.repo.js';
import { insertStockDocument, insertStockDocumentLine } from '../repository/documents.repo.js';
import { getItem, getPack } from '../repository/items.repo.js';
import { ensureSettings, getSettings } from '../repository/settings.repo.js';
import { type RepoCtx, type Row, Q, first, isUuid, query } from '../repository/_base.js';
import { PERMISSIONS } from '../permissions.js';
import { post as ledgerPost, type Movement } from './ledger.service.js';
import { assertStoreAccess, listVisibleBranchIds } from './scope.service.js';

type Dto = Record<string, unknown>;
type Scope = Parameters<typeof assertStoreAccess>[0];
export type DocKind = 'issue' | 'return_to_store' | 'supplier_return' | 'wastage' | 'adjustment' | 'expiry_writeoff';
const rcOf = (ctx: HandlerContext): RepoCtx => ({ tx: ctx.tx as RepoCtx['tx'], tenantId: ctx.tenantId as string, actorId: ctx.actor?.id as string });
const sc = (ctx: HandlerContext): Scope => ctx as unknown as Scope;
const notFound = (): LimsError => new LimsError('common.not_found');
const READ = PERMISSIONS.itemRead;
const MANAGE = PERMISSIONS.stockManage;
const ADJUST = PERMISSIONS.stockAdjust;
const FUTURE_SLACK_MS = 300_000; // 02-TRD §4.7: an instant may lie at most 300 s ahead of the clock
const ZERO = '0.000000';

// ---------------------------------------------------------------- DB error mapping (P-1): a foreign / unknown header reference is the same 404 as a missing row
const BY_CONSTRAINT = new Set(['stock_documents__store__fk', 'stock_documents__department__fk', 'stock_documents__instrument__fk', 'stock_documents__supplier__fk', 'stock_documents__grn__fk']);
const mapped = async <T>(p: Promise<T>): Promise<T> => {
  try { return await p; } catch (e) {
    if (BY_CONSTRAINT.has((e as { constraint?: string } | null)?.constraint ?? '')) throw notFound();
    throw e;
  }
};

// ---------------------------------------------------------------- wire helpers: null is never sent (CV §4.2), timestamps are ISO, bigint money is a number
const MONEY = /_paisa(_x1e6)?$/;
function wire(row: Row): Row {
  const o: Row = {};
  for (const [k, v] of Object.entries(row)) {
    if (v === null || v === undefined) continue;
    o[k] = v instanceof Date ? v.toISOString() : MONEY.test(k) ? Number(v) : v;
  }
  return o;
}
const permissionsOf = async (ctx: HandlerContext): Promise<readonly string[]> => (await (ctx.ports.IdentityPort as any).getActor(ctx)).permissions ?? [];

interface Clock { tz: string; now: number; today: string }
async function clock(ctx: HandlerContext): Promise<Clock> {
  const s = await (ctx.ports.IdentityPort as any).getTenantSettings(ctx, { keys: ['timezone'] });
  const tz = assertZone(s?.timezone);
  const now = nowMs((ctx as any).now());
  return { tz, now, today: ymdIn(now, tz) };
}

/** AC-19.4: with settings.count_locks_store, a store with an open count takes no manual movement. */
export async function assertNotCounting(rc: RepoCtx, storeId: string): Promise<void> {
  if ((await getSettings(rc))?.['count_locks_store'] !== true) return;
  const open = await first(rc, "SELECT 1 AS x FROM inventory.stock_counts WHERE tenant_id = $1 AND status = 'open' AND store_id = $2 LIMIT 1", [storeId]);
  if (open !== null) throw new LimsError('inventory.store_locked_for_count');
}

// ---------------------------------------------------------------- read model (#42 and the answer of every write)
const SUMMARY = ['id', 'doc_no', 'doc_kind', 'store_id', 'occurred_at', 'business_date', 'issued_to_kind', 'department_id', 'instrument_id', 'supplier_id', 'grn_id', 'container_id', 'reason_code', 'reason_text', 'line_count'] as const;
const BUSINESS_DATE = (tz: string): string => `to_char(d.occurred_at AT TIME ZONE ${tz}, 'YYYY-MM-DD') AS business_date`; // `tz` = placeholder holding the tenant timezone

/** The StockDocument as the contract shows it: lines in line order, one movement per line, cost keys only with inventory.cost.read (PE-3). */
export async function viewDocument(ctx: HandlerContext, rc: RepoCtx, id: string): Promise<Dto> {
  const { tz } = await clock(ctx);
  const h = await first(rc, `SELECT d.*, ${BUSINESS_DATE('$2')} FROM inventory.stock_documents d WHERE d.tenant_id = $1 AND d.id = $3`, [tz, id]);
  if (h === null) throw notFound();
  const lines = await query(rc, 'SELECT * FROM inventory.stock_document_lines WHERE tenant_id = $1 AND document_id = $2 ORDER BY line_no', [id]);
  const movements = await query(rc, `SELECT m.id, m.occurred_at, to_char(m.business_date, 'YYYY-MM-DD') AS business_date, m.store_id, m.item_id, m.lot_id, l.lot_no, m.movement_kind, m.qty_base,
      m.balance_qty_after, m.value_paisa, m.value_basis, m.doc_type, m.doc_id, m.instrument_id, m.attributed_test_id, m.rule_id, m.reason_code
    FROM inventory.stock_movements m
    JOIN inventory.stock_document_lines dl ON dl.tenant_id = m.tenant_id AND dl.id = m.doc_line_id
    LEFT JOIN inventory.lots l ON l.tenant_id = m.tenant_id AND l.id = m.lot_id
   WHERE m.tenant_id = $1 AND m.doc_type = 'stock_document' AND m.doc_id = $2 ORDER BY dl.line_no, m.id`, [id]);
  return toStockDocumentDto({ ...wire(h), lines: lines.map(wire), movements: movements.map((m) => ({ ...wire(m), doc_no: h['doc_no'] })) }, await permissionsOf(ctx));
}

// ---------------------------------------------------------------- #41 list
export async function listDocuments(ctx: HandlerContext, f: DocListQuery): Promise<Dto> {
  const rc = rcOf(ctx);
  if (f.store_id !== undefined) await assertStoreAccess(sc(ctx), f.store_id, READ); // 404 invisible / unknown -> 403
  const { tz } = await clock(ctx);
  const q = new Q();
  const tzp = q.p(tz);
  let w = '';
  if (f.store_id !== undefined) w += ` AND d.store_id = ${q.p(f.store_id)}`;
  else { // P-B1: without a store the list covers the visible branches only
    const v = await listVisibleBranchIds(sc(ctx));
    if (!v.all) w += ` AND d.store_id IN (SELECT id FROM inventory.stores WHERE tenant_id = $1 AND branch_id = ANY(${q.p([...v.branchIds])}::uuid[]))`;
  }
  if (f.doc_kind !== undefined) w += ` AND d.doc_kind = ${q.p(f.doc_kind)}`;
  if (f.occurred_at_from !== undefined) w += ` AND d.occurred_at >= ${q.p(f.occurred_at_from)}::timestamptz`;
  if (f.occurred_at_to !== undefined) w += ` AND d.occurred_at <= ${q.p(f.occurred_at_to)}::timestamptz`;
  if (f.cursor !== undefined) w += ` AND d.id < ${q.p(cursorId(f.cursor))}::uuid`;
  const rows = await query(rc, `SELECT d.*, ${BUSINESS_DATE(tzp)},
      (SELECT count(*) FROM inventory.stock_document_lines l WHERE l.tenant_id = d.tenant_id AND l.document_id = d.id)::int AS line_count
    FROM inventory.stock_documents d WHERE d.tenant_id = $1${w} ORDER BY d.id DESC LIMIT ${q.p(f.limit + 1)}`, q.vals); // ponytail: ids are uuidv7 (creation order); keyset on id
  const data = rows.slice(0, f.limit);
  const next = rows.length > f.limit ? Buffer.from(JSON.stringify({ i: data[data.length - 1]!['id'] })).toString('base64url') : undefined;
  return {
    data: data.map((r) => { const o = wire(r); return Object.fromEntries(SUMMARY.filter((k) => o[k] !== undefined).map((k) => [k, o[k]])); }),
    page: { limit: f.limit, ...(next === undefined ? {} : { next_cursor: next }) },
  };
}
function cursorId(cursor: string): string {
  let id: unknown;
  try { id = (JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { i?: unknown } | null)?.i; } catch { /* 400 below */ }
  if (!isUuid(id)) throw invalid(fieldError('/cursor'));
  return id;
}

// ---------------------------------------------------------------- #42 get
export async function getDocument(ctx: HandlerContext, id: string): Promise<Dto> {
  const rc = rcOf(ctx);
  const d = await first(rc, 'SELECT store_id FROM inventory.stock_documents WHERE tenant_id = $1 AND id = $2', [id]);
  if (d === null) throw notFound();
  await assertStoreAccess(sc(ctx), d['store_id'], READ); // the document's store decides: invisible -> 404 (P-B2), visible without the permission -> 403
  return viewDocument(ctx, rc, id);
}

// ---------------------------------------------------------------- writing
interface Head {
  kind: DocKind; store_id: string; occurred_at?: string; reason_code?: string | null; reason_text?: string | null; issued_to_kind?: string | null; department_id?: string | null;
  instrument_id?: string | null; supplier_id?: string | null; grn_id?: string | null; container_id?: string | null;
  /** Allocated by the caller when it takes row locks of its own first: lock order is always number counter -> balance rows (the ledger), never the reverse (deadlock). */
  doc_no?: string;
}
/** One resolved line of a document: `lot_id` null = the unlotted row; `reason` = the per-line reason (#46 only). */
interface Planned { item_id: string; lot_id: string | null; qty: string; direction: 'in' | 'out'; reason: string | null }

const MOVEMENT_KIND: Record<DocKind, { in?: string; out?: string }> = {
  issue: { out: 'issue' }, return_to_store: { in: 'return_to_store' }, supplier_return: { out: 'supplier_return' }, wastage: { out: 'wastage' },
  expiry_writeoff: { out: 'expiry_writeoff' }, adjustment: { in: 'adjust_in', out: 'adjust_out' },
};

async function nextDocNo(rc: RepoCtx, today: string): Promise<string> {
  const pattern = (await ensureSettings(rc))['doc_no_pattern'] as string;
  const period = periodKey(pattern, today);
  for (let n = 0; n < 50; n++) { // a counter that is behind imported / seeded numbers must not make a create fail
    const no = formatNumber(pattern, today, await allocateNumber(rc, 'doc', period));
    if ((await first(rc, 'SELECT 1 AS x FROM inventory.stock_documents WHERE tenant_id = $1 AND doc_no = $2', [no])) === null) return no;
  }
  throw new LimsError('common.internal');
}

/** Header -> ledger -> lines. Returns the new document id. A refusal anywhere throws; the request transaction rolls the whole document back. */
async function commit(rc: RepoCtx, ck: Clock, head: Head, planned: readonly Planned[]): Promise<string> {
  const occurredMs = head.occurred_at === undefined ? ck.now : Date.parse(head.occurred_at);
  if (occurredMs > ck.now + FUTURE_SLACK_MS) throw invalid(fieldError('/occurred_at'));
  if (head.occurred_at !== undefined) { // 02-TRD §4.7: occurred_at in [now - backdate_max_days, now + 300 s], else 400 (T-10 review item 1)
    const days = Number((await ensureSettings(rc))['backdate_max_days'] ?? 7);
    if (occurredMs < ck.now - days * 86_400_000) throw invalid(fieldError('/occurred_at'));
  }
  const occurredIso = new Date(occurredMs).toISOString();
  const business = ymdIn(occurredMs, ck.tz); // TENANT-time date of occurred_at (not the UTC date)
  const id = uuidv7();
  await mapped(insertStockDocument(rc, {
    id, doc_no: head.doc_no ?? await nextDocNo(rc, ck.today), doc_kind: head.kind, store_id: head.store_id, occurred_at: occurredIso, issued_to_kind: head.issued_to_kind ?? null,
    department_id: head.department_id ?? null, instrument_id: head.instrument_id ?? null, supplier_id: head.supplier_id ?? null, grn_id: head.grn_id ?? null,
    reason_code: head.reason_code ?? null, reason_text: head.reason_text === '' ? null : head.reason_text ?? null, container_id: head.container_id ?? null,
  }));
  const lineIds = planned.map(() => uuidv7());
  const movements: Movement[] = planned.map((p, j) => {
    const kind = MOVEMENT_KIND[head.kind][p.direction] as string;
    const reason = p.reason ?? head.reason_code ?? null;
    return { store_id: head.store_id, item_id: p.item_id, lot_id: p.lot_id, kind, qty_base: p.direction === 'out' ? `-${p.qty}` : p.qty, doc_line_id: lineIds[j]!, ...(reason === null ? {} : { reason_code: reason }) };
  });
  const rows = await ledgerPost(rc, { doc_type: 'stock_document', doc_id: id, occurred_at: occurredIso, business_date: business, movements });
  for (const r of rows) if (r['lot_id'] === null && Number(r['qty_base']) < 0 && Number(r['balance_qty_after']) < 0) throw new LimsError('inventory.insufficient_stock'); // see [CONV] above
  for (const [j, p] of planned.entries()) {
    const value = rows.filter((r) => r['doc_line_id'] === lineIds[j]).reduce((a, r) => a + abs(BigInt(r['value_paisa'])), 0n);
    await insertStockDocumentLine(rc, { id: lineIds[j], document_id: id, line_no: j + 1, item_id: p.item_id, lot_id: p.lot_id, direction: p.direction, qty_base: p.qty, value_paisa: value.toString(), reason_code: p.reason });
  }
  return id;
}
const abs = (v: bigint): bigint => (v < 0n ? -v : v);

// ---------------------------------------------------------------- line resolution (validation before any write)
interface Cfg { perm: string; lock: boolean; usable: boolean; active: boolean; group: 'wastage' | 'supplier_return' | 'adjustment' | null }
const CFG: Record<Exclude<DocKind, 'expiry_writeoff'>, Cfg> = {
  issue: { perm: MANAGE, lock: true, usable: true, active: true, group: null },
  return_to_store: { perm: MANAGE, lock: true, usable: true, active: true, group: null },
  supplier_return: { perm: MANAGE, lock: false, usable: false, active: false, group: 'supplier_return' },
  wastage: { perm: MANAGE, lock: false, usable: false, active: false, group: 'wastage' },
  adjustment: { perm: ADJUST, lock: true, usable: false, active: false, group: 'adjustment' },
};
const lotRow = (rc: RepoCtx, id: string): Promise<Row | null> =>
  first(rc, `SELECT id, item_id, status, to_char(expiry_on, 'YYYY-MM-DD') AS expiry_on FROM inventory.lots WHERE tenant_id = $1 AND id = $2`, [id]);

interface Resolved { item: Row; lot_id: string | null; qty: string; direction: 'in' | 'out'; reason: string | null }
async function resolveLine(rc: RepoCtx, kind: DocKind, cfg: Cfg, today: string, l: DocLineInput, i: number): Promise<Resolved> {
  const item = await getItem(rc, l.item_id);
  if (item === null) throw notFound();
  if (cfg.active && item['is_active'] !== true) throw new LimsError('inventory.item_inactive');
  let qty: string;
  if (l.pack_id !== undefined) { // packs are resolved server-side: round_half_up(packs x qty_in_base, 6)
    const pack = await getPack(rc, l.pack_id);
    if (pack === null) throw notFound();
    if (pack['item_id'] !== l.item_id) throw new LimsError('inventory.uom_mismatch');
    try { qty = parseBaseQty(packToBase(l.qty, pack['qty_in_base'])); } catch { throw invalid(fieldError(`/lines/${i}/qty`)); }
  } else qty = formatScaled(scaled(parseBaseQty(l.qty), 6), 6);
  if (l.lot_id !== undefined) {
    if (item['is_lot_tracked'] !== true) throw invalid(fieldError(`/lines/${i}/lot_id`));
    const lot = await lotRow(rc, l.lot_id);
    if (lot === null || lot['item_id'] !== l.item_id) throw notFound();
    if (cfg.usable) {
      if (lot['status'] !== 'available') throw new LimsError('inventory.lot_unavailable'); // AC-07.3
      if (lot['expiry_on'] !== null && lot['expiry_on'] < today) throw new LimsError('inventory.lot_expired'); // AC-07.4: expiry_on < today in tenant time
    }
  }
  const direction = kind === 'return_to_store' ? 'in' : kind === 'adjustment' ? (l.direction as 'in' | 'out') : 'out';
  return { item, lot_id: l.lot_id ?? null, qty, direction, reason: l.reason_code ?? null };
}

async function assertReasons(rc: RepoCtx, group: NonNullable<Cfg['group']>, head: string | undefined, lines: readonly Resolved[]): Promise<void> {
  const codes = new Set((await listReasons(rc, group)).map((r) => r['code'] as string)); // active codes of the group, tenant codes shadow global ones
  if (head === undefined || !codes.has(head)) throw new LimsError('inventory.reason_required'); // AC-11.1: omitted / unknown / inactive / other group -> 422
  if (lines.some((l) => l.reason !== null && !codes.has(l.reason))) throw new LimsError('inventory.reason_required');
}

// ---------------------------------------------------------------- FEFO split (02-TRD §4.4): lot-less outbound lines of lot-tracked items
async function fefoInputs(rc: RepoCtx, ck: Clock, store: string, itemId: string): Promise<{ cands: FefoCandidate[]; left: Map<string, bigint> }> {
  const cand = await query(rc, `SELECT l.id AS lot_id, l.lot_no, to_char(l.expiry_on, 'YYYY-MM-DD') AS expiry_on, l.created_at, b.qty_base
      FROM inventory.stock_balances b JOIN inventory.lots l ON l.tenant_id = b.tenant_id AND l.id = b.lot_id
     WHERE b.tenant_id = $1 AND b.store_id = $2 AND b.item_id = $3 AND b.qty_base > 0 AND l.status = 'available' AND (l.expiry_on IS NULL OR l.expiry_on >= $4::date)`, [store, itemId, ck.today]);
  const open = cand.length === 0 ? [] : await query(rc, `SELECT lot_id, open_expiry_at FROM inventory.opened_containers
     WHERE tenant_id = $1 AND store_id = $2 AND item_id = $3 AND status = 'open' AND lot_id = ANY($4::uuid[])`, [store, itemId, cand.map((c) => c['lot_id'])]);
  return {
    left: new Map(cand.map((c) => [c['lot_id'] as string, scaled(c['qty_base'], 6)])),
    cands: cand.map((c) => ({
      lotId: c['lot_id'], lotNo: c['lot_no'], expiryOn: c['expiry_on'], createdAt: (c['created_at'] as Date).toISOString(), availableQtyBase: ZERO,
      openContainers: open.filter((o) => o['lot_id'] === c['lot_id']).map((o) => ({ openExpiryAt: o['open_expiry_at'] === null ? null : (o['open_expiry_at'] as Date).toISOString() })),
    })),
  };
}

async function plan(rc: RepoCtx, ck: Clock, store: string, lines: readonly Resolved[]): Promise<Planned[]> {
  const named = new Map<string, bigint>(); // `${item}|${lot}` -> base units the document takes from a named lot: FEFO lines only see what is left
  for (const l of lines) if (l.direction === 'out' && l.lot_id !== null) named.set(`${l.item.id}|${l.lot_id}`, (named.get(`${l.item.id}|${l.lot_id}`) ?? 0n) + scaled(l.qty, 6));
  const state = new Map<string, Awaited<ReturnType<typeof fefoInputs>>>();
  const out: Planned[] = [];
  for (const l of lines) {
    const item_id = l.item.id as string;
    if (l.direction === 'in' || l.lot_id !== null || l.item['is_lot_tracked'] !== true) { out.push({ item_id, lot_id: l.lot_id, qty: l.qty, direction: l.direction, reason: l.reason }); continue; }
    if (!state.has(item_id)) {
      const s = await fefoInputs(rc, ck, store, item_id);
      for (const [lot, q] of s.left) s.left.set(lot, q - (named.get(`${item_id}|${lot}`) ?? 0n));
      state.set(item_id, s);
    }
    const s = state.get(item_id)!;
    const r = suggestFefo({
      candidates: s.cands.map((c) => ({ ...c, availableQtyBase: formatScaled(s.left.get(c.lotId)! > 0n ? s.left.get(c.lotId)! : 0n, 6) })),
      qtyBase: l.qty, now: new Date(ck.now).toISOString(), timezone: ck.tz,
    });
    if (r.shortfallQtyBase !== ZERO) throw new LimsError('inventory.insufficient_stock');
    for (const f of r.lines) {
      s.left.set(f.lotId, s.left.get(f.lotId)! - scaled(f.takeQtyBase, 6));
      out.push({ item_id, lot_id: f.lotId, qty: f.takeQtyBase, direction: 'out', reason: l.reason });
    }
  }
  return out;
}

/** #43-#46, #48 and the discard of #40: everything after the scope check. Returns the document id. */
export async function postDocument(ctx: HandlerContext, kind: Exclude<DocKind, 'expiry_writeoff'>, input: DocInput & { container_id?: string }): Promise<string> {
  const rc = rcOf(ctx);
  const cfg = CFG[kind];
  if (cfg.lock) await assertNotCounting(rc, input.store_id); // before the lines: a locked store answers 409 whatever the lines say
  const ck = await clock(ctx);
  const lines: Resolved[] = [];
  for (const [i, l] of input.lines.entries()) lines.push(await resolveLine(rc, kind, cfg, ck.today, l, i));
  if (cfg.group !== null) await assertReasons(rc, cfg.group, input.reason_code, lines);
  const planned = await plan(rc, ck, input.store_id, lines);
  return commit(rc, ck, { kind, ...input }, planned);
}

async function create(ctx: HandlerContext, kind: Exclude<DocKind, 'expiry_writeoff'>, input: DocInput): Promise<Dto> {
  const rc = rcOf(ctx);
  await assertStoreAccess(sc(ctx), input.store_id, CFG[kind].perm); // #48 is privileged: the identity port refuses aal1 with auth.mfa_required (PE-1)
  return viewDocument(ctx, rc, await postDocument(ctx, kind, input));
}
export const createStockIssue = (ctx: HandlerContext, input: DocInput): Promise<Dto> => create(ctx, 'issue', input);
export const createStoreReturn = (ctx: HandlerContext, input: DocInput): Promise<Dto> => create(ctx, 'return_to_store', input);
export const createSupplierReturn = (ctx: HandlerContext, input: DocInput): Promise<Dto> => create(ctx, 'supplier_return', input);
export const recordWastage = (ctx: HandlerContext, input: DocInput): Promise<Dto> => create(ctx, 'wastage', input);
export const createStockAdjustment = (ctx: HandlerContext, input: DocInput): Promise<Dto> => create(ctx, 'adjustment', input);

// ---------------------------------------------------------------- #47 write off expired stock (AC-11.2)
/** One expiry_writeoff per (lot, store) for the FULL quantity the server reads under a row lock; a lot that is not expired or holds nothing is a per-line 400 and nothing is written. */
export async function writeOffExpiredStock(ctx: HandlerContext, input: WriteOffInput): Promise<Dto> {
  const rc = rcOf(ctx);
  await assertStoreAccess(sc(ctx), input.store_id, MANAGE);
  const ck = await clock(ctx);
  const docNo = await nextDocNo(rc, ck.today); // before the balance locks below
  const lots = new Map((await query(rc, `SELECT id, item_id, to_char(expiry_on, 'YYYY-MM-DD') AS expiry_on FROM inventory.lots WHERE tenant_id = $1 AND id = ANY($2::uuid[])`, [input.lot_ids]))
    .map((r) => [r['id'] as string, r]));
  if (input.lot_ids.some((id) => !lots.has(id))) throw notFound(); // unknown / other tenant: no oracle
  const held = new Map((await query(rc, `SELECT lot_id, qty_base FROM inventory.stock_balances WHERE tenant_id = $1 AND store_id = $2 AND lot_id = ANY($3::uuid[]) AND qty_base > 0
      ORDER BY item_id, lot_id FOR UPDATE`, [input.store_id, input.lot_ids])).map((r) => [r['lot_id'] as string, r['qty_base'] as string])); // same lock order as the ledger
  const errs = input.lot_ids.flatMap((id, i) => {
    const expiry = lots.get(id)!['expiry_on'] as string | null;
    return expiry === null || expiry >= ck.today || !held.has(id) ? [fieldError(`/lot_ids/${i}`)] : [];
  });
  if (errs.length > 0) throw invalid(...errs);
  const planned: Planned[] = input.lot_ids.map((id) => ({ item_id: lots.get(id)!['item_id'], lot_id: id, qty: formatScaled(scaled(held.get(id)!, 6), 6), direction: 'out', reason: null }));
  return viewDocument(ctx, rc, await commit(rc, ck, { kind: 'expiry_writeoff', store_id: input.store_id, doc_no: docNo }, planned));
}
