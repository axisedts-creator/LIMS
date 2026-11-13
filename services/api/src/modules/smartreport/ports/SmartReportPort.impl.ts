// SmartReportPort.buildSummary (03-IC §4.10, 02-TRD §7.1 steps 1-2, 6, 9; 08 A2.3, A19 D-111). Staff (user) and system actors only; runs in ctx.tx only.
// Never throws smartreport.summary_not_ready: a not-yet-approved (or rejected) summary comes back as status 'draft'.
import { LimsError } from '../../../core/errors.js';
import { toSmartSummary } from '../mappers/port.mapper.js';
import { buildOrGet, type BuildCtx } from '../summary.service.js';
import { isUuid } from '../library.service.js';

const STAFF = new Set(['user', 'system']);

export const smartReportPort = {
  async buildSummary(ctx: BuildCtx & { actor: { type?: string }; ports: BuildCtx['ports'] & { IdentityPort: any } }, input: { orderId: string; version: number }): Promise<Record<string, unknown>> {
    if (!STAFF.has(ctx.actor.type as string)) throw new LimsError('auth.forbidden');                      // 08 A2.3: fail-closed, no read/write
    const o = input as { orderId?: unknown; version?: unknown } | null | undefined;                      // step 1
    if (o == null || typeof o.orderId !== 'string' || !isUuid(o.orderId) || typeof o.version !== 'number' || !Number.isInteger(o.version) || o.version < 1) {
      throw new LimsError('common.validation_failed');
    }
    const settings = await ctx.ports.IdentityPort.getTenantSettings(ctx, { keys: ['featureFlags'] });    // step 2: only boolean true enables
    if (settings?.featureFlags?.smart_report !== true) throw new LimsError('smartreport.feature_disabled');
    const { summary } = await buildOrGet(ctx, { orderId: o.orderId, reportVersionNo: o.version });        // steps 3-8
    return toSmartSummary(summary, o.version);
  },
};
