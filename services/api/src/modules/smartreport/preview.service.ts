// preview.service.previewLibraryVersion — #22 preview of ANY library version against a real order or a synthetic fixture (02-TRD #22, §13; 03-APP-FLOW §2.7).
// Writes nothing, takes no advisory lock, never reads or writes summaries/bindings. The handler authorises template.manage; the service adds lab.result.read for real orders (AB-13).
import { LimsError } from '../../core/errors.js';
import { isUuid } from './library.service.js';
import { computeContent, type BuildCtx } from './summary.service.js';
import * as libraryRepo from './repository/library.repo.js';
import type { RepoCtx, Row } from './repository/common.repo.js';

export type FixtureCode = 'synthetic_basic' | 'synthetic_all_in_range' | 'synthetic_critical';
export type PreviewInput = { libraryVersionId: string; orderId?: string; fixtureCode?: FixtureCode };
export type PreviewCtx = BuildCtx & {
  readonly requestId: string;
  readonly ports: BuildCtx['ports'] & { IdentityPort: { assertRole(ctx: unknown, req: { permission: string; centreId?: string }): Promise<unknown> } };
  readonly audit: { access(e: { action: string; entityType: string; entityId?: string; centreId?: string; outcome: 'allowed' | 'denied' }): Promise<void> };
};

const FIXTURE_CODES: readonly string[] = ['synthetic_basic', 'synthetic_all_in_range', 'synthetic_critical'];

class Rollback { out?: { results: Row[]; content: Awaited<ReturnType<typeof computeContent>> } }

export async function previewLibraryVersion(ctx: PreviewCtx, input: PreviewInput): Promise<Row> {
  const { libraryVersionId, orderId, fixtureCode } = input;
  const hasOrder = orderId !== undefined;
  if (hasOrder === (fixtureCode !== undefined)) throw new LimsError('common.validation_failed');                      // exactly one
  if (hasOrder ? !isUuid(orderId) : typeof fixtureCode !== 'string' || !FIXTURE_CODES.includes(fixtureCode)) throw new LimsError('common.validation_failed');
  if (!isUuid(libraryVersionId)) throw new LimsError('common.not_found');
  const rc: RepoCtx = { tx: ctx.tx, tenantId: ctx.tenantId, actorId: ctx.actor.id };
  const version = await libraryRepo.getLibraryVersion(rc, libraryVersionId);                                        // RLS + tenant filter: other tenant's id is not found
  if (version === null) throw new LimsError('common.not_found');

  let content: Awaited<ReturnType<typeof computeContent>>;
  let results: Row[];
  let centreId: string | undefined;
  if (hasOrder) {
    const order = await ctx.ports.FrontdeskPort.getOrderSummary(ctx, { orderId });                                    // not visible -> common.not_found propagates
    centreId = order.centreId;
    await ctx.ports.IdentityPort.assertRole(ctx, { permission: 'lab.result.read', centreId: order.centreId as string });                    // auth.forbidden propagates; results are not read
    const done = new Rollback();                                                                                     // everything the ports do for this read is rolled back (P-44): a preview leaves no trace
    try {
      await ctx.tx.savepoint(async (tx) => {
        const c = { ...ctx, tx } as PreviewCtx;
        const lab = await c.ports.LabPort.getOrderResults(c, { orderId, scope: 'approved' });
        const rs = (lab.items as Row[]).flatMap((i) => i.results as Row[]);
        if (rs.length === 0) throw new LimsError('smartreport.no_eligible_results');
        done.out = { results: rs, content: await computeContent(c, { ...rc, tx }, version, order, orderId, rs) };
        throw done;
      });
    } catch (e) { if (e !== done) throw e; }
    ({ results, content } = done.out!);
  } else {
    const fx = ((await import('../../../../../packages/test-fixtures/src/smartreport/index.js')) as unknown as { SMART_PREVIEW_FIXTURES: Record<string, { results: Row[]; analytes: Row[] }> }).SMART_PREVIEW_FIXTURES[fixtureCode as string]!;   // LD-135: literal path (a variable path does not resolve under vitest)
    results = fx.results;
    content = await computeContent(ctx, rc, version, {}, '', results, fx.analytes);
  }

  if (hasOrder) await ctx.audit.access({ action: 'smart_summary.view', entityType: 'smart_summary_preview', entityId: orderId, ...(centreId !== undefined && { centreId }), outcome: 'allowed' });   // after the read succeeded; no PHI
  const c = content.content;
  const score = c.healthScore;
  return {
    status: 'preview', library_version_id: version.id, template_library_version: String(version.version_no), formula_version: version.formula_version, language: version.language,
    content: c, built_at: c.builtAt,
    ...(score !== undefined && { health_score_value: score.value, health_score_band: score.band }),
    panels_scored: score?.panelsScored ?? 0, deranged_count: c.deranged.length, critical_count: c.deranged.filter((d) => d.severity === 'critical').length,
    unmapped_result_count: results.filter((r) => !content.mapByAnalyte.has(r.analyteId)).length, ignored_duplicate_count: content.eligible.length - content.distinctEligible,
    ...(hasOrder && { order_id: orderId }),
  };
}
