// Shared handler steps for smartreport (02-CV §6.3, §10.1): authorise first, build the RepoCtx from the authenticated context only, closed-shape validation errors.
import { LimsError } from '../../../core/errors.js';
import type { HandlerContext } from '../../../core/module.js';
import type { RepoCtx } from '../repository/common.repo.js';

export interface SrCtx extends HandlerContext {
  readonly tenantId: string;
  readonly actor: { readonly id: string };
  readonly tx: RepoCtx['tx'];
  readonly ports: { readonly IdentityPort: { assertRole(ctx: never, req: { permission: string; centreId?: string }): Promise<unknown> } };
}

export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Field name only; never the submitted value. */
export const invalidField = (path: string): LimsError =>
  new LimsError('common.validation_failed', `Invalid ${path}`, [{ path, code: 'common.field_invalid', message: 'Field invalid' }]);

/** Permission check, tenant-wide unless `centreId` is given. Port errors keep their code but become the API's LimsError. */
export async function authorise(ctx: SrCtx, permission: string, centreId?: string): Promise<RepoCtx> {
  try {
    await ctx.ports.IdentityPort.assertRole(ctx as never, centreId === undefined ? { permission } : { permission, centreId });
  } catch (e) {
    const o = e as { code?: unknown; detail?: unknown } | null;
    if (!(e instanceof LimsError) && typeof o?.code === 'string') throw new LimsError(o.code, typeof o.detail === 'string' ? o.detail : undefined);
    throw e;
  }
  return { tx: ctx.tx, tenantId: ctx.tenantId, actorId: ctx.actor.id };
}
