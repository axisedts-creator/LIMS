// 02-CONVENTIONS §1.3: no new Date() in domain/ (inject a clock).
import { codeMatches, lineAt, normPath, scan, type Violation } from './_scan.ts';

export const name = 'no-new-date-in-domain';
const RE = /\bnew\s+Date\s*\(\s*\)/g;

export function check(path: string, source: string): Violation[] {
  if (!('/' + normPath(path)).includes('/domain/')) return [];
  return codeMatches(scan(source), RE).map((m) => ({ rule: name, line: lineAt(source, m.index), message: 'new Date() in domain/; inject a clock' }));
}
