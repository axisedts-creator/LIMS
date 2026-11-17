// HC-T17 gauge counts for 02-TRD §14 (read-only, tenant-filtered, schema-qualified). Counts only: no row, id or PHI leaves this file.
import type { Tx } from './shared.repo.js';

const count = async (tx: Tx, text: string, values: unknown[]): Promise<number> => Number((await tx.query(text, values)).rows[0]?.['n'] ?? 0);

/** open dispatcher flags of one kind (held_collection -> held_open, handover_overdue -> handover_overdue_open). */
export const countOpenFlags = (tx: Tx, tenantId: string, kind: 'held_collection' | 'handover_overdue'): Promise<number> =>
  count(tx, `SELECT count(*)::int AS n FROM homecollection.visit_flags WHERE tenant_id = $1 AND kind = $2 AND status = 'open'`, [tenantId, kind]);

/** [CONV] devices_stale: an active device the server last heard from (last_seen_at) more than `staleAfterHours` ago whose last push is older than that contact
 *  (it pulled / acked since, but never pushed again): the server cannot see the device's pending seq, this is its observable proxy. */
export const countStaleDevices = (tx: Tx, tenantId: string, staleAfterHours: number): Promise<number> =>
  count(tx, `SELECT count(*)::int AS n FROM homecollection.devices WHERE tenant_id = $1 AND status = 'active'
    AND last_seen_at < now() - make_interval(hours => $2::int) AND (last_push_at IS NULL OR last_push_at < last_seen_at)`, [tenantId, staleAfterHours]);
