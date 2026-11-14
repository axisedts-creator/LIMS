// Shared body of the smartreport result consumers (02-TRD §8.2): lock -> supersede the live summary the event outdates -> gated, debounced prebuild enqueue.
// One transaction (the C0 consumer wrapper's, inbox row included), system actor, no external call, never builds (AC-15.1, AC-15.2, AC-15.3, AC-15.5).
import type { ConsumerHandler } from '../../../core/manifest.js';
import { ENQUEUE_SQL } from '../../../core/fanout.js';
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { LimsError } from '../../../../../api/src/core/errors.js';
import { loadSmartreportConfig } from '../../../../../api/src/modules/smartreport/config.js';
import * as libraryRepo from '../../../../../api/src/modules/smartreport/repository/library.repo.js';
import * as reviewsRepo from '../../../../../api/src/modules/smartreport/repository/reviews.repo.js';
import * as summariesRepo from '../../../../../api/src/modules/smartreport/repository/summaries.repo.js';
import type { RepoCtx } from '../../../../../api/src/modules/smartreport/repository/common.repo.js';

export const PREBUILD = 'smartreport.prebuild_summary';
export const PREBUILD_MAX_ATTEMPTS = 10;                                     // 02-CV §7.5 consumer class
type Row = Record<string, any>;

/** Ports are reached as ctx.ports.<Name>Port (analytics precedent) or the lower-case alias (reporting precedent). */
export const portOf = (ctx: Row, name: string): any => ctx['ports']?.[name + 'Port'] ?? ctx['ports']?.[name.toLowerCase()];

/** True when prebuild is enabled (env, read at call time) AND the tenant has flag smart_report on AND an approved library exists. */
export async function prebuildAllowed(ctx: Row, rc: RepoCtx): Promise<boolean> {
  if (!loadSmartreportConfig().prebuildEnabled) return false;
  const s = await portOf(ctx, 'Identity').getTenantSettings(ctx, { keys: ['featureFlags'] });
  if (s?.featureFlags?.smart_report !== true) return false;
  return (await libraryRepo.getApprovedLibraryVersion(rc)) !== null;
}

/** input_result_versions entries are "<result_id>:<version_no>". `outdates` decides, per event kind, whether the live summary is stale. */
export function consumer(outdates: (inputs: readonly string[], p: Row) => boolean): ConsumerHandler {
  return async (event, jobCtx) => {
    const ctx = jobCtx as unknown as Row;
    const tenantId: string | undefined = ctx['tenantId'];
    if (!tenantId || (event?.tenant_id !== undefined && event.tenant_id !== tenantId)) throw new LimsError('common.internal', 'event tenant does not match the job tenant');
    const p: Row = event.payload;
    const orderId: string = p['order_id'];
    const rc: RepoCtx = { tx: ctx['tx'], tenantId, actorId: ctx['actor'].id };

    // step 2: same key as summary.service.buildOrGet, so a concurrent build and this supersede serialise.
    await rc.tx.query(`SELECT pg_advisory_xact_lock(hashtextextended('smartreport:' || $1::text || ':' || $2::text, 0))`, [tenantId, orderId]);

    // step 3
    const live = await summariesRepo.getLiveSummaryByOrder(rc, orderId);
    if (live && outdates(live['input_result_versions'] ?? [], p)) {
      await summariesRepo.updateSummary(rc, live['id'], live['version'], { status: 'superseded', superseded_at: ctx['now'](), superseded_reason: 'results_changed' });   // successor id stays NULL (D-107)
      await reviewsRepo.insertSummaryReview(rc, { id: uuidv7(), centre_id: live['centre_id'], summary_id: live['id'], action: 'superseded' });
    }

    // step 4: debounced by job_key
    if (!(await prebuildAllowed(ctx, rc))) return;
    const runAt = new Date(Date.parse(ctx['now']()) + loadSmartreportConfig().prebuildDelaySeconds * 1000).toISOString();
    await rc.tx.query(ENQUEUE_SQL, [PREBUILD, JSON.stringify({ tenant_id: tenantId, order_id: orderId }), 'smartreport:prebuild:' + orderId, runAt, PREBUILD_MAX_ATTEMPTS]);
  };
}
