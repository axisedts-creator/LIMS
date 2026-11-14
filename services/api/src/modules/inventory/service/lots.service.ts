// C12.T-09 lots, stock balances, movements, FEFO suggestion, opened containers (02-TRD §5.2 #30-#39, §4.4 FEFO, §4.7 tenant time; PRD AC-07.x, AC-18.x; 07-SECURITY PE-1..PE-3, P-B1..P-B8, P-T1).
// Every statement binds the tenant as $1 (T-03 query helpers, RLS on). A foreign or unknown id is the same 404 (no oracle).
// TENANT TIME: the timezone comes from IdentityPort.getTenantSettings({keys:['timezone']}) and the clock from ctx.now(); "today", "expired" (expiry_on < today), the end of the expiry day and
// opened-on + open_stability_days (wall-clock days) are all computed in that zone. Errors of the settings port propagate (fail closed).
// Store-scope operations: load the store -> branch visible? else 404 -> assertRole({permission, branchId}) (scope.service, 404 beats 403, P-B8). Tenant-scope reads list only visible branches (P-B1).
// Money (PE-3): the mappers drop every `_paisa` / `_paisa_x1e6` / value_basis key unless inventory.cost.read; the FEFO suggestion never carries money.
import { LimsError } from '../../../core/errors.js';
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import type { HandlerContext } from '../../../core/module.js';
import { assertTransition } from '../domain/container.state.js';
import { suggestFefo } from '../domain/fefo.js';
import { formatScaled, scaled } from '../domain/quantity.js';
import { addWallDays, assertZone, endOfDay, nowMs, ymdIn } from '../domain/tenantTime.js';
import type { DiscardInput } from '../handlers/documents.schemas.js';
import { fieldError, invalid } from '../handlers/items.schemas.js';
import type { BalanceQuery, ContainerFinishInput, ContainerListQuery, ContainerOpenInput, FefoQuery, LotExpiryInput, LotListQuery, LotStatusInput, MovementQuery } from '../handlers/lots.schemas.js';
import type { PageQuery } from '../handlers/masters.schemas.js';
import { toBalanceRowDto } from '../mappers/balance.dto.js';
import { toLotDto } from '../mappers/lot.dto.js';
import { toMovementDto } from '../mappers/movement.dto.js';
import { getBalanceByKey } from '../repository/balances.repo.js';
import { listReasons } from '../repository/codedSets.repo.js';
import { insertContainer, updateContainer } from '../repository/containers.repo.js';
import { getItem } from '../repository/items.repo.js';
import { updateLot } from '../repository/lots.repo.js';
import { type RepoCtx, type Row, Q, first, isUuid, query } from '../repository/_base.js';
import { PERMISSIONS } from '../permissions.js';
import { postDocument, viewDocument } from './documents.service.js';
import { assertStoreAccess, listVisibleBranchIds } from './scope.service.js';

type Dto = Record<string, unknown>;
type Scope = Parameters<typeof assertStoreAccess>[0];
const rcOf = (ctx: HandlerContext): RepoCtx => ({ tx: ctx.tx as RepoCtx['tx'], tenantId: ctx.tenantId as string, actorId: ctx.actor?.id as string });
const sc = (ctx: HandlerContext): Scope => ctx as unknown as Scope;
const notFound = (): LimsError => new LimsError('common.not_found');
const READ = PERMISSIONS.itemRead;
const BENCH = PERMISSIONS.benchRecord;
const FUTURE_SLACK_MS = 300_000; // 02-TRD §4.7: an instant may lie at most 300 s ahead of the clock

// ---------------------------------------------------------------- DB error mapping (P-1)
const BY_CONSTRAINT: Record<string, () => LimsError> = {
  opened_containers__instrument__fk: notFound, // unknown / other-tenant instrument -> 404
  opened_containers__lot__fk: notFound,
  opened_containers__item__fk: notFound,
  opened_containers__store__fk: notFound,
  lots__ck: () => invalid(fieldError('/expiry_on')), // manufactured_on <= expiry_on
};
const mapped = async <T>(p: Promise<T>): Promise<T> => {
  try { return await p; } catch (e) {
    const fn = (e as { constraint?: string } | null)?.constraint ? BY_CONSTRAINT[(e as { constraint: string }).constraint] : undefined;
    throw fn ? fn() : e;
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
const dropNull = (o: Row): Row => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined));
const pick = (row: Row, keys: readonly string[]): Dto => Object.fromEntries(keys.filter((k) => row[k] !== undefined).map((k) => [k, row[k]]));
const permissionsOf = async (ctx: HandlerContext): Promise<readonly string[]> => (await (ctx.ports.IdentityPort as any).getActor(ctx)).permissions ?? [];

async function clock(ctx: HandlerContext): Promise<{ tz: string; now: number; today: string }> {
  const s = await (ctx.ports.IdentityPort as any).getTenantSettings(ctx, { keys: ['timezone'] });
  const tz = assertZone(s?.timezone);
  const now = nowMs((ctx as any).now());
  return { tz, now, today: ymdIn(now, tz) };
}

// ---------------------------------------------------------------- keyset paging (cursor = base64url {i: last id}; the sort key is re-read tenant-bound, so a forged / foreign cursor is a 400)
interface PageSpec { select: string; from: string; tenantCol: string; idCol: string; where: string; q: Q; key: string; dir: 'ASC' | 'DESC'; p: PageQuery }
interface Paged { readonly rows: Row[]; readonly page: { limit: number; next_cursor?: string } }
async function page(rc: RepoCtx, s: PageSpec): Promise<Paged> {
  let w = s.where;
  if (s.p.cursor !== undefined) {
    let id: unknown;
    try { id = (JSON.parse(Buffer.from(s.p.cursor, 'base64url').toString('utf8')) as { i?: unknown } | null)?.i; } catch { /* falls through to the 400 */ }
    const cur = isUuid(id) ? await first(rc, `SELECT ${s.key} AS k FROM ${s.from} WHERE ${s.tenantCol} = $1 AND ${s.idCol} = $2`, [id]) : null;
    if (cur === null) throw invalid(fieldError('/cursor'));
    const k = s.q.p(cur['k']);
    const i = s.q.p(id);
    const op = s.dir === 'ASC' ? '>' : '<';
    w += ` AND (${s.key} ${op} ${k}::text OR (${s.key} = ${k}::text AND ${s.idCol} ${op} ${i}::uuid))`;
  }
  const rows = await query(rc, `SELECT ${s.select}, ${s.idCol} AS cursor_id FROM ${s.from} WHERE ${s.tenantCol} = $1${w} ORDER BY ${s.key} ${s.dir}, ${s.idCol} ${s.dir} LIMIT ${s.q.p(s.p.limit + 1)}`, s.q.vals);
  const data = rows.slice(0, s.p.limit);
  const next = rows.length > s.p.limit ? Buffer.from(JSON.stringify({ i: data[data.length - 1]!['cursor_id'] })).toString('base64url') : undefined;
  return { rows: data, page: { limit: s.p.limit, ...(next === undefined ? {} : { next_cursor: next }) } };
}

/** P-B1: without a store_id a list covers the visible branches only. */
async function visibleStores(ctx: HandlerContext, q: Q, col: string): Promise<string> {
  const v = await listVisibleBranchIds(sc(ctx));
  return v.all ? '' : ` AND ${col} IN (SELECT id FROM inventory.stores WHERE tenant_id = $1 AND branch_id = ANY(${q.p([...v.branchIds])}::uuid[]))`;
}

// ---------------------------------------------------------------- SQL fragments (dates leave the database as 'YYYY-MM-DD' text: node-pg would turn a date into a local-midnight Date)
const YMD = (c: string): string => `to_char(${c}, 'YYYY-MM-DD')`;
const LOT_SQL = `l.id, l.item_id, l.lot_no, ${YMD('l.expiry_on')} AS expiry_on, ${YMD('l.manufactured_on')} AS manufactured_on, l.status, l.status_reason_code, l.version,
  CASE WHEN l.last_receipt_qty_base > 0 AND l.last_receipt_value_paisa IS NOT NULL THEN round(l.last_receipt_value_paisa::numeric * 1000000 / l.last_receipt_qty_base)::bigint END AS last_receipt_unit_cost_paisa_x1e6`;
const lotRow = (rc: RepoCtx, id: string): Promise<Row | null> =>
  isUuid(id) ? first(rc, `SELECT ${LOT_SQL} FROM inventory.lots l WHERE l.tenant_id = $1 AND l.id = $2`, [id]) : Promise.resolve(null);
const loadLot = async (rc: RepoCtx, id: string): Promise<Row> => (await lotRow(rc, id)) ?? Promise.reject(notFound());

const BALANCE_FROM = `inventory.stock_balances b
  JOIN inventory.items i ON i.tenant_id = b.tenant_id AND i.id = b.item_id
  LEFT JOIN inventory.lots l ON l.tenant_id = b.tenant_id AND l.id = b.lot_id
  LEFT JOIN inventory.store_item_settings si ON si.tenant_id = b.tenant_id AND si.store_id = b.store_id AND si.item_id = b.item_id AND si.is_active`;
/** `today` = placeholder holding the tenant-time date. available_qty_base = what an issue could use: 0 for a quarantined / blocked / expired lot. */
const balanceSelect = (today: string): string => `b.store_id, b.item_id, i.item_code, i.name AS item_name, b.lot_id, l.lot_no, ${YMD('l.expiry_on')} AS expiry_on, l.status AS lot_status, b.qty_base,
  CASE WHEN b.lot_id IS NULL OR (l.status = 'available' AND (l.expiry_on IS NULL OR l.expiry_on >= ${today}::date)) THEN b.qty_base ELSE 0 END AS available_qty_base,
  EXISTS (SELECT 1 FROM inventory.opened_containers c WHERE c.tenant_id = b.tenant_id AND c.store_id = b.store_id AND c.item_id = b.item_id AND c.lot_id IS NOT DISTINCT FROM b.lot_id AND c.status = 'open') AS has_open_container,
  si.reorder_level_base, b.value_paisa,
  CASE WHEN b.qty_base > 0 THEN round(b.value_paisa::numeric * 1000000 / b.qty_base)::bigint END AS avg_unit_cost_paisa_x1e6`;
const balanceDto = (r: Row, perms: readonly string[]): Dto => dropNull(toBalanceRowDto(wire(r), perms));

const CONTAINER_KEYS = ['id', 'store_id', 'item_id', 'lot_id', 'lot_no', 'instrument_id', 'opened_at', 'open_expiry_at', 'status', 'finished_at', 'discard_document_id', 'notes', 'version'];
const CONTAINER_SQL = 'c.id, c.store_id, c.item_id, c.lot_id, l.lot_no, c.instrument_id, c.opened_at, c.open_expiry_at, c.status, c.finished_at, c.discard_document_id, c.notes, c.version';
const CONTAINER_FROM = 'inventory.opened_containers c LEFT JOIN inventory.lots l ON l.tenant_id = c.tenant_id AND l.id = c.lot_id';
const containerDto = (r: Row): Dto => pick(wire(r), CONTAINER_KEYS);
const containerRow = (rc: RepoCtx, id: string): Promise<Row | null> =>
  isUuid(id) ? first(rc, `SELECT ${CONTAINER_SQL} FROM ${CONTAINER_FROM} WHERE c.tenant_id = $1 AND c.id = $2`, [id]) : Promise.resolve(null);

// ---------------------------------------------------------------- #30 #31 lots
export async function listLots(ctx: HandlerContext, f: LotListQuery): Promise<Dto> {
  const rc = rcOf(ctx);
  const q = new Q();
  let w = ` AND l.item_id = ${q.p(f.item_id)}`;
  if (f.status !== undefined) w += ` AND l.status = ${q.p(f.status)}`;
  if (f.expiring_before !== undefined) w += ` AND l.expiry_on < ${q.p(f.expiring_before)}::date`; // strict; a lot without expiry never matches
  const [{ rows, page: pg }, perms] = await Promise.all([
    page(rc, { select: LOT_SQL, from: 'inventory.lots l', tenantCol: 'l.tenant_id', idCol: 'l.id', where: w, q, key: '(l.lot_no COLLATE "C")', dir: 'ASC', p: f }),
    permissionsOf(ctx),
  ]);
  return { data: rows.map((r) => dropNull(toLotDto(wire(r), perms))), page: pg };
}

export async function getLotFull(ctx: HandlerContext, lotId: string): Promise<Dto> {
  const rc = rcOf(ctx);
  const lot = await loadLot(rc, lotId);
  const { today } = await clock(ctx);
  const q = new Q();
  const t = q.p(today);
  const lid = q.p(lotId);
  const vis = await visibleStores(ctx, q, 'b.store_id');
  const [rows, perms] = await Promise.all([
    query(rc, `SELECT ${balanceSelect(t)} FROM ${BALANCE_FROM} WHERE b.tenant_id = $1 AND b.lot_id = ${lid} AND b.qty_base <> 0${vis} ORDER BY b.store_id, b.id`, q.vals),
    permissionsOf(ctx),
  ]);
  return { ...dropNull(toLotDto(wire(lot), perms)), balances: rows.map((r) => balanceDto(r, perms)) };
}

async function assertReason(rc: RepoCtx, group: 'lot_status' | 'adjustment', code: string): Promise<void> {
  if (!(await listReasons(rc, group)).some((r) => r['code'] === code)) throw new LimsError('inventory.reason_required');
}

/** #32 (privileged, gate in the handler). */
export async function setLotStatus(ctx: HandlerContext, lotId: string, ifMatch: number, input: LotStatusInput): Promise<Dto> {
  const rc = rcOf(ctx);
  const cur = await loadLot(rc, lotId);
  if (cur['version'] !== ifMatch) throw new LimsError('common.version_conflict');
  await assertReason(rc, 'lot_status', input.reason_code);
  await mapped(updateLot(rc, lotId, ifMatch, { status: input.status, status_reason_code: input.reason_code }));
  return dropNull(toLotDto(wire(await loadLot(rc, lotId)), await permissionsOf(ctx)));
}

/** #33 (privileged, gate in the handler). The lot may be given any expiry on or after its manufacture date (a past date expires it, AC-07.4). */
export async function correctLotExpiry(ctx: HandlerContext, lotId: string, ifMatch: number, input: LotExpiryInput): Promise<Dto> {
  const rc = rcOf(ctx);
  const cur = await loadLot(rc, lotId);
  if (cur['version'] !== ifMatch) throw new LimsError('common.version_conflict');
  await assertReason(rc, 'adjustment', input.reason_code);
  if (cur['manufactured_on'] != null && input.expiry_on < cur['manufactured_on']) throw invalid(fieldError('/expiry_on'));
  await mapped(updateLot(rc, lotId, ifMatch, { expiry_on: input.expiry_on }));
  return dropNull(toLotDto(wire(await loadLot(rc, lotId)), await permissionsOf(ctx)));
}

// ---------------------------------------------------------------- #34 stock balances
export async function listBalances(ctx: HandlerContext, f: BalanceQuery): Promise<Dto> {
  const rc = rcOf(ctx);
  if (f.store_id !== undefined) await assertStoreAccess(sc(ctx), f.store_id, READ);
  const { today } = await clock(ctx);
  const q = new Q();
  const t = q.p(today);
  let w = f.include_zero ? '' : ' AND b.qty_base <> 0';
  if (f.store_id !== undefined) w += ` AND b.store_id = ${q.p(f.store_id)}`;
  else w += await visibleStores(ctx, q, 'b.store_id');
  if (f.item_id !== undefined) w += ` AND b.item_id = ${q.p(f.item_id)}`;
  if (f.category !== undefined) w += ` AND i.category = ${q.p(f.category)}`;
  if (f.expired_only) w += ` AND l.expiry_on < ${t}::date`; // AC-07.4: expiry_on < today in tenant time
  if (f.expiring_within_days !== undefined) w += ` AND l.expiry_on >= ${t}::date AND l.expiry_on <= ${t}::date + ${q.p(f.expiring_within_days)}::int`;
  if (f.below_reorder) { // on-hand (all lots) under the reorder level of an active, stocked setting
    w += ` AND si.is_stocked AND si.reorder_level_base IS NOT NULL AND coalesce((SELECT sum(x.qty_base) FROM inventory.stock_balances x
            WHERE x.tenant_id = b.tenant_id AND x.store_id = b.store_id AND x.item_id = b.item_id), 0) < si.reorder_level_base`;
  }
  const [{ rows, page: pg }, perms] = await Promise.all([
    page(rc, { select: balanceSelect(t), from: BALANCE_FROM, tenantCol: 'b.tenant_id', idCol: 'b.id', where: w, q, key: `((i.item_code || '/' || coalesce(l.lot_no, '')) COLLATE "C")`, dir: 'ASC', p: f }),
    permissionsOf(ctx),
  ]);
  return { data: rows.map((r) => balanceDto(r, perms)), page: pg };
}

// ---------------------------------------------------------------- #35 movements
const MOVEMENT_SQL = `m.id, m.occurred_at, ${YMD('m.business_date')} AS business_date, m.store_id, m.item_id, m.lot_id, l.lot_no, m.movement_kind, m.qty_base, m.balance_qty_after, m.value_paisa, m.value_basis,
  m.doc_type, m.doc_id, coalesce(sd.doc_no, gr.grn_no, tr.transfer_no, sk.count_no) AS doc_no, m.instrument_id, m.attributed_test_id, m.rule_id, m.reason_code, m.created_by`;
const MOVEMENT_FROM = `inventory.stock_movements m
  LEFT JOIN inventory.lots l ON l.tenant_id = m.tenant_id AND l.id = m.lot_id
  LEFT JOIN inventory.stock_documents sd ON sd.tenant_id = m.tenant_id AND m.doc_type = 'stock_document' AND sd.id = m.doc_id
  LEFT JOIN inventory.goods_receipts gr ON gr.tenant_id = m.tenant_id AND m.doc_type = 'goods_receipt' AND gr.id = m.doc_id
  LEFT JOIN inventory.transfers tr ON tr.tenant_id = m.tenant_id AND m.doc_type = 'transfer' AND tr.id = m.doc_id
  LEFT JOIN inventory.stock_counts sk ON sk.tenant_id = m.tenant_id AND m.doc_type = 'stock_count' AND sk.id = m.doc_id`;

/** created_by_display = ctx.core.user (memoised per request, 08 A17 P-17); an unknown user simply has no display name. */
async function displayNames(ctx: HandlerContext, ids: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const userId of new Set(ids)) {
    try {
      const u = await (ctx.core as any).user(ctx, { userId });
      if (typeof u?.displayName === 'string') out.set(userId, u.displayName);
    } catch { /* no display name */ }
  }
  return out;
}

export async function listMovements(ctx: HandlerContext, f: MovementQuery): Promise<Dto> {
  const rc = rcOf(ctx);
  if (f.store_id !== undefined) await assertStoreAccess(sc(ctx), f.store_id, READ);
  const q = new Q();
  let w = '';
  if (f.store_id !== undefined) w += ` AND m.store_id = ${q.p(f.store_id)}`;
  else w += await visibleStores(ctx, q, 'm.store_id');
  for (const k of ['item_id', 'lot_id', 'doc_type', 'doc_id', 'instrument_id', 'attributed_test_id'] as const) if (f[k] !== undefined) w += ` AND m.${k} = ${q.p(f[k])}`;
  if (f.movement_kind !== undefined) w += ` AND m.movement_kind = ANY(${q.p(f.movement_kind)}::text[])`;
  if (f.occurred_at_from !== undefined) w += ` AND m.occurred_at >= ${q.p(f.occurred_at_from)}::timestamptz`;
  if (f.occurred_at_to !== undefined) w += ` AND m.occurred_at <= ${q.p(f.occurred_at_to)}::timestamptz`;
  const key = `(to_char(m.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') COLLATE "C")`;
  const [{ rows, page: pg }, perms] = await Promise.all([
    page(rc, { select: MOVEMENT_SQL, from: MOVEMENT_FROM, tenantCol: 'm.tenant_id', idCol: 'm.id', where: w, q, key, dir: 'DESC', p: f }),
    permissionsOf(ctx),
  ]);
  const names = await displayNames(ctx, rows.map((r) => r['created_by']));
  return { data: rows.map((r) => dropNull({ ...toMovementDto(wire(r), perms), created_by_display: names.get(r['created_by']) })), page: pg };
}

// ---------------------------------------------------------------- #36 FEFO suggestion (02-TRD §4.4; never money)
export async function fefoSuggestion(ctx: HandlerContext, f: FefoQuery): Promise<Dto> {
  const rc = rcOf(ctx);
  await assertStoreAccess(sc(ctx), f.store_id, READ);
  if ((await getItem(rc, f.item_id)) === null) throw notFound();
  const { tz, now, today } = await clock(ctx);
  // candidates: usable stock only (AC-18.2): quantity > 0, status available, not expired in tenant time
  const lots = await query(rc, `SELECT l.id AS lot_id, l.lot_no, ${YMD('l.expiry_on')} AS expiry_on, l.created_at, b.qty_base
      FROM inventory.stock_balances b JOIN inventory.lots l ON l.tenant_id = b.tenant_id AND l.id = b.lot_id
     WHERE b.tenant_id = $1 AND b.store_id = $2 AND b.item_id = $3 AND b.qty_base > 0 AND l.status = 'available' AND (l.expiry_on IS NULL OR l.expiry_on >= $4::date)`, [f.store_id, f.item_id, today]);
  const open = lots.length === 0 ? [] : await query(rc, `SELECT lot_id, open_expiry_at FROM inventory.opened_containers
     WHERE tenant_id = $1 AND store_id = $2 AND item_id = $3 AND status = 'open' AND lot_id = ANY($4::uuid[])`, [f.store_id, f.item_id, lots.map((l) => l['lot_id'])]);
  const r = suggestFefo({
    candidates: lots.map((l) => ({
      lotId: l['lot_id'], lotNo: l['lot_no'], expiryOn: l['expiry_on'], createdAt: (l['created_at'] as Date).toISOString(), availableQtyBase: l['qty_base'],
      openContainers: open.filter((o) => o['lot_id'] === l['lot_id']).map((o) => ({ openExpiryAt: o['open_expiry_at'] === null ? null : (o['open_expiry_at'] as Date).toISOString() })),
    })),
    qtyBase: f.qty_base, now: new Date(now).toISOString(), timezone: tz,
  });
  return {
    store_id: f.store_id, item_id: f.item_id, qty_base: formatScaled(scaled(f.qty_base, 6), 6),
    lines: r.lines.map((l) => dropNull({
      lot_id: l.lotId, lot_no: l.lotNo, expiry_on: l.expiryOn, effective_expiry_at: l.effectiveExpiryAt, has_open_container: l.hasOpenContainer, take_qty_base: l.takeQtyBase, available_qty_base: l.availableQtyBase,
    })),
    shortfall_qty_base: r.shortfallQtyBase,
  };
}

// ---------------------------------------------------------------- #37 #38 #39 opened containers
export async function listContainers(ctx: HandlerContext, f: ContainerListQuery): Promise<Dto> {
  const rc = rcOf(ctx);
  await assertStoreAccess(sc(ctx), f.store_id, READ);
  const q = new Q();
  let w = ` AND c.store_id = ${q.p(f.store_id)} AND c.status = ${q.p(f.status)}`;
  if (f.instrument_id !== undefined) w += ` AND c.instrument_id = ${q.p(f.instrument_id)}`;
  // newest opened first: with instrument_id the first row is the lot in use on that analyser (AC-07.2)
  const key = `(to_char(c.opened_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') COLLATE "C")`;
  const { rows, page: pg } = await page(rc, { select: CONTAINER_SQL, from: CONTAINER_FROM, tenantCol: 'c.tenant_id', idCol: 'c.id', where: w, q, key, dir: 'DESC', p: f });
  return { data: rows.map(containerDto), page: pg };
}

/** AC-07.1: open expiry = the earlier of (opened-on + open_stability_days, wall-clock days in tenant time) and the end of the lot's expiry day; absent when neither exists. */
export async function openContainer(ctx: HandlerContext, input: ContainerOpenInput): Promise<Dto> {
  const rc = rcOf(ctx);
  await assertStoreAccess(sc(ctx), input.store_id, BENCH);
  const { tz, now, today } = await clock(ctx);
  const item = await getItem(rc, input.item_id);
  if (item === null) throw notFound();
  let lot: Row | null = null;
  if (item['is_lot_tracked'] === true) {
    if (input.lot_id === undefined) throw invalid(fieldError('/lot_id', 'common.field_required'));
    lot = await lotRow(rc, input.lot_id);
    if (lot === null || lot['item_id'] !== input.item_id) throw notFound();
    if (lot['status'] !== 'available') throw new LimsError('inventory.lot_unavailable'); // AC-07.3
    if (lot['expiry_on'] != null && lot['expiry_on'] < today) throw new LimsError('inventory.lot_expired'); // AC-07.4, expiry_on < today in tenant time
    const bal = await getBalanceByKey(rc, { storeId: input.store_id, itemId: input.item_id, lotId: input.lot_id });
    if (bal === null || !(Number(bal['qty_base']) > 0)) throw new LimsError('inventory.insufficient_stock');
  } else if (input.lot_id !== undefined) throw invalid(fieldError('/lot_id'));
  const openedMs = input.opened_at === undefined ? now : Date.parse(input.opened_at);
  if (openedMs > now + FUTURE_SLACK_MS) throw invalid(fieldError('/opened_at'));
  const ends: number[] = [];
  if (item['open_stability_days'] != null) ends.push(addWallDays(openedMs, Number(item['open_stability_days']), tz));
  if (lot !== null && lot['expiry_on'] != null) ends.push(endOfDay(lot['expiry_on'], tz));
  const row = await mapped(insertContainer(rc, {
    id: uuidv7(), store_id: input.store_id, item_id: input.item_id, lot_id: lot === null ? null : input.lot_id, instrument_id: input.instrument_id ?? null,
    opened_at: new Date(openedMs).toISOString(), opened_by: rc.actorId, open_expiry_at: ends.length === 0 ? null : new Date(Math.min(...ends)).toISOString(),
    status: 'open', notes: input.notes === undefined || input.notes === '' ? null : input.notes,
  }));
  return containerDto((await containerRow(rc, row['id'])) as Row);
}

export async function finishContainer(ctx: HandlerContext, containerId: string, ifMatch: number, input: ContainerFinishInput): Promise<Dto> {
  const rc = rcOf(ctx);
  const cur = await containerRow(rc, containerId);
  if (cur === null) throw notFound();
  await assertStoreAccess(sc(ctx), cur['store_id'], BENCH);
  assertTransition(cur['status'], 'finished'); // finished and discarded are terminal
  if (cur['version'] !== ifMatch) throw new LimsError('common.version_conflict');
  const now = nowMs((ctx as any).now());
  const openedAt = (cur['opened_at'] as Date).getTime();
  // [CONV] an omitted finished_at is the clock, but never before opened_at (a container opened with a back-dated / future-dated opened_at); a given one must lie in [opened_at, now + 300 s]
  const at = input.finished_at === undefined ? Math.max(now, openedAt) : Date.parse(input.finished_at);
  if (at < openedAt || (input.finished_at !== undefined && at > now + FUTURE_SLACK_MS)) throw invalid(fieldError('/finished_at'));
  await updateContainer(rc, containerId, ifMatch, { status: 'finished', finished_at: new Date(at).toISOString(), finished_by: rc.actorId });
  return containerDto((await containerRow(rc, containerId)) as Row);
}

/**
 * #40 (03-APP-FLOW §3.5): open -> discarded creates a WASTAGE stock document for the entered remaining quantity (documents.service.postDocument: reason of group wastage, ledger, valuation) and links it.
 * Order: container (404) -> bench.record at its branch (404 beats 403) -> row lock -> transition (409) -> If-Match (409) -> reason (422) -> document. [CONV] the row lock makes two parallel discards queue:
 * the loser re-reads status 'discarded' (409 document_invalid_transition), so the quantity leaves the lot once. Any lot status / expiry may be discarded (an expired or quarantined lot is the usual case).
 */
export async function discardContainer(ctx: HandlerContext, containerId: string, ifMatch: number, input: DiscardInput): Promise<Dto> {
  const rc = rcOf(ctx);
  const cur = await containerRow(rc, containerId);
  if (cur === null) throw notFound();
  await assertStoreAccess(sc(ctx), cur['store_id'], BENCH);
  const locked = await first(rc, 'SELECT status, version FROM inventory.opened_containers WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [containerId]);
  if (locked === null) throw notFound();
  assertTransition(locked['status'], 'discarded');
  if (locked['version'] !== ifMatch) throw new LimsError('common.version_conflict');
  const docId = await postDocument(ctx, 'wastage', {
    store_id: cur['store_id'], container_id: containerId, lines: [{ item_id: cur['item_id'], ...(cur['lot_id'] === null ? {} : { lot_id: cur['lot_id'] }), qty: input.qty_base }],
    ...(input.reason_code === undefined ? {} : { reason_code: input.reason_code }), ...(input.reason_text === undefined ? {} : { reason_text: input.reason_text }),
  });
  const finishedAt = Math.max(nowMs((ctx as any).now()), (cur['opened_at'] as Date).getTime()); // never before opened_at (a back-dated / future-dated opened_at)
  await updateContainer(rc, containerId, ifMatch, { status: 'discarded', finished_at: new Date(finishedAt).toISOString(), finished_by: rc.actorId, discard_document_id: docId });
  return { container: containerDto((await containerRow(rc, containerId)) as Row), document: await viewDocument(ctx, rc, docId) };
}
