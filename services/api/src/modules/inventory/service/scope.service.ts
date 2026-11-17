// C12.T-04 scope service (02-TRD §5 Scope, §6.1; 07-SECURITY P-B1…P-B8; PRD AC-22.2).
// Order, always: load the object (RLS hides other tenants) -> branch visible? else 404 common.not_found -> IdentityPort.assertRole({permission, branchId}) (403).
// 404 before 403 (P-B8): an invisible object never reveals that it exists, nor which permission is missing.
import { LimsError } from '../../../core/errors.js';
import { getStore } from '../repository/stores.repo.js';
import { getTransfer } from '../repository/transfers.repo.js';
import type { RepoCtx, Row } from '../repository/_base.js';

interface ScopeCtx {
  readonly tenantId: string;
  readonly actor: { readonly id: string };
  readonly tx: RepoCtx['tx'];
  readonly ports: { readonly IdentityPort: any };
}
export interface Visible { readonly all: boolean; readonly branchIds: readonly string[] }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const rc = (ctx: ScopeCtx): RepoCtx => ({ tx: ctx.tx, tenantId: ctx.tenantId, actorId: ctx.actor.id });
const notFound = (): never => { throw new LimsError('common.not_found'); };

/** Visible branches from IdentityPort.getActor() only: centreScope.all => every branch; else the explicit branchIds grants (R3). A fresh frozen copy each call. */
export async function listVisibleBranchIds(ctx: ScopeCtx): Promise<Visible> {
  const a = await ctx.ports.IdentityPort.getActor(ctx);
  return Object.freeze({ all: a.centreScope?.all === true, branchIds: Object.freeze([...(a.branchIds ?? [])] as string[]) });
}
const sees = (v: Visible, branchId: string): boolean => v.all || v.branchIds.includes(branchId);

async function loadStore(ctx: ScopeCtx, id: string): Promise<Row | null> {
  return UUID.test(id) ? getStore(rc(ctx), id) : null; // a non-uuid is just "no such row", never a SQL error
}

export async function assertStoreAccess(ctx: ScopeCtx, storeId: string, permission: string): Promise<Row> {
  const store = await loadStore(ctx, storeId);
  if (store === null) return notFound();
  if (!sees(await listVisibleBranchIds(ctx), store['branch_id'])) return notFound();
  await ctx.ports.IdentityPort.assertRole(ctx, { permission, branchId: store['branch_id'] });
  return store;
}

/** `end` = the end the action acts on (from: #59 #60 #62, to: #61); no `end` = a read, visible via either end.
 *  Visible via either end (else 404); acting on an end whose branch is not visible is 403 (P-B3), not 404. */
export async function assertTransferAccess(ctx: ScopeCtx, transferId: string, opts: { permission: string; end?: 'from' | 'to' }): Promise<Row> {
  const t = UUID.test(transferId) ? await getTransfer(rc(ctx), transferId) : null;
  if (t === null) return notFound();
  const [from, to] = await Promise.all([loadStore(ctx, t['from_store_id']), loadStore(ctx, t['to_store_id'])]);
  const v = await listVisibleBranchIds(ctx);
  const fromOk = from !== null && sees(v, from['branch_id']);
  const toOk = to !== null && sees(v, to['branch_id']);
  if (!fromOk && !toOk) return notFound();
  const acting = opts.end === 'to' ? (toOk ? to : null) : opts.end === 'from' ? (fromOk ? from : null) : fromOk ? from : to;
  if (acting === null) throw new LimsError('auth.forbidden');
  await ctx.ports.IdentityPort.assertRole(ctx, { permission: opts.permission, branchId: acting['branch_id'] });
  return t;
}
