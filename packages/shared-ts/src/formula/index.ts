// @lims/shared-ts/formula (02-TRD §3.1; 08 §4.13, R12a). Grammar + semantics: C3 02-TRD §7.1 (+ log10).
// One parser for the program: C3 validates, C5 evaluates. Pure; never throws on any `text`.
import * as D from '../decimal/index.ts';
import type { Decimal } from '../decimal/index.ts';

/** [CONV] local brands until `@lims/contracts/ports/common` is importable (see money/). */
export type Code = string;
export type DecimalString = string;
export type Sex = 'female' | 'male' | 'other' | 'unknown';

export type FormulaAst = { readonly __brand: 'FormulaAst' };
export type FormulaContextVar = '@age_days' | '@age_years' | '@is_female' | '@is_male';
export interface FormulaParseError { readonly offset: number; readonly code: 'syntax' | 'too_long' | 'too_deep' | 'too_many_refs' | 'unknown_function'; readonly message: string }
export type FormulaResult = { readonly ok: true; readonly value: DecimalString; readonly inexact: boolean } | { readonly ok: false; readonly reason: string };

// Limits (C3 TRD §7.1 [CONV]).
const MAX_LEN = 500;
const MAX_DEPTH = 32;
const MAX_REFS = 20;
const MAX_NAME = 32;
const OUT_MAX = 40; // DecimalString maxLength (contracts/openapi/_common.yaml)

const CONTEXT_VARS: readonly string[] = ['@age_days', '@age_years', '@is_female', '@is_male'];
const ARITY: Readonly<Record<string, readonly [number, number]>> = {
  if: [3, 3], min: [1, Infinity], max: [1, Infinity], abs: [1, 1], round: [2, 2],
  sqrt: [1, 1], ln: [1, 1], log10: [1, 1], exp: [1, 1], pow: [2, 2],
};

type Node =
  | { k: 'num'; v: Decimal }
  | { k: 'ref'; code: string }
  | { k: 'ctx'; name: FormulaContextVar }
  | { k: 'neg'; a: Node }
  | { k: 'bin'; op: '+' | '-' | '*' | '/' | '^'; a: Node; b: Node }
  | { k: 'cmp'; op: '<' | '<=' | '>' | '>=' | '==' | '!='; a: Node; b: Node }
  | { k: 'logic'; op: 'and' | 'or'; a: Node; b: Node }
  | { k: 'call'; fn: string; args: Node[] }
  | { k: 'invalid'; reason: string };

// ---------- lexer ----------
type Tok = { t: 'num' | 'upper' | 'lower' | 'ctx' | 'str' | 'op' | 'end'; v: string; at: number };

class ParseFail extends Error {
  readonly e: FormulaParseError;
  constructor(code: FormulaParseError['code'], offset: number, message: string) { super(message); this.e = { offset, code, message }; }
}
const fail = (code: FormulaParseError['code'], at: number, msg: string): never => { throw new ParseFail(code, at, msg); };

const isDigit = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9';
const isUpper = (c: string | undefined) => c !== undefined && c >= 'A' && c <= 'Z';
const isLower = (c: string | undefined) => c !== undefined && c >= 'a' && c <= 'z';
const OPS = ['<=', '>=', '==', '!=', '+', '-', '*', '/', '^', '(', ')', ',', '<', '>'];

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const run = (ok: (c: string | undefined) => boolean) => { while (i < src.length && ok(src[i])) i++; };
  while (i < src.length) {
    const c = src[i];
    const at = i;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    if (isDigit(c)) {
      run(isDigit);
      if (src[i] === '.') {
        i++;
        if (!isDigit(src[i])) fail('syntax', i, 'digit expected after "."');
        run(isDigit);
      }
      out.push({ t: 'num', v: src.slice(at, i), at });
    } else if (isUpper(c)) {
      run((x) => isUpper(x) || isDigit(x) || x === '_');
      if (i - at > MAX_NAME) fail('syntax', at, `analyte code longer than ${MAX_NAME} characters`);
      out.push({ t: 'upper', v: src.slice(at, i), at });
    } else if (isLower(c)) {
      run((x) => isLower(x) || isDigit(x) || x === '_');
      out.push({ t: 'lower', v: src.slice(at, i), at });
    } else if (c === '@') {
      i++;
      run((x) => isLower(x) || x === '_');
      const v = src.slice(at, i);
      if (!CONTEXT_VARS.includes(v)) fail('syntax', at, `unknown context variable ${JSON.stringify(v)}`);
      out.push({ t: 'ctx', v, at });
    } else if (c === '"') {
      const end = src.indexOf('"', i + 1);
      if (end < 0) fail('syntax', at, 'unterminated string');
      out.push({ t: 'str', v: src.slice(i + 1, end), at });
      i = end + 1;
    } else {
      const op = OPS.find((o) => src.startsWith(o, i));
      if (!op) fail('syntax', at, `unexpected character ${JSON.stringify(c)}`);
      out.push({ t: 'op', v: op as string, at });
      i += (op as string).length;
    }
  }
  out.push({ t: 'end', v: '', at: src.length });
  return out;
}

// ---------- parser (recursive descent; depth-guarded) ----------
type Ty = 'num' | 'bool';
const REASON_RE = /^[a-z][a-z0-9_]*$/;

function parse(src: string): { ast: Node; refs: string[]; ctx: FormulaContextVar[] } {
  const toks = lex(src);
  let p = 0;
  let depth = 0;
  const refs: string[] = [];
  const ctx: FormulaContextVar[] = [];
  const peek = () => toks[p] as Tok;
  const next = () => toks[p++] as Tok;
  const isOp = (v: string) => peek().t === 'op' && peek().v === v;
  const isWord = (v: string) => peek().t === 'lower' && peek().v === v;
  const expect = (v: string) => { if (!isOp(v)) fail('syntax', peek().at, `expected "${v}"`); p++; };
  const enter = (at: number) => { if (++depth > MAX_DEPTH) fail('too_deep', at, `nesting deeper than ${MAX_DEPTH}`); };
  const want = (n: [Node, Ty], ty: Ty, at: number): Node => {
    if (n[1] !== ty) fail('syntax', at, ty === 'num' ? 'number expected, got a comparison' : 'comparison expected, got a number');
    return n[0];
  };

  function orExpr(): [Node, Ty] {
    let at = peek().at;
    let l = andExpr();
    while (isWord('or')) {
      p++;
      const a = want(l, 'bool', at);
      at = peek().at;
      l = [{ k: 'logic', op: 'or', a, b: want(andExpr(), 'bool', at) }, 'bool'];
    }
    return l;
  }
  function andExpr(): [Node, Ty] {
    let at = peek().at;
    let l = cmpExpr();
    while (isWord('and')) {
      p++;
      const a = want(l, 'bool', at);
      at = peek().at;
      l = [{ k: 'logic', op: 'and', a, b: want(cmpExpr(), 'bool', at) }, 'bool'];
    }
    return l;
  }
  function cmpExpr(): [Node, Ty] {
    const at = peek().at;
    const l = addExpr();
    const t = peek();
    if (t.t === 'op' && ['<', '<=', '>', '>=', '==', '!='].includes(t.v)) {
      p++;
      const a = want(l, 'num', at);
      const at2 = peek().at;
      return [{ k: 'cmp', op: t.v as '<', a, b: want(addExpr(), 'num', at2) }, 'bool'];
    }
    return l;
  }
  function addExpr(): [Node, Ty] {
    let at = peek().at;
    let l = mulExpr();
    while (isOp('+') || isOp('-')) {
      const op = next().v as '+';
      const a = want(l, 'num', at);
      at = peek().at;
      l = [{ k: 'bin', op, a, b: want(mulExpr(), 'num', at) }, 'num'];
    }
    return l;
  }
  function mulExpr(): [Node, Ty] {
    let at = peek().at;
    let l = unary();
    while (isOp('*') || isOp('/')) {
      const op = next().v as '*';
      const a = want(l, 'num', at);
      at = peek().at;
      l = [{ k: 'bin', op, a, b: want(unary(), 'num', at) }, 'num'];
    }
    return l;
  }
  function unary(): [Node, Ty] {
    if (isOp('-')) {
      const at = next().at;
      enter(at);
      const a = want(unary(), 'num', peek().at);
      depth--;
      return [{ k: 'neg', a }, 'num'];
    }
    return power();
  }
  function power(): [Node, Ty] {
    const at = peek().at;
    const l = primary();
    if (!isOp('^')) return l;
    p++;
    enter(peek().at);
    const at2 = peek().at;
    const b = want(unary(), 'num', at2);
    depth--;
    return [{ k: 'bin', op: '^', a: want(l, 'num', at), b }, 'num'];
  }
  function primary(): [Node, Ty] {
    const t = next();
    switch (t.t) {
      case 'num': return [{ k: 'num', v: D.parseDecimal(t.v) as Decimal }, 'num'];
      case 'upper':
        if (isOp('(')) fail('syntax', t.at, 'function names are lower-case');
        if (!refs.includes(t.v)) refs.push(t.v);
        return [{ k: 'ref', code: t.v }, 'num'];
      case 'ctx':
        if (!ctx.includes(t.v as FormulaContextVar)) ctx.push(t.v as FormulaContextVar);
        return [{ k: 'ctx', name: t.v as FormulaContextVar }, 'num'];
      case 'lower': return call(t);
      case 'op':
        if (t.v === '(') {
          enter(t.at);
          const e = orExpr();
          expect(')');
          depth--;
          return e;
        }
        break;
      default: break;
    }
    return fail('syntax', t.at, t.t === 'end' ? 'unexpected end of formula' : `unexpected ${JSON.stringify(t.v)}`);
  }
  function call(t: Tok): [Node, Ty] {
    if (!isOp('(')) return fail('syntax', t.at, `unexpected ${JSON.stringify(t.v)}`);
    if (t.v === 'invalid') {
      p++;
      const s = next();
      if (s.t !== 'str') fail('syntax', s.at, 'invalid() takes a quoted reason code');
      if (!REASON_RE.test(s.v) || s.v.length > MAX_NAME) fail('syntax', s.at, 'reason code must be lower-case letters, digits, "_", <= 32 chars');
      expect(')');
      return [{ k: 'invalid', reason: s.v }, 'num'];
    }
    const ar = Object.hasOwn(ARITY, t.v) ? ARITY[t.v] : undefined;
    if (!ar) return fail('unknown_function', t.at, `unknown function ${JSON.stringify(t.v)}`);
    p++;
    enter(t.at);
    const args: Node[] = [];
    if (!isOp(')')) {
      for (;;) {
        const at = peek().at;
        const a = orExpr();
        args.push(want(a, t.v === 'if' && args.length === 0 ? 'bool' : 'num', at));
        if (!isOp(',')) break;
        p++;
      }
    }
    expect(')');
    depth--;
    if (args.length < ar[0] || args.length > ar[1]) fail('syntax', t.at, `${t.v}() takes ${ar[0] === ar[1] ? ar[0] : `at least ${ar[0]}`} argument(s)`);
    return [{ k: 'call', fn: t.v, args }, 'num'];
  }

  const top = orExpr();
  if (peek().t !== 'end') fail('syntax', peek().at, `unexpected ${JSON.stringify(peek().v)}`);
  const ast = want(top, 'num', 0);
  if (refs.length > MAX_REFS) fail('too_many_refs', 0, `more than ${MAX_REFS} distinct analyte references`);
  if (astDepth(ast) > MAX_DEPTH) fail('too_deep', 0, `expression deeper than ${MAX_DEPTH}`);
  return { ast, refs, ctx };
}

function children(n: Node): Node[] {
  switch (n.k) {
    case 'neg': return [n.a];
    case 'bin': case 'cmp': case 'logic': return [n.a, n.b];
    case 'call': return n.args;
    default: return [];
  }
}
// Iterative so a 500-char left-assoc chain cannot blow the stack.
function astDepth(root: Node): number {
  let max = 0;
  const stack: Array<[Node, number]> = [[root, 1]];
  while (stack.length) {
    const [n, d] = stack.pop() as [Node, number];
    if (d > max) max = d;
    for (const c of children(n)) stack.push([c, d + 1]);
  }
  return max;
}

// AST is opaque to callers; keep the internal node behind a WeakMap so a forged object is rejected.
const ASTS = new WeakMap<object, { node: Node; refs: readonly string[] }>();

export function parseFormula(text: string): { readonly ast?: FormulaAst; readonly refs: readonly Code[]; readonly contextVars: readonly FormulaContextVar[]; readonly errors: readonly FormulaParseError[] } {
  if (typeof text !== 'string') return { refs: [], contextVars: [], errors: [{ offset: 0, code: 'syntax', message: 'formula must be a string' }] };
  if (text.length > MAX_LEN) return { refs: [], contextVars: [], errors: [{ offset: MAX_LEN, code: 'too_long', message: `formula longer than ${MAX_LEN} characters` }] };
  try {
    const { ast, refs, ctx } = parse(text);
    const handle = Object.freeze({}) as FormulaAst;
    ASTS.set(handle, { node: ast, refs: Object.freeze([...refs]) });
    return { ast: handle, refs, contextVars: ctx, errors: [] };
  } catch (e) {
    if (e instanceof ParseFail) return { refs: [], contextVars: [], errors: [e.e] };
    if (e instanceof RangeError) return { refs: [], contextVars: [], errors: [{ offset: 0, code: 'too_deep', message: 'expression too deep' }] }; // stack guard
    throw e;
  }
}

/** Distinct analyte codes in order of first appearance. */
export function formulaRefs(ast: FormulaAst): readonly Code[] {
  const a = ASTS.get(ast);
  if (!a) throw new TypeError('formulaRefs: not an AST from parseFormula');
  return a.refs;
}

// ---------- evaluator ----------
class NotComputable extends Error {
  readonly reason: string;
  constructor(reason: string) { super(reason); this.reason = reason; }
}
const nc = (reason: string): never => { throw new NotComputable(reason); };
const INEXACT_SIG = 15;
const checked = (d: Decimal): Decimal => (D.outOfRange(d) ? nc('domain_error') : d);

export function evaluateFormula(
  ast: FormulaAst,
  inputs: Readonly<Record<Code, DecimalString | undefined>>,
  ctx: { readonly ageDays?: number; readonly ageYears?: number; readonly sex: Sex },
): FormulaResult {
  const a = ASTS.get(ast as object);
  if (!a) throw new TypeError('evaluateFormula: not an AST from parseFormula');
  let inexact = false;

  const input = (code: string): Decimal => {
    const v: unknown = inputs != null && Object.hasOwn(inputs, code) ? inputs[code] : undefined;
    // [CONV] a value that is not a DecimalString (≤ 40 chars) is unusable — treated as missing, never as 0.
    const d = typeof v === 'string' && v.length <= OUT_MAX ? D.parseDecimal(v) : undefined;
    return d ?? nc(`missing_input:${code}`);
  };
  const ctxVar = (name: FormulaContextVar): Decimal => {
    if (name === '@is_female') return ctx?.sex === 'female' ? D.ONE : D.ZERO;
    if (name === '@is_male') return ctx?.sex === 'male' ? D.ONE : D.ZERO;
    const v = name === '@age_days' ? ctx?.ageDays : ctx?.ageYears;
    // [CONV] absent / non-integer age → not computable (age unknown, 08 A17.1); reason names the variable.
    return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? D.fromInt(v) : nc(`missing_input:${name}`);
  };
  const viaDouble = (f: number): Decimal => {
    inexact = true;
    return Number.isFinite(f) ? checked(D.fromDouble(f, INEXACT_SIG)) : nc('domain_error');
  };
  const positive = (d: Decimal): number => (D.cmp(d, D.ZERO) > 0 ? D.toDouble(d) : nc('domain_error'));

  const num = (n: Node): Decimal => {
    switch (n.k) {
      case 'num': return n.v;
      case 'ref': return input(n.code);
      case 'ctx': return ctxVar(n.name);
      case 'neg': return D.neg(num(n.a));
      case 'invalid': return nc(n.reason);
      case 'bin': {
        const x = num(n.a), y = num(n.b);
        switch (n.op) {
          case '+': return checked(D.add(x, y));
          case '-': return checked(D.sub(x, y));
          case '*': return checked(D.mul(x, y));
          case '/': return D.isZero(y) ? nc('division_by_zero') : checked(D.div(x, y));
          case '^': return pow(x, y);
        }
        break;
      }
      case 'call': return call(n.fn, n.args);
      default: break;
    }
    throw new TypeError(`formula: ${n.k} is not a number`);
  };
  const pow = (x: Decimal, y: Decimal): Decimal => {
    if (D.isInteger(y)) {
      if (D.isZero(x) && D.isNeg(y)) return nc('division_by_zero');
      try { return checked(D.powInt(x, D.toBigInt(y))); } catch { return nc('domain_error'); }
    }
    if (D.isNeg(x)) return nc('domain_error');
    return viaDouble(Math.pow(D.toDouble(x), D.toDouble(y)));
  };
  const call = (fn: string, args: Node[]): Decimal => {
    const arg = (i: number) => num(args[i] as Node);
    switch (fn) {
      case 'if': return bool(args[0] as Node) ? arg(1) : arg(2);
      case 'min': case 'max': {
        let best = arg(0);
        for (let i = 1; i < args.length; i++) {
          const v = arg(i);
          if (fn === 'min' ? D.cmp(v, best) < 0 : D.cmp(v, best) > 0) best = v;
        }
        return best;
      }
      case 'abs': return D.abs(arg(0));
      case 'round': {
        const x = arg(0), nd = arg(1);
        // [CONV] n outside the integers 0..6 is a domain error.
        if (!D.isInteger(nd) || D.cmp(nd, D.ZERO) < 0 || D.cmp(nd, D.fromInt(6)) > 0) return nc('domain_error');
        return D.roundDp(x, Number(D.toBigInt(nd)));
      }
      case 'sqrt': return viaDouble(Math.sqrt(positive(arg(0))));
      case 'ln': return viaDouble(Math.log(positive(arg(0))));
      case 'log10': return viaDouble(Math.log10(positive(arg(0))));
      case 'exp': return viaDouble(Math.exp(D.toDouble(arg(0))));
      case 'pow': return pow(arg(0), arg(1));
      default: throw new TypeError(`formula: unknown function ${fn}`);
    }
  };
  const bool = (n: Node): boolean => {
    if (n.k === 'logic') {
      const x = bool(n.a), y = bool(n.b); // [CONV] strict: a missing input on either side is never masked
      return n.op === 'and' ? x && y : x || y;
    }
    if (n.k !== 'cmp') throw new TypeError('formula: not a comparison');
    const c = D.cmp(num(n.a), num(n.b));
    switch (n.op) {
      case '<': return c < 0;
      case '<=': return c <= 0;
      case '>': return c > 0;
      case '>=': return c >= 0;
      case '==': return c === 0;
      case '!=': return c !== 0;
    }
  };

  try {
    let v = num(a.node);
    // Fit the DecimalString contract (≤ 40 chars): shed decimals half-up; an integer part that cannot fit is a domain error.
    let s = D.toDecimalString(v);
    const intLen = s.indexOf('.') < 0 ? s.length : s.indexOf('.');
    for (let dp = OUT_MAX - intLen - 1; s.length > OUT_MAX; dp--) {
      if (dp < 0) return { ok: false, reason: 'domain_error' };
      v = D.roundDp(v, dp);
      s = D.toDecimalString(v);
    }
    return { ok: true, value: s, inexact };
  } catch (e) {
    if (e instanceof NotComputable) return { ok: false, reason: e.reason };
    throw e;
  }
}
