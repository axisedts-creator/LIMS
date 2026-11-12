// Shared mechanics of the production lab stores (LD-124, 2026-11-12, C5 T-32). Stores run on the caller's ctx.tx ONLY: they never open a connection or a
// transaction, the tenant comes from the `tenantId` argument (= ctx.tenantId), and RLS stays the guard (REQ-SEC-024). The store seams are (tx, tenantId, ...)
// and carry no actor, so created_by / updated_by come from the transaction's own request.jwt.claims `sub` (set by core/db/tx.ts), read once per tx.
import { LimsError } from '../../../core/errors.js';
import type { RepoCtx, RepoTx } from '../repository/base.repo.js';

const actors = new WeakMap<object, Promise<string>>();

/** `sub` of the claims this transaction runs under. A tx without a uuid `sub` is a wiring error: fail closed (500), nothing written. */
function actorOf(tx: RepoTx): Promise<string> {
  let p = actors.get(tx);
  if (!p) {
    p = tx.query(`SELECT current_setting('request.jwt.claims', true)::jsonb ->> 'sub' AS sub`).then((r) => {
      const sub = r.rows[0]?.sub;
      if (typeof sub !== 'string') throw new LimsError('common.internal');
      return sub;
    });
    actors.set(tx, p);
  }
  return p;
}

/** RepoCtx for the repository/*.repo.ts helpers (they add `tenant_id = $1` themselves). */
export async function rcOf(tx: unknown, tenantId: string): Promise<RepoCtx> {
  const t = tx as RepoTx;
  if (!t || typeof t.query !== 'function') throw new LimsError('common.internal');
  return { tx: t, tenantId, actorId: await actorOf(t) };
}

/** Run one statement with $1 = tenant (every lab statement filters `tenant_id = $1`). */
export async function sql(tx: unknown, tenantId: string, text: string, values: readonly unknown[] = []): Promise<any[]> {
  const t = tx as RepoTx;
  if (!t || typeof t.query !== 'function') throw new LimsError('common.internal');
  return (await t.query(text, [tenantId, ...values])).rows;
}
