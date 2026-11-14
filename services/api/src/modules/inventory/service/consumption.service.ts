// C12.T-15 consumption rules, preview, facts and the manual log / resolve / dismiss / reverse, #69-#79 (02-TRD §5.5, §4.7, §8.2-§8.5; PRD AC-15.1-15.4, AC-17.2-17.3; 07-SECURITY P-B1 / P-B7 / P-B8 / PE-1).
// Order on #77 / #79, always: fact row (lock, 404) -> its store (404 unknown / branch not visible) -> assertRole({permission, branchId}) (403) -> state (409) -> If-Match (409) -> body rules.
// #69-#76 and #78 are tenant-context: the handler asserts the permission tenant-wide BEFORE this service runs.
// A fact row is INSERTed with its FINAL status (posted / no_rule / unresolved) after rule matching and store resolution; the only later write of a new fact is the same-status
// value_paisa_total after posting (TRD §8.1 step 6). Quantities and money are never computed in TS (TRD §4.3): the ledger values every movement.
// [CONV] LD-140 is UI-only and does not apply here.
// [CONV] a manual QC fact that names its test only matches per_qc rules attributed to that test (consumers.service candidateRules); events carry no test and match by analyte (§8.3).
// [CONV] a reversal posts at ctx.now() / today (tenant tz): stock returns when the correction is made; the reversal row nets the original in consumption_daily through reverses_movement_id.
// [CONV] resolving a fact whose rules are gone by then (a rule deactivated after the event) posts it with rules_applied 0 and no movements (unresolved -> posted is the only exit but dismiss).
import { LimsError } from '../../../core/errors.js';
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import type { HandlerContext } from '../../../core/module.js';
import { assertTransition } from '../domain/fact.state.js';
import { formatScaled, packToBase, scaled } from '../domain/quantity.js';
import { assertZone, nowMs, ymdIn } from '../domain/tenantTime.js';
import type { FactListQuery, LogEventInput, PreviewInput, RuleCreateInput, RuleListQuery, RuleSupersedeInput } from '../handlers/consumption.schemas.js';
import { fieldError, invalid } from '../handlers/items.schemas.js';
import type { PageQuery } from '../handlers/masters.schemas.js';
import { toConsumptionPreviewDto } from '../mappers/consumption.dto.js';
import { toFactDto } from '../mappers/fact.dto.js';
import { listReasons } from '../repository/codedSets.repo.js';
import { insertFact, updateFact } from '../repository/facts.repo.js';
import { getItem, getPack } from '../repository/items.repo.js';
import { insertRule, updateRule } from '../repository/rules.repo.js';
import { getSettings } from '../repository/settings.repo.js';
import { getStore } from '../repository/stores.repo.js';
import { type RepoCtx, type Row, Q, first, isUuid, query } from '../repository/_base.js';
import { PERMISSIONS } from '../permissions.js';
import { post as ledgerPost, type Movement } from './ledger.service.js';
import { type Clock, estimateValue, lockFact, matchFact, planLots, postNeeds, postUnresolvedFact, raiseUnresolvedAlert, resolveStore, setFactTotal } from './consumers.service.js';
import { listVisibleBranchIds } from './scope.service.js';

export { resolveStore } from './consumers.service.js';

type Dto = Record<string, unknown>;
type Scope = Parameters<typeof listVisibleBranchIds>[0];
const rcOf = (ctx: HandlerContext): RepoCtx => ({ tx: ctx.tx as RepoCtx['tx'], tenantId: ctx.tenantId as string, actorId: ctx.actor?.id as string });
const sc = (ctx: HandlerContext): Scope => ctx as unknown as Scope;
const notFound = (): LimsError => new LimsError('common.not_found');
const BENCH = PERMISSIONS.benchRecord;
const MANAGE = PERMISSIONS.masterManage;
const ADJUST = PERMISSIONS.stockAdjust;
const FUTURE_SLACK_MS = 300_000; // 02-TRD §4.7: an instant may lie at most 300 s ahead of the clock
const DEFAULT_BACKDATE_DAYS = 7;

// ---------------------------------------------------------------- DB error mapping (P-1): a violated constraint is the caller's field, never a 500
const BY_CONSTRAINT: Record<string, () => LimsError> = {
  consumption_rules__current__p_uq: () => new LimsError('inventory.rule_conflict'),
  consumption_rules__item__fk: () => invalid(fieldError('/item_id')),
  consumption_rules__test__fk: () => invalid(fieldError('/test_id')),
  consumption_rules__analyte__fk: () => invalid(fieldError('/analyte_id')),
  consumption_rules__instrument__fk: () => invalid(fieldError('/instrument_id')),
  consumption_rules__pack__fk: () => new LimsError('inventory.uom_mismatch'),
  consumption_rules__shape__ck: () => invalid(fieldError('/rule_kind')),
  consumption_facts__test__fk: () => invalid(fieldError('/test_id')),
  consumption_facts__instrument__fk: () => invalid(fieldError('/instrument_id')),
};
const mapped = async <T>(p: Promise<T>): Promise<T> => {
  try { return await p; } catch (e) {
    const c = (e as { constraint?: string } | null)?.constraint;
    const fn = c === undefined ? undefined : BY_CONSTRAINT[c];
    throw fn ? fn() : e;
  }
};

// ---------------------------------------------------------------- wire helpers: null is never sent (CV §4.2), timestamps are ISO, bigint money is a number
const MONEY = /_paisa(_total|_x1e6)?$/;
function wire(row: Row): Row {
  const o: Row = {};
  for (const [k, v] of Object.entries(row)) {
    if (v === null || v === undefined) continue;
    o[k] = v instanceof Date ? v.toISOString() : MONEY.test(k) ? Number(v) : v;
  }
  return o;
}
const pick = (row: Row, keys: readonly string[]): Dto => Object.fromEntries(keys.filter((k) => row[k] !== undefined).map((k) => [k, row[k]]));
const permissionsOf = async (ctx: HandlerContext): Promise<readonly string[]> => (await (ctx.ports.IdentityPort as any).getActor(ctx)).permissions ?? [];

async function clock(ctx: HandlerContext): Promise<Clock & { nowIso: string }> {
  const s = await (ctx.ports.IdentityPort as any).getTenantSettings(ctx, { keys: ['timezone'] });
  const tz = assertZone(s?.timezone);
  const now = nowMs((ctx as any).now());
  return { tz, nowMs: now, nowIso: new Date(now).toISOString() };
}

function cursorId(p: PageQuery): string {
  let id: unknown;
  try { id = (JSON.parse(Buffer.from(p.cursor as string, 'base64url').toString('utf8')) as { i?: unknown } | null)?.i; } catch { /* 400 below */ }
  if (!isUuid(id)) throw invalid(fieldError('/cursor'));
  return id;
}
const nextCursor = (rows: readonly Row[]): string => Buffer.from(JSON.stringify({ i: rows[rows.length - 1]!['id'] })).toString('base64url');

// ---------------------------------------------------------------- rules: DTO, conversion
const RULE_KEYS = ['id', 'rule_kind', 'test_id', 'analyte_id', 'instrument_id', 'item_id', 'qty_base', 'entered_qty', 'entered_pack_id', 'effective_from', 'effective_to', 'supersedes_rule_id', 'notes', 'is_active', 'version'];
const ruleDto = (row: Row, history?: readonly Row[]): Dto => ({ ...pick(wire(row), RULE_KEYS), ...(history === undefined ? {} : { history: history.map((h) => pick(wire(h), ['id', 'qty_base', 'effective_from', 'effective_to'])) }) });
const isCurrent = (r: Row): boolean => r['effective_to'] === null && r['is_active'] === true;

/** qty (packs when pack_id is given, else base units) -> { qty_base, entered_qty, entered_pack_id }; a pack of another item is 422 inventory.uom_mismatch (TRD §4.1). */
async function baseQty(rc: RepoCtx, itemId: string, qty: string, packId: string | undefined): Promise<{ qty_base: string; entered_qty: string; entered_pack_id: string | null }> {
  const entered = formatScaled(scaled(qty, 6), 6);
  if (packId === undefined) return { qty_base: entered, entered_qty: entered, entered_pack_id: null };
  const pack = await getPack(rc, packId);
  if (pack === null || pack['item_id'] !== itemId) throw new LimsError('inventory.uom_mismatch');
  let base: string;
  try { base = packToBase(qty, String(pack['qty_in_base'])); } catch { throw invalid(fieldError('/qty')); } // pack quantities carry at most 3 decimals
  return { qty_base: base, entered_qty: entered, entered_pack_id: packId };
}

/** Shape check against the catalog (TRD §5.5 #70): the analyte must belong to the test. A LimsError of the port (unknown test) propagates unchanged. */
async function checkCatalog(ctx: HandlerContext, testId: string | undefined, analyteId: string | undefined): Promise<void> {
  if (testId === undefined) return;
  const t = await (ctx.ports as any).CatalogPort.getTest(ctx, { testId });
  if (analyteId !== undefined && !((t?.analytes ?? []) as { id: string }[]).some((a) => a.id === analyteId)) throw invalid(fieldError('/analyte_id'));
}

const lockRule = async (rc: RepoCtx, id: string): Promise<Row> => (await first(rc, 'SELECT * FROM inventory.consumption_rules WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [id])) ?? Promise.reject(notFound());

// ---------------------------------------------------------------- #69 list
export async function listRules(ctx: HandlerContext, f: RuleListQuery): Promise<Dto> {
  const q = new Q();
  let w = f.current_only ? ' AND is_active AND effective_to IS NULL' : '';
  for (const k of ['rule_kind', 'test_id', 'instrument_id', 'item_id'] as const) if (f[k] !== undefined) w += ` AND ${k} = ${q.p(f[k])}`;
  if (f.cursor !== undefined) w += ` AND id > ${q.p(cursorId(f))}::uuid`;
  const rows = await query(rcOf(ctx), `SELECT * FROM inventory.consumption_rules WHERE tenant_id = $1${w} ORDER BY id LIMIT ${q.p(f.limit + 1)}`, q.vals);
  const data = rows.slice(0, f.limit);
  return { data: data.map((r) => ruleDto(r)), page: { limit: f.limit, ...(rows.length > f.limit ? { next_cursor: nextCursor(data) } : {}) } };
}

// ---------------------------------------------------------------- #70 create (AC-12.x shape checks; one CURRENT rule per key)
export async function createRule(ctx: HandlerContext, input: RuleCreateInput): Promise<Dto> {
  const rc = rcOf(ctx);
  await checkCatalog(ctx, input.test_id, input.analyte_id);
  if ((await getItem(rc, input.item_id)) === null) throw invalid(fieldError('/item_id'));
  const qty = await baseQty(rc, input.item_id, input.qty, input.pack_id);
  const row = await mapped(insertRule(rc, {
    id: uuidv7(), rule_kind: input.rule_kind, test_id: input.test_id ?? null, analyte_id: input.analyte_id ?? null, instrument_id: input.instrument_id ?? null, item_id: input.item_id, ...qty,
    effective_from: (await clock(ctx)).nowIso, notes: input.notes ?? null,
  }));
  return ruleDto(row);
}

// ---------------------------------------------------------------- #71 get (+ the supersede chain, both directions)
export async function getRule(ctx: HandlerContext, id: string): Promise<Dto> {
  const rc = rcOf(ctx);
  const row = await first(rc, 'SELECT * FROM inventory.consumption_rules WHERE tenant_id = $1 AND id = $2', [id]);
  if (row === null) throw notFound();
  const chain = await query(rc, `WITH RECURSIVE up AS (
        SELECT id, supersedes_rule_id, qty_base, effective_from, effective_to FROM inventory.consumption_rules WHERE tenant_id = $1 AND id = $2
        UNION SELECT r.id, r.supersedes_rule_id, r.qty_base, r.effective_from, r.effective_to FROM inventory.consumption_rules r JOIN up ON r.tenant_id = $1 AND r.id = up.supersedes_rule_id),
      down AS (
        SELECT id, supersedes_rule_id, qty_base, effective_from, effective_to FROM inventory.consumption_rules WHERE tenant_id = $1 AND id = $2
        UNION SELECT r.id, r.supersedes_rule_id, r.qty_base, r.effective_from, r.effective_to FROM inventory.consumption_rules r JOIN down ON r.tenant_id = $1 AND r.supersedes_rule_id = down.id)
    SELECT id, qty_base, effective_from, effective_to FROM up UNION SELECT id, qty_base, effective_from, effective_to FROM down ORDER BY effective_from, id`, [id]);
  return ruleDto(row, chain);
}

// ---------------------------------------------------------------- #72 supersede / #73 deactivate (the old rule closes at one instant; the new one starts at it)
const closeAt = (rule: Row, nowIso: string): string => {
  const from = new Date(rule['effective_from']).getTime();
  return new Date(Math.max(Date.parse(nowIso), from + 1)).toISOString(); // effective_to > effective_from (consumption_rules__qty__ck)
};

export async function supersedeRule(ctx: HandlerContext, id: string, ifMatch: number, input: RuleSupersedeInput): Promise<Dto> {
  const rc = rcOf(ctx);
  const old = await lockRule(rc, id);
  if (!isCurrent(old)) throw new LimsError('inventory.document_invalid_transition');
  if (old['version'] !== ifMatch) throw new LimsError('common.version_conflict');
  const qty = await baseQty(rc, old['item_id'], input.qty, input.pack_id);
  const at = closeAt(old, (await clock(ctx)).nowIso);
  await updateRule(rc, id, ifMatch, { effective_to: at });
  const row = await mapped(insertRule(rc, {
    id: uuidv7(), rule_kind: old['rule_kind'], test_id: old['test_id'], analyte_id: old['analyte_id'], instrument_id: old['instrument_id'], item_id: old['item_id'], ...qty,
    effective_from: at, supersedes_rule_id: id, notes: input.notes ?? null,
  }));
  return ruleDto(row);
}

export async function deactivateRule(ctx: HandlerContext, id: string, ifMatch: number): Promise<Dto> {
  const rc = rcOf(ctx);
  const rule = await lockRule(rc, id);
  if (!isCurrent(rule)) throw new LimsError('inventory.document_invalid_transition');
  if (rule['version'] !== ifMatch) throw new LimsError('common.version_conflict');
  return ruleDto(await updateRule(rc, id, ifMatch, { effective_to: closeAt(rule, (await clock(ctx)).nowIso), is_active: false }));
}

// ---------------------------------------------------------------- facts: DTO
const FACT_SQL = `id, fact_kind, source, status, instrument_id, test_id, analyte_id, occurred_at, to_char(business_date, 'YYYY-MM-DD') AS business_date, multiplier, store_id, rules_applied,
  value_paisa_total, reason_code, note, version`;
const MOVE_SQL = `SELECT m.id, m.occurred_at, to_char(m.business_date, 'YYYY-MM-DD') AS business_date, m.store_id, m.item_id, m.lot_id, l.lot_no, m.movement_kind, m.qty_base::text AS qty_base,
    m.balance_qty_after::text AS balance_qty_after, m.value_paisa, m.value_basis, m.doc_type, m.doc_id, m.instrument_id, m.attributed_test_id, m.rule_id, m.reason_code
  FROM inventory.stock_movements m LEFT JOIN inventory.lots l ON l.tenant_id = m.tenant_id AND l.id = m.lot_id`;

/** Fact DTOs with their movements; `storeIds` (P-B1) limits the movements to visible branches. value_paisa_total is cost data (REQ-SEC-081) and is dropped without inventory.cost.read. */
async function factDtos(rc: RepoCtx, rows: readonly Row[], perms: readonly string[], storeIds?: readonly string[]): Promise<Dto[]> {
  if (rows.length === 0) return [];
  const q = new Q();
  const scope = storeIds === undefined ? '' : ` AND m.store_id = ANY(${q.p([...storeIds])}::uuid[])`;
  const moves = await query(rc, `${MOVE_SQL} WHERE m.tenant_id = $1 AND m.doc_type = 'consumption_fact' AND m.doc_id = ANY(${q.p(rows.map((r) => r['id']))}::uuid[])${scope} ORDER BY m.created_at, m.qty_base`, q.vals);
  const cost = perms.includes(PERMISSIONS.costRead);
  return rows.map((r) => {
    const dto = toFactDto({ ...wire(r), movements: moves.filter((m) => m['doc_id'] === r['id']).map(wire) }, perms) as Dto;
    if (!cost) delete dto['value_paisa_total'];
    return dto;
  });
}
async function factView(ctx: HandlerContext, rc: RepoCtx, id: string): Promise<Dto> {
  const row = await first(rc, `SELECT ${FACT_SQL} FROM inventory.consumption_facts WHERE tenant_id = $1 AND id = $2`, [id]);
  if (row === null) throw notFound();
  return (await factDtos(rc, [row], await permissionsOf(ctx)))[0]!;
}

// ---------------------------------------------------------------- #75 list (P-B1: facts of visible branches + facts without a store)
export async function listFacts(ctx: HandlerContext, f: FactListQuery): Promise<Dto> {
  const rc = rcOf(ctx);
  const q = new Q();
  const v = await listVisibleBranchIds(sc(ctx));
  let visible: string[] | undefined;
  let w = '';
  if (!v.all) {
    visible = (await query(rc, 'SELECT id FROM inventory.stores WHERE tenant_id = $1 AND branch_id = ANY($2::uuid[])', [[...v.branchIds]])).map((r) => r['id']);
    w += ` AND (store_id IS NULL OR store_id = ANY(${q.p(visible)}::uuid[]))`;
  }
  for (const k of ['status', 'fact_kind', 'instrument_id', 'test_id'] as const) if (f[k] !== undefined) w += ` AND ${k} = ${q.p(f[k])}`;
  if (f.business_date_from !== undefined) w += ` AND business_date >= ${q.p(f.business_date_from)}::date`;
  if (f.business_date_to !== undefined) w += ` AND business_date <= ${q.p(f.business_date_to)}::date`;
  if (f.cursor !== undefined) w += ` AND id < ${q.p(cursorId(f))}::uuid`;
  const rows = await query(rc, `SELECT ${FACT_SQL} FROM inventory.consumption_facts WHERE tenant_id = $1${w} ORDER BY id DESC LIMIT ${q.p(f.limit + 1)}`, q.vals);
  const data = rows.slice(0, f.limit);
  return { data: await factDtos(rc, data, await permissionsOf(ctx), visible), page: { limit: f.limit, ...(rows.length > f.limit ? { next_cursor: nextCursor(data) } : {}) } };
}

// ---------------------------------------------------------------- #74 preview (dry run: reads only)
export async function previewConsumption(ctx: HandlerContext, input: PreviewInput): Promise<Dto> {
  const rc = rcOf(ctx);
  const clk = await clock(ctx);
  const perms = await permissionsOf(ctx);
  const cost = perms.includes(PERMISSIONS.costRead);
  const instrumentId = input.instrument_id ?? null;
  const needs = await matchFact(rc, { fact_kind: input.fact_kind as never, occurred_at: input.at ?? clk.nowIso, instrument_id: instrumentId, test_id: input.test_id ?? null, analyte_id: input.analyte_id ?? null, multiplier: 1 });
  const res = await resolveStore(rc, { instrument_id: instrumentId });
  const taken = new Map<string, bigint>();
  const lines: Row[] = [];
  for (const n of needs) {
    if (res.store_id === null) { lines.push({ rule_id: n.rule_id, item_id: n.item_id, qty_base: n.qty_base }); continue; }
    for (const p of await planLots(rc, { storeId: res.store_id, itemId: n.item_id, qty: n.qty_base, instrumentId, clock: clk, taken })) {
      lines.push({ rule_id: n.rule_id, item_id: n.item_id, qty_base: p.qty, ...(p.lot_id === null ? {} : { lot_id: p.lot_id }), ...(cost ? { est_value_paisa: await estimateValue(rc, res.store_id, n.item_id, p.lot_id, p.qty) } : {}) });
    }
  }
  return toConsumptionPreviewDto({ ...(res.store_id === null ? {} : { store_id: res.store_id }), store_resolution_step: res.step, lines }, perms) as Dto;
}

// ---------------------------------------------------------------- #76 manual log (AC-15.1 calibration, AC-15.3 qc, AC-15.2 window; P-B7)
export async function logEvent(ctx: HandlerContext, input: LogEventInput): Promise<Dto> {
  const rc = rcOf(ctx);
  const clk = await clock(ctx);
  const at = Date.parse(input.occurred_at);
  const backdate = Number((await getSettings(rc))?.['backdate_max_days'] ?? DEFAULT_BACKDATE_DAYS);
  if (at < clk.nowMs - backdate * 86_400_000 || at > clk.nowMs + FUTURE_SLACK_MS) throw invalid(fieldError('/occurred_at')); // AC-15.2
  if (input.reason_code !== undefined && !(await listReasons(rc, 'calibration')).some((r) => r['code'] === input.reason_code)) throw invalid(fieldError('/reason_code'));

  const multiplier = input.fact_kind === 'qc' ? (input.observations ?? 1) : 1;
  const instrumentId = input.instrument_id ?? null;
  const needs = await matchFact(rc, { fact_kind: input.fact_kind, occurred_at: input.occurred_at, instrument_id: instrumentId, test_id: input.test_id, analyte_id: input.analyte_id ?? null, multiplier });
  let storeId: string | null = null;
  if (needs.length > 0) {
    storeId = (await resolveStore(rc, { instrument_id: instrumentId })).store_id;
    if (storeId !== null) { // P-B7: the resolved store's branch must be in the caller's scope, else 403 and nothing is written
      const store = await getStore(rc, storeId);
      const v = await listVisibleBranchIds(sc(ctx));
      if (store === null || !(v.all || v.branchIds.includes(store['branch_id']))) throw new LimsError('auth.forbidden');
      await ctx.ports.IdentityPort.assertRole(ctx, { permission: BENCH, branchId: store['branch_id'] });
    }
  }
  const status = needs.length === 0 ? 'no_rule' : storeId === null ? 'unresolved' : 'posted';
  const id = uuidv7();
  const businessDate = ymdIn(at, clk.tz);
  await mapped(insertFact(rc, {
    id, fact_kind: input.fact_kind, basis_key: `manual:${uuidv7()}`, source: 'manual', instrument_id: instrumentId, test_id: input.test_id, analyte_id: input.analyte_id ?? null,
    occurred_at: input.occurred_at, business_date: businessDate, multiplier, store_id: status === 'posted' ? storeId : null, status, rules_applied: needs.length, value_paisa_total: 0,
    reason_code: input.reason_code ?? null, note: input.note ?? null,
  }));
  if (status === 'posted') {
    const { rows, total } = await postNeeds(rc, { factId: id, factKind: input.fact_kind, occurredAt: input.occurred_at, businessDate, storeId: storeId!, instrumentId, needs, clock: clk });
    if (rows.length > 0) await setFactTotal(rc, id, total);
  } else if (status === 'unresolved') await raiseUnresolvedAlert(rc, instrumentId);
  return factView(ctx, rc, id);
}

// ---------------------------------------------------------------- #77 resolve (AC-17.3: the original time is kept)
export async function resolveFact(ctx: HandlerContext, id: string, ifMatch: number, storeId: string): Promise<Dto> {
  const rc = rcOf(ctx);
  const fact = await lockFact(rc, id);
  if (fact === null) throw notFound();
  const store = await getStore(rc, storeId);
  const v = await listVisibleBranchIds(sc(ctx));
  if (store === null || !(v.all || v.branchIds.includes(store['branch_id']))) throw notFound(); // P-B8: 404 beats 403
  await ctx.ports.IdentityPort.assertRole(ctx, { permission: MANAGE, branchId: store['branch_id'] });
  assertTransition(fact['status'], 'posted', fact['source']);
  if (fact['version'] !== ifMatch) throw new LimsError('common.version_conflict');
  if (store['is_active'] !== true) throw invalid(fieldError('/store_id'));
  const clk = await clock(ctx);
  await postUnresolvedFact(rc, fact, storeId, ifMatch, clk, clk.nowIso);
  return factView(ctx, rc, id);
}

// ---------------------------------------------------------------- #78 dismiss (AC-17.3: nothing is deducted; the fact stays listed for reconciliation)
async function assertReason(rc: RepoCtx, group: string, code: string): Promise<void> {
  if (!(await listReasons(rc, group)).some((r) => r['code'] === code)) throw new LimsError('inventory.reason_required');
}
export async function dismissFact(ctx: HandlerContext, id: string, ifMatch: number, reasonCode: string): Promise<Dto> {
  const rc = rcOf(ctx);
  const fact = await lockFact(rc, id);
  if (fact === null) throw notFound();
  assertTransition(fact['status'], 'dismissed', fact['source']);
  await assertReason(rc, 'fact_dismiss', reasonCode);
  if (fact['version'] !== ifMatch) throw new LimsError('common.version_conflict');
  await updateFact(rc, id, ifMatch, { status: 'dismissed', reason_code: reasonCode });
  return factView(ctx, rc, id);
}

// ---------------------------------------------------------------- #79 reverse (AC-15.4: exactly the original quantities and values; manual facts only)
export async function reverseFact(ctx: HandlerContext, id: string, ifMatch: number, reasonCode: string): Promise<Dto> {
  const rc = rcOf(ctx);
  const fact = await lockFact(rc, id);
  if (fact === null) throw notFound();
  if (fact['store_id'] === null) await ctx.ports.IdentityPort.assertRole(ctx, { permission: ADJUST }); // no store, no branch: asserted tenant-wide
  else {
    const store = await getStore(rc, fact['store_id']);
    const v = await listVisibleBranchIds(sc(ctx));
    if (store === null || !(v.all || v.branchIds.includes(store['branch_id']))) throw notFound();
    await ctx.ports.IdentityPort.assertRole(ctx, { permission: ADJUST, branchId: store['branch_id'] }); // privileged: aal1 -> auth.mfa_required (PE-1)
  }
  if (fact['source'] !== 'manual') throw new LimsError('inventory.fact_not_reversible'); // before the status rule (A4)
  assertTransition(fact['status'], 'reversed', 'manual');
  if (fact['version'] !== ifMatch) throw new LimsError('common.version_conflict');
  await assertReason(rc, 'fact_reverse', reasonCode);

  const clk = await clock(ctx);
  const originals = await query(rc, `SELECT id, store_id, item_id, lot_id, qty_base::text AS qty_base, instrument_id, attributed_test_id, rule_id FROM inventory.stock_movements
      WHERE tenant_id = $1 AND doc_type = 'consumption_fact' AND doc_id = $2 AND movement_kind LIKE 'consume\\_%' AND movement_kind <> 'consume_reversal' ORDER BY created_at, id`, [id]);
  if (originals.length > 0) {
    const movements: Movement[] = originals.map((m) => ({
      store_id: m['store_id'], item_id: m['item_id'], lot_id: m['lot_id'], kind: 'consume_reversal', qty_base: String(m['qty_base']).replace(/^-/, ''), reverses_movement_id: m['id'],
      instrument_id: m['instrument_id'], attributed_test_id: m['attributed_test_id'], rule_id: m['rule_id'], reason_code: reasonCode,
    }));
    await ledgerPost(rc, { doc_type: 'consumption_fact', doc_id: id, occurred_at: clk.nowIso, business_date: ymdIn(clk.nowMs, clk.tz), movements });
  }
  await updateFact(rc, id, ifMatch, { status: 'reversed', reason_code: reasonCode });
  return factView(ctx, rc, id);
}
