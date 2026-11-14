// reporting.report.released.v1 -> total clocks stop (02-TRD §10.2; 03-IC §3.17; AC-14.3; 08 R1, R13, CR-C5-006). Reads ONLY payload.{order_id, report_kind, released_at, order_item_ids?}; patient_id, referrer, audiences,
// release_basis, report_id and every unknown field are never read, passed on or logged (S-15). report_kind is passed through unchanged (x-extensible): the service stops items for final | partial only and
// never throws on an unknown kind; C9 stores no report_kind (P-4). order_item_ids is absent (omitted from the service input) or an array of <= 200 uuids; null / a string / a bad entry is malformed.
// REQ-SEC-024: tenant guard and payload validation run BEFORE any service call; malformed input throws a fixed message (nothing echoed). The consumer issues no SQL; a service failure rejects (10 attempts, dead letter).
import type { ConsumerHandler } from '../../../core/manifest.js';
import { createTatService } from '../../../../../api/src/modules/quality/service/tat.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
const MAX_ITEMS = 200;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);

export function createReportReleasedHandler(deps: { service?: { applyRelease(ctx: any, i: { orderId: string; reportKind: string; orderItemIds?: string[]; releasedAt: string }): Promise<unknown> } } = {}): ConsumerHandler {
  return async (event, ctx) => {
    const tenantId = ctx.tenantId;
    if (typeof tenantId !== 'string' || !tenantId || event?.tenant_id !== tenantId) throw new Error('reporting.report.released.v1: event tenant does not match the job tenant');
    const p = (event as any).payload;
    const ids = p?.order_item_ids;
    if (typeof p !== 'object' || p === null || Array.isArray(p) || !isUuid(p.order_id) || typeof p.report_kind !== 'string' || p.report_kind === ''
      || typeof p.released_at !== 'string' || !ISO_UTC.test(p.released_at) || Number.isNaN(Date.parse(p.released_at))
      || (ids !== undefined && (!Array.isArray(ids) || ids.length > MAX_ITEMS || !ids.every(isUuid)))) {
      throw new Error('reporting.report.released.v1: malformed payload');   // fixed message: nothing of the payload is echoed
    }
    const service = deps.service ?? (defaultService ??= createTatService());
    await service.applyRelease(ctx, { orderId: p.order_id, reportKind: p.report_kind, ...(ids !== undefined ? { orderItemIds: ids as string[] } : {}), releasedAt: p.released_at });
  };
}
let defaultService: ReturnType<typeof createTatService> | undefined;

export const handle: ConsumerHandler = createReportReleasedHandler();
