// C12.T-13 transfers #56-#62 (02-TRD §5.5, §5.11; 03-APP-FLOW §3.3 T1-T4; PRD AC-10.1-10.4, AC-19.4; 07-SECURITY P-B3 / P-B8 / P-T1-P-T4; 08 A17 D-69, D-71).
// Order on #59-#62, always: scope (assertTransferAccess: 404 invisible -> 403 acted-on end) -> row lock -> transition (409 inventory.document_invalid_transition) -> If-Match (409 common.version_conflict) -> body rules.
// Money never computed in TS (TRD §4.3): the ledger values every transfer_out / wastage; the only own arithmetic is the receive pro-rata, one SQL `round(numeric)` (half-up) statement.
// [CONV] LD-140 is UI-only and does not apply here.
// [CONV] D-69 receive: destination transfer_in +r at round_half_up(r / d x V); a shortfall (d - r) posts at the SOURCE, same (store, item, lot) row, transfer_in +(d - r) at V - destination value, then wastage -(d - r), reason = the line's discrepancy code.
// [CONV] D-71 dispatch FEFO split: when any line has no lot (lot-tracked item), every current line is soft-removed and the resolved lines are inserted as 1..n (the partial unique is WHERE removed_at IS NULL); a transfer without such a line keeps its lines.
// [CONV] numbering skips a number already taken in the tenant (a counter that is behind imported / seeded numbers must not make a create fail); ponytail: 50 probes, then common.internal.
// ponytail: an unlotted outbound is not stopped by the ledger (negative unlotted rows are legal there), so dispatch locks and checks the unlotted source row itself (SELECT ... FOR UPDATE).
import { LimsError } from '../../../core/errors.js';
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import type { HandlerContext } from '../../../core/module.js';
import { suggestFefo } from '../domain/fefo.js';
import { formatNumber, periodKey } from '../domain/numbering.js';
import { formatScaled, packToBase, parseBaseQty, scaled } from '../domain/quantity.js';
import { assertZone, nowMs, ymdIn } from '../domain/tenantTime.js';
import { assertTransition } from '../domain/transfer.state.js';
import { fieldError, invalid } from '../handlers/items.schemas.js';
import type { PageQuery } from '../handlers/masters.schemas.js';
import type { ReceiveLineInput, TransferCreateInput, TransferDraftInput, TransferLineInput, TransferListQuery } from '../handlers/transfers.schemas.js';
import { toTransferDto } from '../mappers/transfer.dto.js';
import { listReasons } from '../repository/codedSets.repo.js';
import { allocateNumber } from '../repository/counters.repo.js';
import { getItem, getPack } from '../repository/items.repo.js';
import { getSettings, ensureSettings } from '../repository/settings.repo.js';
import { getStore } from '../repository/stores.repo.js';
import { getTransfer as loadTransfer, insertTransfer, insertTransferLine, listTransferLines, removeTransferLine, updateTransfer, updateTransferLine } from '../repository/transfers.repo.js';
import { type RepoCtx, type Row, Q, first, isUuid, query } from '../repository/_base.js';
import { PERMISSIONS } from '../permissions.js';
import { post as ledgerPost, type Movement } from './ledger.service.js';
import { assertStoreAccess, assertTransferAccess, listVisibleBranchIds } from './scope.service.js';

type Dto = Record<string, unknown>;
type Scope = Parameters<typeof assertStoreAccess>[0];
const rcOf = (ctx: HandlerContext): RepoCtx => ({ tx: ctx.tx as RepoCtx['tx'], tenantId: ctx.tenantId as string, actorId: ctx.actor?.id as string });
const sc = (ctx: HandlerContext): Scope => ctx as unknown as Scope;
const notFound = (): LimsError => new LimsError('common.not_found');
const READ = PERMISSIONS.itemRead;
const MANAGE = PERMISSIONS.stockManage;
const ZERO = '0.000000';

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
const SUMMARY = ['id', 'transfer_no', 'from_store_id', 'to_store_id', 'status', 'dispatched_at', 'received_at', 'version'] as const;
const permissionsOf = async (ctx: HandlerContext): Promise<readonly string[]> => (await (ctx.ports.IdentityPort as any).getActor(ctx)).permissions ?? [];

async function clock(ctx: HandlerContext): Promise<{ tz: string; now: number; nowIso: string; today: string }> {
  const s = await (ctx.ports.IdentityPort as any).getTenantSettings(ctx, { keys: ['timezone'] });
  const tz = assertZone(s?.timezone);
  const now = nowMs((ctx as any).now());
  return { tz, now, nowIso: new Date(now).toISOString(), today: ymdIn(now, tz) };
}

/** The Transfer as the contract shows it: current lines only, cost keys only with inventory.cost.read (PE-3). */
async function view(ctx: HandlerContext, rc: RepoCtx, id: string): Promise<Dto> {
  const t = await loadTransfer(rc, id);
  if (t === null) throw notFound();
  const lines = await listTransferLines(rc, id);
  return toTransferDto({ ...wire(t), lines: lines.map(wire) }, await permissionsOf(ctx));
}

/** Row lock on the transfer: two requests on the same document queue here, the loser re-reads the new status (-> 409). */
async function lockTransfer(rc: RepoCtx, id: string): Promise<Row> {
  const t = await first(rc, 'SELECT * FROM inventory.transfers WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [id]);
  if (t === null) throw notFound();
  return t;
}
function checkVersion(t: Row, ifMatch: number): void {
  if (t['version'] !== ifMatch) throw new LimsError('common.version_conflict');
}

/** AC-19.4: with settings.count_locks_store, a store with an open count takes no manual movement. */
async function assertNotCounting(rc: RepoCtx, storeIds: readonly string[]): Promise<void> {
  if ((await getSettings(rc))?.['count_locks_store'] !== true) return;
  const open = await first(rc, "SELECT 1 AS x FROM inventory.stock_counts WHERE tenant_id = $1 AND status = 'open' AND store_id = ANY($2::uuid[]) LIMIT 1", [[...storeIds]]);
  if (open !== null) throw new LimsError('inventory.store_locked_for_count');
}

// ---------------------------------------------------------------- #56 list
export async function listTransfers(ctx: HandlerContext, f: TransferListQuery): Promise<Dto> {
  const rc = rcOf(ctx);
  const q = new Q();
  let w = '';
  const v = await listVisibleBranchIds(sc(ctx));
  if (!v.all) { // P-B1: visible through either end
    const ids = `(SELECT id FROM inventory.stores WHERE tenant_id = $1 AND branch_id = ANY(${q.p([...v.branchIds])}::uuid[]))`;
    w += ` AND (from_store_id IN ${ids} OR to_store_id IN ${ids})`;
  }
  if (f.from_store_id !== undefined) w += ` AND from_store_id = ${q.p(f.from_store_id)}`;
  if (f.to_store_id !== undefined) w += ` AND to_store_id = ${q.p(f.to_store_id)}`;
  if (f.status !== undefined) w += ` AND status = ${q.p(f.status)}`;
  if (f.cursor !== undefined) w += ` AND id < ${q.p(cursorId(f))}::uuid`;
  const rows = await query(rc, `SELECT * FROM inventory.transfers WHERE tenant_id = $1${w} ORDER BY id DESC LIMIT ${q.p(f.limit + 1)}`, q.vals); // ponytail: ids are uuidv7 (creation order); keyset on id
  const data = rows.slice(0, f.limit);
  const next = rows.length > f.limit ? Buffer.from(JSON.stringify({ i: data[data.length - 1]!['id'] })).toString('base64url') : undefined;
  return {
    data: data.map((r) => Object.fromEntries(SUMMARY.filter((k) => wire(r)[k] !== undefined).map((k) => [k, wire(r)[k]]))),
    page: { limit: f.limit, ...(next === undefined ? {} : { next_cursor: next }) },
  };
}
function cursorId(p: PageQuery): string {
  let id: unknown;
  try { id = (JSON.parse(Buffer.from(p.cursor as string, 'base64url').toString('utf8')) as { i?: unknown } | null)?.i; } catch { /* 400 below */ }
  if (!isUuid(id)) throw invalid(fieldError('/cursor'));
  return id;
}

// ---------------------------------------------------------------- lines: validation shared by #57 and #59
interface DraftLine { item_id: string; lot_id: string | null; qty_base: string }
async function resolveLines(rc: RepoCtx, lines: readonly TransferLineInput[]): Promise<DraftLine[]> {
  const out: DraftLine[] = [];
  for (const [i, l] of lines.entries()) {
    const item = await getItem(rc, l.item_id);
    if (item === null) throw notFound();
    let qty: string;
    if (l.pack_id !== undefined) {
      const pack = await getPack(rc, l.pack_id);
      if (pack === null) throw notFound();
      if (pack['item_id'] !== l.item_id) throw new LimsError('inventory.uom_mismatch');
      try { qty = parseBaseQty(packToBase(l.qty, pack['qty_in_base'])); } catch { throw invalid(fieldError(`/lines/${i}/qty`)); }
    } else qty = formatScaled(scaled(parseBaseQty(l.qty), 6), 6);
    if (l.lot_id !== undefined) {
      if (item['is_lot_tracked'] !== true) throw invalid(fieldError(`/lines/${i}/lot_id`));
      const lot = await first(rc, 'SELECT item_id FROM inventory.lots WHERE tenant_id = $1 AND id = $2', [l.lot_id]);
      if (lot === null || lot['item_id'] !== l.item_id) throw notFound();
    }
    out.push({ item_id: l.item_id, lot_id: l.lot_id ?? null, qty_base: qty }); // draft: availability and expiry are judged at dispatch (03-APP-FLOW T2)
  }
  return out;
}
const insertLines = async (rc: RepoCtx, transferId: string, lines: readonly DraftLine[]): Promise<Row[]> => {
  const rows: Row[] = [];
  for (const [i, l] of lines.entries()) rows.push(await insertTransferLine(rc, { id: uuidv7(), transfer_id: transferId, line_no: i + 1, item_id: l.item_id, lot_id: l.lot_id, qty_base: l.qty_base }));
  return rows;
};

async function nextNumber(rc: RepoCtx, today: string): Promise<string> {
  const pattern = (await ensureSettings(rc))['transfer_no_pattern'] as string;
  const period = periodKey(pattern, today);
  for (let n = 0; n < 50; n++) {
    const no = formatNumber(pattern, today, await allocateNumber(rc, 'transfer', period));
    if ((await first(rc, 'SELECT 1 AS x FROM inventory.transfers WHERE tenant_id = $1 AND transfer_no = $2', [no])) === null) return no;
  }
  throw new LimsError('common.internal');
}

// ---------------------------------------------------------------- #57 create
export async function createTransfer(ctx: HandlerContext, input: TransferCreateInput): Promise<Dto> {
  const rc = rcOf(ctx);
  await assertStoreAccess(sc(ctx), input.from_store_id, MANAGE); // 404 invisible / unknown -> 403 (P-B8); the destination only has to exist
  if ((await getStore(rc, input.to_store_id)) === null) throw notFound();
  const lines = await resolveLines(rc, input.lines);
  const { today } = await clock(ctx);
  const id = uuidv7();
  await insertTransfer(rc, { id, transfer_no: await nextNumber(rc, today), from_store_id: input.from_store_id, to_store_id: input.to_store_id, status: 'draft', notes: input.notes ?? null });
  await insertLines(rc, id, lines);
  return view(ctx, rc, id);
}

// ---------------------------------------------------------------- #58 get
export async function getTransfer(ctx: HandlerContext, id: string): Promise<Dto> {
  await assertTransferAccess(sc(ctx), id, { permission: READ });
  return view(ctx, rcOf(ctx), id);
}

// ---------------------------------------------------------------- #59 replace draft (D-71, §5.11)
export async function replaceTransferDraft(ctx: HandlerContext, id: string, ifMatch: number, input: TransferDraftInput): Promise<Dto> {
  const rc = rcOf(ctx);
  await assertTransferAccess(sc(ctx), id, { permission: MANAGE, end: 'from' });
  const t = await lockTransfer(rc, id);
  assertTransition(t['status'], 'draft');
  checkVersion(t, ifMatch);
  const lines = await resolveLines(rc, input.lines); // validated BEFORE anything is removed
  for (const l of await listTransferLines(rc, id)) await removeTransferLine(rc, l['id'], l['version']);
  await insertLines(rc, id, lines);
  await updateTransfer(rc, id, ifMatch, { notes: input.notes ?? null });
  return view(ctx, rc, id);
}

// ---------------------------------------------------------------- #60 dispatch (AC-10.1)
const lotInfo = (rc: RepoCtx, ids: readonly string[]): Promise<Row[]> =>
  query(rc, `SELECT id, status, to_char(expiry_on, 'YYYY-MM-DD') AS expiry_on FROM inventory.lots WHERE tenant_id = $1 AND id = ANY($2::uuid[])`, [[...ids]]);

interface Planned { src: Row | null; item_id: string; lot_id: string | null; qty: string }
export async function dispatchTransfer(ctx: HandlerContext, id: string, ifMatch: number): Promise<Dto> {
  const rc = rcOf(ctx);
  await assertTransferAccess(sc(ctx), id, { permission: MANAGE, end: 'from' });
  const t = await lockTransfer(rc, id);
  assertTransition(t['status'], 'dispatched');
  checkVersion(t, ifMatch);
  const from = t['from_store_id'] as string;
  await assertNotCounting(rc, [from]);
  const { tz, nowIso, today } = await clock(ctx);
  const lines = await listTransferLines(rc, id);
  if (lines.length === 0) throw invalid(fieldError('/lines'));

  const items = new Map<string, Row>();
  for (const iid of new Set(lines.map((l) => l['item_id'] as string))) items.set(iid, (await getItem(rc, iid)) ?? (() => { throw notFound(); })());
  const lotRows = new Map((await lotInfo(rc, lines.flatMap((l) => (l['lot_id'] ? [l['lot_id'] as string] : [])))).map((r) => [r['id'] as string, r]));

  // named lots: usable (AC-07.3 status, AC-07.4 expiry in TENANT time: the expiry day itself is still usable)
  const named = new Map<string, bigint>(); // `${item}|${lot}` -> base units this dispatch takes from that lot
  for (const l of lines) {
    if (!l['lot_id']) continue;
    const lot = lotRows.get(l['lot_id']);
    if (lot === undefined) throw notFound();
    if (lot['status'] !== 'available') throw new LimsError('inventory.lot_unavailable');
    if (lot['expiry_on'] !== null && lot['expiry_on'] < today) throw new LimsError('inventory.lot_expired');
    const k = `${l['item_id']}|${l['lot_id']}`;
    named.set(k, (named.get(k) ?? 0n) + scaled(l['qty_base'], 6));
  }

  // lot-less lines of lot-tracked items: FEFO over the usable lots of the source store (02-TRD §4.4), net of what named lines already take
  const avail = new Map<string, Map<string, bigint>>(); // item -> lot -> available
  const fefoInputs = new Map<string, { lotId: string; lotNo: string; expiryOn: string | null; createdAt: string; openContainers: { openExpiryAt: string | null }[] }[]>();
  const planned: Planned[] = [];
  let split = false;
  const unlotted = new Map<string, bigint>(); // item -> base units needed from the unlotted row
  for (const l of lines) {
    const item = items.get(l['item_id'])!;
    if (l['lot_id']) { planned.push({ src: l, item_id: l['item_id'], lot_id: l['lot_id'], qty: l['qty_base'] }); continue; }
    if (item['is_lot_tracked'] !== true) {
      unlotted.set(l['item_id'], (unlotted.get(l['item_id']) ?? 0n) + scaled(l['qty_base'], 6));
      planned.push({ src: l, item_id: l['item_id'], lot_id: null, qty: l['qty_base'] });
      continue;
    }
    split = true;
    if (!avail.has(l['item_id'])) {
      const cand = await query(rc, `SELECT l.id AS lot_id, l.lot_no, to_char(l.expiry_on, 'YYYY-MM-DD') AS expiry_on, l.created_at, b.qty_base
          FROM inventory.stock_balances b JOIN inventory.lots l ON l.tenant_id = b.tenant_id AND l.id = b.lot_id
         WHERE b.tenant_id = $1 AND b.store_id = $2 AND b.item_id = $3 AND b.qty_base > 0 AND l.status = 'available' AND (l.expiry_on IS NULL OR l.expiry_on >= $4::date)`, [from, l['item_id'], today]);
      const open = cand.length === 0 ? [] : await query(rc, `SELECT lot_id, open_expiry_at FROM inventory.opened_containers
          WHERE tenant_id = $1 AND store_id = $2 AND item_id = $3 AND status = 'open' AND lot_id = ANY($4::uuid[])`, [from, l['item_id'], cand.map((c) => c['lot_id'])]);
      avail.set(l['item_id'], new Map(cand.map((c) => [c['lot_id'] as string, scaled(c['qty_base'], 6) - (named.get(`${l['item_id']}|${c['lot_id']}`) ?? 0n)])));
      fefoInputs.set(l['item_id'], cand.map((c) => ({
        lotId: c['lot_id'], lotNo: c['lot_no'], expiryOn: c['expiry_on'], createdAt: (c['created_at'] as Date).toISOString(),
        openContainers: open.filter((o) => o['lot_id'] === c['lot_id']).map((o) => ({ openExpiryAt: o['open_expiry_at'] === null ? null : (o['open_expiry_at'] as Date).toISOString() })),
      })));
    }
    const left = avail.get(l['item_id'])!;
    const r = suggestFefo({
      candidates: fefoInputs.get(l['item_id'])!.map((c) => ({ ...c, availableQtyBase: formatScaled(left.get(c.lotId)! > 0n ? left.get(c.lotId)! : 0n, 6) })),
      qtyBase: l['qty_base'], now: nowIso, timezone: tz,
    });
    if (r.shortfallQtyBase !== ZERO) throw new LimsError('inventory.insufficient_stock');
    for (const fl of r.lines) {
      left.set(fl.lotId, left.get(fl.lotId)! - scaled(fl.takeQtyBase, 6));
      planned.push({ src: null, item_id: l['item_id'], lot_id: fl.lotId, qty: fl.takeQtyBase });
    }
  }
  for (const [item, need] of unlotted) { // the ledger lets an unlotted row go negative, a transfer must not
    const row = await first(rc, 'SELECT qty_base FROM inventory.stock_balances WHERE tenant_id = $1 AND store_id = $2 AND item_id = $3 AND lot_id IS NULL FOR UPDATE', [from, item]);
    if (row === null || scaled(row['qty_base'], 6) < need) throw new LimsError('inventory.insufficient_stock');
  }

  // D-71: a FEFO split rewrites the draft (soft-remove every current line, insert the resolved ones as 1..n); the movements point at the final line ids
  let finalLines: Row[] = lines;
  if (split) {
    for (const l of lines) await removeTransferLine(rc, l['id'], l['version']);
    finalLines = await insertLines(rc, id, planned.map((p) => ({ item_id: p.item_id, lot_id: p.lot_id, qty_base: p.qty })));
  }
  const movements: Movement[] = finalLines.map((l) => ({ store_id: from, item_id: l['item_id'], lot_id: l['lot_id'] ?? null, kind: 'transfer_out', qty_base: `-${l['qty_base']}`, doc_line_id: l['id'] }));
  const rows = await ledgerPost(rc, { doc_type: 'transfer', doc_id: id, occurred_at: nowIso, business_date: today, movements });
  for (const l of finalLines) { // pro-rata value of what left the source (the ledger's value, sign flipped)
    const v = rows.filter((r) => r['doc_line_id'] === l['id']).reduce((a, r) => a - BigInt(r['value_paisa']), 0n);
    await updateTransferLine(rc, l['id'], l['version'], { dispatched_value_paisa: v.toString() });
  }
  await updateTransfer(rc, id, ifMatch, { status: 'dispatched', dispatched_at: nowIso, dispatched_by: rc.actorId });
  return view(ctx, rc, id);
}

// ---------------------------------------------------------------- #61 receive (AC-10.2, D-69)
export async function receiveTransfer(ctx: HandlerContext, id: string, ifMatch: number, input: { lines: ReceiveLineInput[] }): Promise<Dto> {
  const rc = rcOf(ctx);
  await assertTransferAccess(sc(ctx), id, { permission: MANAGE, end: 'to' });
  const t = await lockTransfer(rc, id);
  assertTransition(t['status'], 'received');
  checkVersion(t, ifMatch);
  const lines = await listTransferLines(rc, id);
  const byId = new Map(lines.map((l) => [l['id'] as string, l]));
  if (input.lines.some((l) => !byId.has(l.line_id))) throw notFound(); // a line of another transfer / a removed line (404, no oracle)
  if (input.lines.length !== lines.length) throw invalid(fieldError('/lines')); // every current line exactly once (duplicates are refused by the schema)

  const plan = input.lines.map((l, i) => {
    const line = byId.get(l.line_id)!;
    const d = scaled(line['qty_base'], 6);
    const r = scaled(l.received_qty_base, 6);
    if (r > d) throw invalid(fieldError(`/lines/${i}/received_qty_base`)); // never an over-receipt
    return { line, d, r, code: r < d ? l.discrepancy_reason_code : undefined, i };
  });
  const short = plan.filter((p) => p.r < p.d);
  if (short.length > 0) {
    const codes = new Set((await listReasons(rc, 'transfer_discrepancy')).map((x) => x['code'] as string));
    if (short.some((p) => p.code === undefined || !codes.has(p.code))) throw new LimsError('inventory.reason_required');
  }
  await assertNotCounting(rc, short.length > 0 ? [t['to_store_id'], t['from_store_id']] : [t['to_store_id']]);
  const { nowIso, today } = await clock(ctx);

  // destination value = round_half_up(r / d x V), one SQL statement for all lines (TRD §4.3: no money arithmetic in TS)
  const part = plan.filter((p) => p.r > 0n && p.r < p.d);
  const prorata = new Map<number, bigint>();
  if (part.length > 0) {
    const rows = await query(rc, `SELECT x.n::int AS n, round(x.r * x.v / x.d)::bigint AS val FROM unnest($2::numeric[], $3::bigint[], $4::numeric[]) WITH ORDINALITY AS x(r, v, d, n) WHERE $1::uuid IS NOT NULL`,
      [part.map((p) => formatScaled(p.r, 6)), part.map((p) => String(p.line['dispatched_value_paisa'] ?? 0)), part.map((p) => formatScaled(p.d, 6))]);
    for (const row of rows) prorata.set(part[Number(row['n']) - 1]!.i, BigInt(row['val']));
  }
  const movements: Movement[] = [];
  for (const p of plan) {
    const lot = (p.line['lot_id'] as string | null) ?? null;
    const V = BigInt(p.line['dispatched_value_paisa'] ?? 0);
    const dest = p.r === p.d ? V : p.r === 0n ? 0n : prorata.get(p.i)!;
    if (p.r > 0n) movements.push({ store_id: t['to_store_id'], item_id: p.line['item_id'], lot_id: lot, kind: 'transfer_in', qty_base: formatScaled(p.r, 6), value_hint: Number(dest), doc_line_id: p.line['id'] });
    if (p.r < p.d) { // D-69: the pair on the source row, the transfer_in first so the wastage never lacks stock
      const loss = formatScaled(p.d - p.r, 6);
      movements.push({ store_id: t['from_store_id'], item_id: p.line['item_id'], lot_id: lot, kind: 'transfer_in', qty_base: loss, value_hint: Number(V - dest), doc_line_id: p.line['id'] });
      movements.push({ store_id: t['from_store_id'], item_id: p.line['item_id'], lot_id: lot, kind: 'wastage', qty_base: `-${loss}`, reason_code: p.code!, doc_line_id: p.line['id'] });
    }
  }
  await ledgerPost(rc, { doc_type: 'transfer', doc_id: id, occurred_at: nowIso, business_date: today, movements });
  for (const p of plan) await updateTransferLine(rc, p.line['id'], p.line['version'], { received_qty_base: formatScaled(p.r, 6), discrepancy_reason_code: p.code ?? null });
  await updateTransfer(rc, id, ifMatch, { status: 'received', received_at: nowIso, received_by: rc.actorId });
  return view(ctx, rc, id);
}

// ---------------------------------------------------------------- #62 cancel (draft only: dispatched stock in transit must be received, AC-10.4)
export async function cancelTransfer(ctx: HandlerContext, id: string, ifMatch: number, input: { reason_text: string }): Promise<Dto> {
  const rc = rcOf(ctx);
  await assertTransferAccess(sc(ctx), id, { permission: MANAGE, end: 'from' });
  const t = await lockTransfer(rc, id);
  assertTransition(t['status'], 'cancelled');
  checkVersion(t, ifMatch);
  await updateTransfer(rc, id, ifMatch, { status: 'cancelled', cancelled_at: (await clock(ctx)).nowIso, cancelled_by: rc.actorId, cancel_reason_text: input.reason_text });
  return view(ctx, rc, id);
}
