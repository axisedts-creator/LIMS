// PG-T14/T15 SQL for payments.refunds shared by the refund service, the completion step and the tasks. Every statement is tenant-scoped.
import type { Ctx, Row } from './shared.js';

export const findRefund = async (ctx: Pick<Ctx, 'tenantId' | 'tx'>, id: string, lock = false): Promise<Row | undefined> =>
  (await ctx.tx.query(`SELECT * FROM payments.refunds WHERE tenant_id = $1 AND id = $2${lock ? ' FOR UPDATE' : ''}`, [ctx.tenantId, id])).rows[0];

/** Optimistic update on the locked row: version + from-status predicate, bumps version. undefined = nothing updated. */
export async function updateRefund(ctx: Pick<Ctx, 'tenantId' | 'tx' | 'now' | 'actor'>, row: Row, sets: Row, from: readonly string[]): Promise<Row | undefined> {
  const all: Row = { ...sets, updated_at: ctx.now(), updated_by: ctx.actor.id };
  const cols = Object.keys(all);
  const vals: unknown[] = cols.map((c) => all[c]);
  const n = vals.length;
  vals.push(ctx.tenantId, row['id'], row['version'], [...from]);
  return (await ctx.tx.query(
    `UPDATE payments.refunds SET ${[...cols.map((c, i) => `${c} = $${i + 1}`), 'version = version + 1'].join(', ')} WHERE tenant_id = $${n + 1} AND id = $${n + 2} AND version = $${n + 3} AND status = ANY($${n + 4}) RETURNING *`,
    vals)).rows[0];
}
