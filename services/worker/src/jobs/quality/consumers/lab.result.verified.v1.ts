// lab.result.verified.v1 -> quality.verification_log + TAT stop (02-TRD §10.2; 03-IC §3.9; 08 A13 D-2; AC-14.2, AC-14.3). Reads ONLY event.event_id and payload.{result_id, result_version_no, order_id, order_item_id, test_id, analyte_id, mode, verified_at}.
// specimen_id and verified_by_membership_id are NOT read (mode:auto events carry neither, D-2); department_id, origin, instrument_id, processing_branch_id and unknown fields are never read, stored or logged (S-15/S-17).
// REQ-SEC-024: an event of another tenant is refused before any query. Order of work: (1) guard + validation, (2) ONE idempotent verification_log statement (ON CONFLICT DO NOTHING; the row id is generated in SQL so a
// redelivery repeats the identical statement), (3) tat.applyVerified({ orderItemId, testId, verifiedAt }) for manual AND auto (idempotent: earliest verified_at wins). A failure of either rejects (retry redoes both).
import type { ConsumerHandler } from '../../../core/manifest.js';
import { createTatService } from '../../../../../api/src/modules/quality/service/tat.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
const INT4_MAX = 2_147_483_647;

const INSERT_SQL = `INSERT INTO quality.verification_log (id, tenant_id, result_id, result_version_no, order_id, order_item_id, test_id, analyte_id, mode, verified_at, event_id, created_by)
  VALUES (app.uuidv7(), $1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10, $11)
  ON CONFLICT (tenant_id, result_id, result_version_no) DO NOTHING`;

const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);

export function createResultVerifiedHandler(deps: { service?: { applyVerified(ctx: any, i: { orderItemId: string; testId: string; verifiedAt: string }): Promise<unknown> } } = {}): ConsumerHandler {
  return async (event, ctx) => {
    const tenantId = ctx.tenantId;
    if (typeof tenantId !== 'string' || !tenantId || event?.tenant_id !== tenantId) throw new Error('lab.result.verified.v1: event tenant does not match the job tenant');
    const p = (event as any).payload;
    const e = event as any;
    if (typeof p !== 'object' || p === null || Array.isArray(p)
      || !isUuid(e.event_id) || !isUuid(p.result_id) || !isUuid(p.order_id) || !isUuid(p.order_item_id) || !isUuid(p.test_id) || !isUuid(p.analyte_id)
      || !Number.isInteger(p.result_version_no) || p.result_version_no < 1 || p.result_version_no > INT4_MAX
      || (p.mode !== 'manual' && p.mode !== 'auto')
      || typeof p.verified_at !== 'string' || !ISO_UTC.test(p.verified_at) || Number.isNaN(Date.parse(p.verified_at))) {
      throw new Error('lab.result.verified.v1: malformed payload');   // fixed message: nothing of the payload is echoed
    }
    await ctx.tx.query(INSERT_SQL, [tenantId, p.result_id, p.result_version_no, p.order_id, p.order_item_id, p.test_id, p.analyte_id, p.mode, p.verified_at, e.event_id, ctx.actor.id]);
    const service = deps.service ?? (defaultService ??= createTatService());
    await service.applyVerified(ctx, { orderItemId: p.order_item_id, testId: p.test_id, verifiedAt: p.verified_at });
  };
}
let defaultService: ReturnType<typeof createTatService> | undefined;

export const handle: ConsumerHandler = createResultVerifiedHandler();
