// CR TENANT-LOGO-1: the multipart layer (02-TRD §6.2 "JSON + multipart only"). Before it, the booted API answered 415 to EVERY upload
// before any handler ran (found on production: the first real logo upload). Two parts:
//   - parseMultipart: the strict parser, as a pure function;
//   - the REAL booted app (bootstrap + a fixture contract shaped like identity uploadBrandingAsset): an upload reaches its handler as
//     { kind: 'logo', file: { filename, mimeType, bytes } }, an upload route takes nothing but multipart, a JSON route never takes multipart.
// Synthetic bytes only.
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { bootstrap } from '../bootstrap.js';
import { boundaryOf, MULTIPART_BODY_LIMIT, parseMultipart } from '../uploads/multipart.js';
import { calls, cfg, FIXTURES } from './helpers.js';

const B = '----limsTESTboundary';
const CT = `multipart/form-data; boundary=${B}`;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 0x0d, 0x0a, 0x2d, 0x2d, 9]);   // holds CRLF and "--" inside the bytes
type Part = { name: string; value?: string; file?: { filename: string; type?: string; bytes: Buffer }; rawHead?: string };
const build = (parts: Part[], o: { boundary?: string; close?: boolean; preamble?: string } = {}): Buffer => {
  const b = o.boundary ?? B; const out: Buffer[] = [Buffer.from(o.preamble ?? '')];
  for (const p of parts) {
    const head = p.rawHead ?? (p.file
      ? `Content-Disposition: form-data; name="${p.name}"; filename="${p.file.filename}"\r\n${p.file.type === undefined ? '' : `Content-Type: ${p.file.type}\r\n`}`
      : `Content-Disposition: form-data; name="${p.name}"\r\n`);
    out.push(Buffer.from(`--${b}\r\n${head}\r\n`), p.file ? p.file.bytes : Buffer.from(p.value ?? ''), Buffer.from('\r\n'));
  }
  if (o.close !== false) out.push(Buffer.from(`--${b}--\r\n`));
  return Buffer.concat(out);
};
const logo = (over: Partial<Part['file']> = {}): Part => ({ name: 'file', file: { filename: 'logo.png', type: 'image/png', bytes: PNG, ...over } as any });
const kind: Part = { name: 'kind', value: 'logo' };
const code = (fn: () => unknown): string | undefined => { try { fn(); } catch (e: any) { return e?.code; } return undefined; };

describe('parseMultipart', () => {
  it('text field + file part: the field is a string, the file is { filename, mimeType, bytes } with the exact bytes (CRLF and "--" inside kept)', () => {
    const r = parseMultipart(CT, build([kind, logo()])) as any;
    expect(Object.keys(r).sort()).toEqual(['file', 'kind']); expect(r.kind).toBe('logo');
    expect(r.file.filename).toBe('logo.png'); expect(r.file.mimeType).toBe('image/png'); expect(Buffer.isBuffer(r.file.bytes)).toBe(true); expect(r.file.bytes.equals(PNG)).toBe(true);
  });
  it('part order does not matter; a quoted boundary and a preamble of white space are accepted; the type is lower-cased without parameters', () => {
    const r = parseMultipart(`multipart/form-data; charset=utf-8; boundary="${B}"`, build([logo({ type: 'IMAGE/PNG; charset=binary' }), kind], { preamble: '\r\n' })) as any;
    expect(r.kind).toBe('logo'); expect(r.file.mimeType).toBe('image/png');
  });
  it('a file part without a Content-Type is application/octet-stream (accept() then refuses it by type)', () => {
    expect((parseMultipart(CT, build([kind, logo({ type: undefined })])) as any).file.mimeType).toBe('application/octet-stream');
  });
  it('an empty file is a file with zero bytes (accept() refuses it); a UTF-8 file name is read as UTF-8', () => {
    const r = parseMultipart(CT, build([kind, logo({ bytes: Buffer.alloc(0), filename: 'लोगो.png' })])) as any;   // build() writes the header as UTF-8 bytes, as browsers do
    expect(r.file.bytes.length).toBe(0); expect(r.file.filename).toBe('लोगो.png');
  });
  it('the result has no prototype: a part named __proto__ or constructor cannot reach Object.prototype', () => {
    expect(code(() => parseMultipart(CT, build([{ name: '__proto__', value: 'x' }])))).toBeUndefined();
    expect(({} as any).x).toBeUndefined(); expect(Object.getPrototypeOf(parseMultipart(CT, build([kind])))).toBeNull();
  });
  it.each<[string, () => unknown]>([
    ['not multipart', () => parseMultipart('application/json', build([kind]))],
    ['no boundary parameter', () => parseMultipart('multipart/form-data', build([kind]))],
    ['a boundary longer than 70 characters', () => parseMultipart(`multipart/form-data; boundary=${'x'.repeat(71)}`, build([kind], { boundary: 'x'.repeat(71) }))],
    ['a body that is not bytes', () => parseMultipart(CT, 'kind=logo' as any)],
    ['the wrong boundary in the body', () => parseMultipart(CT, build([kind], { boundary: '----other' }))],
    ['text before the first delimiter', () => parseMultipart(CT, build([kind], { preamble: 'smuggled' }))],
    ['no closing delimiter (truncated upload)', () => parseMultipart(CT, build([kind, logo()], { close: false }).subarray(0, -6))],
    ['a part without a name', () => parseMultipart(CT, build([{ name: '', rawHead: 'Content-Disposition: form-data\r\n', value: 'x' }]))],
    ['a part that is not form-data', () => parseMultipart(CT, build([{ name: 'kind', rawHead: 'Content-Disposition: attachment; name="kind"\r\n', value: 'x' }]))],
    ['a name with a path or bracket', () => parseMultipart(CT, build([{ name: 'a[b]', value: 'x' }]))],
    ['the same name twice (which one would the handler see?)', () => parseMultipart(CT, build([kind, { name: 'kind', value: 'signature' }]))],
    ['two files under one name', () => parseMultipart(CT, build([logo(), logo()]))],
    ['a nested multipart part', () => parseMultipart(CT, build([{ name: 'file', file: { filename: 'a.png', type: 'multipart/mixed; boundary=x', bytes: PNG } }]))],
    ['a file name with a control character', () => parseMultipart(CT, build([logo({ filename: 'a\u0001.png' })]))],
    ['a file name over 255 characters', () => parseMultipart(CT, build([logo({ filename: `${'a'.repeat(252)}.png` })]))],
    ['a text field over 64 KiB', () => parseMultipart(CT, build([{ name: 'kind', value: 'x'.repeat(64 * 1024 + 1) }]))],
    ['a text field that is not UTF-8', () => parseMultipart(CT, build([{ name: 'kind', file: undefined, rawHead: 'Content-Disposition: form-data; name="kind"\r\n', value: undefined } as any].map((p) => p), {}).fill(0xff, B.length + 60, B.length + 62))],
    ['part headers over 4 KiB', () => parseMultipart(CT, build([{ name: 'kind', rawHead: `Content-Disposition: form-data; name="kind"\r\nX-Pad: ${'p'.repeat(5000)}\r\n`, value: 'x' }]))],
    ['a repeated header in one part', () => parseMultipart(CT, build([{ name: 'kind', rawHead: 'Content-Disposition: form-data; name="kind"\r\nContent-Disposition: form-data; name="file"\r\n', value: 'x' }]))],
    ['more than 20 parts', () => parseMultipart(CT, build(Array.from({ length: 21 }, (_, i) => ({ name: `f${i}`, value: 'x' }))))],
  ])('%s -> 400 common.validation_failed', (_n, fn) => { expect(code(fn)).toBe('common.validation_failed'); });
  it('boundaryOf reads plain and quoted boundaries and nothing else', () => {
    expect(boundaryOf(CT)).toBe(B); expect(boundaryOf(`Multipart/Form-Data; boundary="a b"`)).toBe('a b');
    for (const v of [undefined, 7, '', 'multipart/form-datax; boundary=a', 'multipart/mixed; boundary=a', 'multipart/form-data; boundary=']) expect(boundaryOf(v)).toBeUndefined();
  });
});

describe('the booted app (real bootstrap, fixture contract)', () => {
  const root = join(FIXTURES, 'upload1');
  const open: FastifyInstance[] = []; let app: FastifyInstance;
  beforeEach(async () => { calls().length = 0; app = await bootstrap({ config: cfg(), repoRoot: root, modulesDir: join(root, 'modules') }); open.push(app); }, 30000);
  afterEach(async () => { await Promise.all(open.splice(0).map((a) => a.close())); });
  const upload = (payload: Buffer | string, headers: Record<string, string> = { 'content-type': CT }) => app.inject({ method: 'POST', url: '/v1/catalog/files', headers, payload });

  it('an upload reaches its handler as { kind, file: { filename, mimeType, bytes } } (was: 415 before any handler)', async () => {
    const r = await upload(build([kind, logo()]));
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual({ kind: 'logo', file: { filename: 'logo.png', mimeType: 'image/png', isBuffer: true, size: PNG.length, first4: '89504e47' } });
    expect(calls()).toEqual(['uploadThing']);
  });
  it('the text field is validated by the spec: an unknown kind, a missing kind, a missing file and an extra field are 400, handler not called', async () => {
    for (const parts of [[{ name: 'kind', value: 'signature' }, logo()], [logo()], [kind], [kind, logo(), { name: 'tenant_id', value: 'other' }]]) {
      const r = await upload(build(parts as Part[]));
      expect(r.statusCode, JSON.stringify(parts.map((p: any) => p.name))).toBe(400); expect(r.json().code).toBe('common.validation_failed');
    }
    expect(calls()).toEqual([]);
  });
  it('a field typed by a shared $ref (as real upload forms have) is validated too: the app boots, a good id passes, a bad id is 400', async () => {
    const good = await upload(build([kind, logo(), { name: 'part_id', value: '0190a000-0000-7000-8000-00000000aaaa' }]));
    expect(good.statusCode, good.body).toBe(200); expect(good.json().part_id).toBe('0190a000-0000-7000-8000-00000000aaaa');
    const badId = await upload(build([kind, logo(), { name: 'part_id', value: 'not-a-uuid' }]));
    expect(badId.statusCode).toBe(400); expect(calls()).toEqual(['uploadThing']);
  });
  it('a text part where the file must be is refused (a string is not a file)', async () => {
    const r = await upload(build([kind, { name: 'file', value: 'not a file' }]));
    expect(r.statusCode).toBe(400); expect(calls()).toEqual([]);
  });
  it('a malformed body is 400 common.validation_failed with a problem body, handler not called', async () => {
    const r = await upload(build([kind, logo()], { close: false }).subarray(0, -6));
    expect(r.statusCode).toBe(400); expect(r.json().code).toBe('common.validation_failed'); expect(r.headers['content-type']).toMatch(/application\/problem\+json/); expect(calls()).toEqual([]);
  });
  it('an upload route takes nothing but multipart: JSON and form-urlencoded bodies are 415, handler not called', async () => {
    const j = await upload(JSON.stringify({ kind: 'logo', file: 'x' }), { 'content-type': 'application/json' });
    expect(j.statusCode, j.body).toBe(415); expect(j.json().code).toBe('common.unsupported_media_type');
    const f = await upload('kind=logo&file=x', { 'content-type': 'application/x-www-form-urlencoded' });
    expect(f.statusCode).toBe(415);
    expect(calls()).toEqual([]);
  });
  it('a JSON route never takes multipart (415 before the body is parsed), and still takes JSON', async () => {
    const m = await app.inject({ method: 'POST', url: '/v1/catalog/notes', headers: { 'content-type': CT }, payload: build([kind]) });
    expect(m.statusCode, m.body).toBe(415); expect(m.json().code).toBe('common.unsupported_media_type'); expect(calls()).toEqual([]);
    const j = await app.inject({ method: 'POST', url: '/v1/catalog/notes', payload: { kind: 'logo' } });
    expect(j.statusCode, j.body).toBe(200); expect(j.json()).toEqual({ kind: 'logo' });
  });
  it('a body over the limit is 413 common.payload_too_large, handler not called', async () => {
    const r = await upload(build([kind, logo({ bytes: Buffer.alloc(MULTIPART_BODY_LIMIT) })]));
    expect(r.statusCode).toBe(413); expect(r.json().code).toBe('common.payload_too_large'); expect(calls()).toEqual([]);
  });
  it('a 15 MiB file (the largest accept() takes) passes the layer', async () => {
    const r = await upload(build([kind, logo({ bytes: Buffer.alloc(15 * 1024 * 1024, 7) })]));
    expect(r.statusCode, r.body.slice(0, 200)).toBe(200); expect(r.json().file.size).toBe(15 * 1024 * 1024);
  });
});
