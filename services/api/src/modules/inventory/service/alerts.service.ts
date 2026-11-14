// Ledger alert hooks (06 row T-05; 02-TRD §4.3 step 7; 05-SCHEMA §2.27 inventory.alerts; AC-20.1, AC-20.2, AC-12.8). Called by ledger.service.post() in the same transaction.
// One unresolved alert per dedupe_key (partial unique index alerts__tenant_id_dedupe__p_uq): a repeat raise = ON CONFLICT -> occurrences + 1, last_raised_at = now().
// [CONV] dedupe_key = '<alert_kind>:<store_id>:<item_id>'. below_reorder "available" = sum of qty_base of ALL balance rows of (store, item) (tester assumption, T-05 notes).
// [CONV] negative_stock is raised, never auto-resolved here (TRD §4.3 is silent; ack/resolve belongs to the alerts API).
// expired_lot_in_use (TRD §4.3 step 7, third bullet; review T-05 #1): FEFO never picks an expired lot (§4.5 step 1), so a consume_* (not consume_reversal) on a lot with expiry_on < business_date is the in-use case.
//   [CONV] dedupe_key = 'expired_lot_in_use:<store_id>:<item_id>:<lot_id>'.
// Every statement binds tenant_id = $1 (REQ-SEC-024) and orders its pairs (store_id, item_id) so concurrent batches take alert rows in one order (no deadlock).
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { type RepoCtx, type Row, query } from '../repository/_base.js';

// pairs ($3 stores, $4 items) whose available quantity is under an active reorder level
const LOW = `SELECT k.store_id, k.item_id FROM unnest($3::uuid[], $4::uuid[]) AS k(store_id, item_id)
  JOIN inventory.store_item_settings s ON s.tenant_id = $1 AND s.store_id = k.store_id AND s.item_id = k.item_id AND s.is_active AND s.reorder_level_base IS NOT NULL
 WHERE (SELECT coalesce(sum(b.qty_base), 0) FROM inventory.stock_balances b WHERE b.tenant_id = $1 AND b.store_id = k.store_id AND b.item_id = k.item_id) < s.reorder_level_base`;

const RESOLVE_BELOW = `WITH low AS (${LOW}),
  tgt AS (SELECT a.id FROM inventory.alerts a
           WHERE a.tenant_id = $1 AND a.alert_kind = 'below_reorder' AND a.status <> 'resolved'
             AND (a.store_id, a.item_id) IN (SELECT store_id, item_id FROM unnest($3::uuid[], $4::uuid[]) AS k(store_id, item_id))
             AND NOT EXISTS (SELECT 1 FROM low WHERE low.store_id = a.store_id AND low.item_id = a.item_id)
           ORDER BY a.store_id, a.item_id FOR UPDATE OF a)
UPDATE inventory.alerts a SET status = 'resolved', resolved_at = now(), version = a.version + 1, updated_at = now(), updated_by = $2::uuid
  FROM tgt WHERE a.tenant_id = $1 AND a.id = tgt.id`;

const RAISE_BELOW = `INSERT INTO inventory.alerts (id, tenant_id, alert_kind, store_id, item_id, dedupe_key, status, first_raised_at, last_raised_at, occurrences, created_by, updated_by)
SELECT i.id, $1::uuid, 'below_reorder', low.store_id, low.item_id, 'below_reorder:' || low.store_id::text || ':' || low.item_id::text, 'open', now(), now(), 1, $2::uuid, $2::uuid
  FROM (${LOW}) low
  JOIN unnest($3::uuid[], $4::uuid[], $5::uuid[]) AS i(store_id, item_id, id) ON i.store_id = low.store_id AND i.item_id = low.item_id
 ORDER BY low.store_id, low.item_id
ON CONFLICT (tenant_id, dedupe_key) WHERE status <> 'resolved'
DO UPDATE SET occurrences = alerts.occurrences + 1, last_raised_at = now(), version = alerts.version + 1, updated_at = now(), updated_by = EXCLUDED.updated_by`;

// pairs ($3, $4) whose unlotted row is below 0 (lot-tracked item: consumption beyond book stock; non-tracked item: negative own row)
const RAISE_NEGATIVE = `INSERT INTO inventory.alerts (id, tenant_id, alert_kind, store_id, item_id, dedupe_key, status, first_raised_at, last_raised_at, occurrences, created_by, updated_by)
SELECT i.id, $1::uuid, 'negative_stock', i.store_id, i.item_id, 'negative_stock:' || i.store_id::text || ':' || i.item_id::text, 'open', now(), now(), 1, $2::uuid, $2::uuid
  FROM unnest($3::uuid[], $4::uuid[], $5::uuid[]) AS i(store_id, item_id, id)
  JOIN inventory.stock_balances b ON b.tenant_id = $1 AND b.store_id = i.store_id AND b.item_id = i.item_id AND b.lot_id IS NULL AND b.qty_base < 0
 ORDER BY i.store_id, i.item_id
ON CONFLICT (tenant_id, dedupe_key) WHERE status <> 'resolved'
DO UPDATE SET occurrences = alerts.occurrences + 1, last_raised_at = now(), version = alerts.version + 1, updated_at = now(), updated_by = EXCLUDED.updated_by`;

// triples ($3 stores, $4 items, $5 lots, $6 ids) consumed on a lot whose expiry_on is before the batch business_date ($7)
const RAISE_EXPIRED = `INSERT INTO inventory.alerts (id, tenant_id, alert_kind, store_id, item_id, lot_id, dedupe_key, status, first_raised_at, last_raised_at, occurrences, created_by, updated_by)
SELECT i.id, $1::uuid, 'expired_lot_in_use', i.store_id, i.item_id, i.lot_id,
       'expired_lot_in_use:' || i.store_id::text || ':' || i.item_id::text || ':' || i.lot_id::text, 'open', now(), now(), 1, $2::uuid, $2::uuid
  FROM unnest($3::uuid[], $4::uuid[], $5::uuid[], $6::uuid[]) AS i(store_id, item_id, lot_id, id)
  JOIN inventory.lots l ON l.tenant_id = $1 AND l.id = i.lot_id AND l.expiry_on < $7::date
 ORDER BY i.store_id, i.item_id, i.lot_id
ON CONFLICT (tenant_id, dedupe_key) WHERE status <> 'resolved'
DO UPDATE SET occurrences = alerts.occurrences + 1, last_raised_at = now(), version = alerts.version + 1, updated_at = now(), updated_by = EXCLUDED.updated_by`;

/** Distinct (store, item, lot) triples of consume_* rows (not consume_reversal) on a lot. */
function expiredCandidates(rows: readonly Row[]): { stores: string[]; items: string[]; lots: string[]; ids: string[] } {
  const seen = new Map<string, [string, string, string]>();
  for (const r of rows) {
    const k: string = r['movement_kind'];
    if (r['lot_id'] !== null && k.startsWith('consume_') && k !== 'consume_reversal') seen.set(`${r['store_id']}|${r['item_id']}|${r['lot_id']}`, [r['store_id'], r['item_id'], r['lot_id']]);
  }
  const all = [...seen.values()];
  return { stores: all.map((t) => t[0]), items: all.map((t) => t[1]), lots: all.map((t) => t[2]), ids: all.map(() => uuidv7()) };
}

/** Distinct (store, item) pairs of `rows`, optionally only the rows on the unlotted balance row. */
function pairsOf(rows: readonly Row[], unlottedOnly: boolean): { stores: string[]; items: string[]; ids: string[] } {
  const seen = new Map<string, [string, string]>();
  for (const r of rows) if (!unlottedOnly || r['lot_id'] === null) seen.set(`${r['store_id']}|${r['item_id']}`, [r['store_id'], r['item_id']]);
  const all = [...seen.values()];
  return { stores: all.map((p) => p[0]), items: all.map((p) => p[1]), ids: all.map(() => uuidv7()) };
}

/** After a posted batch: below_reorder raise/resolve for every touched (store, item); negative_stock for the pairs whose unlotted row was touched;
 *  expired_lot_in_use for consumptions of a lot expired before businessDate. */
export async function afterPost(rc: RepoCtx, rows: readonly Row[], businessDate: string): Promise<void> {
  const all = pairsOf(rows, false);
  if (all.stores.length === 0) return;
  await query(rc, RESOLVE_BELOW, [rc.actorId, all.stores, all.items]);
  await query(rc, RAISE_BELOW, [rc.actorId, all.stores, all.items, all.ids]);
  const unl = pairsOf(rows, true);
  if (unl.stores.length > 0) await query(rc, RAISE_NEGATIVE, [rc.actorId, unl.stores, unl.items, unl.ids]);
  const exp = expiredCandidates(rows);
  if (exp.stores.length > 0) await query(rc, RAISE_EXPIRED, [rc.actorId, exp.stores, exp.items, exp.lots, exp.ids, businessDate]);
}
