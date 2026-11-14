// C7 API-T08 — canonical JSON + Ed25519 config signing (02-TRD §5.10, D-06; 07-SECURITY REQ-SEC-119/128; AC-15.1 server half).
// Expected API of ../../service/signing.ts (names are SEAM, the writer must match):
//   canonicalJson(value: unknown): string
//       UTF-8-ready canonical text: object keys sorted by Unicode CODE POINT (not UTF-16 unit), no whitespace, strings escaped minimally:
//       only `"` -> \", `\` -> \\ and every control char U+0000..U+001F as \u00xx (lower-case hex, NO \n \t shorthand); everything else raw
//       (so `/ < > & U+007F` and all non-ASCII stay literal). Numbers: safe integers only (-0 -> 0). null/true/false/arrays (order kept)/{} ok.
//       Throws (fail closed) on: fractional, NaN, ±Infinity, unsafe integers, undefined (also as a property value), bigint, function, symbol,
//       Date and other non-plain objects, lone surrogates in strings/keys, circular references. Own key "__proto__" is a normal key.
//   canonicalSha256(document: unknown): string                  hex SHA-256 of the UTF-8 canonical bytes (agent_config_versions.canonical_sha256)
//   loadSigningKey(file: string): KeyObject                       reads a PKCS#8 PEM Ed25519 PRIVATE key (LIMS_INSTRUMENTS_CONFIG_SIGNING_KEY_FILE);
//                                                                 throws on missing/garbage/non-Ed25519/public-only key; message never contains key material
//   signConfigDocument(document, { privateKey: KeyObject | string(PKCS#8 PEM), keyId: string(1..32) }):
//       { alg: 'Ed25519', key_id, signature: base64url (unpadded) Ed25519 over canonicalJson(document) UTF-8 bytes, document }
//       `document` is returned as given (not mutated, not re-ordered); key_id is NOT part of the signed bytes; throws for a non-Ed25519 or public key.
// Shared golden vector: ../fixtures/config/* (byte-identical copy lives in apps/bridge-agent/testdata/config, CI c7-fixture-copy-check).
import { createHash, createPublicKey, generateKeyPairSync, verify, type KeyObject } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { canonicalJson, canonicalSha256, loadSigningKey, signConfigDocument } from '../../service/signing.js';

const FIX = fileURLToPath(new URL('../fixtures/config/', import.meta.url));
const GO_FIX = fileURLToPath(new URL('../../../../../../../apps/bridge-agent/testdata/config/', import.meta.url));
const fx = (n: string): Buffer => readFileSync(join(FIX, n));
const txt = (n: string): string => fx(n).toString('utf8').trim();
const vector = (): unknown => JSON.parse(fx('canonical.vector.json').toString('utf8'));
const expectedBytes = (): Buffer => fx('canonical.expected.bin');
const utf8 = (s: string): Buffer => Buffer.from(s, 'utf8');
const pubKey = (): KeyObject => createPublicKey(fx('test-key.spki.pem'));
const verifies = (sig: string, bytes: Buffer, key: KeyObject = pubKey()): boolean =>
  verify(null, bytes, key, Buffer.from(sig, 'base64url'));

const tmps: string[] = [];
afterAll(() => { for (const t of tmps) rmSync(t, { recursive: true, force: true }); });
function tmpFile(name: string, body: string | Buffer): string {
  const d = mkdtempSync(join(tmpdir(), 'lims-c7-t08-'));
  tmps.push(d);
  const p = join(d, name);
  writeFileSync(p, body);
  return p;
}

describe('golden vector (TS half of "TS and Go produce identical bytes/signature")', () => {
  it('fixture files exist', () => {
    for (const n of ['canonical.vector.json', 'canonical.expected.bin', 'canonical.sha256.txt', 'signature.b64url.txt', 'test-key.pkcs8.pem', 'test-key.spki.pem']) {
      expect(existsSync(join(FIX, n)), n).toBe(true);
    }
  });
  it('canonical bytes equal the expected bytes exactly', () => {
    const got = utf8(canonicalJson(vector()));
    expect(got.equals(expectedBytes())).toBe(true);
  });
  it('canonicalSha256 equals the vector hash', () => {
    expect(canonicalSha256(vector())).toBe(txt('canonical.sha256.txt'));
    expect(createHash('sha256').update(expectedBytes()).digest('hex')).toBe(txt('canonical.sha256.txt'));
  });
  it('signing with the test key reproduces the expected signature byte for byte (Ed25519 is deterministic)', () => {
    const env = signConfigDocument(vector() as object, { privateKey: loadSigningKey(join(FIX, 'test-key.pkcs8.pem')), keyId: 'cfg-test-1' });
    expect(env.signature).toBe(txt('signature.b64url.txt'));
  });
  it('expected signature verifies over the expected bytes with the test public key; flipped bit does not', () => {
    expect(verifies(txt('signature.b64url.txt'), expectedBytes())).toBe(true);
    const bad = Buffer.from(expectedBytes());
    bad[10] ^= 1;
    expect(verifies(txt('signature.b64url.txt'), bad)).toBe(false);
  });
  it('canonicalisation is idempotent on the vector', () => {
    const once = canonicalJson(vector());
    expect(canonicalJson(JSON.parse(once))).toBe(once);
  });
  it('Go copy of the fixtures, when present, is byte-identical (AG-T11 owns creating it)', () => {
    if (!existsSync(GO_FIX)) return; // Go side lands in AG-T11; CI job c7-fixture-copy-check makes its absence fatal
    const names = readdirSync(FIX).sort();
    expect(readdirSync(GO_FIX).sort()).toEqual(names);
    for (const n of names) expect(readFileSync(join(GO_FIX, n)).equals(fx(n)), n).toBe(true);
  });
});

describe('canonicalJson rules', () => {
  it('sorts keys at every depth, no whitespace', () => {
    expect(canonicalJson({ b: { d: 1, c: [2, { z: 1, a: 2 }] }, a: null })).toBe('{"a":null,"b":{"c":[2,{"a":2,"z":1}],"d":1}}');
  });
  it('sorts by code point, not UTF-16 unit (U+FF5A before U+1F600)', () => {
    expect(canonicalJson({ '\u{1F600}': 1, 'ｚ': 2, é: 3, z: 4 })).toBe('{"z":4,"é":3,"ｚ":2,"😀":1}');
  });
  it('sorts keys as strings: "" < "10" < "2" < "B" < "a"', () => {
    expect(canonicalJson({ a: 1, B: 2, 2: 3, 10: 4, '': 5 })).toBe('{"":5,"10":4,"2":3,"B":2,"a":1}');
  });
  it('keeps array order', () => {
    expect(canonicalJson([3, 1, 2, [9, 8]])).toBe('[3,1,2,[9,8]]');
  });
  it('scalars and empties', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(true)).toBe('true');
    expect(canonicalJson(false)).toBe('false');
    expect(canonicalJson({})).toBe('{}');
    expect(canonicalJson([])).toBe('[]');
    expect(canonicalJson('')).toBe('""');
    expect(canonicalJson({ a: null })).toBe('{"a":null}');
  });
  it('integers: 0, negatives, max safe, -0 -> 0', () => {
    expect(canonicalJson([0, -5, 9007199254740991, -9007199254740991, -0])).toBe('[0,-5,9007199254740991,-9007199254740991,0]');
  });
  it('escapes only quote, backslash and C0 controls (\\u00xx lower-case, no shorthand)', () => {
    expect(canonicalJson('a"b\\c')).toBe('"a\\"b\\\\c"');
    expect(canonicalJson('\n\t\r\b\f')).toBe('"\\u000a\\u0009\\u000d\\u0008\\u000c"');
    expect(canonicalJson('\u0000\u0001\u001f')).toBe('"\\u0000\\u0001\\u001f"');
  });
  it('leaves / < > & DEL U+2028 and non-ASCII literal (not HTML- or ASCII-escaped)', () => {
    expect(canonicalJson('/<>&\u007f µ→😀')).toBe('"/<>&\u007f µ→😀"');
  });
  it('escapes keys the same way as values', () => {
    expect(canonicalJson({ 'a"\n': 1 })).toBe('{"a\\"\\u000a":1}');
  });
  it('output is valid JSON that parses back to the same value', () => {
    const v = { s: 'q"\\\n\u0001😀', n: [0, -3, 7], o: { x: null, y: [true, false] } };
    expect(JSON.parse(canonicalJson(v))).toEqual(v);
  });
  it('own "__proto__" key is serialised, not dropped', () => {
    const o = JSON.parse('{"__proto__":{"x":1},"a":2}');
    expect(canonicalJson(o)).toBe('{"__proto__":{"x":1},"a":2}');
  });
  it('key insertion order does not change output', () => {
    expect(canonicalJson({ a: 1, b: 2, c: { x: 1, y: 2 } })).toBe(canonicalJson({ c: { y: 2, x: 1 }, b: 2, a: 1 }));
  });
  it('does not mutate its input', () => {
    const v = { b: [1, { z: 1, a: 2 }], a: 'x' };
    const before = JSON.stringify(v);
    canonicalJson(v);
    expect(JSON.stringify(v)).toBe(before);
  });
});

describe('canonicalJson fails closed on values it cannot represent exactly', () => {
  const circ: Record<string, unknown> = { a: 1 };
  circ.self = circ;
  const cases: [string, unknown][] = [
    ['fractional', 1.5],
    ['fractional in nested doc', { a: [{ b: 0.1 }] }],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['unsafe integer 2^53', 2 ** 53],
    ['1e21', 1e21],
    ['undefined', undefined],
    ['undefined property', { a: undefined }],
    ['undefined array item', [1, undefined]],
    ['bigint', 10n],
    ['function', () => 1],
    ['symbol', Symbol('x')],
    ['Date', new Date(0)],
    ['Map', new Map([['a', 1]])],
    ['lone high surrogate in value', '\uD83D'],
    ['lone low surrogate in key', { '\uDE00': 1 }],
    ['circular reference', circ],
  ];
  for (const [name, v] of cases) {
    it(`throws: ${name}`, () => {
      expect(() => canonicalJson(v)).toThrow();
    });
  }
});

describe('canonicalJson fuzz against an independent reference', () => {
  const ALPHABET = ['a', 'Z', '0', '"', '\\', '\n', '\u0001', '\u007f', '/', '<', 'é', 'ｚ', '\u{1F600}', ' '];
  let seed = 0x2f6e2b1;
  const rnd = (n: number): number => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  const str = (): string => Array.from({ length: rnd(6) }, () => ALPHABET[rnd(ALPHABET.length)]).join('');
  const gen = (d: number): unknown => {
    const k = rnd(d > 3 ? 4 : 6);
    if (k === 0) return null;
    if (k === 1) return rnd(2) === 0;
    if (k === 2) return rnd(200001) - 100000;
    if (k === 3) return str();
    if (k === 4) return Array.from({ length: rnd(4) }, () => gen(d + 1));
    const o: Record<string, unknown> = {};
    for (let i = rnd(5); i > 0; i--) o[str()] = gen(d + 1);
    return o;
  };
  const cps = (s: string): number[] => Array.from(s, (c) => c.codePointAt(0)!);
  const cmp = (a: string, b: string): number => {
    const A = cps(a), B = cps(b);
    for (let i = 0; i < Math.min(A.length, B.length); i++) if (A[i] !== B[i]) return A[i]! - B[i]!;
    return A.length - B.length;
  };
  const esc = (s: string): string =>
    '"' + Array.from(s, (c) => (c === '"' ? '\\"' : c === '\\' ? '\\\\' : c.charCodeAt(0) < 0x20 ? '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0') : c)).join('') + '"';
  const ref = (v: unknown): string =>
    v === null ? 'null'
    : typeof v === 'boolean' || typeof v === 'number' ? String(v === 0 ? 0 : v)
    : typeof v === 'string' ? esc(v)
    : Array.isArray(v) ? '[' + v.map(ref).join(',') + ']'
    : '{' + Object.keys(v as object).sort(cmp).map((k) => esc(k) + ':' + ref((v as Record<string, unknown>)[k])).join(',') + '}';
  it('300 random documents match the reference and round-trip', () => {
    for (let i = 0; i < 300; i++) {
      const v = gen(0);
      const c = canonicalJson(v);
      expect(c).toBe(ref(v));
      expect(canonicalJson(JSON.parse(c))).toBe(c);
    }
  });
});

describe('signConfigDocument envelope', () => {
  const key = (): KeyObject => loadSigningKey(join(FIX, 'test-key.pkcs8.pem'));
  it('returns { alg, key_id, signature, document } with an unpadded base64url 64-byte signature', () => {
    const doc = vector() as object;
    const env = signConfigDocument(doc, { privateKey: key(), keyId: 'cfg-2026-11' });
    expect(env.alg).toBe('Ed25519');
    expect(env.key_id).toBe('cfg-2026-11');
    expect(env.signature).toMatch(/^[A-Za-z0-9_-]{86}$/);
    expect(env.document).toEqual(doc);
    expect(Object.keys(env).sort()).toEqual(['alg', 'document', 'key_id', 'signature']);
  });
  it('signature verifies over canonical bytes of the returned document with the public key', () => {
    const env = signConfigDocument({ z: 1, a: [1, 2] }, { privateKey: key(), keyId: 'k' });
    expect(verifies(env.signature, utf8('{"a":[1,2],"z":1}'))).toBe(true);
  });
  it('tampering with the document after signing breaks verification (agent_id swap, version bump)', () => {
    const doc = { agent_id: 'A', config_version: 7 };
    const env = signConfigDocument(doc, { privateKey: key(), keyId: 'k' });
    expect(verifies(env.signature, utf8(canonicalJson({ ...doc, agent_id: 'B' })))).toBe(false);
    expect(verifies(env.signature, utf8(canonicalJson({ ...doc, config_version: 8 })))).toBe(false);
  });
  it('same signature regardless of key order or key_id (only the document is signed)', () => {
    const a = signConfigDocument({ a: 1, b: 2 }, { privateKey: key(), keyId: 'one' });
    const b = signConfigDocument({ b: 2, a: 1 }, { privateKey: key(), keyId: 'two' });
    expect(a.signature).toBe(b.signature);
  });
  it('different documents give different signatures', () => {
    const a = signConfigDocument({ v: 1 }, { privateKey: key(), keyId: 'k' });
    const b = signConfigDocument({ v: 2 }, { privateKey: key(), keyId: 'k' });
    expect(a.signature).not.toBe(b.signature);
  });
  it('does not mutate the document', () => {
    const doc = { b: 1, a: { d: 1, c: 2 } };
    const before = JSON.stringify(doc);
    signConfigDocument(doc, { privateKey: key(), keyId: 'k' });
    expect(JSON.stringify(doc)).toBe(before);
  });
  it('accepts a PKCS#8 PEM string as well as a KeyObject', () => {
    const pem = fx('test-key.pkcs8.pem').toString('utf8');
    const env = signConfigDocument(vector() as object, { privateKey: pem, keyId: 'k' });
    expect(env.signature).toBe(txt('signature.b64url.txt'));
  });
  it('key_id must be 1..32 chars (agent_config_versions CHECK char_length <= 32)', () => {
    expect(() => signConfigDocument({}, { privateKey: key(), keyId: '' })).toThrow();
    expect(() => signConfigDocument({}, { privateKey: key(), keyId: 'x'.repeat(33) })).toThrow();
    expect(signConfigDocument({}, { privateKey: key(), keyId: 'x'.repeat(32) }).key_id).toHaveLength(32);
  });
  it('refuses to sign a document that cannot be canonicalised', () => {
    expect(() => signConfigDocument({ t: 1.5 }, { privateKey: key(), keyId: 'k' })).toThrow();
  });
  it('refuses a non-Ed25519 key (EC, X25519) and a public key', () => {
    const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const x = generateKeyPairSync('x25519');
    expect(() => signConfigDocument({}, { privateKey: ec.privateKey, keyId: 'k' })).toThrow();
    expect(() => signConfigDocument({}, { privateKey: x.privateKey, keyId: 'k' })).toThrow();
    expect(() => signConfigDocument({}, { privateKey: pubKey(), keyId: 'k' })).toThrow();
    expect(() => signConfigDocument({}, { privateKey: 'not a key', keyId: 'k' })).toThrow();
  });
});

describe('loadSigningKey (LIMS_INSTRUMENTS_CONFIG_SIGNING_KEY_FILE, REQ-SEC-128)', () => {
  it('loads the fixture PKCS#8 Ed25519 private key', () => {
    const k = loadSigningKey(join(FIX, 'test-key.pkcs8.pem'));
    expect(k.type).toBe('private');
    expect(k.asymmetricKeyType).toBe('ed25519');
  });
  it('throws for a missing file', () => {
    expect(() => loadSigningKey(join(tmpdir(), 'lims-c7-t08-does-not-exist.pem'))).toThrow();
  });
  it('throws for garbage and empty files', () => {
    expect(() => loadSigningKey(tmpFile('g.pem', 'hello'))).toThrow();
    expect(() => loadSigningKey(tmpFile('e.pem', ''))).toThrow();
  });
  it('throws for a public-only key and for non-Ed25519 private keys', () => {
    expect(() => loadSigningKey(join(FIX, 'test-key.spki.pem'))).toThrow();
    const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' });
    expect(() => loadSigningKey(tmpFile('ec.pem', ec))).toThrow();
    const x = generateKeyPairSync('x25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
    expect(() => loadSigningKey(tmpFile('x.pem', x))).toThrow();
  });
  it('error messages never contain key material', () => {
    const pem = fx('test-key.pkcs8.pem').toString('utf8');
    const body = pem.split('\n').filter((l) => l && !l.startsWith('-----'))[0]!;
    const broken = tmpFile('b.pem', pem.replace(body.slice(10, 20), '!!!!!!!!!!'));
    let msg = '';
    try { loadSigningKey(broken); } catch (e) { msg = String((e as Error).message) + String((e as Error).stack); }
    expect(msg).not.toBe('');
    expect(msg).not.toContain(body);
    expect(msg).not.toContain(body.slice(0, 16));
  });
});
