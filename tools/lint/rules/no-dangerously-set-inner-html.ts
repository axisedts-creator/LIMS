// 02-CONVENTIONS §1.3: no dangerouslySetInnerHTML with non-constant input (REQ-SEC-088).
import { codeMatches, lineAt, scan, type Violation } from './_scan.ts';

export const name = 'no-dangerously-set-inner-html';
const RE = /\bdangerouslySetInnerHTML\s*=\s*\{/g;

export function check(_path: string, source: string): Violation[] {
  const s = scan(source);
  return codeMatches(s, RE).flatMap((m) => {
    // Find the close brace of the JSX expression container, skipping string chars.
    const start = m.index + m[0].length;
    let depth = 1;
    let k = start;
    for (; k < source.length && depth > 0; k++) {
      if (s.kind[k] === 1) continue;
      if (source[k] === '{') depth++;
      else if (source[k] === '}') depth--;
    }
    const expr = source.slice(start, k - 1);
    const lit = /^\s*\{\s*__html\s*:\s*(['"`])/.exec(expr);
    if (lit) {
      // Constant iff the value is one literal with no code chars (so no ${…}) up to its closing quote.
      const a = start + lit[0].length - 1;
      let b = a + 1;
      while (b < k && s.kind[b] === 1 && source[b] !== lit[1]) b += source[b] === '\\' ? 2 : 1;
      if (source[b] === lit[1] && s.kind[b] === 1 && /^\s*,?\s*\}\s*$/.test(source.slice(b + 1, k - 1))) return [];
    }
    return [{ rule: name, line: lineAt(source, m.index), message: 'dangerouslySetInnerHTML only with a constant string; render text nodes or sanitise server-side' }];
  });
}
