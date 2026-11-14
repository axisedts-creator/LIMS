// 08 A13 P-9: one spreadsheet injection guard, @lims/shared-ts/spreadsheet. Module-local copies are banned (C3, C4, C8).
// Flags a declaration (function / const / let / var) of the guard names outside packages/shared-ts/src/spreadsheet/.
import { codeMatches, lineAt, scan, under, type Violation } from './_scan.ts';

export const name = 'no-local-spreadsheet-guard';
const HOME = 'packages/shared-ts/src/spreadsheet';
const RE = /\b(?:function\s*\*?\s*|(?:const|let|var)\s+)(?:neutrali[sz]eFormula|restoreNeutralised)\b/g;

export function check(path: string, source: string): Violation[] {
  if (under(path, HOME)) return [];
  return codeMatches(scan(source), RE).map((m) => ({
    rule: name,
    line: lineAt(source, m.index),
    message: 'module-local spreadsheet guard; import neutraliseFormula / restoreNeutralised from @lims/shared-ts/spreadsheet',
  }));
}
