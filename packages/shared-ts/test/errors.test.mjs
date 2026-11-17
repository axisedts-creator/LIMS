// T0A-08 / TRD §3.1 errors (needs T0C-03 generated codes + @lims/contracts); CV §4.6 problem+json; REQ-SEC-095.
// ASSUMED: toProblem returns { type:'urn:lims:error:'+code, title, status, code, detail?, instance, request_id, errors? }.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const load = () => import(new URL('../src/errors/index.ts', import.meta.url).href);
const RID = '01933b6f-0a11-7e2b-8c55-1d2e3f405162';
const INST = '/v1/lab/specimens/01933b6e-8f1a-7c3d-9a40-2f5e6b7c8d90/collect';

describe('re-exports + isLimsError', () => {
  it('LimsError(code, safeDetail?, fieldErrors?) is an Error carrying its fields', async () => {
    const { LimsError } = await load();
    const fe = [{ path: '/a', code: 'common.field_required', message: 'a is required' }];
    const e = new LimsError('common.validation_failed', 'bad', fe);
    assert.ok(e instanceof Error); assert.equal(e.code, 'common.validation_failed'); assert.equal(e.safeDetail, 'bad'); assert.deepEqual(e.fieldErrors, fe);
  });
  it('isLimsError narrows by class and optional code', async () => {
    const { LimsError, isLimsError } = await load();
    const e = new LimsError('common.not_found');
    assert.equal(isLimsError(e), true); assert.equal(isLimsError(e, 'common.not_found'), true); assert.equal(isLimsError(e, 'common.internal'), false);
    for (const x of [new Error('x'), { code: 'common.not_found' }, null, undefined, 'common.not_found', 404]) assert.equal(isLimsError(x), false);
  });
});

describe('ERROR_HTTP', () => {
  it('maps registered codes to HTTP statuses (CV §4.6/§4.7)', async () => {
    const { ERROR_HTTP } = await load();
    assert.equal(ERROR_HTTP['common.validation_failed'], 400); assert.equal(ERROR_HTTP['common.not_found'], 404);
    assert.equal(ERROR_HTTP['common.internal'], 500); assert.equal(ERROR_HTTP['common.rate_limited'], 429); assert.equal(ERROR_HTTP['common.version_conflict'], 409);
  });
  it('every entry is an integer 4xx/5xx', async () => {
    const { ERROR_HTTP } = await load();
    const es = Object.entries(ERROR_HTTP); assert.ok(es.length > 0);
    for (const [k, v] of es) assert.ok(Number.isInteger(v) && v >= 400 && v <= 599, `${k}=${v}`);
  });
});

describe('toProblem', () => {
  it('LimsError -> problem with urn type, status from ERROR_HTTP, code, instance, request_id', async () => {
    const { LimsError, toProblem, ERROR_HTTP } = await load();
    const p = toProblem(new LimsError('common.not_found'), INST, RID);
    assert.equal(p.type, 'urn:lims:error:common.not_found'); assert.equal(p.code, 'common.not_found'); assert.equal(p.status, ERROR_HTTP['common.not_found']);
    assert.equal(p.instance, INST); assert.equal(p.request_id, RID); assert.equal(typeof p.title, 'string'); assert.ok(p.title.length > 0);
    assert.equal(p.errors, undefined);
  });
  it('safeDetail becomes detail; fieldErrors become errors[] for validation failures (status 400)', async () => {
    const { LimsError, toProblem } = await load();
    const fe = [{ path: '/reason_code', code: 'common.field_required', message: 'reason_code is required' }];
    const p = toProblem(new LimsError('common.validation_failed', 'Request is invalid.', fe), INST, RID);
    assert.equal(p.status, 400); assert.equal(p.detail, 'Request is invalid.'); assert.deepEqual(p.errors, fe);
  });
  it('unknown Error -> 500 common.internal with request_id only: no message, stack, SQL, path leaks', async () => {
    const { toProblem } = await load();
    const e = new Error('relation "lab.specimen" does not exist at C:\\srv\\app\\db.ts:42 for 9801234567'); e.stack = 'Error: SECRETSTACK\n    at /srv/app/x.ts:1:1';
    const p = toProblem(e, INST, RID); const blob = JSON.stringify(p);
    assert.equal(p.status, 500); assert.equal(p.code, 'common.internal'); assert.equal(p.type, 'urn:lims:error:common.internal'); assert.equal(p.request_id, RID);
    for (const s of ['lab.specimen', 'srv', 'db.ts', '9801234567', 'SECRETSTACK']) assert.ok(!blob.includes(s), s);
    assert.equal(p.errors, undefined);
  });
  it('non-Error throwables (string, null, undefined, number, plain object) -> 500 common.internal', async () => {
    const { toProblem } = await load();
    for (const t of ['boom PLANT', null, undefined, 42, { message: 'PLANT', code: 'common.not_found' }]) {
      const p = toProblem(t, INST, RID); assert.equal(p.status, 500); assert.equal(p.code, 'common.internal'); assert.ok(!JSON.stringify(p).includes('PLANT'));
    }
  });
  it('is JSON-serialisable and has no stack key', async () => {
    const { LimsError, toProblem } = await load();
    const p = toProblem(new LimsError('common.rate_limited'), INST, RID);
    assert.deepEqual(JSON.parse(JSON.stringify(p)), p); assert.ok(!('stack' in p));
  });
});
