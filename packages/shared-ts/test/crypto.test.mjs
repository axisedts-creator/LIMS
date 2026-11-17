// T0A-08 / TRD §3.1 crypto; 04 A9–A13 token sizes (128-bit links/QR/reset, 256-bit device, OTP >= 6 digits); 08 R24 (sha256 bytea).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const DIR = new URL('../src/crypto/', import.meta.url);
const load = () => import(new URL('index.ts', DIR).href);
const B64U = /^[A-Za-z0-9_-]+$/;
const hex = (u8) => Buffer.from(u8).toString('hex');
const srcText = () => {
  const files = readdirSync(DIR).filter((f) => /\.(ts|js|mjs)$/.test(f));
  assert.ok(files.length > 0, 'src/crypto is empty');
  return files.map((f) => readFileSync(new URL(f, DIR), 'utf8')).join('\n');
};

describe('randomToken', () => {
  it('16 bytes -> 22 base64url chars decoding to exactly 16 bytes (128-bit)', async () => {
    const { randomToken } = await load();
    for (let i = 0; i < 200; i++) { const t = randomToken(16); assert.equal(t.length, 22); assert.match(t, B64U); assert.equal(Buffer.from(t, 'base64url').length, 16); }
  });
  it('32 bytes -> 43 base64url chars decoding to exactly 32 bytes (256-bit device token)', async () => {
    const { randomToken } = await load();
    for (let i = 0; i < 200; i++) { const t = randomToken(32); assert.equal(t.length, 43); assert.match(t, B64U); assert.equal(Buffer.from(t, 'base64url').length, 32); }
  });
  it('no padding, no "+" "/" ; round-trips through base64url', async () => {
    const { randomToken } = await load();
    for (const n of [16, 32]) for (let i = 0; i < 100; i++) { const t = randomToken(n); assert.ok(!/[=+/]/.test(t)); assert.equal(Buffer.from(t, 'base64url').toString('base64url'), t); }
  });
  it('rejects any size other than 16 or 32', async () => {
    const { randomToken } = await load();
    for (const bad of [0, 1, 8, 15, 17, 24, 31, 33, 64, -16, 16.5, NaN, Infinity, '16', null, undefined]) assert.throws(() => randomToken(bad), undefined, String(bad));
  });
  it('is random: 5,000 tokens all distinct; every byte position and bit take both values', async () => {
    const { randomToken } = await load();
    const seen = new Set(); const orMask = new Uint8Array(32); const andMask = new Uint8Array(32).fill(255);
    for (let i = 0; i < 5000; i++) { const t = randomToken(32); seen.add(t); const b = Buffer.from(t, 'base64url'); for (let j = 0; j < 32; j++) { orMask[j] |= b[j]; andMask[j] &= b[j]; } }
    assert.equal(seen.size, 5000);
    assert.ok(orMask.every((v) => v === 255)); assert.ok(andMask.every((v) => v === 0));
  });
  it('source uses no Math.random', () => {
    assert.ok(!/Math\.random/.test(srcText()));
  });
});

describe('sha256', () => {
  const ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
  const EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  it('known vectors, string and Uint8Array inputs agree', async () => {
    const { sha256Hex } = await load();
    assert.equal(sha256Hex('abc'), ABC); assert.equal(sha256Hex(''), EMPTY);
    assert.equal(sha256Hex(new TextEncoder().encode('abc')), ABC); assert.equal(sha256Hex(new Uint8Array(0)), EMPTY);
    assert.match(sha256Hex('x'), /^[0-9a-f]{64}$/);
  });
  it('strings are hashed as UTF-8', async () => {
    const { sha256Hex } = await load();
    for (const s of ['é', 'नेपाल', 'a\u0000b', '😀']) assert.equal(sha256Hex(s), createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex'));
  });
  it('sha256Bytes: Uint8Array of 32 bytes equal to the hex digest (bytea column)', async () => {
    const { sha256Bytes, sha256Hex } = await load();
    const b = sha256Bytes('abc');
    assert.ok(b instanceof Uint8Array); assert.equal(b.length, 32); assert.equal(hex(b), ABC);
    assert.equal(hex(sha256Bytes(new Uint8Array([1, 2, 3]))), sha256Hex(new Uint8Array([1, 2, 3])));
  });
  it('does not mutate its Uint8Array input; result is a fresh buffer each call', async () => {
    const { sha256Bytes } = await load();
    const input = new Uint8Array([9, 8, 7]); const a = sha256Bytes(input); const before = hex(a); a[0] ^= 0xff;
    assert.deepEqual([...input], [9, 8, 7]); assert.equal(hex(sha256Bytes(input)), before);
  });
});

describe('hmacSha256Hex (RFC 4231)', () => {
  it('test case 1', async () => {
    const { hmacSha256Hex } = await load();
    assert.equal(hmacSha256Hex(new Uint8Array(20).fill(0x0b), 'Hi There'), 'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7');
  });
  it('test case 2', async () => {
    const { hmacSha256Hex } = await load();
    assert.equal(hmacSha256Hex(new TextEncoder().encode('Jefe'), 'what do ya want for nothing?'), '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843');
  });
  it('test case 6 (key longer than block size)', async () => {
    const { hmacSha256Hex } = await load();
    assert.equal(hmacSha256Hex(new Uint8Array(131).fill(0xaa), 'Test Using Larger Than Block-Size Key - Hash Key First'), '60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54');
  });
  it('different key or input -> different mac', async () => {
    const { hmacSha256Hex } = await load();
    const k = new Uint8Array([1, 2, 3]);
    assert.notEqual(hmacSha256Hex(k, 'a'), hmacSha256Hex(k, 'b')); assert.notEqual(hmacSha256Hex(k, 'a'), hmacSha256Hex(new Uint8Array([1, 2, 4]), 'a'));
  });
});

describe('timingSafeEqualStr', () => {
  it('true for equal, false for different (same length, different length, prefix, empty vs non-empty)', async () => {
    const { timingSafeEqualStr: eq } = await load();
    assert.equal(eq('abc', 'abc'), true); assert.equal(eq('', ''), true); assert.equal(eq('नेपाल', 'नेपाल'), true);
    assert.equal(eq('abc', 'abd'), false); assert.equal(eq('abc', 'abcd'), false); assert.equal(eq('abcd', 'abc'), false); assert.equal(eq('', 'a'), false); assert.equal(eq('é', 'e'), false);
  });
  it('never throws on length mismatch / multi-byte length mismatch', async () => {
    const { timingSafeEqualStr: eq } = await load();
    assert.doesNotThrow(() => eq('a', 'é')); assert.equal(eq('a', 'é'), false);
    assert.doesNotThrow(() => eq('x'.repeat(10_000), 'y'));
  });
  it('src uses a constant-time primitive (timingSafeEqual)', () => {
    assert.match(srcText(), /timingSafeEqual/);
  });
});

describe('randomDigits (OTP, 04 A9)', () => {
  it('returns exactly n ASCII digits for n = 6..12', async () => {
    const { randomDigits } = await load();
    for (let n = 6; n <= 12; n++) for (let i = 0; i < 50; i++) { const d = randomDigits(n); assert.equal(typeof d, 'string'); assert.equal(d.length, n); assert.match(d, /^[0-9]+$/); }
  });
  it('rejects n < 6 and non-integers (OTP must be >= 6 digits)', async () => {
    const { randomDigits } = await load();
    for (const bad of [0, 1, 5, -6, 6.5, NaN, Infinity, '6', null, undefined]) assert.throws(() => randomDigits(bad), undefined, String(bad));
  });
  it('keeps leading zeros and is uniform-ish: all 10 digits appear in every position over 3,000 draws; ~10% start with 0', async () => {
    const { randomDigits } = await load();
    const pos = Array.from({ length: 6 }, () => new Set()); let lead0 = 0;
    for (let i = 0; i < 3000; i++) { const d = randomDigits(6); if (d[0] === '0') lead0++; for (let j = 0; j < 6; j++) pos[j].add(d[j]); }
    for (const s of pos) assert.equal(s.size, 10);
    assert.ok(lead0 > 200 && lead0 < 400, `leading-zero count ${lead0}`);
  });
});
