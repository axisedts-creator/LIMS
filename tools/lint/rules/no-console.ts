// 02-CONVENTIONS §1.3 / §9: no console.*; use the shared logger.
import { codeMatches, lineAt, scan, type Violation } from './_scan.ts';

export const name = 'no-console';
const RE = /(?<![\w$.])console\s*[.[]/g;

export function check(_path: string, source: string): Violation[] {
  return codeMatches(scan(source), RE).map((m) => ({ rule: name, line: lineAt(source, m.index), message: 'console.* is banned; use the shared logger' }));
}
