// inventory.opened_containers (05 §2.21). Explicit tenant filter on every statement; status = 'open' literals match the partial indexes.
import { type Row, type RepoCtx, first, getRow, insertRow, query, table, updateRow } from './_base.js';

const CONTAINERS = table('opened_containers', 'C', ['store_id', 'item_id', 'lot_id', 'instrument_id', 'opened_at', 'opened_by', 'open_expiry_at', 'status', 'finished_at',
  'finished_by', 'discard_document_id', 'notes']);

export const insertContainer = (rc: RepoCtx, row: Row) => insertRow(rc, CONTAINERS, row);
export const getContainer = (rc: RepoCtx, id: string) => getRow(rc, CONTAINERS, id);
/** The open container an instrument is drawing from (index opened_containers__tenant_id_in_use__p_idx): newest opened first. */
export const findInUseContainer = (rc: RepoCtx, f: { instrumentId: string; itemId: string; storeId: string }): Promise<Row | null> =>
  first(rc, `SELECT * FROM inventory.opened_containers WHERE tenant_id = $1 AND instrument_id = $2 AND item_id = $3 AND store_id = $4 AND status = 'open'
             ORDER BY opened_at DESC, id LIMIT 1`, [f.instrumentId, f.itemId, f.storeId]);
/** Open-stability scan (index ..._open_expiry__p_idx); isoTimestamp = timestamptz text. */
export const listOpenContainersExpiringBefore = (rc: RepoCtx, isoTimestamp: string) =>
  query(rc, `SELECT * FROM inventory.opened_containers WHERE tenant_id = $1 AND status = 'open' AND open_expiry_at IS NOT NULL AND open_expiry_at < $2
             ORDER BY open_expiry_at, id`, [isoTimestamp]);
export const updateContainer = (rc: RepoCtx, id: string, expectedVersion: number, patch: Row) => updateRow(rc, CONTAINERS, id, expectedVersion, patch);
