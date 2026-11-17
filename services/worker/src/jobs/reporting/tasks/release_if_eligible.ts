// reporting.release_if_eligible (02-TRD §4.6 rule 5, §9): re-evaluates one rendered version as the SYSTEM actor and releases it when BillingPort says eligible
// (release mode `auto`). Enqueued by the render task, the billing.balance.changed.v1 hint consumer and sweep_held_releases (key `release:<version_id>`).
// "Not releasable now" (released already, newer version, cancelled, auto_release = manual, held for dues) RESOLVES; a transient failure (BillingPort / FrontdeskPort /
// event log down, contradictory port answer) THROWS so the queue retries and the job transaction rolls everything back.
import type { TaskHandler } from '../../../core/manifest.js';
import { releaseVersion } from '../../../../../api/src/modules/reporting/service/release.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const releaseIfEligible: TaskHandler = async (payload, jobCtx) => {
  const ctx = jobCtx as any;
  const id = payload?.['report_version_id'];
  if (typeof ctx.tenantId !== 'string' || payload?.['tenant_id'] !== ctx.tenantId || typeof id !== 'string' || !UUID.test(id)) {
    ctx.log?.warn?.({ event: 'release_if_eligible_skipped', reason: 'bad_payload' });
    return;
  }
  const out = await releaseVersion(ctx, id, { mode: 'auto' });
  if (out.kind !== 'released') ctx.log?.info?.({ event: 'release_if_eligible_no_release', outcome: out.kind, reason: out.kind === 'held' ? out.basis : out.reason });
};
