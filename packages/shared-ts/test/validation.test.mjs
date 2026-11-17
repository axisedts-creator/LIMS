// T0A-08 / TRD §3.1 validation (ajv strict, removeAdditional:false); CV §4.6/§4.7; REQ-SEC-080/095.
// Needs src/errors (LimsError) => depends on T0C-03 / @lims/contracts.
// ASSUMED: assertValid(schema, v, path?) prefixes `path` (a JSON pointer, e.g. '/body') to every fieldErrors[].path;
//   missing required property -> fieldErrors[].code 'common.field_required' (CV §4.6 example).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const load = () => import(new URL('../src/validation/index.ts', import.meta.url).href);
const loadErr = () => import(new URL('../src/errors/index.ts', import.meta.url).href);
const SCHEMA = { type: 'object', additionalProperties: false, required: ['name', 'qty'], properties: { name: { type: 'string', maxLength: 5 }, qty: { type: 'integer', minimum: 1, maximum: 10 }, kind: { enum: ['a', 'b'] } } };
const thrown = (fn) => { try { fn(); } catch (e) { return e; } return assert.fail('did not throw'); };

describe('compileSchema', () => {
  it('returns a predicate: true for valid, false for invalid', async () => {
    const { compileSchema } = await load(); const ok = compileSchema(SCHEMA);
    assert.equal(ok({ name: 'abc', qty: 2 }), true); assert.equal(ok({ name: 'abc' }), false); assert.equal(ok({ name: 'abcdef', qty: 2 }), false);
    assert.equal(ok({ name: 'a', qty: 11 }), false); assert.equal(ok({ name: 'a', qty: 1.5 }), false); assert.equal(ok({ name: 'a', qty: 1, kind: 'z' }), false);
    for (const v of [null, undefined, 'x', 3, [], true]) assert.equal(ok(v), false);
  });
  it('unknown properties are rejected (additionalProperties:false) and NOT stripped (removeAdditional:false)', async () => {
    const { compileSchema } = await load(); const ok = compileSchema(SCHEMA);
    const v = { name: 'a', qty: 1, tenant_id: 'x' };
    assert.equal(ok(v), false); assert.deepEqual(Object.keys(v), ['name', 'qty', 'tenant_id']);
  });
  it('removeAdditional:false even when the schema does not forbid extras: value is not mutated', async () => {
    const { compileSchema } = await load();
    const ok = compileSchema({ type: 'object', properties: { a: { type: 'integer' } } });
    const v = { a: 1, extra: 2 }; assert.equal(ok(v), true); assert.deepEqual(v, { a: 1, extra: 2 });
  });
  it('no type coercion or default injection', async () => {
    const { compileSchema } = await load();
    const ok = compileSchema({ type: 'object', properties: { n: { type: 'integer' }, d: { type: 'string', default: 'x' } } });
    const v = { n: '5' }; assert.equal(ok(v), false); assert.deepEqual(v, { n: '5' });
    const w = { n: 5 }; assert.equal(ok(w), true); assert.deepEqual(w, { n: 5 });
  });
  it('strict mode: unknown keyword / unknown format throw at compile time', async () => {
    const { compileSchema } = await load();
    assert.throws(() => compileSchema({ type: 'string', frobnicate: true }));
    assert.throws(() => compileSchema({ type: 'string', format: 'not-a-format' }));
  });
  it('__proto__ key from JSON.parse is rejected by additionalProperties:false', async () => {
    const { compileSchema } = await load(); const ok = compileSchema({ type: 'object', additionalProperties: false, properties: { a: { type: 'integer' } } });
    assert.equal(ok(JSON.parse('{"__proto__":{"admin":true},"a":1}')), false);
    assert.equal({}.admin, undefined);
  });
});

describe('assertValid', () => {
  it('returns the same value when valid', async () => {
    const { assertValid } = await load(); const v = { name: 'abc', qty: 2 };
    assert.equal(assertValid(SCHEMA, v), v);
  });
  it("throws LimsError('common.validation_failed') with fieldErrors {path (JSON pointer), code, message}", async () => {
    const { assertValid } = await load(); const { LimsError, isLimsError } = await loadErr();
    const e = thrown(() => assertValid(SCHEMA, { name: 'abcdefgh', qty: 99, extra: 1 }));
    assert.ok(e instanceof LimsError); assert.ok(isLimsError(e, 'common.validation_failed')); assert.equal(e.code, 'common.validation_failed');
    assert.ok(Array.isArray(e.fieldErrors) && e.fieldErrors.length >= 3);
    for (const f of e.fieldErrors) { assert.match(f.path, /^(\/[^/]*)*$/); assert.equal(typeof f.code, 'string'); assert.equal(typeof f.message, 'string'); }
    const paths = e.fieldErrors.map((f) => f.path);
    assert.ok(paths.includes('/name') && paths.includes('/qty'));
  });
  it('missing required property -> path /<prop>, code common.field_required', async () => {
    const { assertValid } = await load();
    const e = thrown(() => assertValid(SCHEMA, { name: 'a' }));
    assert.ok(e.fieldErrors.some((f) => f.path === '/qty' && f.code === 'common.field_required'), JSON.stringify(e.fieldErrors));
  });
  it('optional path argument prefixes every error path', async () => {
    const { assertValid } = await load();
    const e = thrown(() => assertValid(SCHEMA, { name: 'a' }, '/body'));
    assert.ok(e.fieldErrors.length > 0 && e.fieldErrors.every((f) => f.path.startsWith('/body')), JSON.stringify(e.fieldErrors));
  });
  it('JSON-pointer escaping for odd keys (~0 ~1)', async () => {
    const { assertValid } = await load();
    const S = { type: 'object', properties: { 'a/b': { type: 'object', properties: { 'c~d': { type: 'integer' } } } } };
    const e = thrown(() => assertValid(S, { 'a/b': { 'c~d': 'x' } }));
    assert.ok(e.fieldErrors.some((f) => f.path === '/a~1b/c~0d'), JSON.stringify(e.fieldErrors));
  });
  it('error output never echoes rejected input values (PHI-safe, REQ-SEC-095)', async () => {
    const { assertValid } = await load();
    const PLANT = 'SYNTHETIC-PHI-NAME-9801234567';
    const S = { type: 'object', additionalProperties: false, properties: { patient_name: { type: 'string', maxLength: 3 }, k: { enum: ['a'] } } };
    const e = thrown(() => assertValid(S, { patient_name: PLANT, k: PLANT }));
    const blob = JSON.stringify({ m: e.message, s: e.safeDetail, f: e.fieldErrors });
    assert.ok(!blob.includes(PLANT) && !blob.includes('9801234567'), blob);
  });
  it('bounded work: 1,000 violations give at most 1,000 fieldErrors', async () => {
    const { assertValid } = await load();
    const arr = Array.from({ length: 1000 }, () => 'x');
    const e = thrown(() => assertValid({ type: 'array', items: { type: 'integer' } }, arr));
    assert.ok(e.fieldErrors.length >= 1 && e.fieldErrors.length <= 1000);
  });
});
