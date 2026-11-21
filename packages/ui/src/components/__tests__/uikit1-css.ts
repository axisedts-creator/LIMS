// T0D-UIKIT-1 test helper (tests only): a small reader for packages/ui/src/components/kit.css.
// Rules are kept with their @media condition ('' = none) so a test can ask "what does this selector declare, and under which media".
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type Rule = { sels: string[]; decls: Map<string, string>; media: string; order: number };

const KIT = join(process.cwd(), 'src', 'components', 'kit.css'); // vitest root = packages/ui
const norm = (s: string) => s.replace(/\s+/g, ' ').replace(/"/g, "'").trim();

function splitTop(s: string, sep = ','): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(' || ch === '[') depth++;
    if (ch === ')' || ch === ']') depth--;
    if (ch === sep && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map(norm).filter(Boolean);
}

export function parseCss(css: string): Rule[] {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: Rule[] = [];
  let order = 0;
  const walk = (text: string, media: string) => {
    let i = 0;
    while (i < text.length) {
      const open = text.indexOf('{', i);
      if (open < 0) break;
      const head = norm(text.slice(i, open));
      let depth = 1;
      let j = open + 1;
      while (j < text.length && depth > 0) {
        if (text[j] === '{') depth++;
        else if (text[j] === '}') depth--;
        j++;
      }
      const body = text.slice(open + 1, j - 1);
      if (head.startsWith('@media')) walk(body, norm(head.slice(6)));
      else if (!head.startsWith('@')) {
        const decls = new Map<string, string>();
        for (const d of splitTop(body, ';')) {
          const k = d.indexOf(':');
          if (k > 0) decls.set(d.slice(0, k).trim(), d.slice(k + 1).trim());
        }
        rules.push({ sels: splitTop(head), decls, media, order: order++ });
      }
      i = j;
    }
  };
  walk(src, '');
  return rules;
}

export const kitCss = () => readFileSync(KIT, 'utf8');
export const kitRules = () => parseCss(kitCss());

/** Rules whose selector list holds a selector matching `re` (and, when given, the exact media text). */
export function rulesMatching(re: RegExp, media?: string): Rule[] {
  return kitRules().filter((r) => (media === undefined || r.media === media) && r.sels.some((s) => re.test(s)));
}

/** Last declared value of `prop` over the rules matching `re` (no media unless given); undefined when none declares it. */
export function declared(re: RegExp, prop: string, media = ''): string | undefined {
  let v: string | undefined;
  for (const r of rulesMatching(re, media)) if (r.decls.has(prop)) v = r.decls.get(prop);
  return v;
}

/** rem value of a length like "24rem" or "min(24rem, 100%)"; NaN when not a plain rem length. */
export const rem = (v: string | undefined): number => {
  const m = /^(\d*\.?\d+)rem$/.exec((v ?? '').trim());
  return m ? Number(m[1]) : NaN;
};
