// C12.T-15 consumption engine shared by the manual log / resolve (consumption.service), the resolve_unresolved task and, later, the event consumers (T-16 / T-17)
// (02-TRD §4.5 consumption lot selection, §8.2 store resolution, §8.3 rule matching, §8.4 posting a fact; PRD AC-12.6, AC-17.2).
// Everything works on a RepoCtx ({ tx, tenantId, actorId }) so the worker can call it: no HandlerContext, no ports. The clock (tenant tz + now) is passed in.
// NO RULE CACHE (TRD §11): every match is one indexed SELECT on inventory.consumption_rules (consumption_rules__tenant_id_match__idx).
// Quantities and money are never computed in TS (TRD §4.3): the ledger values every movement; TS only does exact bigint arithmetic on numeric(18,6) quantities.
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { loadInventoryConfig } from '../config.js';
import { type Need, type Rule, type RuleFact, type FactKind, matchRules, ruleKindForFact } from '../domain/rules.js';
import { suggestFefo } from '../domain/fefo.js';
import { formatScaled, scaled } from '../domain/quantity.js';
import { ymdIn } from '../domain/tenantTime.js';
import { type RepoCtx, type Row, Q, first, query } from '../repository/_base.js';
import { findInUseContainer } from '../repository/containers.repo.js';
import { getSettings } from '../repository/settings.repo.js';
import { updateFact } from '../repository/facts.repo.js';
import { post as ledgerPost, type Movement } from './ledger.service.js';

export interface Clock { readonly tz: string; readonly nowMs: number }
export type ResolutionStep = 1 | 2 | 3 | 4 | 5 | 6;
export interface StoreResolution { store_id: string | null; step: ResolutionStep }
export interface ResolveInput { instrument_id?: string | null; centre_id?: string | null; processing_branch_id?: string | null }
export interface FactKey {
  fact_kind: FactKind; occurred_at: string; instrument_id: string | null; test_id: string | null; analyte_id: string | null; multiplier: number; rule_id?: string;
}
export interface LotPart { lot_id: string | null; qty: string }

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const MOVEMENT_KIND: Record<FactKind, string> = {
  test: 'consume_test', analyte: 'consume_analyte', rerun: 'consume_rerun', qc: 'consume_qc', calibration: 'consume_calibration', fixed: 'consume_fixed',
};

// ---------------------------------------------------------------- §8.2 store resolution (first match wins)
const defaultStoreOfBranch = async (rc: RepoCtx, branchId: string): Promise<string | null> =>
  (await first(rc, 'SELECT id FROM inventory.stores WHERE tenant_id = $1 AND branch_id = $2 AND is_default_consumption AND is_active ORDER BY id LIMIT 1', [branchId]))?.['id'] ?? null;
/** ctx.core.centre(centre_id).branchId: the same read the core repository does (core.collection_centres, tenant-bound). */
const branchOfCentre = async (rc: RepoCtx, centreId: string): Promise<string | null> =>
  (await first(rc, 'SELECT branch_id FROM core.collection_centres WHERE tenant_id = $1 AND id = $2', [centreId]))?.['branch_id'] ?? null;

/**
 * Steps 1, 2, 5, 6 are on by default; 3 and 4 only through LIMS_INVENTORY_RESOLUTION_STEPS (06-PLAN §3, CR flags). Step 6 (store_id null) always applies.
 * Read-only: never writes (the preview and the task both rely on it).
 */
export async function resolveStore(rc: RepoCtx, f: ResolveInput, steps?: readonly number[]): Promise<StoreResolution> {
  const on = new Set(steps ?? (await loadInventoryConfig()).resolutionSteps);
  if (on.has(1) && f.instrument_id) {
    const b = await first(rc, 'SELECT store_id FROM inventory.instrument_bindings WHERE tenant_id = $1 AND instrument_id = $2 AND is_active', [f.instrument_id]);
    if (b !== null) return { store_id: b['store_id'], step: 1 };
  }
  if (on.has(2) && f.centre_id) {
    const branch = await branchOfCentre(rc, f.centre_id);
    const s = branch === null ? null : await defaultStoreOfBranch(rc, branch);
    if (s !== null) return { store_id: s, step: 2 };
  }
  if (on.has(3) && f.processing_branch_id) {
    const s = await defaultStoreOfBranch(rc, f.processing_branch_id);
    if (s !== null) return { store_id: s, step: 3 };
  }
  if (on.has(4) && f.instrument_id) { // CR-C9-006 / CR-C12-005: the published instrument directory gives the centre
    const d = await first(rc, 'SELECT centre_id FROM instruments.v_pub_instrument_directory WHERE tenant_id = $1 AND instrument_id = $2', [f.instrument_id]);
    const branch = d === null || d['centre_id'] == null ? null : await branchOfCentre(rc, d['centre_id']);
    const s = branch === null ? null : await defaultStoreOfBranch(rc, branch);
    if (s !== null) return { store_id: s, step: 4 };
  }
  if (on.has(5)) {
    const def = (await getSettings(rc))?.['default_consumption_store_id'] ?? null;
    if (def !== null && (await first(rc, 'SELECT 1 AS x FROM inventory.stores WHERE tenant_id = $1 AND id = $2 AND is_active', [def])) !== null) return { store_id: def, step: 5 };
  }
  return { store_id: null, step: 6 };
}

// ---------------------------------------------------------------- §8.3 rule matching (candidates from the index, precedence from domain/rules.ts)
const toRule = (r: Row): Rule => ({
  id: r['id'], rule_kind: r['rule_kind'], test_id: r['test_id'] ?? null, analyte_id: r['analyte_id'] ?? null, instrument_id: r['instrument_id'] ?? null, item_id: r['item_id'],
  qty_base: String(r['qty_base']), effective_from: iso(r['effective_from']), effective_to: r['effective_to'] == null ? null : iso(r['effective_to']), is_active: r['is_active'] === true,
});

/** Active rules of the fact's kind whose window holds `occurred_at` and whose key fields can match (rules are evaluated at the ORIGINAL time, §8.3.4). One SELECT per call. */
async function candidateRules(rc: RepoCtx, f: FactKey): Promise<Rule[]> {
  const q = new Q();
  const kind = ruleKindForFact(f.fact_kind);
  const at = q.p(new Date(f.occurred_at).toISOString());
  let w = ` AND rule_kind = ${q.p(kind)} AND is_active AND effective_from <= ${at}::timestamptz AND (effective_to IS NULL OR effective_to > ${at}::timestamptz)`;
  switch (kind) {
    case 'per_test': case 'per_rerun': case 'per_calibration': w += ` AND test_id = ${q.p(f.test_id)}::uuid`; break;
    case 'per_analyte': w += ` AND test_id = ${q.p(f.test_id)}::uuid AND analyte_id = ${q.p(f.analyte_id)}::uuid`; break;
    case 'per_qc': // analyte = A or any; [CONV] a fact that names its test (manual log) only matches rules attributed to it
      w += ` AND (analyte_id IS NULL OR analyte_id = ${q.p(f.analyte_id)}::uuid)`;
      if (f.test_id !== null) w += ` AND test_id = ${q.p(f.test_id)}::uuid`;
      break;
    case 'per_day': w += ` AND id = ${q.p(f.rule_id ?? null)}::uuid`; break;
  }
  if (kind !== 'per_day') w += ` AND (instrument_id IS NULL OR instrument_id = ${q.p(f.instrument_id)}::uuid)`;
  return (await query(rc, `SELECT * FROM inventory.consumption_rules WHERE tenant_id = $1${w}`, q.vals)).map(toRule);
}

export async function matchFact(rc: RepoCtx, f: FactKey): Promise<Need[]> {
  const rules = await candidateRules(rc, f);
  const key: RuleFact = { fact_kind: f.fact_kind, occurred_at: new Date(f.occurred_at).toISOString(), instrument_id: f.instrument_id, test_id: f.test_id, analyte_id: f.analyte_id, multiplier: f.multiplier,
    ...(f.rule_id === undefined ? {} : { rule_id: f.rule_id }) };
  return matchRules(key, rules);
}

/** The needs of a STORED fact, evaluated at its original occurred_at (a superseded rule still applies to an old event; a rule created later does not). */
export function matchStoredFact(rc: RepoCtx, fact: Row): Promise<Need[]> {
  const fixed = /^fixed:([0-9a-f-]{36}):/i.exec(String(fact['basis_key'] ?? ''));
  return matchFact(rc, {
    fact_kind: fact['fact_kind'], occurred_at: iso(fact['occurred_at']), instrument_id: fact['instrument_id'] ?? null, test_id: fact['test_id'] ?? null, analyte_id: fact['analyte_id'] ?? null,
    multiplier: Number(fact['multiplier']), ...(fixed ? { rule_id: fixed[1]! } : {}),
  });
}

// ---------------------------------------------------------------- §4.5 lot selection
/** Split one need (store, item, qty > 0) over lots: 1 the in-use lot of the instrument (even expired / quarantined), 2 FEFO, 3 the rest on the unlotted row. Read-only. */
export async function planLots(rc: RepoCtx, a: { storeId: string; itemId: string; qty: string; instrumentId: string | null; clock: Clock; taken?: Map<string, bigint> }): Promise<LotPart[]> {
  const taken = a.taken ?? new Map<string, bigint>();
  const parts: LotPart[] = [];
  let left = scaled(a.qty, 6);
  const take = (lotId: string, avail: bigint): void => {
    const t = avail < left ? avail : left;
    parts.push({ lot_id: lotId, qty: formatScaled(t, 6) });
    taken.set(lotId, (taken.get(lotId) ?? 0n) + t);
    left -= t;
  };
  if (a.instrumentId !== null) {
    const c = await findInUseContainer(rc, { instrumentId: a.instrumentId, itemId: a.itemId, storeId: a.storeId });
    if (c !== null && c['lot_id'] != null) {
      const b = await first(rc, 'SELECT qty_base::text AS q FROM inventory.stock_balances WHERE tenant_id = $1 AND store_id = $2 AND item_id = $3 AND lot_id = $4', [a.storeId, a.itemId, c['lot_id']]);
      const q = b === null ? '-' : String(b['q']);
      const avail = q.startsWith('-') ? 0n : scaled(q, 6) - (taken.get(c['lot_id']) ?? 0n); // a negative lot row has nothing to give
      if (avail > 0n) take(c['lot_id'], avail);
    }
  }
  if (left > 0n) {
    const today = ymdIn(a.clock.nowMs, a.clock.tz);
    const lots = await query(rc, `SELECT l.id AS lot_id, l.lot_no, to_char(l.expiry_on, 'YYYY-MM-DD') AS expiry_on, l.created_at, b.qty_base::text AS qty_base
        FROM inventory.stock_balances b JOIN inventory.lots l ON l.tenant_id = b.tenant_id AND l.id = b.lot_id
       WHERE b.tenant_id = $1 AND b.store_id = $2 AND b.item_id = $3 AND b.qty_base > 0 AND l.status = 'available' AND (l.expiry_on IS NULL OR l.expiry_on >= $4::date)`, [a.storeId, a.itemId, today]);
    const open = lots.length === 0 ? [] : await query(rc, `SELECT lot_id, open_expiry_at FROM inventory.opened_containers
        WHERE tenant_id = $1 AND store_id = $2 AND item_id = $3 AND status = 'open' AND lot_id = ANY($4::uuid[])`, [a.storeId, a.itemId, lots.map((l) => l['lot_id'])]);
    const candidates = lots.flatMap((l) => {
      const free = scaled(l['qty_base'], 6) - (taken.get(l['lot_id']) ?? 0n);
      return free <= 0n ? [] : [{
        lotId: l['lot_id'] as string, lotNo: l['lot_no'] as string, expiryOn: l['expiry_on'] as string | null, createdAt: iso(l['created_at']), availableQtyBase: formatScaled(free, 6),
        openContainers: open.filter((o) => o['lot_id'] === l['lot_id']).map((o) => ({ openExpiryAt: o['open_expiry_at'] == null ? null : iso(o['open_expiry_at']) })),
      }];
    });
    if (candidates.length > 0) {
      const r = suggestFefo({ candidates, qtyBase: formatScaled(left, 6), now: new Date(a.clock.nowMs).toISOString(), timezone: a.clock.tz });
      for (const l of r.lines) take(l.lotId, scaled(l.takeQtyBase, 6));
    }
  }
  if (left > 0n) parts.push({ lot_id: null, qty: formatScaled(left, 6) }); // §4.3 step 4: short stock never blocks a consumption; the ledger raises negative_stock
  return parts;
}

/** Estimated value of consuming `qty` from (store, item, lot): the lot row's average, or the store average for the unlotted row (the same rules as ledger steps 3-4; paisa, rounded half up in SQL). */
export async function estimateValue(rc: RepoCtx, storeId: string, itemId: string, lotId: string | null, qty: string): Promise<number> {
  const r = lotId === null
    ? await first(rc, `SELECT round($4::numeric * sum(value_paisa) / nullif(sum(qty_base), 0))::bigint AS v FROM inventory.stock_balances WHERE tenant_id = $1 AND store_id = $2 AND item_id = $3 AND qty_base > 0`, [storeId, itemId, qty])
    : await first(rc, `SELECT round($5::numeric * value_paisa / nullif(qty_base, 0))::bigint AS v FROM inventory.stock_balances WHERE tenant_id = $1 AND store_id = $2 AND item_id = $3 AND lot_id = $4 AND qty_base > 0`, [storeId, itemId, lotId, qty]);
  return r === null || r['v'] === null ? 0 : Number(r['v']);
}

// ---------------------------------------------------------------- §8.4 posting a fact
/** Post the needs of one fact at `storeId`: one consume_* movement per lot part (ledger.service is the only writer). Returns the ledger rows and the signed value total. */
export async function postNeeds(rc: RepoCtx, a: {
  factId: string; factKind: FactKind; occurredAt: string; businessDate: string; storeId: string; instrumentId: string | null; needs: readonly Need[]; clock: Clock;
}): Promise<{ rows: Row[]; total: bigint }> {
  if (a.needs.length === 0) return { rows: [], total: 0n };
  const taken = new Map<string, bigint>();
  const movements: Movement[] = [];
  for (const need of a.needs) {
    for (const part of await planLots(rc, { storeId: a.storeId, itemId: need.item_id, qty: need.qty_base, instrumentId: a.instrumentId, clock: a.clock, taken })) {
      movements.push({ store_id: a.storeId, item_id: need.item_id, lot_id: part.lot_id, kind: MOVEMENT_KIND[a.factKind], qty_base: `-${part.qty}`, instrument_id: a.instrumentId,
        attributed_test_id: need.attributed_test_id, rule_id: need.rule_id });
    }
  }
  const rows = await ledgerPost(rc, { doc_type: 'consumption_fact', doc_id: a.factId, occurred_at: new Date(a.occurredAt).toISOString(), business_date: a.businessDate, movements });
  return { rows, total: rows.reduce((s, r) => s + BigInt(r['value_paisa']), 0n) };
}

/** Same-status write of value_paisa_total after posting (05 §2.24, TRD §8.1 step 6.4). Not an optimistic-lock write: the fact is part of the request that created it, so `version` stays. */
export async function setFactTotal(rc: RepoCtx, factId: string, total: bigint): Promise<void> {
  await query(rc, 'UPDATE inventory.consumption_facts SET value_paisa_total = $2::bigint, updated_at = now(), updated_by = $3::uuid WHERE tenant_id = $1 AND id = $4', [total.toString(), rc.actorId, factId]);
}

/** Row lock on a fact: two requests on the same fact queue here and the loser re-reads the new status. */
export const lockFact = (rc: RepoCtx, id: string): Promise<Row | null> =>
  first(rc, `SELECT *, to_char(business_date, 'YYYY-MM-DD') AS business_date_text FROM inventory.consumption_facts WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [id]);

/** TRD §8.2 step 6: ONE open alert per dedupe key `unresolved:<instrument or 'none'>` (a repeat raise = occurrences + 1). */
export async function raiseUnresolvedAlert(rc: RepoCtx, instrumentId: string | null): Promise<void> {
  await query(rc, `INSERT INTO inventory.alerts (id, tenant_id, alert_kind, instrument_id, dedupe_key, status, first_raised_at, last_raised_at, occurrences, created_by, updated_by)
    VALUES ($2::uuid, $1, 'unresolved_consumption', $3::uuid, $4, 'open', now(), now(), 1, $5::uuid, $5::uuid)
    ON CONFLICT (tenant_id, dedupe_key) WHERE status <> 'resolved'
    DO UPDATE SET occurrences = alerts.occurrences + 1, last_raised_at = now(), version = alerts.version + 1, updated_at = now(), updated_by = EXCLUDED.updated_by`,
  [uuidv7(), instrumentId, `unresolved:${instrumentId ?? 'none'}`, rc.actorId]);
}

/**
 * Post an `unresolved` (already locked) fact to `storeId` with its ORIGINAL occurred_at / business_date and move it to `posted` in ONE optimistic update (unresolved -> posted, C2).
 * Rules are re-matched at the original time (§8.3.4). Shared by #77 and the resolve_unresolved task.
 */
export async function postUnresolvedFact(rc: RepoCtx, fact: Row, storeId: string, ifMatch: number, clock: Clock, nowIso: string): Promise<Row> {
  const needs = await matchStoredFact(rc, fact);
  const { total } = await postNeeds(rc, {
    factId: fact['id'], factKind: fact['fact_kind'], occurredAt: iso(fact['occurred_at']), businessDate: String(fact['business_date_text'] ?? fact['business_date']), storeId,
    instrumentId: fact['instrument_id'] ?? null, needs, clock,
  });
  return updateFact(rc, fact['id'], ifMatch, { status: 'posted', store_id: storeId, rules_applied: needs.length, value_paisa_total: total.toString(), resolved_at: nowIso, resolved_by: rc.actorId });
}

/** A batch of unresolved facts, oldest first, after an optional (occurred_at, id) cursor (consumption_facts__tenant_id_status__p_idx). Fetches limit + 1 to tell whether more remain. */
export function listUnresolvedBatch(rc: RepoCtx, f: { limit: number; after?: { occurred_at: string; id: string } }): Promise<Row[]> {
  const q = new Q();
  const after = f.after === undefined ? '' : ` AND (occurred_at, id) > (${q.p(f.after.occurred_at)}::timestamptz, ${q.p(f.after.id)}::uuid)`;
  return query(rc, `SELECT *, to_char(business_date, 'YYYY-MM-DD') AS business_date_text, to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at_text
      FROM inventory.consumption_facts WHERE tenant_id = $1 AND status = 'unresolved'${after} ORDER BY occurred_at, id LIMIT ${q.p(f.limit + 1)}`, q.vals);
}
