// T0A-12 / 08 R12a, C3 TRD §7.1 (grammar + semantics), 08 §4.13 (signatures). See .orchestra/notes/T0A-12-tests.md.
// Spec-fixed API: parseFormula(text) -> {ast?, refs, contextVars, errors:[{offset,code,message}]};
//   formulaRefs(ast); evaluateFormula(ast, inputs, {ageDays?, ageYears?, sex}) -> {ok:true,value,inexact} | {ok:false,reason}.
//   Error codes: syntax | too_long | too_deep | too_many_refs | unknown_function. Reasons: missing_input:<CODE> | division_by_zero | domain_error | <invalid() code>.
// ASSUMED (spec silent): decimal results compared NUMERICALLY (trailing zeros not asserted); non-decimal input strings -> {ok:false};
//   type misuse (boolean in arithmetic) is rejected at parse (errors.length>0) OR at evaluate (ok:false), never thrown;
//   shared vectors file shape { "vectors":[{ id, expression, inputs:{CODE: "1.5"|null}, ctx?:{ageDays,ageYears,sex}, expected:{ok:true,value,inexact?}|{ok:false,reason} }] }.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const load = () => import(new URL('../src/formula/index.ts', import.meta.url).href);
const VECTORS = new URL('../../fakes/contract-tests/formula.vectors.json', import.meta.url);

// ---- independent decimal normaliser (BigInt; no impl code) ----
function norm(s) {
  assert.match(s, /^-?\d+(\.\d+)?$/, `not a plain decimal string: ${s}`);
  let [i, f = ''] = s.replace(/^-/, '').split('.');
  f = f.replace(/0+$/, ''); i = i.replace(/^0+(?=\d)/, '');
  const neg = s.startsWith('-') && (i !== '0' || f !== '');
  return `${neg ? '-' : ''}${i}${f ? '.' + f : ''}`;
}
const num = (v, expect, msg) => assert.equal(norm(v), norm(expect), msg);
const FEMALE = { sex: 'female' };

async function run(expr, inputs = {}, ctx = FEMALE) {
  const { parseFormula, evaluateFormula } = await load();
  const p = parseFormula(expr);
  assert.deepEqual(p.errors, [], `parse errors for ${expr}: ${JSON.stringify(p.errors)}`);
  assert.ok(p.ast, 'ast present when no errors');
  return evaluateFormula(p.ast, inputs, ctx);
}
async function val(expr, inputs, ctx) {
  const r = await run(expr, inputs, ctx);
  assert.equal(r.ok, true, `${expr} -> ${JSON.stringify(r)}`);
  return r;
}
async function rejected(expr, inputs = {}) {
  const { parseFormula, evaluateFormula } = await load();
  const p = parseFormula(expr);
  if (p.errors.length > 0) { assert.equal(p.ast, undefined, 'no ast when errors'); return p.errors; }
  return evaluateFormula(p.ast, inputs, FEMALE).ok === false ? [] : assert.fail(`${expr} was accepted and computed`);
}

// ---- G1–G10 (C3 TRD §7.1), inline so the suite does not depend on the shared file ----
const G = [
  ['G1', 'MCV / RBC', { MCV: '70.0', RBC: '5.60' }, FEMALE, { ok: true, value: '12.5' }],
  ['G2', 'NEUT_ABS / LYMPH_ABS', { NEUT_ABS: '4.20', LYMPH_ABS: '2.10' }, FEMALE, { ok: true, value: '2' }],
  ['G3', 'PLT / LYMPH_ABS', { PLT: '250', LYMPH_ABS: '2.00' }, FEMALE, { ok: true, value: '125' }],
  ['G4', 'WBC * NEUT_PCT / 100', { WBC: '8.50', NEUT_PCT: '60.0' }, FEMALE, { ok: true, value: '5.1' }],
  ['G5', 'if(TG >= 400, invalid("tg_over_400"), TC - HDL - TG / 5)', { TC: '200', HDL: '50', TG: '150' }, FEMALE, { ok: true, value: '120' }],
  ['G6', 'if(TG >= 400, invalid("tg_over_400"), TC - HDL - TG / 5)', { TC: '200', HDL: '50', TG: '450' }, FEMALE, { ok: false, reason: 'tg_over_400' }],
  ['G7', 'NEUT_ABS / LYMPH_ABS', { NEUT_ABS: '4.20', LYMPH_ABS: '0' }, FEMALE, { ok: false, reason: 'division_by_zero' }],
  ['G8', 'TP - ALB', { TP: '7.0' }, FEMALE, { ok: false, reason: 'missing_input:ALB' }],
  ['G9', 'round(2 ^ 0.5, 3)', {}, FEMALE, { ok: true, value: '1.414' }],
  ['G10', 'if(@is_female == 1, A * 0.9, A)', { A: '10' }, FEMALE, { ok: true, value: '9.0' }],
];
function check(r, exp) {
  assert.equal(r.ok, exp.ok);
  if (exp.ok) num(r.value, exp.value); else assert.equal(r.reason, exp.reason);
}

describe('golden vectors G1–G10 (08 R12a)', () => {
  for (const [id, expr, inputs, ctx, exp] of G) it(`${id}: ${expr}`, async () => check(await run(expr, inputs, ctx), exp));
  it('G9 is inexact (non-integer pow); G1–G5,G10 are exact', async () => {
    assert.equal((await run('round(2 ^ 0.5, 3)')).inexact, true);
    for (const [id, expr, inputs, ctx, exp] of G) if (exp.ok && id !== 'G9') assert.equal((await run(expr, inputs, ctx)).inexact, false, id);
  });
});

describe('shared vectors file packages/fakes/contract-tests/formula.vectors.json', () => {
  it('exists, includes G1–G10, and every vector passes through the shared lib', async () => {
    assert.ok(existsSync(VECTORS), 'formula.vectors.json must exist (08 R12a; CR-C3-002)');
    const doc = JSON.parse(readFileSync(VECTORS, 'utf8'));
    const ids = new Set(doc.vectors.map((v) => v.id));
    for (let i = 1; i <= 10; i++) assert.ok(ids.has(`G${i}`), `G${i} missing`);
    const { parseFormula, evaluateFormula } = await load();
    for (const v of doc.vectors) {
      const p = parseFormula(v.expression);
      assert.deepEqual(p.errors, [], v.id);
      const inputs = Object.fromEntries(Object.entries(v.inputs ?? {}).map(([k, x]) => [k, x ?? undefined]));
      const r = evaluateFormula(p.ast, inputs, v.ctx ?? FEMALE);
      check(r, v.expected);
      if (v.expected.ok && 'inexact' in v.expected) assert.equal(r.inexact, v.expected.inexact, v.id);
    }
  });
  it('synthetic only: no real patient data keys', () => {
    const txt = readFileSync(VECTORS, 'utf8');
    assert.doesNotMatch(txt, /patient_name|"name"\s*:/i);
  });
});

describe('exact decimal arithmetic (>= 28 significant digits, half-up)', () => {
  it('0.1 + 0.2 == 0.3 exactly (binary floats fail)', async () => {
    num((await val('if(0.1 + 0.2 == 0.3, 1, 0)')).value, '1');
    num((await val('0.1 + 0.2')).value, '0.3');
  });
  it('integers beyond 2^53 are exact', async () => {
    num((await val('12345678901234567890 + 1')).value, '12345678901234567891');
    num((await val('9007199254740993 * 3')).value, '27021597764222979');
  });
  it('division keeps >= 28 significant digits: 1/3*3 is 0.999...9 (>= 27 nines)', async () => {
    const v = (await val('1 / 3 * 3')).value;
    assert.match(v, /^0\.9{27,}$/);
  });
  it('2/3 rounds half-up at the 28th significant digit', async () => {
    assert.match((await val('2 / 3')).value, /^0\.66666666666666666666666666(67|7)$/);
  });
  it('arithmetic results are not marked inexact', async () => {
    assert.equal((await val('1 / 3')).inexact, false);
  });
  it('comparison chain: all six operators', async () => {
    for (const [e, t] of [['1 < 2', 1], ['2 <= 2', 1], ['3 > 2', 1], ['2 >= 3', 0], ['1.0 == 1', 1], ['1 != 1.00', 0]]) num((await val(`if(${e}, 1, 0)`)).value, String(t), e);
  });
});

describe('round(x, n): half-up, n in 0..6', () => {
  for (const [e, x] of [['round(2.5, 0)', '3'], ['round(0.125, 2)', '0.13'], ['round(1.0005, 3)', '1.001'], ['round(1.0004, 3)', '1'], ['round(7, 2)', '7'], ['round(0.5, 0)', '1'], ['round(0.0000005, 6)', '0.000001']]) {
    it(e, async () => num((await val(e)).value, x));
  }
  it('round of an exact value stays exact', async () => assert.equal((await val('round(1.2345, 2)')).inexact, false));
});

describe('precedence and associativity', () => {
  for (const [e, x] of [['2 + 3 * 4', '14'], ['(2 + 3) * 4', '20'], ['10 - 4 - 3', '3'], ['100 / 10 / 5', '2'], ['-2 ^ 2', '-4'], ['2 ^ 3 ^ 2', '512'], ['2 ^ -1', '0.5'], ['--3', '3'], ['1 + -2', '-1']]) {
    it(e, async () => num((await val(e)).value, x));
  }
  it('integer-exponent pow is exact (not inexact)', async () => {
    const r = await val('pow(2, 10)'); num(r.value, '1024'); assert.equal(r.inexact, false);
  });
  it('(-2)^2 is 4 (negative base, integer exponent is fine)', async () => num((await val('(-2) ^ 2')).value, '4'));
  it('min / max / abs', async () => {
    num((await val('min(3, 1, 2)')).value, '1'); num((await val('max(3, 1, 2)')).value, '3'); num((await val('abs(-4.5)')).value, '4.5');
  });
  it('and / or / short logic as if() conditions', async () => {
    const f = 'if(A > 1 and B > 1, 1, if(A > 5 or B > 5, 2, 3))';
    num((await val(f, { A: '2', B: '2' })).value, '1'); num((await val(f, { A: '6', B: '0' })).value, '2'); num((await val(f, { A: '0', B: '0' })).value, '3');
  });
  it('whitespace is insignificant', async () => num((await val('  1\t+\n2 ')).value, '3'));
});

describe('inexact functions (IEEE double, 15 significant digits, inexact: true)', () => {
  for (const [e, x] of [['sqrt(16)', '4'], ['sqrt(2)', '1.4142135623731'], ['log10(1000)', '3'], ['ln(1)', '0'], ['exp(0)', '1'], ['2 ^ 0.5', '1.4142135623731'], ['pow(2, 0.5)', '1.4142135623731'], ['ln(10)', '2.30258509299405']]) {
    it(`${e} -> ${x}, inexact`, async () => { const r = await val(e); num(r.value, x); assert.equal(r.inexact, true); });
  }
  it('result never carries more than 15 significant digits', async () => {
    const v = (await val('sqrt(3)')).value.replace('.', '').replace(/^0+/, '');
    assert.ok(v.replace(/0+$/, '').length <= 15, v);
  });
  it('inexact propagates through later arithmetic', async () => assert.equal((await val('sqrt(2) + 1')).inexact, true));
  it('inexact is false when the inexact branch is not taken (lazy if)', async () => assert.equal((await val('if(1 == 1, 1, sqrt(2))')).inexact, false));
});

describe('not computable', () => {
  it('missing input is never 0: reason missing_input:<CODE>', async () => {
    check(await run('A + B', { A: '1' }), { ok: false, reason: 'missing_input:B' });
    check(await run('A * 0', {}), { ok: false, reason: 'missing_input:A' });
    check(await run('A + B', { A: '1', B: undefined }), { ok: false, reason: 'missing_input:B' });
  });
  it('division by zero (also via zero expression and 0.00)', async () => {
    for (const e of ['1 / 0', '1 / 0.00', '1 / (2 - 2)']) check(await run(e), { ok: false, reason: 'division_by_zero' });
  });
  it('domain errors: sqrt/ln/log10 of non-positive, negative base with fractional exponent', async () => {
    for (const e of ['sqrt(-1)', 'ln(0)', 'ln(-1)', 'log10(0)', 'log10(-5)', '(-8) ^ 0.5', 'pow(-8, 0.5)']) check(await run(e), { ok: false, reason: 'domain_error' });
  });
  it('sqrt(0): spec says sqrt of a non-positive number is domain_error, and 0 is non-positive', async () => {
    check(await run('sqrt(0)'), { ok: false, reason: 'domain_error' });
  });
  it('invalid("code") makes the whole formula not computable, even nested', async () => {
    check(await run('1 + if(1 == 1, invalid("bad_input"), 2)'), { ok: false, reason: 'bad_input' });
  });
  it('lazy if: untaken branch is not evaluated (no division_by_zero, no missing input, no invalid)', async () => {
    num((await val('if(1 == 1, 5, 1 / 0)')).value, '5');
    num((await val('if(1 == 0, 1 / 0, 7)')).value, '7');
    num((await val('if(1 == 1, 5, MISSING)')).value, '5');
    num((await val('if(1 == 1, 5, invalid("x"))')).value, '5');
  });
  it('non-decimal input strings never compute (NaN, Infinity, exponent, empty, junk)', async () => {
    for (const bad of ['NaN', 'Infinity', '-Infinity', '1e3', '', ' ', '0x10', '1,5', 'abc', '1.', '.5']) {
      const r = await run('A + 1', { A: bad });
      assert.equal(r.ok, false, `input ${JSON.stringify(bad)} computed as ${JSON.stringify(r)}`);
    }
  });
});

describe('context variables', () => {
  it('@is_female / @is_male: 1 or 0; other and unknown are 0 for both', async () => {
    for (const [sex, f, m] of [['female', 1, 0], ['male', 0, 1], ['other', 0, 0], ['unknown', 0, 0]]) {
      num((await val('@is_female * 10 + @is_male', {}, { sex })).value, String(f * 10 + m), sex);
    }
  });
  it('@age_years / @age_days read ctx', async () => {
    num((await val('@age_years', {}, { sex: 'male', ageYears: 42, ageDays: 15341 })).value, '42');
    num((await val('@age_days', {}, { sex: 'male', ageYears: 0, ageDays: 17 })).value, '17');
  });
  it('contextVars listed by parse in order of first appearance, distinct', async () => {
    const { parseFormula } = await load();
    assert.deepEqual(parseFormula('@age_years + @is_male + @age_years').contextVars, ['@age_years', '@is_male']);
    assert.deepEqual(parseFormula('1 + 2').contextVars, []);
  });
  it('unknown context variable is a syntax error', async () => assert.ok((await rejected('@age_weeks')).length > 0));
});

describe('parseFormula: refs, errors, limits', () => {
  it('refs = distinct analyte codes in order of first appearance; formulaRefs(ast) agrees', async () => {
    const { parseFormula, formulaRefs } = await load();
    const p = parseFormula('B + A * B - C_2 / A1');
    assert.deepEqual(p.errors, []); assert.deepEqual(p.refs, ['B', 'A', 'C_2', 'A1']);
    assert.deepEqual(formulaRefs(p.ast), ['B', 'A', 'C_2', 'A1']);
  });
  it('refs inside an untaken branch are still refs', async () => {
    const { parseFormula } = await load();
    assert.deepEqual(parseFormula('if(A > 0, B, C)').refs, ['A', 'B', 'C']);
  });
  it('syntax errors carry offset, code, message; no ast', async () => {
    const { parseFormula } = await load();
    const p = parseFormula('1 + * 2');
    assert.equal(p.ast, undefined); assert.ok(p.errors.length >= 1);
    const e = p.errors[0]; assert.equal(e.code, 'syntax'); assert.equal(typeof e.message, 'string');
    assert.ok(Number.isInteger(e.offset) && e.offset >= 0 && e.offset <= 7);
  });
  it('rejects: empty, ternary, ||, &&, exponent notation, .5, 5., bare comparison chain, lower-case ref, trailing junk, unbalanced parens', async () => {
    for (const t of ['', '   ', 'A ? 1 : 2', 'A || B', 'A && B', '1e3', '.5', '5.', '1 < 2 < 3', 'abc', 'A B', '(1 + 2', '1 + 2)', '1 +', 'if(1)', 'if(1 == 1, 2)', 'A = 1', '"str"', 'invalid(reason)']) {
      const { parseFormula } = await load();
      const p = parseFormula(t);
      assert.ok(p.errors.length > 0, `accepted: ${JSON.stringify(t)}`);
    }
  });
  it('booleans are only legal as if() condition and and/or operands', async () => {
    for (const t of ['1 + (2 < 3)', '(1 < 2) * 3', 'max(1 < 2, 3)', 'if(5, 1, 2)']) await rejected(t);
  });
  it('invalid() reason must be lower / digit / underscore, <= 32 chars', async () => {
    const { parseFormula } = await load();
    assert.deepEqual(parseFormula('invalid("tg_over_400")').errors, []);
    assert.deepEqual(parseFormula(`invalid("${'a'.repeat(32)}")`).errors, []);
    for (const bad of ['BadReason', 'has space', 'a'.repeat(33), '', 'x-y', 'x\\"y']) assert.ok(parseFormula(`invalid("${bad}")`).errors.length > 0, bad);
  });
  it('unknown_function: lower-case name before "(" outside the function list', async () => {
    const { parseFormula } = await load();
    for (const t of ['foo(1)', 'sin(1)', 'log(10)', 'cbrt(8)', 'sum(1, 2)']) assert.ok(parseFormula(t).errors.some((e) => e.code === 'unknown_function'), t);
    for (const f of ['if(1==1,1,2)', 'min(1,2)', 'max(1,2)', 'abs(1)', 'round(1,0)', 'sqrt(1)', 'ln(1)', 'log10(1)', 'exp(1)', 'pow(1,2)']) assert.deepEqual(parseFormula(f).errors, [], f);
  });
  it('analyte ref <= 32 chars: 32 ok, 33 syntax error', async () => {
    const { parseFormula } = await load();
    assert.deepEqual(parseFormula('A'.repeat(32)).errors, []);
    assert.ok(parseFormula('A'.repeat(33)).errors.length > 0);
  });
  it('too_long: 500 chars ok, 501 -> too_long', async () => {
    const { parseFormula } = await load();
    const mk = (k, pad = '') => `max(${Array(k).fill('1').join(',')})${pad}`;
    const ok = mk(248); assert.equal(ok.length, 500); assert.deepEqual(parseFormula(ok).errors, []);
    const long = mk(248, ' '); assert.equal(long.length, 501);
    assert.ok(parseFormula(long).errors.some((e) => e.code === 'too_long'));
  });
  it('too_many_refs: 20 distinct ok, 21 -> too_many_refs; repeats do not count', async () => {
    const { parseFormula } = await load();
    const refs = (n) => Array.from({ length: n }, (_, i) => `R${i}`);
    assert.deepEqual(parseFormula(`max(${refs(20).join(',')})`).errors, []);
    assert.ok(parseFormula(`max(${refs(21).join(',')})`).errors.some((e) => e.code === 'too_many_refs'));
    const rep = parseFormula(`max(${refs(20).join(',')},R0,R1)`);
    assert.deepEqual(rep.errors, []); assert.equal(rep.refs.length, 20);
  });
  it('too_deep: nesting > 32 -> too_deep, nesting well under 32 ok', async () => {
    const { parseFormula } = await load();
    assert.deepEqual(parseFormula(`${'('.repeat(10)}1${')'.repeat(10)}`).errors, []);
    assert.ok(parseFormula(`${'('.repeat(40)}1${')'.repeat(40)}`).errors.some((e) => e.code === 'too_deep'));
    assert.ok(parseFormula(`${'abs('.repeat(40)}1${')'.repeat(40)}`).errors.some((e) => e.code === 'too_deep'));
  });
});

describe('adversarial input (pure function, DoS-guarded; never throws)', () => {
  it('10k-deep parens / unary minus / calls do not overflow the stack or throw', async () => {
    const { parseFormula } = await load();
    for (const t of ['('.repeat(10000) + '1' + ')'.repeat(10000), '-'.repeat(10000) + '1', 'abs('.repeat(10000) + '1' + ')'.repeat(10000), '1' + '^1'.repeat(10000)]) {
      const p = parseFormula(t);
      assert.ok(p.errors.length > 0 && p.ast === undefined, 'over-limit input rejected via errors');
    }
  });
  it('huge input (1 MB) is rejected quickly as too_long', async () => {
    const { parseFormula } = await load();
    const t0 = Date.now(); const p = parseFormula('1+'.repeat(500000));
    assert.ok(p.errors.some((e) => e.code === 'too_long')); assert.ok(Date.now() - t0 < 1000, 'must not scan the full input slowly');
  });
  it('prototype-pollution-ish codes are inert: __proto__ / constructor as analyte codes', async () => {
    const { parseFormula, evaluateFormula } = await load();
    for (const code of ['PROTO__', 'CONSTRUCTOR', 'TOSTRING']) {
      const p = parseFormula(`${code} + 1`); assert.deepEqual(p.errors, []);
      assert.deepEqual(evaluateFormula(p.ast, {}, FEMALE), { ok: false, reason: `missing_input:${code}` });
    }
    // analyteRef must start with an upper-case letter (C3 TRD:503): leading `_` is a syntax error
    assert.ok(parseFormula('__PROTO__ + 1').errors.length > 0);
    const inputs = JSON.parse('{"__proto__":"5"}'); const p = parseFormula('A + 1');
    assert.equal(evaluateFormula(p.ast, inputs, FEMALE).ok, false);
  });
  it('evaluate does not mutate inputs/ctx (frozen) and is deterministic', async () => {
    const { parseFormula, evaluateFormula } = await load();
    const inputs = Object.freeze({ A: '1.5' }), ctx = Object.freeze({ sex: 'male' }); const p = parseFormula('A * 2 + sqrt(4)');
    const a = evaluateFormula(p.ast, inputs, ctx), b = evaluateFormula(p.ast, inputs, ctx);
    assert.deepEqual(a, b);
  });
  it('fuzz: random token strings never throw from parse or evaluate (seeded LCG, 3000 cases)', async () => {
    const { parseFormula, evaluateFormula } = await load();
    const toks = ['A', 'B', 'TG', '1', '0', '2.5', '0.0', '+', '-', '*', '/', '^', '(', ')', ',', '<', '>=', '==', '!=', 'and', 'or', 'if', 'min', 'sqrt', 'ln', 'log10', 'exp', 'pow', 'round', 'abs', 'invalid', '"x"', '"', '@age_years', '@is_female', '@', ' ', '.', 'e', '\u0000', 'é', '9'.repeat(40)];
    let s = 123456789; const rnd = (n) => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s % n; };
    for (let i = 0; i < 3000; i++) {
      const text = Array.from({ length: 1 + rnd(14) }, () => toks[rnd(toks.length)]).join(rnd(3) === 0 ? ' ' : '');
      const p = parseFormula(text);
      assert.ok(Array.isArray(p.errors) && Array.isArray(p.refs) && Array.isArray(p.contextVars));
      if (p.errors.length === 0) {
        const r = evaluateFormula(p.ast, { A: '3', B: '0', TG: '150' }, FEMALE);
        assert.equal(typeof r.ok, 'boolean');
        if (r.ok) { assert.match(r.value, /^-?\d+(\.\d+)?$/); assert.equal(typeof r.inexact, 'boolean'); } else assert.equal(typeof r.reason, 'string');
      } else assert.equal(p.ast, undefined);
    }
  });
});
