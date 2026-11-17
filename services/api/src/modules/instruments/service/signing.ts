// C7 API-T08 — canonical JSON + Ed25519 config signing (02-TRD §5.10, D-06; 07-SECURITY REQ-SEC-119/128; AC-15.1).
// Canonical form: keys sorted by Unicode code point, no whitespace, minimal escapes (`"`, `\`, C0 as lower-case \u00xx),
// safe integers only. Fails closed on anything it cannot represent exactly. Go twin: apps/bridge-agent (AG-T11),
// shared golden vector in __tests__/fixtures/config.
import { createHash, createPrivateKey, sign, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';

export interface SignedConfigEnvelope<T> {
  alg: 'Ed25519';
  key_id: string;
  signature: string;
  document: T;
}

const LONE_SURROGATE = /\p{Surrogate}/u;

function cmpCodePoint(a: string, b: string): number {
  const A = Array.from(a);
  const B = Array.from(b);
  for (let i = 0; i < Math.min(A.length, B.length); i++) {
    const d = A[i]!.codePointAt(0)! - B[i]!.codePointAt(0)!;
    if (d !== 0) return d;
  }
  return A.length - B.length;
}

function str(s: string): string {
  if (LONE_SURROGATE.test(s)) throw new Error('canonicalJson: lone surrogate in string');
  let out = '"';
  for (const c of s) {
    const u = c.charCodeAt(0);
    out += c === '"' ? '\\"' : c === '\\' ? '\\\\' : u < 0x20 ? '\\u' + u.toString(16).padStart(4, '0') : c;
  }
  return out + '"';
}

function enc(v: unknown, stack: Set<object>): string {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'boolean':
      return v ? 'true' : 'false';
    case 'number':
      if (!Number.isSafeInteger(v)) throw new Error('canonicalJson: only safe integers are allowed');
      return String(v); // String(-0) === '0'
    case 'string':
      return str(v);
    case 'object':
      break;
    default:
      throw new Error(`canonicalJson: unsupported type ${typeof v}`);
  }
  if (stack.has(v)) throw new Error('canonicalJson: circular reference');
  stack.add(v);
  let out: string;
  if (Array.isArray(v)) {
    out = '[' + v.map((x) => enc(x, stack)).join(',') + ']';
  } else {
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) throw new Error('canonicalJson: only plain objects are allowed');
    const o = v as Record<string, unknown>;
    out = '{' + Object.keys(o).sort(cmpCodePoint).map((k) => str(k) + ':' + enc(o[k], stack)).join(',') + '}';
  }
  stack.delete(v);
  return out;
}

export function canonicalJson(value: unknown): string {
  return enc(value, new Set());
}

export function canonicalSha256(document: unknown): string {
  return createHash('sha256').update(canonicalJson(document), 'utf8').digest('hex');
}

function assertEd25519Private(k: KeyObject): KeyObject {
  if (k.type !== 'private' || k.asymmetricKeyType !== 'ed25519') throw new Error('signing key must be an Ed25519 private key');
  return k;
}

function parsePrivateKey(pem: string | Buffer): KeyObject {
  let k: KeyObject;
  try {
    k = createPrivateKey({ key: pem, format: 'pem' });
  } catch {
    // never echo the underlying error: it may quote key material
    throw new Error('signing key is not a valid PKCS#8 PEM private key');
  }
  return assertEd25519Private(k);
}

/** Reads LIMS_INSTRUMENTS_CONFIG_SIGNING_KEY_FILE (PKCS#8 PEM Ed25519 private key). */
export function loadSigningKey(file: string): KeyObject {
  let pem: Buffer;
  try {
    pem = readFileSync(file);
  } catch {
    throw new Error('signing key file cannot be read');
  }
  return parsePrivateKey(pem);
}

export function signConfigDocument<T>(
  document: T,
  opts: { privateKey: KeyObject | string; keyId: string },
): SignedConfigEnvelope<T> {
  const { keyId } = opts;
  const n = typeof keyId === 'string' ? Array.from(keyId).length : 0; // code points, like PG char_length
  if (n < 1 || n > 32) throw new Error('key_id must be 1..32 characters');
  const key = typeof opts.privateKey === 'string' ? parsePrivateKey(opts.privateKey) : assertEd25519Private(opts.privateKey);
  const signature = sign(null, Buffer.from(canonicalJson(document), 'utf8'), key).toString('base64url');
  return { alg: 'Ed25519', key_id: keyId, signature, document };
}
