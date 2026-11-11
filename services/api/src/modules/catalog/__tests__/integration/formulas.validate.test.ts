// T-11 (C3) — #36 validateFormula (POST /v1/catalog/formulas/validate): read-only E3 POST, permission catalog.test.read, no Idempotency-Key, no If-Match.
// Spec: 06-PLAN T-11 (grammar errors, unknown refs, non-numeric target, cycle path, chain depth, dependency order; vectors G1–G10), 02-TRD §5.2 row 36 (invalid formulas return
//       200 valid:false, only mutations return 422), §7.1 (grammar, limits, validation rules, golden vectors), §7.2 (graph), PRD AC-04.1, 04.2, 04.3, 04.4, 04.5, 04.6, 04.7, 04.8,
//       07-SECURITY S-1 (tenant scope), S-5 (strict bodies, prototype keys), S-14 / AB-17 (formula DoS, grammar fuzz), 02-TRD §13 (sample inputs are never logged),
//       contracts/openapi/catalog.yaml (FormulaValidateRequest / FormulaValidateResult).
// Driven through handlers.validateFormula with a request-shaped object and the HandlerContext subset the services get (conventions of rangePreview.handlers.test.ts);
// responses are validated against the OpenAPI schema. Vectors: packages/fakes/contract-tests/formula.vectors.json run through the ENDPOINT (shared evaluator behind it).
// ASSUMPTIONS (spec silent; see .orchestra/notes/C3.T-11-tests.md): the handler validates its own body; `sample_inputs` is JSON object text — unparsable or non-object text -> 400 at /sample_inputs;
//   a value that is not a DecimalString is either 400 at /sample_inputs or "missing" (never 0); without `analyte_id` the expression is its own root (chain_depth counts it: HGB * 3 -> 1);
//   with `analyte_id` the candidate is the analyte's open draft, else its latest published version; error paths are '/formula_expression' (TRD §7.2) or '/expression' (request field).
//   Cases the spec leaves open are NOT tested: formula inputs used only inside comparisons with non-numeric analytes (the AST is opaque), age_years derivation from age_days.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formulaRefs, parseFormula } from '../../../../../../../packages/shared-ts/src/formula/index.js';
import { isLimsError } from '../../../../core/errors.js';
import { REPO_ROOT, loadSpec } from '../../../../core/module.js';
import { handlers } from '../../handlers/index.js';
import { manifest } from '../../index.js';
import { makeIdentity } from '../helpers/identity.js';
import { errPaths, rejection } from '../helpers/t6.js';
import { A, CBC, HB, RBC, chain, draftOf, fnode, leaf, pubOf, snap, world, writes, type Env7 } from '../helpers/t11.js';
import { ID, T, ana } from '../helpers/t7.js';

const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/catalog.yaml'));
const requireAjv = createRequire(createRequire(import.meta.url).resolve('@fastify/ajv-compiler'));
const Ajv2020 = requireAjv('ajv/dist/2020.js').default as new (o: object) => any;
const ajv = new Ajv2020({ strict: false, allErrors: true });
const validatorFor = (name: string) => {
  const v = ajv.compile({ $ref: `#/components/schemas/${name}`, components: spec.components });
  return (x: unknown) => { const ok = v(x); return ok ? [] : (v.errors as any[]).map((e) => `${e.instancePath} ${e.message}`); };
};
const opOf = (id: string): any => { for (const p of Object.values<any>(spec.paths)) for (const m of Object.values<any>(p)) if (m?.operationId === id) return m; };

const OP = 'validateFormula', READ = 'catalog.test.read';
const H = handlers as Record<string, (req: any, ctx: any) => Promise<{ status: number; body?: any }>>;
const req = (body?: unknown) => ({ params: {}, query: {}, headers: {}, body });
const call = (e: Env7, body: unknown) => e.db.run((ctx) => H[OP]!(req(body), { ...ctx, ports: { IdentityPort: makeIdentity([READ], 1) } }));
const inputsText = (o: Record<string, string>) => JSON.stringify(o);
/** 200 + schema-valid body. */
const validate = async (e: Env7, body: unknown) => {
  const r = await call(e, body);
  expect(r.status).toBe(200);
  expect(validatorFor('FormulaValidateResult')(r.body)).toEqual([]);
  return r.body;
};
const bad = async (e: Env7, body: unknown) => {
  const x = await rejection(call(e, body));
  expect(isLimsError(x), `got ${x?.code ?? x?.message}`).toBe(true);
  expect(x.statusCode).toBe(400);
  expect(['common.validation_failed', 'common.unknown_field']).toContain(x.code);
  return x;
};
const text = (b: any) => JSON.stringify(b.errors);

// ---- fixtures (synthetic) ---------------------------------------------------------------------------------------------------------------------------------------------------------------------
const MCV = leaf(101, 'MCV', { version: { unit_code: 'fl' } });
const MENTZER = { analyte: ana(110, A, CBC.test.id as string, { code: 'MENTZER', name: 'Mentzer index' }) };
const MENTZER_D = draftOf(110, MENTZER.analyte['id'], { version_no: 1, unit_code: null, method_id: null, decimals: 1 });
const LDL = { analyte: ana(111, A, CBC.test.id as string, { code: 'LDL', name: 'LDL cholesterol' }) };
const LDL_D = draftOf(111, LDL.analyte['id'], { version_no: 1, unit_code: 'mg_dl', method_id: null, decimals: 0 });
const [TC, HDL, TG] = [leaf(121, 'TC'), leaf(122, 'HDL'), leaf(123, 'TG')];
const TXT = leaf(131, 'TXT', { version: { result_type: 'text', decimals: null, unit_code: null } });
const GRADE = leaf(132, 'GRADE', { version: { result_type: 'ordinal', decimals: null, unit_code: null, value_set_code: 'MY_ORD' } });
const OFF = leaf(133, 'OFF', { analyte: { is_active: false } });
const basic = () => world([MCV, TC, HDL, TG, TXT, GRADE, OFF], { analytes: [MENTZER.analyte, LDL.analyte], versions: [MENTZER_D, LDL_D] });

// ============================================================================================================ contract and wiring
describe('contract and wiring (#36)', () => {
  it('is a read-only POST: catalog.test.read, no idempotency, no If-Match / Idempotency-Key parameter; strict request without server-owned fields; strict result', () => {
    const op = opOf(OP);
    expect(op['x-permission']).toBe(READ); expect(op['x-idempotency']).toBe('none');
    expect(JSON.stringify(op.parameters ?? [])).not.toMatch(/IfMatch|IdempotencyKey/);
    expect(spec.components.schemas['FormulaValidateRequest'].additionalProperties).toBe(false);
    expect(spec.components.schemas['FormulaValidateRequest'].required).toEqual(['expression']);
    expect(spec.components.schemas['FormulaValidateResult'].additionalProperties).toBe(false);
  });

  it('validateFormula left probes/pending.json and is wired to a real handler (not the 503 stub)', { timeout: T }, async () => {
    const pending: string[] = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'probes', 'pending.json'), 'utf8'));
    expect(pending).not.toContain(OP);
    expect((manifest.handlers as any)[OP]).toBe(H[OP]);
    const x = await call(basic(), { expression: 'MCV / RBC' }).then(() => undefined, (r) => r);
    expect(x?.code).not.toBe('common.service_unavailable'); expect(x?.detail).not.toBe('not_implemented');
  });

  it('a context without tenantId / actor / tx fails closed with auth.unauthenticated', { timeout: T }, async () => {
    const x = await rejection(H[OP]!(req({ expression: 'MCV / RBC' }), { ports: { IdentityPort: makeIdentity([READ]) } }));
    expect(isLimsError(x, 'auth.unauthenticated')).toBe(true);
  });
});

// ============================================================================================================ AC-04.1 / 04.2 / 04.8: the happy path
describe('AC-04.1, AC-04.2, AC-04.8 — valid formulas', () => {
  it('AC-04.1 MENTZER = MCV / RBC with MCV 70.0, RBC 5.60 -> valid, inputAnalyteCodes ["MCV","RBC"], sample_result 12.5, no errors', { timeout: T }, async () => {
    const b = await validate(basic(), { analyte_id: MENTZER.analyte['id'], expression: 'MCV / RBC', sample_inputs: inputsText({ MCV: '70.0', RBC: '5.60' }) });
    expect(b.valid).toBe(true);
    expect(b.input_analyte_codes).toEqual(['MCV', 'RBC']);
    expect(Number(b.sample_result)).toBe(12.5);
    expect(b.errors).toEqual([]);
    expect(b.sample_not_computable_reason).toBeUndefined();
    expect(b.chain_depth).toBe(1);
  });

  it('AC-04.2 LDL (Friedewald) -> valid, inputs {TC, HDL, TG} in the shared parser\'s order of first appearance; dependency_order holds all three (leaves) and nothing else', { timeout: T }, async () => {
    // SPEC CONFLICT (notes): AC-04.2 prints ["TC","HDL","TG"] but TG is read first; the order is pinned to formulaRefs (TRD §7.1 "order of first appearance"), the set to {TC, HDL, TG}.
    const expr = 'if(TG >= 400, invalid("tg_over_400"), TC - HDL - TG / 5)';
    const lib = [...formulaRefs(parseFormula(expr).ast as never)];
    expect([...lib].sort()).toEqual(['HDL', 'TC', 'TG']);
    const b = await validate(basic(), { analyte_id: LDL.analyte['id'], expression: expr, sample_inputs: inputsText({ TC: '200', HDL: '50', TG: '150' }) });
    expect(b).toMatchObject({ valid: true, input_analyte_codes: lib, errors: [] });
    expect(Number(b.sample_result)).toBe(120);
    expect([...b.dependency_order.filter((c: string) => c !== 'LDL')].sort()).toEqual(['HDL', 'TC', 'TG']);
  });

  it('AC-04.8 response shape without analyte_id: dependency_order lists inputs before dependants (leaves first); the expression itself is not in it; chain_depth 1 for leaf-only inputs', { timeout: T }, async () => {
    const b = await validate(basic(), { expression: 'TC - HDL' });
    expect(b.valid).toBe(true);
    expect(b.input_analyte_codes).toEqual(['TC', 'HDL']);
    expect([...b.dependency_order].sort()).toEqual(['HDL', 'TC']);
    expect(b.chain_depth).toBe(1);
    expect(b.sample_result).toBeUndefined();                       // no sample_inputs -> nothing to compute
  });

  it('AC-04.8 dependency order over a real chain: HB <- N1 <- N2 <- N3 gives exactly [HB, N1, N2, N3] and chain_depth 4 for an expression reading N3', { timeout: T }, async () => {
    const n = chain(200, 3, { analyte: HB });
    const e = world(n.map((x, i) => (i === 0 ? fnode(201, 'C1', 'HB + 1', [HB]) : x)));
    const b = await validate(e, { expression: 'C3 * 2' });
    expect(b).toMatchObject({ valid: true, input_analyte_codes: ['C3'], chain_depth: 4 });
    expect(b.dependency_order).toEqual(['HB', 'C1', 'C2', 'C3']);
  });

  it('AC-04.8 with analyte_id the root may be listed, but only last', { timeout: T }, async () => {
    const e = world([MCV], { analytes: [MENTZER.analyte], versions: [MENTZER_D] });
    const b = await validate(e, { analyte_id: MENTZER.analyte['id'], expression: 'MCV / RBC' });
    const i = b.dependency_order.indexOf('MENTZER');
    if (i >= 0) expect(i).toBe(b.dependency_order.length - 1);
    expect(b.dependency_order.filter((c: string) => c !== 'MENTZER').sort()).toEqual(['MCV', 'RBC']);
  });

  it('sample_context drives @-variables: G10-style formula for a female sample', { timeout: T }, async () => {
    const e = world([leaf(140, 'AA')]);
    const b = await validate(e, { expression: 'if(@is_female == 1, AA * 0.9, AA)', sample_inputs: inputsText({ AA: '10' }), sample_context: { sex: 'female', age_days: 12000 } });
    expect(b.valid).toBe(true);
    expect(Number(b.sample_result)).toBe(9);
  });

  it('whitespace and newlines between tokens are fine and do not change the inputs', { timeout: T }, async () => {
    const b = await validate(basic(), { expression: '  TC\n-   HDL\t' });
    expect(b).toMatchObject({ valid: true, input_analyte_codes: ['TC', 'HDL'] });
  });
});

// ============================================================================================================ golden vectors G1–G10 (+ C5's additions) through the endpoint
describe('golden vectors (packages/fakes/contract-tests/formula.vectors.json) through the endpoint', () => {
  const vectors: any[] = JSON.parse(readFileSync(join(REPO_ROOT, 'packages/fakes/contract-tests/formula.vectors.json'), 'utf8')).vectors;
  const CODES = ['MCV', 'NEUT_ABS', 'LYMPH_ABS', 'PLT', 'WBC', 'NEUT_PCT', 'TC', 'HDL', 'TG', 'TP', 'ALB', 'A', 'RBC'];
  // RBC already exists in the base world; every other code gets a numeric leaf.
  const vworld = () => world(CODES.filter((c) => c !== 'RBC').map((c, i) => leaf(300 + i, c)));
  const ids = vectors.map((v) => v.id);

  it('the vector file still holds G1–G10', () => {
    for (let i = 1; i <= 10; i++) expect(ids).toContain(`G${i}`);
  });

  for (const v of vectors.filter((x) => x.id !== 'X6')) {          // X6 needs @age_years, which the request cannot carry
    it(`${v.id}: ${v.expression}`, { timeout: T }, async () => {
      const inputs = Object.fromEntries(Object.entries(v.inputs ?? {}).filter(([, x]) => x !== null)) as Record<string, string>;
      const body: Record<string, unknown> = { expression: v.expression, sample_inputs: inputsText(inputs) };
      if (v.ctx?.sex || v.ctx?.ageDays !== undefined) body['sample_context'] = { ...(v.ctx.sex ? { sex: v.ctx.sex } : {}), ...(v.ctx.ageDays !== undefined ? { age_days: v.ctx.ageDays } : {}) };
      const b = await validate(vworld(), body);
      expect(b.valid, text(b)).toBe(true);                         // every vector is a VALID formula, computable or not
      if (v.expected.ok) {
        expect(b.sample_result, `${v.id} sample_result`).toBeDefined();
        expect(Number(b.sample_result)).toBe(Number(v.expected.value));
        expect(b.sample_not_computable_reason).toBeUndefined();
      } else {
        expect(b.sample_result).toBeUndefined();
        expect(b.sample_not_computable_reason).toBe(v.expected.reason);
      }
    });
  }
});

// ============================================================================================================ invalid formulas: 200 valid:false (never 422 here)
describe('invalid formulas return 200 {valid:false, errors[]} — grammar (done_when), AC-04.4, AC-04.5, AC-04.6', () => {
  const invalid = async (e: Env7, body: Record<string, unknown>) => {
    const b = await validate(e, body);
    expect(b.valid, text(b)).toBe(false);
    expect(b.errors.length).toBeGreaterThanOrEqual(1);
    for (const x of b.errors) {
      expect(typeof x.path).toBe('string'); expect(typeof x.code).toBe('string'); expect(typeof x.message).toBe('string');
      expect(x.message.length).toBeGreaterThan(0);
    }
    expect(b.sample_result).toBeUndefined();
    return b;
  };

  it.each([
    ['dangling operator', 'MCV /'], ['two operands, no operator', 'MCV RBC'], ['unbalanced (', '(MCV / RBC'], ['unbalanced )', 'MCV / RBC)'], ['empty parentheses', '()'],
    ['foreign character', 'MCV $ RBC'], ['exponent notation is not part of the grammar', 'MCV * 1e3'], ['lowercase identifier is not an analyte code', 'mcv / rbc'],
    ['unknown function', 'frobnicate(MCV)'], ['wrong arity', 'if(MCV)'], ['comparison used as a number', '(MCV > 1) + 2'], ['C5 ternary is not in the grammar', 'MCV > 1 ? 2 : 3'],
    ['|| / && are not in the grammar', 'MCV > 1 && RBC > 1'], ['unknown context variable', '@height * 2'], ['unterminated string', 'if(MCV > 1, invalid("abc), 1)'],
    ['whitespace only', '   '], ['SQL-looking payload', "MCV'; DROP TABLE catalog.analytes;--"], ['markup payload', '<script>alert(1)</script>'],
    ['RTL override forgery', 'MCV ‮/ RBC'], ['non-ASCII look-alike code (Cyrillic М)', 'МCV / RBC'],
  ])('grammar error: %s -> valid:false with at least one error', { timeout: T }, async (_n, expr) => {
    const e = basic();
    const b = await invalid(e, { expression: expr });
    expect(b.errors[0].path).toMatch(/\/(formula_)?expression$/);
    expect(JSON.stringify(e.db.stmts.map((s) => s.text))).not.toMatch(/DROP TABLE/i);      // payload never reaches SQL text
  });

  it('a NUL byte in the expression is rejected (400) or reported as invalid — never accepted, never an unhandled exception', { timeout: T }, async () => {
    const r = await call(basic(), { expression: 'MCV\u0000 / RBC' }).then((x) => ({ ok: x }), (x) => ({ err: x }));
    if ('ok' in r) expect(r.ok.body.valid).toBe(false); else { expect(isLimsError(r.err)).toBe(true); expect(r.err.statusCode).toBe(400); }
  });

  it('AC-04.4 an unknown analyte code XYZ is named in the error', { timeout: T }, async () => {
    const b = await invalid(basic(), { expression: 'MCV / XYZ' });
    expect(b.errors.some((x: any) => x.message.includes('XYZ')), text(b)).toBe(true);
    expect(b.input_analyte_codes).toEqual(expect.arrayContaining(['MCV']));      // parsed refs are still reported
  });

  it('AC-04.4 / S-1 every unknown code is reported (not only the first)', { timeout: T }, async () => {
    const b = await invalid(basic(), { expression: 'QQ1 + QQ2 + MCV' });
    expect(text(b)).toContain('QQ1'); expect(text(b)).toContain('QQ2');
  });

  it('S-1 a code that exists only for tenant B is unknown for tenant A (same error as a made-up code)', { timeout: T }, async () => {
    const b = await invalid(basic(), { expression: 'MCV / ONLYB' });
    expect(b.errors.some((x: any) => x.message.includes('ONLYB'))).toBe(true);
  });

  it('an INACTIVE analyte is not "an active analyte code of the tenant" -> named as invalid', { timeout: T }, async () => {
    const b = await invalid(basic(), { expression: 'MCV + OFF' });
    expect(text(b)).toContain('OFF');
  });

  it('AC-04.5 the formula analyte must be numeric: a text analyte (analyte_id) -> valid:false', { timeout: T }, async () => {
    const b = await invalid(basic(), { analyte_id: TXT.analyte['id'], expression: 'MCV * 2' });
    expect(b.errors[0].path).toMatch(/\/(formula_)?expression$/);
  });

  it('AC-04.5 an input whose result type is not numeric (ordinal GRADE) used in arithmetic -> valid:false naming GRADE', { timeout: T }, async () => {
    const b = await invalid(basic(), { expression: 'GRADE * 2' });
    expect(text(b)).toContain('GRADE');
  });

  it('AC-04.5 ... and a text input likewise', { timeout: T }, async () => {
    expect(text(await invalid(basic(), { expression: 'TXT + MCV' }))).toContain('TXT');
  });

  it('AC-04.6 nesting deeper than 32 -> valid:false (depth limit), a modest nesting is fine', { timeout: T }, async () => {
    const nest = (n: number) => '('.repeat(n) + 'MCV' + ')'.repeat(n);
    await invalid(basic(), { expression: nest(40) });
    expect((await validate(basic(), { expression: nest(5) })).valid).toBe(true);
  });

  it('AC-04.6 more than 20 distinct analyte refs -> valid:false; exactly 20 is fine', { timeout: T }, async () => {
    const codes = Array.from({ length: 21 }, (_, i) => `Q${i + 1}`);
    const e = world(codes.map((c, i) => leaf(400 + i, c)));
    await invalid(e, { expression: codes.join(' + ') });
    expect((await validate(e, { expression: codes.slice(0, 20).join(' + ') })).valid).toBe(true);
  });

  it('AC-04.6 length: exactly 500 characters is accepted; 501 is rejected (400 at the schema, or 200 valid:false) — never accepted', { timeout: T }, async () => {
    const e = basic();
    // min(MCV,MCV,…,MCV) is wide, not deep (a long a+b+c chain would trip the depth-32 limit); padded with trailing spaces to the exact length
    const pad = (n: number) => { const core = 'min(' + 'MCV,'.repeat(123) + 'MCV)'; return core + ' '.repeat(n - core.length); };
    expect(pad(500)).toHaveLength(500); expect(pad(501)).toHaveLength(501);
    expect((await validate(e, { expression: pad(500) })).valid).toBe(true);
    const r = await call(e, { expression: pad(501) }).then((x) => ({ ok: x }), (x) => ({ err: x }));
    if ('ok' in r) expect(r.ok.body.valid).toBe(false); else { expect(r.err.statusCode).toBe(400); expect(errPaths(r.err)).toContain('/expression'); }
  });

  it('AB-17 / S-14: 10 000 nested parentheses never overflow the stack — a structured rejection, not a RangeError', { timeout: T }, async () => {
    const e = basic();
    const r = await call(e, { expression: '('.repeat(10_000) + 'MCV' + ')'.repeat(10_000) }).then((x) => ({ ok: x }), (x) => ({ err: x }));
    if ('ok' in r) { expect(r.ok.status).toBe(200); expect(r.ok.body.valid).toBe(false); } else { expect(isLimsError(r.err)).toBe(true); expect(r.err.statusCode).toBe(400); }
    expect(await e.db.run(() => 1)).toBe(1);
  });

  it('S-14 grammar fuzz: 150 random token soups -> always 200 with a boolean valid (or a 400), never an unexpected exception', { timeout: 60_000 }, async () => {
    let s = 12345; const rnd = (n: number) => (s = (s * 1103515245 + 12345) % 2147483648) % n;
    const ALPHABET = ['MCV', 'RBC', 'HB', 'XYZ', '1', '2.5', '.', '(', ')', ',', '+', '-', '*', '/', '^', '<', '>=', '==', '!=', ' ', 'if', 'min', 'max', 'round', 'invalid', '"x"', '"', 'and', 'or', '@age_days', '@is_female', '@', '$', 'é', '‮', '\u0000', '\n'];
    const e = basic();
    for (let i = 0; i < 150; i++) {
      const expr = Array.from({ length: 1 + rnd(24) }, () => ALPHABET[rnd(ALPHABET.length)]).join(rnd(2) ? ' ' : '');
      if (expr.length === 0) continue;
      const r = await call(e, { expression: expr }).then((x) => ({ ok: x }), (x) => ({ err: x }));
      if ('ok' in r) { expect(r.ok.status).toBe(200); expect(typeof r.ok.body.valid, expr).toBe('boolean'); expect(validatorFor('FormulaValidateResult')(r.ok.body), expr).toEqual([]); }
      else { expect(isLimsError(r.err), `${JSON.stringify(expr)} -> ${r.err?.message}`).toBe(true); expect(r.err.statusCode).toBe(400); }
    }
  });
});

// ============================================================================================================ AC-04.3 cycles, AC-04.7 chain depth
describe('AC-04.3 cycles and AC-04.7 chain depth through the endpoint', () => {
  const AA = fnode(150, 'A', 'B + 1', [leaf(151, 'B').analyte]);               // published A = B + 1, edge A -> B
  const BB = leaf(151, 'B');
  const cyc = (extra: { versions?: any[]; edges?: any[] } = {}) => world([AA, BB], extra);

  it('AC-04.3 published A = B + 1, validating B = A * 2 -> valid:false and the message carries the path "B -> A -> B" at /formula_expression', { timeout: T }, async () => {
    const e = cyc();
    const b = await validate(e, { analyte_id: BB.analyte['id'], expression: 'A * 2' });
    expect(b.valid).toBe(false);
    expect(b.errors[0].path).toMatch(/\/(formula_)?expression$/);
    expect(b.errors[0].message).toContain('B -> A -> B');
  });

  it('self-reference: HB = HB * 3 -> the cycle HB -> HB', { timeout: T }, async () => {
    const b = await validate(world([]), { analyte_id: HB.id, expression: 'HB * 3' });
    expect(b.valid).toBe(false);
    expect(b.errors[0].message).toContain('HB -> HB');
  });

  it('three-cycle A -> B -> C -> A is reported with all four codes', { timeout: T }, async () => {
    const C3 = leaf(162, 'C');
    const n1 = fnode(160, 'A', 'B + 1', [leaf(161, 'B').analyte]);
    const n2 = fnode(161, 'B', 'C + 1', [C3.analyte]);
    const b = await validate(world([n1, n2, C3]), { analyte_id: C3.analyte['id'], expression: 'A + 1' });
    expect(b.valid).toBe(false);
    expect(b.errors[0].message).toContain('C -> A -> B -> C');
  });

  it('a SCHEDULED (published, future effective_from) version counts for cycle detection', { timeout: T }, async () => {
    const sched = fnode(170, 'A', 'B + 1', [leaf(171, 'B').analyte], { version: { effective_from: new Date('2026-12-01T00:00:00.000Z') } });
    const b = await validate(world([sched, leaf(171, 'B')]), { analyte_id: ID(0x3000 + 171), expression: 'A * 2' });
    expect(b.valid).toBe(false);
    expect(b.errors[0].message).toContain('B -> A -> B');
  });

  it('a SUPERSEDED version\'s old edges are history: A used to read B, now reads HB -> B = A * 2 is NOT a cycle', { timeout: T }, async () => {
    const oldV = fnode(180, 'A', 'B + 1', [leaf(181, 'B').analyte], { version: { status: 'superseded', effective_to: new Date('2026-06-01T00:00:00.000Z') } });
    const cur = pubOf(182, oldV.analyte['id'], { version_no: 2, formula_expression: 'HB + 1', formula_inputs: ['HB'], decimals: 1, unit_code: 'u', method_id: null, effective_from: new Date('2026-06-01T00:00:00.000Z') });
    const curEdges = [{ tenant_id: A, analyte_version_id: cur['id'], analyte_id: oldV.analyte['id'], input_analyte_id: HB.id, created_by: ID(0xa1) }];
    const e = world([oldV, leaf(181, 'B')], { versions: [cur], edges: curEdges });
    const b = await validate(e, { analyte_id: ID(0x3000 + 181), expression: 'A * 2' });
    expect(b.valid, text(b)).toBe(true);
  });

  it('another analyte\'s unpublished DRAFT formula does not count (edges exist only for published / scheduled versions)', { timeout: T }, async () => {
    const draftB = draftOf(190, BB.analyte['id'], { version_no: 2, formula_expression: 'A * 2', formula_inputs: ['A'] });
    const e = cyc({ versions: [draftB] });
    // validating A's own candidate B + 1 is fine although B's open draft reads A
    const b = await validate(e, { analyte_id: AA.analyte['id'], expression: 'B + 1' });
    expect(b.valid, text(b)).toBe(true);
  });

  it('AC-04.7 chain depth 5 (the expression + 4 formula analytes) is valid and reports chain_depth 5; 6 is rejected "formula chain too deep"', { timeout: T }, async () => {
    const mk = (len: number) => world(chain(200, len, { analyte: HB }).map((x, i) => (i === 0 ? fnode(201, 'C1', 'HB + 1', [HB]) : x)));
    const ok = await validate(mk(4), { expression: 'C4 + 1' });
    expect(ok).toMatchObject({ valid: true, chain_depth: 5 });
    const deep = await validate(mk(5), { expression: 'C5 + 1' });
    expect(deep.valid).toBe(false);
    expect(deep.errors[0].message).toMatch(/formula chain too deep/i);
    expect(deep.errors[0].path).toMatch(/\/(formula_)?expression$/);
  });

  it('the same chain rule applies with analyte_id (the analyte replaces its own published edges)', { timeout: T }, async () => {
    const nodes = chain(200, 5, { analyte: HB }).map((x, i) => (i === 0 ? fnode(201, 'C1', 'HB + 1', [HB]) : x));
    const top = { analyte: ana(260, A, CBC.test.id as string, { code: 'TOP' }) };
    const e = world(nodes, { analytes: [top.analyte], versions: [draftOf(260, top.analyte['id'], { version_no: 1, unit_code: null, method_id: null, decimals: 1 })] });
    const b = await validate(e, { analyte_id: top.analyte['id'], expression: 'C5 + 1' });
    expect(b.valid).toBe(false);
    expect(b.errors[0].message).toMatch(/too deep/i);
  });
});

// ============================================================================================================ sample inputs, request validation, S-1, S-5
describe('sample inputs, request validation, tenant scope (S-1, S-5)', () => {
  it('a missing input is not computable with reason missing_input:<CODE> and valid stays true (G8 shape)', { timeout: T }, async () => {
    const b = await validate(basic(), { expression: 'TC - HDL', sample_inputs: inputsText({ TC: '200' }) });
    expect(b.valid).toBe(true); expect(b.sample_result).toBeUndefined(); expect(b.sample_not_computable_reason).toBe('missing_input:HDL');
  });

  it('prototype-named keys in sample_inputs supply nothing: {"__proto__":{"TC":"1"},"constructor":"5"} -> TC still missing, never 0', { timeout: T }, async () => {
    for (const text of ['{"__proto__":{"TC":"1"}}', '{"constructor":"5","toString":"6"}', '{"TC":null}']) {
      const b = await validate(basic(), { expression: 'TC + 1', sample_inputs: text });
      expect(b.sample_result, text).toBeUndefined();
      expect(b.sample_not_computable_reason, text).toBe('missing_input:TC');
    }
  });

  it.each([['not JSON', 'TC=1'], ['a JSON array', '[1,2]'], ['a JSON string', '"TC"'], ['JSON null', 'null'], ['a number', '5']])(
    'sample_inputs that is %s -> 400 at /sample_inputs; nothing written', { timeout: T }, async (_n, t) => {
      const e = basic(); const before = snap(e.db);
      expect(errPaths(await bad(e, { expression: 'TC + 1', sample_inputs: t }))).toContain('/sample_inputs');
      expect(snap(e.db)).toBe(before);
    });

  it('a non-decimal sample value ("abc", "1e3", "NaN") is either a 400 at /sample_inputs or treated as missing — never as a number, never as 0', { timeout: T }, async () => {
    for (const v of ['abc', '1e3', 'NaN', 'Infinity', '']) {
      const r = await call(basic(), { expression: 'TC + 1', sample_inputs: inputsText({ TC: v }) }).then((x) => ({ ok: x }), (x) => ({ err: x }));
      if ('ok' in r) { expect(r.ok.body.sample_result, v).toBeUndefined(); expect(r.ok.body.sample_not_computable_reason, v).toBeDefined(); }
      else { expect(r.err.statusCode, v).toBe(400); expect(errPaths(r.err)).toContain('/sample_inputs'); }
    }
  });

  it.each([
    ['no body', undefined, '/expression'], ['no expression', {}, '/expression'], ['empty expression', { expression: '' }, '/expression'], ['expression not a string', { expression: 5 }, '/expression'],
    ['unknown field', { expression: 'TC', status: 'x' }, ''], ['tenant_id smuggled', { expression: 'TC', tenant_id: '0190a000-0000-7000-8000-00000000bbbb' }, ''],
    ['analyte_id not a uuid', { expression: 'TC', analyte_id: 'x' }, '/analyte_id'], ['sex outside the enum', { expression: 'TC', sample_context: { sex: 'robot' } }, '/sample_context/sex'],
    ['age_days negative', { expression: 'TC', sample_context: { age_days: -1 } }, '/sample_context/age_days'], ['age_days beyond 73000', { expression: 'TC', sample_context: { age_days: 73001 } }, '/sample_context/age_days'],
    ['age_days fractional', { expression: 'TC', sample_context: { age_days: 1.5 } }, '/sample_context/age_days'], ['unknown sample_context field', { expression: 'TC', sample_context: { height: 1 } }, ''],
    ['sample_inputs over 4000 chars', { expression: 'TC', sample_inputs: JSON.stringify({ TC: '1'.repeat(4100) }) }, '/sample_inputs'],
  ])('request validation: %s -> 400', { timeout: T }, async (_n, body, path) => {
    const e = basic(); const before = snap(e.db);
    const x = await bad(e, body);
    if (path && x.code === 'common.validation_failed') expect(errPaths(x)).toContain(path);
    expect(snap(e.db)).toBe(before);
  });

  it('S-1: an analyte_id of tenant B, or one that does not exist -> 404 common.not_found (no existence oracle: same answer)', { timeout: T }, async () => {
    for (const id of [ID(0x3003), ID(0xdead)]) {                                                  // 0x3003 = HB_B of tenant B in the base world
      const x = await rejection(call(basic(), { analyte_id: id, expression: 'TC + 1' }));
      expect(isLimsError(x, 'common.not_found'), `got ${x?.code}`).toBe(true); expect(x.statusCode).toBe(404);
    }
  });

  it('read-only: no INSERT / UPDATE / DELETE, no event, no revision bump — also for invalid formulas and for cycle checks', { timeout: T }, async () => {
    const e = basic(); const before = snap(e.db);
    for (const body of [{ expression: 'TC - HDL', sample_inputs: inputsText({ TC: '5', HDL: '1' }) }, { expression: 'XYZ +' }, { analyte_id: MENTZER.analyte['id'], expression: 'MENTZER * 2' }]) await validate(e, body);
    expect(writes(e.db)).toEqual([]);
    expect(snap(e.db)).toBe(before);
    expect(e.db.events).toHaveLength(0);
  });

  it('every statement issued is scoped to the caller\'s tenant (RLS context) and uses bind parameters — no sample value or code is spliced into SQL', { timeout: T }, async () => {
    const e = basic();
    await validate(e, { expression: 'TC - HDL', sample_inputs: inputsText({ TC: '4242.4242', HDL: '9' }) });
    const sql = e.db.stmts.map((s) => s.text).join('\n');
    expect(sql).not.toContain('4242.4242');
    expect(e.db.stmts.every((s) => s.tenantId === A)).toBe(true);
  });

  it('20 parallel validations agree and none interferes with another', { timeout: T }, async () => {
    const e = basic();
    const out = await Promise.all(Array.from({ length: 20 }, (_, i) => validate(e, { expression: 'TC - HDL', sample_inputs: inputsText({ TC: String(100 + i), HDL: '40' }) })));
    out.forEach((b, i) => { expect(b.valid).toBe(true); expect(Number(b.sample_result)).toBe(60 + i); });
  });
});
