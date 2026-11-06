// 02-CONVENTIONS §1.3: no Math.random() for tokens/ids; use @lims/shared-ts/crypto (04 A9–A13).
import { codeMatches, lineAt, scan, type Violation } from './_scan.ts';

export const name = 'no-math-random';
const RE = /\bMath\s*(?:\.\s*random\b|\[\s*(['"`])random\1\s*\])/g;

export function check(_path: string, source: string): Violation[] {
  return codeMatches(scan(source), RE).map((m) => ({ rule: name, line: lineAt(source, m.index), message: 'Math.random() is not a CSPRNG; use @lims/shared-ts/crypto' }));
}
