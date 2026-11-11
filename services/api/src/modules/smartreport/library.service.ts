// Library validation service (02-TRD §9.4; 03-APP-FLOW "Validate"; 08 A19 P-44, D-108). Read-only: reads through the repositories, never writes.
// No authorisation here: the handler (T11) authorises first. V6 asks CatalogPort once per distinct follow-up test, each inside a savepoint (P-44).
import { LimsError } from '../../core/errors.js';
import { type ValidationReport, validateLibrary } from './domain/library.validate.js';
import type { LibBlock, LibMapping, LibRule } from './domain/library.validate.js';
import * as blocksRepo from './repository/blocks.repo.js';
import type { RepoCtx } from './repository/common.repo.js';
import * as denyTermsRepo from './repository/denyTerms.repo.js';
import * as libraryRepo from './repository/library.repo.js';
import * as mappingsRepo from './repository/mappings.repo.js';
import * as rulesRepo from './repository/rules.repo.js';

interface SavepointTx { savepoint<T>(fn: (tx: never) => Promise<T>): Promise<T> }
export interface LibraryCtx {
  readonly tenantId: string;
  readonly actor: { readonly id: string };
  readonly tx: RepoCtx['tx'];
  readonly ports: { readonly CatalogPort: { getTest(ctx: never, input: { testId: string; requireActive: true }): Promise<unknown> } };
}

const opt = <T>(v: T | null | undefined): T | undefined => (v == null ? undefined : v);

/** Port errors keep their code but become the API's LimsError. */
const asLimsError = (e: unknown): unknown => {
  const code = (e as { code?: unknown } | null)?.code;
  return !(e instanceof LimsError) && typeof code === 'string' ? new LimsError(code) : e;
};

export async function validateLibraryVersion(ctx: LibraryCtx, libraryVersionId: string): Promise<ValidationReport> {
  const rc: RepoCtx = { tx: ctx.tx, tenantId: ctx.tenantId, actorId: ctx.actor.id };
  const version = await libraryRepo.getLibraryVersion(rc, libraryVersionId);
  if (!version || version.tenant_id !== ctx.tenantId) throw new LimsError('common.not_found');

  const [blockRows, ruleRows, mappingRows, tenantTerms, globalTerms] = await Promise.all([
    blocksRepo.listBlocks(rc, libraryVersionId), rulesRepo.listRules(rc, libraryVersionId), mappingsRepo.listMappings(rc, libraryVersionId),
    denyTermsRepo.listDenyTerms(rc), denyTermsRepo.listGlobalDenyTerms(rc),
  ]);

  const rules: LibRule[] = ruleRows.map((r) => ({
    id: r.id, ruleKind: r.rule_kind, triggerKind: r.trigger_kind, direction: r.direction, priority: r.priority, blockId: r.block_id, blockKind: r.block_kind,
    ...(opt(r.analyte_id) !== undefined && { analyteId: r.analyte_id }), ...(opt(r.group_code) !== undefined && { groupCode: r.group_code }),
    ...(opt(r.min_severity) !== undefined && { minSeverity: r.min_severity }), ...(opt(r.suggested_test_id) !== undefined && { suggestedTestId: r.suggested_test_id }),
    ...(opt(r.interval_days) !== undefined && { intervalDays: r.interval_days }),
  }));
  const blocks: LibBlock[] = blockRows.map((b) => ({ id: b.id, blockKey: b.block_key, kind: b.kind, textEn: opt(b.text_en), textNe: opt(b.text_ne) }));
  const mappings: LibMapping[] = mappingRows.map((m) => ({ id: m.id, analyteId: m.analyte_id, groupCode: m.group_code }));

  // V6: a test the catalog calls inactive or cannot see is a finding; any other port error is not ours to swallow.
  const inactiveTestIds = new Set<string>();
  const tests = [...new Set(rules.flatMap((r) => (r.suggestedTestId === undefined ? [] : [r.suggestedTestId])))];
  for (const testId of tests) {
    try {
      await (ctx.tx as unknown as SavepointTx).savepoint((tx) => ctx.ports.CatalogPort.getTest({ ...ctx, tx } as never, { testId, requireActive: true }));
    } catch (e) {
      const err = asLimsError(e);
      if (err instanceof LimsError && (err.code === 'catalog.test_inactive' || err.code === 'common.not_found')) inactiveTestIds.add(testId);
      else throw err;
    }
  }

  return validateLibrary(
    { language: version.language, scoreEnabled: version.score_enabled, blocks, rules, mappings },
    // ponytail: V13 has no catalog source in the spec (no CatalogPort analyte-status method); empty set until a CR adds one.
    { denyTerms: [...globalTerms, ...tenantTerms].map((t) => ({ term: t.term })), inactiveTestIds, inactiveAnalyteIds: new Set() },
  );
}
