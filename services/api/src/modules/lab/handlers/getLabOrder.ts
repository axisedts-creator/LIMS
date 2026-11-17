// #15 getLabOrder (02-TRD §5.3; lab.yaml LabOrderDto; 07-SECURITY P-01 / P-02 / P-10). T-32: replaces the fail-closed stub.
// lab.specimen.read (tenant-wide, P-10) -> order of this tenant (RLS + tenant filter, P-01) -> the caller's centre scope covers the order centre (P-02: else 404, never 403).
import { LimsError } from '../../../core/errors.js';
import type { Handler } from '../../../core/module.js';
import { repoCtx, role, scopeOf, specimenCtx, uuidParam, visible } from '../service/specimen.service.js';
import { labOrderDto } from '../store/results.store.js';
import { sql } from '../store/scope.js';

export const handler: Handler = async (req, hctx) => {
  const c = specimenCtx(hctx);
  await role(c, 'lab.specimen.read');
  const id = uuidParam(req.params, 'order_id');
  const rc = repoCtx(c);
  const order = (await sql(rc.tx, rc.tenantId, 'SELECT * FROM lab.orders WHERE tenant_id = $1 AND id = $2', [id]))[0];
  if (!order || !visible(await scopeOf(c), order)) throw new LimsError('common.not_found');
  return { status: 200, body: await labOrderDto(rc, order) };
};
