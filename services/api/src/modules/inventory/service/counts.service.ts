// C12.T-14 stock counts #63-#68 (02-TRD §5.6, §4.3; 03-APP-FLOW §3.4 K1-K4; PRD AC-19.1-19.4; 07-SECURITY P-B1 / P-B2 / P-B8 / P-T1-P-T3 / PE-1 / PE-2).
// Order on #66-#68, always: scope (404 invisible -> 403 branch permission) -> row lock -> transition (409 inventory.document_invalid_transition) -> If-Match (409 common.version_conflict, #67 #68) -> body rules.
// Quantities and money are never computed in TS (TRD §4.3): the ledger values every count_adjust_*; TS only does exact bigint arithmetic on the numeric(18,6) quantities (variance), like transfers.service.
// [CONV] LD-140 is UI-only and does not apply here.
// [CONV] BLIND COUNT: a caller without inventory.stock.adjust gets count lines without book_qty_snapshot / book_qty_at_count / variance_* (the snapshot is still stored); variance_value_paisa also needs inventory.cost.read (mapper).
//        The contract lists book_qty_snapshot under CountLine.required; the blind rule wins (07-SECURITY, 04-UI-UX S11) - see .orchestra/notes/C12.T-14-impl.md (CR for C0).
// [CONV] variance = counted - book_at_count; book_at_count = book_qty_snapshot + sum(qty of the (store, item, lot) movements with snapshot_at < occurred_at <= line.counted_at) (occurred_at, never created_at).
// [CONV] uncounted_policy 'zero': lines never counted are counted 0 at post time (counted_at = ctx.now()); 'skip': they stay untouched (book_at_count / variance stay NULL).
// [CONV] a negative variance larger than the lot row is the ledger's split (lot row to 0, remainder on the unlotted row, negative_stock alert): the post never fails on it (AC-19.3).
// [CONV] numbering skips a number already taken in the tenant (as transfers.service); ponytail: 50 probes, then common.internal.
// [CONV] a line created by #66 for a pair outside the snapshot takes the balance AS OF snapshot_at as book_qty_snapshot (review #1), so book_at_count stays snapshot + movements (snapshot_at, counted_at].
import { LimsError } from '../../../core/errors.js';
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import type { HandlerContext } from '../../../core/module.js';
import { formatNumber, periodKey } from '../domain/numbering.js';
import { formatScaled, scaled } from '../domain/quantity.js';
import { assertTransition } from '../domain/count.state.js';
import { assertZone, nowMs, ymdIn } from '../domain/tenantTime.js';
import type { CountLineInput, CountListQuery, CountOpenInput } from '../handlers/counts.schemas.js';
import { fieldError, invalid } from '../handlers/items.schemas.js';
import type { PageQuery } from '../handlers/masters.schemas.js';
import { toCountDto } from '../mappers/count.dto.js';
import { insertCount, insertCountLine, getCount as loadCount, updateCount, updateCountLine } from '../repository/counts.repo.js';
import { listReasons } from '../repository/codedSets.repo.js';
import { allocateNumber } from '../repository/counters.repo.js';
import { getItem } from '../repository/items.repo.js';
import { ensureSettings } from '../repository/settings.repo.js';
import { getStore } from '../repository/stores.repo.js';
import { type RepoCtx, type Row, Q, first, isUuid, query } from '../repository/_base.js';
import { PERMISSIONS } from '../permissions.js';
import { post as ledgerPost, type Movement } from './ledger.service.js';
import { assertStoreAccess, listVisibleBranchIds } from './scope.service.js';

type Dto = Record<string, unknown>;
type Scope = Parameters<typeof assertStoreAccess>[0];
const rcOf = (ctx: HandlerContext): RepoCtx => ({ tx: ctx.tx as RepoCtx['tx'], tenantId: ctx.tenantId as string, actorId: ctx.actor?.id as string });
const sc = (ctx: HandlerContext): Scope => ctx as unknown as Scope;
const notFound = (): LimsError => new LimsError('common.not_found');
const READ = PERMISSIONS.itemRead;
const MANAGE = PERMISSIONS.stockManage;
const ADJUST = PERMISSIONS.stockAdjust;
const DEFAULT_REASON = 'count_variance';
const BOOK_KEYS = ['book_qty_snapshot', 'book_qty_at_count', 'variance_qty_base', 'variance_value_paisa'] as const;
const SUMMARY = ['id', 'count_no', 'store_id', 'status', 'scope_category', 'snapshot_at', 'posted_at', 'version'] as const;

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
const signed = (v: bigint): string => (v < 0n ? `-${formatScaled(-v, 6)}` : formatScaled(v, 6));

async function clock(ctx: HandlerContext): Promise<{ now: number; nowIso: string; today: string }> {
  const s = await (ctx.ports.IdentityPort as any).getTenantSettings(ctx, { keys: ['timezone'] });
  const tz = assertZone(s?.timezone);
  const now = nowMs((ctx as any).now());
  return { now, nowIso: new Date(now).toISOString(), today: ymdIn(now, tz) };
}

function cursorId(p: PageQuery): string {
  let id: unknown;
  try { id = (JSON.parse(Buffer.from(p.cursor as string, 'base64url').toString('utf8')) as { i?: unknown } | null)?.i; } catch { /* 400 below */ }
  if (!isUuid(id)) throw invalid(fieldError('/cursor'));
  return id;
}
const nextCursor = (rows: readonly Row[]): string => Buffer.from(JSON.stringify({ i: rows[rows.length - 1]!['id'] })).toString('base64url');

/** Count line DTOs for this caller: cost keys by the mapper, book / variance keys only with inventory.stock.adjust (BLIND COUNT). */
function lineDtos(rows: readonly Row[], perms: readonly string[]): Row[] {
  const lines = toCountDto({ lines: rows.map(wire) }, perms)['lines'] as Row[];
  if (!perms.includes(ADJUST)) for (const l of lines) for (const k of BOOK_KEYS) delete l[k];
  return lines;
}

/** The Count as the contract shows it: one page of lines (ORDER BY id; limit default 200). */
async function view(ctx: HandlerContext, rc: RepoCtx, id: string, page: PageQuery = { limit: 200 }): Promise<Dto> {
  const c = await loadCount(rc, id);
  if (c === null) throw notFound();
  const q = new Q();
  const after = page.cursor === undefined ? '' : ` AND id > ${q.p(cursorId(page))}::uuid`;
  const rows = await query(rc, `SELECT * FROM inventory.stock_count_lines WHERE tenant_id = $1 AND count_id = ${q.p(id)}${after} ORDER BY id LIMIT ${q.p(page.limit + 1)}`, q.vals);
  const data = rows.slice(0, page.limit);
  const next = rows.length > page.limit ? nextCursor(data) : undefined;
  const perms = await permissionsOf(ctx);
  const dto = toCountDto({ ...wire(c), lines: data, lines_page: { limit: page.limit, ...(next === undefined ? {} : { next_cursor: next }) } }, perms);
  dto['lines'] = lineDtos(data, perms);
  return dto;
}

/** Load the count, 404 when its store's branch is not visible, then assert `permission` for that branch (P-B8: 404 beats 403). */
async function assertCountAccess(ctx: HandlerContext, id: string, permission: string): Promise<Row> {
  const rc = rcOf(ctx);
  const c = isUuid(id) ? await loadCount(rc, id) : null;
  if (c === null) throw notFound();
  const store = await getStore(rc, c['store_id']);
  const v = await listVisibleBranchIds(sc(ctx));
  if (store === null || !(v.all || v.branchIds.includes(store['branch_id']))) throw notFound();
  await ctx.ports.IdentityPort.assertRole(ctx, { permission, branchId: store['branch_id'] });
  return c;
}

/** Row lock on the count: two requests on the same document queue here, the loser re-reads the new status (-> 409). */
async function lockCount(rc: RepoCtx, id: string): Promise<Row> {
  const c = await first(rc, 'SELECT * FROM inventory.stock_counts WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [id]);
  if (c === null) throw notFound();
  return c;
}
const listLines = (rc: RepoCtx, countId: string): Promise<Row[]> => query(rc, 'SELECT * FROM inventory.stock_count_lines WHERE tenant_id = $1 AND count_id = $2 ORDER BY id', [countId]);

// ---------------------------------------------------------------- #63 list
export async function listCounts(ctx: HandlerContext, f: CountListQuery): Promise<Dto> {
  const rc = rcOf(ctx);
  const q = new Q();
  let w = '';
  const v = await listVisibleBranchIds(sc(ctx));
  if (!v.all) w += ` AND store_id IN (SELECT id FROM inventory.stores WHERE tenant_id = $1 AND branch_id = ANY(${q.p([...v.branchIds])}::uuid[]))`; // P-B1
  if (f.store_id !== undefined) w += ` AND store_id = ${q.p(f.store_id)}`;
  if (f.status !== undefined) w += ` AND status = ${q.p(f.status)}`;
  if (f.cursor !== undefined) w += ` AND id < ${q.p(cursorId(f))}::uuid`;
  const rows = await query(rc, `SELECT * FROM inventory.stock_counts WHERE tenant_id = $1${w} ORDER BY id DESC LIMIT ${q.p(f.limit + 1)}`, q.vals); // ponytail: ids are uuidv7 (creation order); keyset on id
  const data = rows.slice(0, f.limit);
  return {
    data: data.map((r) => { const o = wire(r); return Object.fromEntries(SUMMARY.filter((k) => o[k] !== undefined).map((k) => [k, o[k]])); }),
    page: { limit: f.limit, ...(rows.length > f.limit ? { next_cursor: nextCursor(data) } : {}) },
  };
}

// ---------------------------------------------------------------- #64 open (AC-19.1)
async function nextNumber(rc: RepoCtx, today: string): Promise<string> {
  const pattern = (await ensureSettings(rc))['count_no_pattern'] as string;
  const period = periodKey(pattern, today);
  for (let n = 0; n < 50; n++) {
    const no = formatNumber(pattern, today, await allocateNumber(rc, 'count', period));
    if ((await first(rc, 'SELECT 1 AS x FROM inventory.stock_counts WHERE tenant_id = $1 AND count_no = $2', [no])) === null) return no;
  }
  throw new LimsError('common.internal');
}

export async function openCount(ctx: HandlerContext, input: CountOpenInput): Promise<Dto> {
  const rc = rcOf(ctx);
  await assertStoreAccess(sc(ctx), input.store_id, MANAGE); // 404 invisible / unknown -> 403 (P-B8)
  if ((await first(rc, "SELECT 1 AS x FROM inventory.stock_counts WHERE tenant_id = $1 AND store_id = $2 AND status = 'open'", [input.store_id])) !== null) throw new LimsError('inventory.count_already_open');
  const { nowIso, today } = await clock(ctx);
  const id = uuidv7();
  try {
    await insertCount(rc, { id, count_no: await nextNumber(rc, today), store_id: input.store_id, status: 'open', scope_category: input.scope_category ?? null, snapshot_at: nowIso, notes: input.notes ?? null });
  } catch (e) { // two opens at once: the partial unique index (store, status = 'open') decides, the loser is a 409 (CR-C12-003)
    if ((e as { code?: string }).code === '23505' && String((e as { constraint?: string }).constraint).includes('store_open')) throw new LimsError('inventory.count_already_open');
    throw e;
  }
  // every non-zero balance row of the store (a negative unlotted row too, E7), optionally one item category
  const q = new Q();
  const cat = input.scope_category === undefined ? '' : ` AND i.category = ${q.p(input.scope_category)}`;
  const bal = await query(rc, `SELECT b.item_id, b.lot_id, b.qty_base FROM inventory.stock_balances b JOIN inventory.items i ON i.tenant_id = b.tenant_id AND i.id = b.item_id
      WHERE b.tenant_id = $1 AND b.store_id = ${q.p(input.store_id)} AND b.qty_base <> 0${cat} ORDER BY b.item_id, b.lot_id NULLS FIRST`, q.vals);
  for (const b of bal) await insertCountLine(rc, { id: uuidv7(), count_id: id, item_id: b['item_id'], lot_id: b['lot_id'], book_qty_snapshot: b['qty_base'] });
  return view(ctx, rc, id);
}

// ---------------------------------------------------------------- #65 get
export async function getCount(ctx: HandlerContext, id: string, page: PageQuery): Promise<Dto> {
  await assertCountAccess(ctx, id, READ);
  return view(ctx, rcOf(ctx), id, page);
}

// ---------------------------------------------------------------- #66 record (AC-19.2 inputs; no stock effect)
export async function recordLines(ctx: HandlerContext, id: string, input: { lines: CountLineInput[] }): Promise<Dto> {
  const rc = rcOf(ctx);
  const c = await assertCountAccess(ctx, id, MANAGE);
  assertTransition((await lockCount(rc, id))['status'], 'open');
  const { nowIso } = await clock(ctx);
  const lines = await listLines(rc, id);
  const byId = new Map(lines.map((l) => [l['id'] as string, l]));
  const byKey = new Map(lines.map((l) => [`${l['item_id']}|${l['lot_id'] ?? ''}`, l]));
  const reasons = new Set<string>();
  if (input.lines.some((l) => l.reason_code !== undefined)) for (const g of ['adjustment', 'count_variance']) for (const r of await listReasons(rc, g)) reasons.add(r['code']);

  // pass 1: resolve and validate EVERY line (nothing is written until all are good)
  const plan: { row: Row | null; input: CountLineInput; book: string }[] = [];
  for (const [i, l] of input.lines.entries()) {
    if (l.reason_code !== undefined && !reasons.has(l.reason_code)) throw invalid(fieldError(`/lines/${i}/reason_code`));
    let row: Row | null;
    if (l.line_id !== undefined) {
      row = byId.get(l.line_id) ?? null;
      if (row === null) throw notFound(); // unknown line / a line of another count (no oracle)
      if (row['item_id'] !== l.item_id || (row['lot_id'] ?? null) !== (l.lot_id ?? null)) throw invalid(fieldError(`/lines/${i}/item_id`));
      plan.push({ row, input: l, book: '' });
      continue;
    }
    row = byKey.get(`${l.item_id}|${l.lot_id ?? ''}`) ?? null;
    if (row !== null) { plan.push({ row, input: l, book: '' }); continue; }
    if ((await getItem(rc, l.item_id)) === null) throw notFound();
    if (l.lot_id !== undefined) {
      const lot = await first(rc, 'SELECT item_id FROM inventory.lots WHERE tenant_id = $1 AND id = $2', [l.lot_id]);
      if (lot === null || lot['item_id'] !== l.item_id) throw notFound();
    }
    // book_qty_snapshot = balance AS OF snapshot_at (current balance minus movements after it), so #67 does not count those twice (review #1, AC-19.2)
    const b = await first(rc, `SELECT (coalesce((SELECT qty_base FROM inventory.stock_balances WHERE tenant_id = $1 AND store_id = $2 AND item_id = $3 AND lot_id IS NOT DISTINCT FROM $4::uuid), 0)
        - coalesce((SELECT sum(qty_base) FROM inventory.stock_movements WHERE tenant_id = $1 AND store_id = $2 AND item_id = $3 AND lot_id IS NOT DISTINCT FROM $4::uuid AND occurred_at > $5), 0))::text AS qty_base`,
      [c['store_id'], l.item_id, l.lot_id ?? null, c['snapshot_at']]);
    plan.push({ row: null, input: l, book: String(b!['qty_base']) });
  }

  // pass 2: write
  const out: Row[] = [];
  for (const p of plan) {
    const l = p.input;
    const fields: Row = { counted_qty_base: formatScaled(scaled(l.counted_qty_base, 6), 6), counted_at: l.counted_at ?? nowIso, counted_by: rc.actorId, ...(l.reason_code === undefined ? {} : { reason_code: l.reason_code }) };
    out.push(p.row === null
      ? await insertCountLine(rc, { id: uuidv7(), count_id: id, item_id: l.item_id, lot_id: l.lot_id ?? null, book_qty_snapshot: p.book, ...fields })
      : await updateCountLine(rc, p.row['id'], p.row['version'], fields)); // latest entry wins
  }
  return { updated: out.length, lines: lineDtos(out, await permissionsOf(ctx)) };
}

// ---------------------------------------------------------------- #67 post (AC-19.2, AC-19.3)
export async function postCount(ctx: HandlerContext, id: string, ifMatch: number, input: { uncounted_policy: 'skip' | 'zero' }): Promise<Dto> {
  const rc = rcOf(ctx);
  await assertCountAccess(ctx, id, ADJUST); // privileged: aal1 -> 403 auth.mfa_required (PE-1)
  const c = await lockCount(rc, id);
  assertTransition(c['status'], 'posted');
  if (c['version'] !== ifMatch) throw new LimsError('common.version_conflict');
  const { nowIso, today } = await clock(ctx);

  let lines = await listLines(rc, id);
  if (input.uncounted_policy === 'zero') { // never-counted lines are counted 0 now
    const zeroed: Row[] = [];
    for (const l of lines) zeroed.push(l['counted_qty_base'] !== null ? l : await updateCountLine(rc, l['id'], l['version'], { counted_qty_base: '0.000000', counted_at: nowIso, counted_by: rc.actorId }));
    lines = zeroed;
  }
  const counted = lines.filter((l) => l['counted_qty_base'] !== null);

  // movements of each (store, item, lot) in (snapshot_at, counted_at] (AC-19.2)
  const deltas = new Map((counted.length === 0 ? [] : await query(rc, `SELECT l.id, coalesce((SELECT sum(m.qty_base) FROM inventory.stock_movements m
        WHERE m.tenant_id = $1 AND m.store_id = $3 AND m.item_id = l.item_id AND m.lot_id IS NOT DISTINCT FROM l.lot_id AND m.occurred_at > $4 AND m.occurred_at <= l.counted_at), 0)::text AS delta
      FROM inventory.stock_count_lines l WHERE l.tenant_id = $1 AND l.id = ANY($2::uuid[])`, [counted.map((l) => l['id']), c['store_id'], c['snapshot_at']])).map((r) => [r['id'] as string, r['delta'] as string]));

  const plan = counted.map((l) => {
    const book = scaled(String(l['book_qty_snapshot']), 6) + scaled(deltas.get(l['id'])!, 6);
    return { line: l, book, variance: scaled(String(l['counted_qty_base']), 6) - book, reason: (l['reason_code'] as string | null) ?? DEFAULT_REASON };
  });
  const movements: Movement[] = plan.filter((p) => p.variance !== 0n).map((p) => ({
    store_id: c['store_id'], item_id: p.line['item_id'], lot_id: p.line['lot_id'] ?? null, kind: p.variance > 0n ? 'count_adjust_in' : 'count_adjust_out',
    qty_base: signed(p.variance), reason_code: p.reason, doc_line_id: p.line['id'],
  }));
  // a variance larger than the lot row is split by the ledger (lot row to 0, rest unlotted, negative_stock): the post does not fail
  const rows = movements.length === 0 ? [] : await ledgerPost(rc, { doc_type: 'stock_count', doc_id: id, occurred_at: nowIso, business_date: today, movements });
  for (const p of plan) {
    const value = rows.filter((r) => r['doc_line_id'] === p.line['id']).reduce((a, r) => a + BigInt(r['value_paisa']), 0n);
    await updateCountLine(rc, p.line['id'], p.line['version'], { book_qty_at_count: signed(p.book), variance_qty_base: signed(p.variance), variance_value_paisa: value.toString(), reason_code: p.reason });
  }
  await updateCount(rc, id, ifMatch, { status: 'posted', posted_at: nowIso, posted_by: rc.actorId });
  return view(ctx, rc, id);
}

// ---------------------------------------------------------------- #68 cancel (no stock effect; lifts the count lock)
export async function cancelCount(ctx: HandlerContext, id: string, ifMatch: number): Promise<Dto> {
  const rc = rcOf(ctx);
  await assertCountAccess(ctx, id, MANAGE);
  const c = await lockCount(rc, id);
  assertTransition(c['status'], 'cancelled');
  if (c['version'] !== ifMatch) throw new LimsError('common.version_conflict');
  await updateCount(rc, id, ifMatch, { status: 'cancelled', cancelled_at: (await clock(ctx)).nowIso, cancelled_by: rc.actorId });
  return view(ctx, rc, id);
}
