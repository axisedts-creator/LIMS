// 02-CONVENTIONS §1.3: no bare SET in SQL strings; only SET LOCAL / set_config(…, true) (04 S9, REQ-ARCH-016).
import { lineAt, sqlTexts, type Violation } from './_scan.ts';

export const name = 'no-bare-set';
// SET at statement start (string start or after ;), not followed by LOCAL.
const BARE_SET = /(?:^|;)[\s'"`]*(set)\s+(?!local\b)/gi;
const SESSION_SET_CONFIG = /\bset_config\s*\([^()]*,\s*false\s*\)/gi;

export function check(path: string, source: string): Violation[] {
  const out: Violation[] = [];
  for (const { value, offset } of sqlTexts(path, source)) {
    for (const m of value.matchAll(BARE_SET)) {
      out.push({ rule: name, line: lineAt(source, offset + m.index + m[0].lastIndexOf(m[1])), message: 'bare SET is session-scoped under PgBouncer; use SET LOCAL or set_config(…, true)' });
    }
    for (const m of value.matchAll(SESSION_SET_CONFIG)) {
      out.push({ rule: name, line: lineAt(source, offset + m.index), message: 'set_config(…, false) is session-scoped; pass true (transaction-local)' });
    }
  }
  return out;
}
