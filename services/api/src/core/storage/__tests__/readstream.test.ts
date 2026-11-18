// T0B-FILESTREAM-1 (LD-312) done_when 1, 4: storage adapter readStream / putStream. Same tenant, bucket and error rules as read / put (P-13, R26),
// but the object is never read whole into memory. Fails now: StorageAdapter has no readStream / putStream.
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { CREDENTIAL, TENANT_A, TENANT_B } from './helpers.js';
import { CHUNK, MiB, SLACK, bytesOf, expectedSha, makeStreamStorage, sink, source } from './stream.helpers.js';

const PATH = `${TENANT_A}/2026/11/0190a000-0000-7000-8000-000000000001-v1.pdf`;
const rejection = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { return e; } throw new Error('expected a rejection'); };
const all = async (body: unknown): Promise<Buffer> => { const parts: Buffer[] = []; for await (const c of body as AsyncIterable<Uint8Array>) parts.push(Buffer.from(c)); return Buffer.concat(parts); };

describe('storage.readStream', () => {
  it('returns a Node Readable with the whole-object size and the validators the provider gave; the object is never fetched whole', async () => {
    const { f, storage } = await makeStreamStorage();
    const lm = new Date('2026-11-16T10:00:00.000Z');
    f.seed('reports', PATH, { size: 3 * CHUNK + 5, etag: '"abc123"', lastModified: lm });
    const r = await storage.readStream('reports', PATH);
    expect(r.body).toBeInstanceOf(Readable);
    expect(r.byteSize).toBe(3 * CHUNK + 5); expect(r.etag).toBe('"abc123"'); expect(new Date(r.lastModified).toISOString()).toBe(lm.toISOString());
    expect(f.count('get'), 'raw.get (whole object) must not be used').toBe(0);
    expect(f.pulled.bytes, 'nothing is read before the consumer asks').toBeLessThanOrEqual(SLACK);
    const got = await sink(r.body);
    expect(got).toEqual({ size: 3 * CHUNK + 5, sha256: expectedSha(3 * CHUNK + 5) });
  });
  it('validators are omitted when the provider gives none', async () => {
    const { f, storage } = await makeStreamStorage();
    f.seed('reports', PATH, { size: 10 });
    const r = await storage.readStream('reports', PATH);
    expect(r.etag).toBeUndefined(); expect(r.lastModified).toBeUndefined();
    await sink(r.body);
  });
  it('a range is passed to the provider (inclusive) and only those bytes are fetched; byteSize stays the whole size', async () => {
    const { f, storage } = await makeStreamStorage();
    f.seed('reports', PATH, { size: 10 * CHUNK });
    const r = await storage.readStream('reports', PATH, { range: { start: 100, end: 199 } });
    expect(f.gets.at(-1)?.range).toEqual({ start: 100, end: 199 });
    expect(r.byteSize).toBe(10 * CHUNK);
    expect(r.range).toEqual({ start: 100, end: 199 });
    expect((await all(r.body)).equals(bytesOf(100, 100))).toBe(true);
    expect(f.pulled.bytes).toBeLessThanOrEqual(100 + SLACK);
  });
  it('tenant rule: another tenant path, traversal and a bad bucket never reach the raw service', async () => {
    const { f, storage } = await makeStreamStorage();
    for (const [b, p] of [['reports', `${TENANT_B}/2026/11/x.pdf`], ['reports', `${TENANT_A}/../${TENANT_B}/x.pdf`], ['reports', 'x.pdf'], ['nope', PATH]] as const)
      expect((await rejection(storage.readStream(b, p))).code, `${b} ${p}`).toBe('common.internal');
    expect(f.calls).toEqual([]);
  });
  it('P-13: reads may target another module\'s bucket (reads are not owner bound), like read()', async () => {
    const { f, storage } = await makeStreamStorage('reporting');
    f.seed('frontdesk-trf', PATH, { size: 20 });
    expect((await sink((await storage.readStream('frontdesk-trf', PATH)).body)).size).toBe(20);
  });
  it('a missing object is common.dependency_unavailable, the same answer as read(); no credential, URL or path in the error or the log', async () => {
    const { r, storage } = await makeStreamStorage();
    const e = await rejection(storage.readStream('reports', PATH));
    expect(e.code).toBe('common.dependency_unavailable');
    expect(JSON.stringify([e.message, r.lines, r.incs])).not.toMatch(new RegExp(`${CREDENTIAL}|https?:|token=|${TENANT_A}`));
  });
  it('a failure in the middle of the body surfaces as a stream error (no silent truncation) and the error text carries no credential', async () => {
    const { f, r, storage } = await makeStreamStorage();
    f.seed('reports', PATH, { size: 5 * CHUNK }); f.state.failAfter = 2 * CHUNK; f.state.failMessage = `reset ${CREDENTIAL} https://storage.invalid/x?token=t`;
    const res = await storage.readStream('reports', PATH);
    const e = await rejection(sink(res.body));
    expect(String(e?.message)).not.toMatch(new RegExp(`${CREDENTIAL}|https?:|token=`));
    expect(JSON.stringify(r.lines)).not.toContain(CREDENTIAL);
  });
  it('destroying the body stops the provider read (no 50 MB drained for a client that went away)', async () => {
    const { f, storage } = await makeStreamStorage();
    f.seed('reports', PATH, { size: 50 * MiB });
    const res = await storage.readStream('reports', PATH);
    for await (const _ of res.body as AsyncIterable<Uint8Array>) { break; }
    (res.body as Readable).destroy();
    await new Promise((r) => setTimeout(r, 20));
    expect(f.pulled.bytes).toBeLessThan(2 * MiB);
  });
});

describe('storage.putStream', () => {
  const OPEN = { contentType: 'application/pdf', ifAbsent: true };
  const P = `${TENANT_A}/2026/11/up.pdf`;
  it('streams the source to the provider; sha256 and byteSize are computed on the way and equal those of put() for the same bytes', async () => {
    const { f, storage } = await makeStreamStorage('frontdesk');
    const body = Buffer.concat([Buffer.from('%PDF-1.7\n'), bytesOf(0, 3 * CHUNK + 11)]);
    const res = await storage.putStream('frontdesk-trf', P, Readable.from([body.subarray(0, 70000), body.subarray(70000)], { objectMode: false }), OPEN);
    expect(res).toEqual({ sha256: createHash('sha256').update(body).digest('hex'), byteSize: body.length });
    expect(f.count('putStream')).toBe(1);
    expect(f.stored('frontdesk-trf', P)).toMatchObject({ size: body.length, contentType: 'application/pdf' });
    const again = await storage.put('frontdesk-trf', `${TENANT_A}/2026/11/up2.pdf`, body, OPEN);
    expect(again).toEqual(res);
  });
  it('accepts a web ReadableStream and an async iterable too', async () => {
    const { storage } = await makeStreamStorage('frontdesk');
    const a = await storage.putStream('frontdesk-trf', P, Readable.toWeb(source(CHUNK + 1)), OPEN);
    const b = await storage.putStream('frontdesk-trf', `${TENANT_A}/2026/11/up2.pdf`, (async function* () { yield bytesOf(0, CHUNK + 1); })(), OPEN);
    expect(a).toEqual(b);
  });
  it('maxBytes is enforced while streaming: 413 common.payload_too_large, at most maxBytes + slack pulled, nothing stored', async () => {
    const { f, storage } = await makeStreamStorage('frontdesk'); const pulled = { bytes: 0, chunks: 0 };
    const e = await rejection(storage.putStream('frontdesk-trf', P, source(50 * MiB, { pulled }), { ...OPEN, maxBytes: 2 * MiB }));
    expect(e.code).toBe('common.payload_too_large'); expect(e.statusCode).toBe(413);
    expect(pulled.bytes).toBeLessThanOrEqual(2 * MiB + SLACK);
    expect(f.has('frontdesk-trf', P), 'an over-limit upload leaves no object').toBe(false);
  });
  it('a source that fails in the middle stores nothing and does not leak the source error text', async () => {
    const { f, storage } = await makeStreamStorage('frontdesk');
    const e = await rejection(storage.putStream('frontdesk-trf', P, source(5 * CHUNK, { failAfter: 2 * CHUNK, failMessage: `reset ${CREDENTIAL}` }), OPEN));
    expect(String(e?.message)).not.toContain(CREDENTIAL);
    expect(f.has('frontdesk-trf', P)).toBe(false);
  });
  it('write rules as put(): only the module\'s own bucket, tenant path, create only; checked before the source is read', async () => {
    const { f, storage } = await makeStreamStorage('frontdesk'); const pulled = { bytes: 0, chunks: 0 };
    for (const [b, p] of [['reports', P], ['frontdesk-trf', `${TENANT_B}/2026/11/x.pdf`], ['frontdesk-trf', 'x.pdf']] as const)
      expect((await rejection(storage.putStream(b, p, source(CHUNK, { pulled }), OPEN))).code).toBe('common.internal');
    expect(pulled.bytes, 'source untouched').toBe(0); expect(f.calls).toEqual([]);
    await storage.putStream('frontdesk-trf', P, source(10), OPEN);
    expect((await rejection(storage.putStream('frontdesk-trf', P, source(10), OPEN))).code, 'ifAbsent: second create fails').toBe('common.dependency_unavailable');
  });
  it('a body that is not a stream, bytes or iterable is common.internal', async () => {
    const { storage } = await makeStreamStorage('frontdesk');
    expect((await rejection(storage.putStream('frontdesk-trf', P, 42 as any, OPEN))).code).toBe('common.internal');
    expect((await rejection(storage.putStream('frontdesk-trf', P, source(3), { contentType: 5 as any }))).code).toBe('common.internal');
  });
});
