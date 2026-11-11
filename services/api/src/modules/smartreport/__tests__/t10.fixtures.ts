// C14 T10 fixtures (not a test file). Synthetic data only. Shared by domain/__tests__/library.validate.test.ts and __tests__/library.service.test.ts.
//
// SEAMS pinned for T10 (the spec fixes the rules V1-V14 and codes, not the TypeScript shapes):
//   domain/library.validate.ts   validateLibrary(library: LibraryInput, env: ValidationEnv): ValidationReport      (pure: no I/O, never mutates its arguments)
//     LibraryInput = { language: 'en'|'ne'; scoreEnabled: boolean; blocks: LibBlock[]; rules: LibRule[]; mappings: LibMapping[] }   ACTIVE rows only
//     LibBlock   = { id; blockKey; kind: 'deranged'|'advice'|'followup'|'disclaimer'|'score_explanation'; textEn?: string|null; textNe?: string|null }
//     LibRule    = { id; ruleKind; triggerKind: 'analyte'|'group'|'any'|'all_in_range'; analyteId?; groupCode?; direction: 'low'|'high'|'abnormal'|'any';
//                    minSeverity?; priority; blockId; blockKind; suggestedTestId?; intervalDays? }
//     LibMapping = { id; analyteId; groupCode }
//     ValidationEnv = { denyTerms: { term: string }[]  (global + tenant ACTIVE, TRD 9.5);
//                       inactiveTestIds: ReadonlySet<string>  (follow-up tests the catalog says are inactive or not visible -> V6);
//                       inactiveAnalyteIds: ReadonlySet<string>  (V13) }
//     ValidationReport = { valid: boolean  (= no error issue), errors: Issue[], warnings: Issue[] }
//     Issue = { code: <TRD 9.4 code>, severity: 'error'|'warning', path: string, ...extras }
//       path = JSON Pointer of the offending object: `/blocks/<block id>`, `/rules/<rule id>`, `/mappings/<mapping id>`; library-level issues (V1,V2,V3,V11,V14) any string.
//       extras: deny_term -> blockKey + term; generic_deranged_missing -> direction; placeholder_* -> blockKey + placeholder.
//   library.service.ts           validateLibraryVersion(ctx, libraryVersionId): Promise<ValidationReport>
//     ctx = { tenantId, actor: { id }, tx (with savepoint(fn(tx))), ports: { CatalogPort } }. NO authorisation inside the service (handler #18 does it, T11).
//     Reads ONLY through the repositories (getLibraryVersion, listBlocks, listRules, listMappings, listDenyTerms, listGlobalDenyTerms), ACTIVE rows only, never writes.
//     Unknown id or another tenant's id -> LimsError common.not_found.
//     V6: one CatalogPort.getTest(portCtx, { testId, requireActive: true }) per DISTINCT follow-up test, each inside ctx.tx.savepoint(...) (08 A19 P-44); a LimsError
//         `catalog.test_inactive` / `common.not_found` from the port becomes followup_test_inactive on every rule using that test; any other error propagates.
import type { BlockKindT } from './t10.types.js';

export interface LibBlock { id: string; blockKey: string; kind: BlockKindT; textEn?: string | null; textNe?: string | null }
export interface LibRule {
  id: string; ruleKind: BlockKindT; triggerKind: 'analyte' | 'group' | 'any' | 'all_in_range'; analyteId?: string; groupCode?: string;
  direction: 'low' | 'high' | 'abnormal' | 'any'; minSeverity?: 'borderline' | 'out_of_range' | 'critical'; priority: number; blockId: string; blockKind: BlockKindT;
  suggestedTestId?: string; intervalDays?: number;
}
export interface LibMapping { id: string; analyteId: string; groupCode: string }
export interface LibInput { language: 'en' | 'ne'; scoreEnabled: boolean; blocks: LibBlock[]; rules: LibRule[]; mappings: LibMapping[] }

/** TRD 9.5 global seed (DECISION list). */
export const GLOBAL_DENY = ['diagnos', 'cure', 'guarantee', 'buy', 'order now', 'discount', 'offer', 'supplement', 'capsule', 'tablet', 'dose', 'prescri', 'medicine', 'herbal',
  'ayurved', 'price', 'rs.', 'npr', 'call us', 'hotline', 'whatsapp', 'http', 'www.'];

const uid = (n: number) => `01900000-7100-7000-8000-${n.toString(16).padStart(12, '0')}`;
export const sid = uid;

/** TRD 9.3 starter library, verbatim texts (08 A19 D-108 wording for score.explanation). No mappings, no follow-up rules. */
export function starterLibrary(): LibInput {
  const blocks: LibBlock[] = [
    { id: uid(1), blockKey: 'deranged.generic.high', kind: 'deranged', textEn: '{analyte_name} is above the reference range of this laboratory.' },
    { id: uid(2), blockKey: 'deranged.generic.low', kind: 'deranged', textEn: '{analyte_name} is below the reference range of this laboratory.' },
    { id: uid(3), blockKey: 'deranged.generic.abnormal', kind: 'deranged', textEn: '{analyte_name} is reported as abnormal by this laboratory.' },
    { id: uid(4), blockKey: 'advice.all_in_range', kind: 'advice', textEn: 'All results included in this summary are within the reference ranges of this laboratory.' },
    { id: uid(5), blockKey: 'disclaimer.main', kind: 'disclaimer', textEn: "This summary does not replace the full laboratory report or your doctor's advice. Reference ranges are those of this laboratory." },
    { id: uid(6), blockKey: 'score.explanation', kind: 'score_explanation',
      textEn: 'The health score shows how many of your measured results are within the reference range, averaged across the body systems tested. It does not tell you whether you have a disease.' },
  ];
  const rule = (n: number, direction: LibRule['direction'], blockId: string): LibRule =>
    ({ id: uid(n), ruleKind: 'deranged', triggerKind: 'any', direction, minSeverity: 'borderline', priority: 900, blockId, blockKind: 'deranged' });
  return {
    language: 'en', scoreEnabled: true, blocks,
    rules: [rule(11, 'high', uid(1)), rule(12, 'low', uid(2)), rule(13, 'abnormal', uid(3)),
      { id: uid(14), ruleKind: 'advice', triggerKind: 'all_in_range', direction: 'any', priority: 100, blockId: uid(4), blockKind: 'advice' }],
    mappings: [],
  };
}
