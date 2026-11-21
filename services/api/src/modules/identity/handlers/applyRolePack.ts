// POST apply role pack (CR-C2-RM-001 / LD-150). Still not implemented over HTTP (RM-T05 / LD-158 stub). SEC-AUTHZ-4 (LD-261): the stub asks
// IdentityPort.assertRole for the contract x-permission first, so a role without it gets auth.forbidden and the guard is in place the day the
// real handler replaces the throw below. Without a port the stub still answers its own common.internal "not implemented" (same code, no data touched).
import { LimsError } from '../../../core/errors.js';
import type { Handler } from '../../../core/module.js';

export const applyRolePack: Handler = async (_req, hctx) => {
  const port = (hctx as unknown as { ports?: { IdentityPort?: { assertRole?: (c: unknown, r: { permission: string }) => Promise<unknown> } } }).ports?.IdentityPort;
  if (typeof port?.assertRole === 'function') await port.assertRole(hctx, { permission: 'identity.role.manage' });
  throw new LimsError('common.internal', 'identity applyRolePack not implemented');
};
