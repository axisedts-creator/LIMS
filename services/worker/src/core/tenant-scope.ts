// Core-internal 4-arg withTenantScope for the cron fan-out (02-TRD §7.1, 08 A23.1/A23.2, D-214; AC-0D-5.15).
// Swaps request.jwt.claims on the already-open transaction to the tenant's system actor for `fn`, then restores them.
import type { WorkerTx } from './tasklist.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SWITCH_SQL = `SELECT current_setting('request.jwt.claims', true) AS prev, set_config('request.jwt.claims', $1::text, true)`;
const RESTORE_SQL = `SELECT set_config('request.jwt.claims', $1::text, true)`;

const active = new WeakSet<object>();

export async function withTenantScope<T>(tx: WorkerTx, tenantId: string, systemActorId: string, fn: () => Promise<T>): Promise<T> {
  if (typeof tenantId !== 'string' || !UUID.test(tenantId)) throw new Error('withTenantScope: tenantId is not a UUID');
  if (typeof systemActorId !== 'string' || !UUID.test(systemActorId)) throw new Error('withTenantScope: systemActorId is not a UUID');
  if (active.has(tx)) throw new Error('withTenantScope: nested use on the same transaction');
  active.add(tx);
  try {
    // [CONV] previous claims come from the DB; a tx wrapper that tracks claims itself (tx.claims) is the fallback.
    const known = (tx as { claims?: unknown }).claims;
    const { rows } = await tx.query(SWITCH_SQL, [JSON.stringify({ sub: systemActorId, tenant_id: tenantId, actor_type: 'system' })]);
    const prev: string = typeof rows[0]?.prev === 'string' ? rows[0].prev : known === undefined ? '' : JSON.stringify(known);
    try {
      return await fn();
    } finally {
      await tx.query(RESTORE_SQL, [prev]);
    }
  } finally {
    active.delete(tx);
  }
}
