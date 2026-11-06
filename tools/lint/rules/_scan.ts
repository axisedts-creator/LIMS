// Shared helpers for tools/lint/rules/*. No deps; loadable by node type stripping.
// ponytail: hand lexer, not a parser. Regex literals containing quotes and JSX text with
// apostrophes can confuse it; swap to the TypeScript compiler API if that bites.

export type Violation = { rule: string; line: number; message: string };

export const normPath = (p: string): string => p.replace(/\\/g, '/').replace(/^(\.\/)+/, '');

/** True when `path` sits under directory `dir` (segment-exact, so `bsdate-extra/` ≠ `bsdate/`). */
export const under = (path: string, dir: string): boolean => normPath(path).startsWith(dir.replace(/\/?$/, '/'));

export type Scan = {
  /** source with comments blanked to spaces (newlines kept, offsets stable) */
  text: string;
  /** per char: 0 = code, 1 = inside a string/template literal (quotes count as string) */
  kind: Uint8Array;
};

/** Lex JS/TS/Dart-ish source: blank `//` and block comments, mark string/template chars. Never throws. */
export function scan(src: string): Scan {
  const out = src.split('');
  const kind = new Uint8Array(src.length);
  const tpl: number[] = []; // brace depth at each open `${`
  let depth = 0;
  let i = 0;
  const n = src.length;
  const blank = (a: number, b: number) => {
    for (let k = a; k < b && k < n; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  // Read a template body from i (just after ` or }); stops at closing ` or at `${`.
  const templateBody = () => {
    while (i < n) {
      const c = src[i];
      kind[i] = 1;
      if (c === '\\') { if (i + 1 < n) kind[i + 1] = 1; i += 2; continue; }
      if (c === '`') { i++; return; }
      if (c === '$' && src[i + 1] === '{') { kind[i + 1] = 1; i += 2; tpl.push(depth); depth++; return; }
      i++;
    }
  };
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      const e = src.indexOf('\n', i);
      const end = e === -1 ? n : e;
      blank(i, end);
      i = end;
    } else if (c === '/' && src[i + 1] === '*') {
      const e = src.indexOf('*/', i + 2);
      const end = e === -1 ? n : e + 2;
      blank(i, end);
      i = end;
    } else if (c === '"' || c === "'") {
      kind[i++] = 1;
      while (i < n && src[i] !== c && src[i] !== '\n') {
        kind[i] = 1;
        if (src[i] === '\\' && i + 1 < n) kind[++i] = 1;
        i++;
      }
      if (i < n) kind[i++] = 1;
    } else if (c === '`') {
      kind[i++] = 1;
      templateBody();
    } else if (c === '{') {
      depth++; i++;
    } else if (c === '}') {
      depth--;
      if (tpl.length && tpl[tpl.length - 1] === depth) { tpl.pop(); kind[i++] = 1; templateBody(); }
      else i++;
    } else i++;
  }
  return { text: out.join(''), kind };
}

export const lineAt = (src: string, offset: number): number => {
  let l = 1;
  for (let k = 0; k < offset && k < src.length; k++) if (src.charCodeAt(k) === 10) l++;
  return l;
};

/** Regex matches (needs the `g` flag) whose first char is code, not inside a string or comment. */
export function codeMatches(s: Scan, re: RegExp): RegExpExecArray[] {
  const res: RegExpExecArray[] = [];
  for (const m of s.text.matchAll(re)) if (s.kind[m.index] === 0 && m[0].trim() !== '') res.push(m as RegExpExecArray);
  return res;
}

/** Module specifiers of import/export-from/side-effect import/dynamic import()/require() (JS, TS, Dart). */
export function imports(src: string): Array<{ spec: string; line: number }> {
  const s = scan(src);
  const re = /\b(?:from|import|require)\s*\(?\s*(['"`])([^'"`\n]*)\1/g;
  return codeMatches(s, re).map((m) => ({ spec: m[2], line: lineAt(src, m.index) }));
}

/** Contiguous string/template-literal runs (template `${…}` splits a run). */
export function strings(src: string): Array<{ value: string; offset: number }> {
  const s = scan(src);
  const res: Array<{ value: string; offset: number }> = [];
  let k = 0;
  while (k < src.length) {
    if (s.kind[k] !== 1) { k++; continue; }
    const start = k;
    while (k < src.length && s.kind[k] === 1) k++;
    res.push({ value: src.slice(start, k), offset: start });
  }
  return res;
}

/** SQL text to check: whole file (minus `--` comments) for .sql, else string literals. Offsets index into `src`. */
export function sqlTexts(path: string, src: string): Array<{ value: string; offset: number }> {
  if (/\.sql$/i.test(path)) return [{ value: src.replace(/--[^\n]*/g, (m) => ' '.repeat(m.length)), offset: 0 }];
  return strings(src);
}
