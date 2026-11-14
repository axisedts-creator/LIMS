// C5 chain status read-through for getAnatomicCase (02-TRD §4.8). Not stored, never cached beyond the request (PHI P3): one LabPort call per detail read.
import { isLimsError } from '../../../core/errors.js';
import type { LabStatus } from '../mappers/case.dto.js';

interface LabResult { orderItemId?: unknown; versionNo?: unknown; status?: unknown; origin?: unknown }
export interface LabCtx { readonly ports: { readonly LabPort: { getOrderResults(c: unknown, i: { orderId: string; scope: 'all_visible' }): Promise<{ items?: ReadonlyArray<{ results?: ReadonlyArray<LabResult> }> }> } } }

/**
 * orderItemId -> { status, versionNo } of the newest origin=module result. `undefined` = the caller lacks lab.result.read (LabPort throws auth.forbidden):
 * the case is shown WITHOUT lab_status rather than failing. Any other error is rethrown unchanged (08 A17 P-23).
 */
export async function labStatusByOrderItem(c: LabCtx, orderId: string): Promise<Map<string, LabStatus> | undefined> {
  let res;
  try {
    res = await c.ports.LabPort.getOrderResults(c, { orderId, scope: 'all_visible' });
  } catch (e) {
    if (isLimsError(e) && e.code === 'auth.forbidden') return undefined;
    throw e;
  }
  const out = new Map<string, LabStatus>();
  for (const item of res?.items ?? []) {
    for (const r of item.results ?? []) {
      if (r.origin !== 'module' || typeof r.orderItemId !== 'string' || typeof r.status !== 'string') continue; // instrument / manual results never count
      const v = Number(r.versionNo);
      const cur = out.get(r.orderItemId);
      if (!cur || v > cur.versionNo) out.set(r.orderItemId, { status: r.status, versionNo: v });
    }
  }
  return out;
}
