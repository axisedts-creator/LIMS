// Ledger core: ledger.service.post() is the ONLY writer of stock_movements / stock_balances / consumption_daily (06 row T-05; 02-TRD §3.1, §4.3, §10; 01-PRD §8.1; 05-SCHEMA §6.4).
// TS never computes quantities or money (TRD §4.3): every value is one SQL `numeric` statement per movement, rounded half-up once with round(numeric); TS only validates, orders and passes strings through.
// Everything runs in rc.tx (the caller owns BEGIN/COMMIT). tenant_id comes from rc.tenantId only ($1 of every statement, REQ-SEC-024); created_by = rc.actorId.
// Per batch: 1 insert missing balance rows + lock them FOR UPDATE ordered (store_id, item_id, lot_id NULLS FIRST); 2 per movement: value (plan) then balance UPDATE + ledger INSERT;
//           3 one consumption_daily upsert (aggregated, ordered); 4 alert hooks (alerts.service).
// [CONV] Callers must not interleave two post() calls in one transaction with different lock orders (the order is guaranteed per batch only).
// [CONV] D-75 inbound into a negative unlotted row stays ONE movement whose value is -V (cleared part) + the remainder's rule value; an inbound result below 0 (possible only after a source-fixed receipt into a negative row) is clamped to 0 to honour stock_movements__sign__ck.
// ponytail: the average over other lot rows (st / lr in PLAN) is read unlocked; a parallel change to a sibling lot only shifts an unlotted valuation by that change, the §10.1 invariants are unaffected.
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { LimsError } from '../../../core/errors.js';
import { type RepoCtx, type Row, isUuid, query } from '../repository/_base.js';
import { afterPost } from './alerts.service.js';

export type { RepoCtx };
/** One intended movement. qty_base is a SIGNED DecimalString; value_hint is the source-fixed integer paisa (receive / opening_balance / transfer_in only). */
export interface Movement {
  store_id: string; item_id: string; lot_id: string | null; kind: string; qty_base: string; value_hint?: number;
  doc_line_id?: string | null; instrument_id?: string | null; attributed_test_id?: string | null; rule_id?: string | null; reason_code?: string | null; reverses_movement_id?: string | null;
}
export interface PostInput { doc_type: string; doc_id: string; occurred_at: string; business_date: string; movements: Movement[] }

const IN_KINDS = new Set(['receive', 'opening_balance', 'return_to_store', 'transfer_in', 'consume_reversal', 'adjust_in', 'count_adjust_in']);
const OUT_KINDS = new Set(['supplier_return', 'issue', 'transfer_out', 'consume_test', 'consume_analyte', 'consume_rerun', 'consume_qc', 'consume_calibration', 'consume_fixed',
  'wastage', 'expiry_writeoff', 'adjust_out', 'count_adjust_out']);
const HINT_KINDS = new Set(['receive', 'opening_balance', 'transfer_in']);
const NOT_IN_DAILY = new Set(['receive', 'opening_balance', 'supplier_return', 'transfer_out', 'transfer_in', 'adjust_in', 'adjust_out']);   // 05 §6.4: "In consumption_daily? no"
const DOC_TYPES = new Set(['goods_receipt', 'stock_document', 'transfer', 'stock_count', 'consumption_fact']);
const KEYS = new Set(['store_id', 'item_id', 'lot_id', 'kind', 'qty_base', 'value_hint', 'doc_line_id', 'instrument_id', 'attributed_test_id', 'rule_id', 'reason_code', 'reverses_movement_id']);
const MAX_MOVEMENTS = 500;
const DECIMAL = /^-?[0-9]{1,12}(\.[0-9]{1,6})?$/;   // IC §2.1 DecimalString

const bad = (path: string): LimsError => new LimsError('common.validation_failed', undefined, [{ path, code: 'common.field_invalid', message: 'Field invalid' }]);
const optUuid = (v: unknown, path: string): string | null => {
  if (v === undefined || v === null) return null;
  if (!isUuid(v)) throw bad(path);
  return v;
};

function validate(input: PostInput): Movement[] {
  if (!input || typeof input !== 'object') throw bad('/');
  if (!DOC_TYPES.has(input.doc_type)) throw bad('/doc_type');
  if (!isUuid(input.doc_id)) throw bad('/doc_id');
  if (typeof input.occurred_at !== 'string' || Number.isNaN(Date.parse(input.occurred_at))) throw bad('/occurred_at');
  const bd = input.business_date;
  if (typeof bd !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(bd) || new Date(`${bd}T00:00:00Z`).toISOString().slice(0, 10) !== bd) throw bad('/business_date');
  const ms = input.movements;
  if (!Array.isArray(ms) || ms.length === 0 || ms.length > MAX_MOVEMENTS) throw bad('/movements');
  ms.forEach((m, i) => {
    const at = (f: string) => `/movements/${i}/${f}`;
    if (!m || typeof m !== 'object' || Object.keys(m).some((k) => !KEYS.has(k))) throw bad(`/movements/${i}`);   // unknown keys (e.g. a smuggled tenant_id) are refused
    if (!isUuid(m.store_id)) throw bad(at('store_id'));
    if (!isUuid(m.item_id)) throw bad(at('item_id'));
    if (m.lot_id !== null && !isUuid(m.lot_id)) throw bad(at('lot_id'));
    const inbound = IN_KINDS.has(m.kind);
    if (!inbound && !OUT_KINDS.has(m.kind)) throw bad(at('kind'));
    if (typeof m.qty_base !== 'string' || !DECIMAL.test(m.qty_base) || !/[1-9]/.test(m.qty_base) || m.qty_base.startsWith('-') === inbound) throw bad(at('qty_base'));   // non-zero, sign matches the kind (§6.4)
    if (HINT_KINDS.has(m.kind) ? !Number.isSafeInteger(m.value_hint) || (m.value_hint as number) < 0 : m.value_hint !== undefined) throw bad(at('value_hint'));
    for (const f of ['doc_line_id', 'instrument_id', 'attributed_test_id', 'rule_id'] as const) optUuid(m[f], at(f));
    if (m.reason_code !== undefined && m.reason_code !== null && (typeof m.reason_code !== 'string' || m.reason_code.length < 1 || m.reason_code.length > 200)) throw bad(at('reason_code'));
    if ((m.kind === 'consume_reversal') !== (optUuid(m.reverses_movement_id, at('reverses_movement_id')) !== null)) throw bad(at('reverses_movement_id'));   // required for, and only for, consume_reversal
  });
  return ms;
}

// ---- step 1: balance rows -------------------------------------------------------------------------------------------------------------------------------
const INSERT_MISSING = `INSERT INTO inventory.stock_balances (id, tenant_id, store_id, item_id, lot_id, qty_base, value_paisa, last_movement_at, created_by, updated_by)
SELECT k.id, $1::uuid, k.store_id, k.item_id, k.lot_id, 0, 0, now(), $2::uuid, $2::uuid
  FROM unnest($3::uuid[], $4::uuid[], $5::uuid[], $6::uuid[]) AS k(id, store_id, item_id, lot_id)
 ORDER BY k.store_id, k.item_id, k.lot_id NULLS FIRST
ON CONFLICT DO NOTHING`;
const LOCK = `SELECT b.id FROM inventory.stock_balances b
  JOIN unnest($2::uuid[], $3::uuid[], $4::uuid[]) AS k(store_id, item_id, lot_id) ON k.store_id = b.store_id AND k.item_id = b.item_id AND k.lot_id IS NOT DISTINCT FROM b.lot_id
 WHERE b.tenant_id = $1
 ORDER BY b.store_id, b.item_id, b.lot_id NULLS FIRST
 FOR UPDATE OF b`;

async function lockBalances(rc: RepoCtx, ms: readonly Movement[]): Promise<void> {
  const keys = new Map<string, [string, string, string | null]>();
  const add = (s: string, i: string, l: string | null) => keys.set(`${s}|${i}|${l ?? ''}`, [s, i, l]);
  for (const m of ms) {
    add(m.store_id, m.item_id, m.lot_id);
    if (m.lot_id !== null && (m.kind.startsWith('consume_') || m.kind === 'count_adjust_out')) add(m.store_id, m.item_id, null);   // the unlotted row a split spills onto
  }
  const all = [...keys.values()];
  const cols = [all.map(() => uuidv7()), all.map((k) => k[0]), all.map((k) => k[1]), all.map((k) => k[2])];
  await query(rc, INSERT_MISSING, [rc.actorId, ...cols]);
  await query(rc, LOCK, cols.slice(1));
}

// ---- steps 2-4: valuation (one statement per movement; PRD §8.1) ----------------------------------------------------------------------------------
// rw = target row (Q, V); st = store average over this item's rows with qty > 0; lr = item's latest last receipt; ow = the lot's own last receipt; rvs = value of the reversed movement.
const unVal = (x: string): string => `CASE WHEN sn > 0 THEN -round((${x}) * sv / sn) WHEN lv IS NOT NULL THEN -round((${x}) * lv / ln) ELSE 0 END`;   // step 4: unlotted outbound
const UN_BASIS = `CASE WHEN sn > 0 THEN 'average' WHEN lv IS NOT NULL THEN 'last_receipt' ELSE 'none' END`;
const CAN_SPLIT = `(left(kind, 8) = 'consume_' OR kind = 'count_adjust_out')`;   // step 3: only these may exceed the lot row (excess goes to the unlotted row)
const PLAN = `WITH p AS (SELECT $2::uuid AS store_id, $3::uuid AS item_id, $4::uuid AS lot_id, $5::text AS kind, $6::numeric AS q, $7::bigint AS hint, $8::uuid AS rev),
rw AS (SELECT b.qty_base AS qty, b.value_paisa AS val FROM inventory.stock_balances b JOIN p ON b.store_id = p.store_id AND b.item_id = p.item_id
        AND ((p.lot_id IS NULL AND b.lot_id IS NULL) OR b.lot_id = p.lot_id) WHERE b.tenant_id = $1),
st AS (SELECT sum(b.value_paisa) AS sv, sum(b.qty_base) AS sn FROM inventory.stock_balances b JOIN p ON b.store_id = p.store_id AND b.item_id = p.item_id
        WHERE b.tenant_id = $1 AND b.qty_base > 0),
lr AS (SELECT l.last_receipt_value_paisa AS lv, l.last_receipt_qty_base AS ln FROM inventory.lots l JOIN p ON l.item_id = p.item_id
        WHERE l.tenant_id = $1 AND l.last_receipt_qty_base > 0 AND l.last_receipt_value_paisa IS NOT NULL ORDER BY l.created_at DESC, l.id DESC LIMIT 1),
ow AS (SELECT l.last_receipt_value_paisa AS ov, l.last_receipt_qty_base AS onn FROM inventory.lots l JOIN p ON l.id = p.lot_id
        WHERE l.tenant_id = $1 AND l.last_receipt_qty_base > 0 AND l.last_receipt_value_paisa IS NOT NULL),
rvs AS (SELECT -m.value_paisa AS rvv FROM inventory.stock_movements m JOIN p ON m.id = p.rev
         WHERE m.tenant_id = $1 AND left(m.movement_kind, 8) = 'consume_' AND m.movement_kind <> 'consume_reversal'
           AND m.store_id = p.store_id AND m.item_id = p.item_id AND m.lot_id IS NOT DISTINCT FROM p.lot_id AND m.qty_base = -p.q),   -- review T-05 #2: same store/item/lot, exactly the negated qty (TRD §4.3 step 2)
c AS (SELECT p.*, coalesce((SELECT qty FROM rw), 0) AS rq, coalesce((SELECT val FROM rw), 0) AS rval, abs(p.q) AS m, st.sv, st.sn, lr.lv, lr.ln, ow.ov, ow.onn, (SELECT rvv FROM rvs) AS rvv
        FROM p LEFT JOIN st ON true LEFT JOIN lr ON true LEFT JOIN ow ON true),
e AS (SELECT c.*, CASE WHEN rq < 0 AND q >= -rq THEN q + rq ELSE q END AS x FROM c),
d AS (SELECT e.*,
        CASE WHEN lot_id IS NOT NULL THEN CASE WHEN ov IS NOT NULL THEN round(x * ov / onn) END
             ELSE CASE WHEN sn > 0 THEN round(x * sv / sn) WHEN lv IS NOT NULL THEN round(x * lv / ln) END END AS evv,
        CASE WHEN lot_id IS NOT NULL THEN CASE WHEN ov IS NOT NULL THEN 'last_receipt' END
             ELSE CASE WHEN sn > 0 THEN 'average' WHEN lv IS NOT NULL THEN 'last_receipt' END END AS evb
        FROM e)
SELECT 1 AS ord, lot_id, q AS qty,
  (CASE WHEN q > 0 THEN
          CASE kind WHEN 'receive' THEN hint WHEN 'opening_balance' THEN hint WHEN 'transfer_in' THEN hint WHEN 'consume_reversal' THEN rvv
            ELSE greatest(0, CASE WHEN rq > 0 THEN round(q * rval / rq)
                                  WHEN rq < 0 AND q >= -rq THEN -rval + coalesce(evv, 0)
                                  WHEN rq < 0 THEN round(q * rval / rq)
                                  ELSE coalesce(evv, 0) END) END
        WHEN lot_id IS NULL THEN ${unVal('m')}
        WHEN m = rq THEN -rval
        ELSE -round(m * rval / rq) END)::bigint AS val,
  CASE WHEN q > 0 THEN
          CASE kind WHEN 'receive' THEN 'receipt' WHEN 'opening_balance' THEN 'receipt' WHEN 'transfer_in' THEN 'transfer' WHEN 'consume_reversal' THEN 'reversal'
            ELSE CASE WHEN rq <> 0 THEN 'average' ELSE coalesce(evb, 'none') END END
        WHEN lot_id IS NULL THEN ${UN_BASIS}
        ELSE 'average' END AS basis
  FROM d WHERE q > 0 OR lot_id IS NULL OR m <= rq
UNION ALL
SELECT 1, lot_id, -rq, (-rval)::bigint, 'average' FROM d WHERE q < 0 AND lot_id IS NOT NULL AND m > rq AND rq > 0 AND ${CAN_SPLIT}
UNION ALL
SELECT 2, NULL::uuid, q + rq, (${unVal('m - rq')})::bigint, ${UN_BASIS} FROM d WHERE q < 0 AND lot_id IS NOT NULL AND m > rq AND ${CAN_SPLIT}
ORDER BY ord`;

// ---- step 5: balance + ledger row ----------------------------------------------------------------------------------------------------------------------
const apply = (unlotted: boolean): string => `WITH u AS (
  UPDATE inventory.stock_balances SET qty_base = qty_base + $10::numeric, value_paisa = value_paisa + $11::bigint, version = version + 1, last_movement_at = now(), updated_at = now(), updated_by = $2::uuid
   WHERE tenant_id = $1 AND store_id = $6::uuid AND item_id = $7::uuid AND lot_id ${unlotted ? 'IS NULL' : '= $8::uuid'} RETURNING qty_base)
INSERT INTO inventory.stock_movements (id, tenant_id, business_date, occurred_at, store_id, item_id, lot_id, movement_kind, qty_base, value_paisa, value_basis, doc_type, doc_id, doc_line_id,
  instrument_id, attributed_test_id, rule_id, reason_code, reverses_movement_id, balance_qty_after, created_by)
SELECT $3::uuid, $1::uuid, $4::date, $5::timestamptz, $6::uuid, $7::uuid, $8::uuid, $9::text, $10::numeric, $11::bigint, $12::text, $13::text, $14::uuid, $15::uuid,
  $16::uuid, $17::uuid, $18::uuid, $19::text, $20::uuid, u.qty_base, $2::uuid FROM u RETURNING *`;
const APPLY_LOT = apply(false);
const APPLY_UNLOTTED = apply(true);

// ---- step 6: consumption_daily (05 §6.4: return_to_store under issue, count_adjust_in under count_adjust_out, consume_reversal under the reversed kind; all negated) --------------------
const DAILY = `WITH m AS (
  SELECT sm.business_date, sm.store_id, sm.item_id, sm.instrument_id, sm.attributed_test_id, -sm.qty_base AS q, -sm.value_paisa AS v,
         CASE sm.movement_kind WHEN 'return_to_store' THEN 'issue' WHEN 'count_adjust_in' THEN 'count_adjust_out' WHEN 'consume_reversal' THEN o.movement_kind ELSE sm.movement_kind END AS k
    FROM inventory.stock_movements sm LEFT JOIN inventory.stock_movements o ON o.tenant_id = sm.tenant_id AND o.id = sm.reverses_movement_id
   WHERE sm.tenant_id = $1 AND sm.id = ANY($3::uuid[])),
g AS (SELECT business_date, store_id, item_id, k, instrument_id, attributed_test_id, sum(q) AS q, sum(v) AS v, count(*) AS n,
             row_number() OVER (ORDER BY business_date, store_id, item_id, k, instrument_id NULLS FIRST, attributed_test_id NULLS FIRST) AS rn
        FROM m GROUP BY business_date, store_id, item_id, k, instrument_id, attributed_test_id)
INSERT INTO inventory.consumption_daily (id, tenant_id, business_date, store_id, item_id, movement_kind, instrument_id, attributed_test_id, qty_consumed, value_consumed_paisa, movements, created_by, updated_by)
SELECT ids.id, $1::uuid, g.business_date, g.store_id, g.item_id, g.k, g.instrument_id, g.attributed_test_id, g.q, g.v::bigint, g.n::integer, $2::uuid, $2::uuid
  FROM g JOIN unnest($4::uuid[]) WITH ORDINALITY AS ids(id, rn) ON ids.rn = g.rn
 ORDER BY g.rn
ON CONFLICT ON CONSTRAINT consumption_daily__key__uq
DO UPDATE SET qty_consumed = consumption_daily.qty_consumed + EXCLUDED.qty_consumed, value_consumed_paisa = consumption_daily.value_consumed_paisa + EXCLUDED.value_consumed_paisa,
  movements = consumption_daily.movements + EXCLUDED.movements, version = consumption_daily.version + 1, updated_at = now(), updated_by = EXCLUDED.updated_by`;

/**
 * Post a batch of movements for one document. Returns the inserted stock_movements rows in processing order (a split consume_* / count_adjust_out returns the lot-row part first).
 * Errors: common.validation_failed (malformed input, nothing written), inventory.insufficient_stock (409; the caller's transaction rolls back the whole batch).
 */
export async function post(rc: RepoCtx, input: PostInput): Promise<Row[]> {
  const ms = validate(input);
  await lockBalances(rc, ms);
  const out: Row[] = [];
  for (const m of ms) {
    const lot = m.lot_id;
    const parts = await query(rc, PLAN, [m.store_id, m.item_id, lot, m.kind, m.qty_base, m.value_hint ?? null, m.reverses_movement_id ?? null]);
    if (parts.length === 0) throw new LimsError('inventory.insufficient_stock');
    for (const p of parts) {
      if (p['val'] === null) throw bad('/movements/reverses_movement_id');   // consume_reversal whose original is not the matching consumption (tenant, store, item, lot, -qty)
      const row = (await query(rc, p['lot_id'] === null ? APPLY_UNLOTTED : APPLY_LOT, [rc.actorId, uuidv7(), input.business_date, input.occurred_at, m.store_id, m.item_id, p['lot_id'], m.kind,
        p['qty'], p['val'], p['basis'], input.doc_type, input.doc_id, m.doc_line_id ?? null, m.instrument_id ?? null, m.attributed_test_id ?? null, m.rule_id ?? null,
        m.reason_code ?? null, m.reverses_movement_id ?? null]))[0];
      if (!row) throw new LimsError('common.internal');   // the balance row was locked in step 1, so this is a programming error
      out.push(row);
    }
  }
  const daily = out.filter((r) => !NOT_IN_DAILY.has(r['movement_kind']));
  if (daily.length > 0) await query(rc, DAILY, [rc.actorId, daily.map((r) => r['id']), daily.map(() => uuidv7())]);
  await afterPost(rc, out, input.business_date);
  return out;
}
