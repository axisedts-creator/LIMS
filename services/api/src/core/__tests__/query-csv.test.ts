// T0D-FIX-1 item 1 (LD-446, CR DEPLOY-AXIS-012 item 2): array query parameters declared `style: form, explode: false` are split at commas
// ONCE in core/openapi.ts, before validation. Three forms must reach the handler as the same array: comma, repeated, single.
// enum / maxLength / minimum apply per element; parameters with the default explode are never split (a comma is data there).
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { bootstrap } from '../bootstrap.js';
import { calls, cfg, FIXTURES } from './helpers.js';

const root = join(FIXTURES, 'csvq');
const open: FastifyInstance[] = [];
let app: FastifyInstance;

beforeEach(async () => {
  calls().length = 0;
  app = await bootstrap({ config: cfg(), repoRoot: root, modulesDir: join(root, 'modules') });
  open.push(app);
}, 30000);
afterEach(async () => { await Promise.all(open.splice(0).map((a) => a.close())); });

const get = (qs: string) => app.inject({ method: 'GET', url: `/v1/catalog/things${qs}` });
const seen = async (qs: string) => { const r = await get(qs); expect(r.statusCode, `${qs} -> ${r.body}`).toBe(200); return r.json().query; };

describe('explode:false array parameters: comma, repeated and single forms (item 1)', () => {
  it('comma form: status=a,b,c reaches the handler as [a, b, c]', async () => {
    expect((await seen('?status=pending_enrolment,active,revoked')).status).toEqual(['pending_enrolment', 'active', 'revoked']);
  });
  it('repeated form still arrives as an array', async () => {
    expect((await seen('?status=active&status=revoked')).status).toEqual(['active', 'revoked']);
  });
  it('single value still arrives as a one element array', async () => {
    expect((await seen('?status=active')).status).toEqual(['active']);
  });
  it('the other filters of the request are untouched (limit default and coercion)', async () => {
    const q = await seen('?status=active,revoked&limit=7');
    expect(q.limit).toBe(7);
    expect((await seen('?status=active')).limit).toBe(50);
  });
  it('comma and repeated forms mixed in one request: every element is kept', async () => {
    expect((await seen('?status=active,revoked&status=pending_enrolment')).status).toEqual(['active', 'revoked', 'pending_enrolment']);
  });
  it('item type coercion runs per element: n=1,2,3 is [1, 2, 3]', async () => {
    expect((await seen('?n=1,2,3')).n).toEqual([1, 2, 3]);
  });
});

describe('validation applies per element, after the split (item 1)', () => {
  it('enum per element: an unknown element -> 400 and the handler is not called', async () => {
    expect((await get('?status=active,bogus')).statusCode).toBe(400);
    expect(calls()).toEqual([]);
  });
  it('maxLength per element: two 5 char elements pass although the raw value is 11 chars; a 6 char element -> 400', async () => {
    expect((await seen('?code=abcde,fghij')).code).toEqual(['abcde', 'fghij']);
    expect((await get('?code=abcde,abcdef')).statusCode).toBe(400);
  });
  it('maxItems applies to the split array: 4 elements -> 400', async () => {
    expect((await get('?status=active,active,active,active')).statusCode).toBe(400);
    expect(calls()).toEqual([]);
  });
  it('an empty element is invalid (400, never a 500, never silently dropped): status=active, and status=', async () => {
    for (const qs of ['?status=active,', '?status=,active', '?status=active,,revoked', '?status=']) {
      expect((await get(qs)).statusCode, qs).toBe(400);
    }
    expect(calls()).toEqual([]);
  });
  it('a bad element in the integer list -> 400', async () => {
    expect((await get('?n=1,x')).statusCode).toBe(400);
    expect((await get('?n=1,10')).statusCode).toBe(400);
  });
  it('strict query still holds: an unknown parameter -> 400 even next to a valid comma list', async () => {
    expect((await get('?status=active,revoked&foo=1')).statusCode).toBe(400);
  });
});

describe('only explode:false parameters are split (item 1, security note: parsing changes for every module)', () => {
  it('a parameter with the default explode keeps a comma as data: tag=a,b is ["a,b"]', async () => {
    expect((await seen('?tag=a,b')).tag).toEqual(['a,b']);
  });
  it('and its repeated form is untouched', async () => {
    expect((await seen('?tag=a&tag=b')).tag).toEqual(['a', 'b']);
  });
  it('a request without the list parameters gets no invented ones', async () => {
    const q = await seen('');
    expect(q.status).toBeUndefined();
    expect(q.code).toBeUndefined();
  });
  it('a long comma list cannot slip past maxItems by size alone: 200 elements -> 400, quickly', async () => {
    const t0 = Date.now();
    expect((await get(`?status=${Array(200).fill('active').join(',')}`)).statusCode).toBe(400);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});
