// Shared helpers for the T0D-02 auth tests. Tokens are signed with node:crypto only (independent of the impl's JWT lib).
import { createHmac, createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type Alg = 'HS256' | 'ES256' | 'RS256';

/** Fixed clock for unit tests (ms). */
export const NOW_MS = Date.UTC(2026, 10, 7, 12, 0, 0);
export const NOW_S = Math.floor(NOW_MS / 1000);

export const ISS = 'https://gotrue.lims.test/auth/v1';
export const AUD = 'authenticated';
export const SUB = '0190a000-0000-7000-8000-00000000a001';
export const SESSION_ID = '0190a000-0000-7000-8000-0000000000e1';
export const TENANT_A = '0190a000-0000-7000-8000-00000000aaaa';
export const TENANT_B = '0190a000-0000-7000-8000-00000000bbbb';

const dir = mkdtempSync(join(tmpdir(), 'lims-t0d02-'));
let n = 0;
/** Writes a file under a private temp dir and returns its path. */
export function tmpFile(content: string, name = `f${n++}`): string {
  const p = join(dir, `${n++}-${name}`);
  writeFileSync(p, content);
  return p;
}

export const b64u = (b: Buffer | string): string => Buffer.from(b).toString('base64url');

export interface KeySet {
  readonly alg: Alg;
  /** What goes into LIMS_CORE_JWT_KEY_FILE: raw secret (HS256) or SPKI public PEM (ES256/RS256). */
  readonly verifyKeyFile: string;
  readonly signKey: KeyObject | Buffer;
  /** Signs `header.payload` for this alg. */
  signWith(alg: Alg, input: string, key?: KeyObject | Buffer): string;
}

const hs = (input: string, secret: Buffer | KeyObject): string =>
  createHmac('sha256', secret instanceof Buffer ? secret : (secret as KeyObject).export()).update(input).digest('base64url');

export function signRaw(alg: Alg, input: string, key: KeyObject | Buffer): string {
  if (alg === 'HS256') return hs(input, key);
  if (alg === 'ES256') return sign('sha256', Buffer.from(input), { key: key as KeyObject, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return sign('RSA-SHA256', Buffer.from(input), key as KeyObject).toString('base64url');
}

export function makeKeys(alg: Alg): KeySet {
  if (alg === 'HS256') {
    const secret = Buffer.from('t0d02-hs256-secret-0123456789abcdef0123456789abcdef');
    return { alg, verifyKeyFile: tmpFile(secret.toString('utf8'), 'jwt-hs.key'), signKey: secret, signWith: signRaw };
  }
  const pair = alg === 'ES256'
    ? generateKeyPairSync('ec', { namedCurve: 'P-256' })
    : generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  return { alg, verifyKeyFile: tmpFile(pem, 'jwt-pub.pem'), signKey: pair.privateKey, signWith: signRaw };
}

/** Unrelated key pair of the same alg, for "re-signed with a wrong key" tests. */
export const wrongKeyFor = (alg: Alg): KeyObject | Buffer =>
  alg === 'HS256' ? Buffer.from('another-secret-another-secret-another-secret!!') : makeKeys(alg).signKey;

export function goodPayload(over: Record<string, unknown> = {}, nowS = NOW_S): Record<string, unknown> {
  return { sub: SUB, session_id: SESSION_ID, aal: 'aal1', iss: ISS, aud: AUD, iat: nowS - 10, exp: nowS + 600, ...over };
}

export interface SignOpts {
  readonly header?: Record<string, unknown>;
  /** key to sign with (default: the key set's own) */
  readonly key?: KeyObject | Buffer;
  /** alg used for the MAC/signature itself (default: header.alg if it is HS256/ES256/RS256, else key set alg) */
  readonly signAlg?: Alg;
  /** drop keys from the payload */
  readonly omit?: readonly string[];
}

/** Builds a JWT. Never validates anything: callers can build deliberately broken tokens. */
export function makeToken(ks: KeySet, payloadOver: Record<string, unknown> = {}, o: SignOpts = {}, nowS = NOW_S): string {
  const payload = goodPayload(payloadOver, nowS);
  for (const k of o.omit ?? []) delete payload[k];
  const header = { alg: ks.alg, typ: 'JWT', ...(o.header ?? {}) };
  const input = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(payload))}`;
  const a = o.signAlg ?? ks.alg;
  return `${input}.${signRaw(a, input, o.key ?? ks.signKey)}`;
}

/** `alg: none` token with an empty signature (and variants). */
export function noneToken(alg: string, payload: Record<string, unknown> = goodPayload(), sig = ''): string {
  return `${b64u(JSON.stringify({ alg, typ: 'JWT' }))}.${b64u(JSON.stringify(payload))}.${sig}`;
}

/** Re-encode the payload of a signed token without re-signing (tamper). */
export function tamper(token: string, over: Record<string, unknown>): string {
  const [h, p, s] = token.split('.');
  const payload = { ...JSON.parse(Buffer.from(p!, 'base64url').toString()), ...over };
  return `${h}.${b64u(JSON.stringify(payload))}.${s}`;
}

/** Duck-typed auth error check: .code and HTTP 401 (error classes are T0D-04's; we only need these two fields). */
export async function expectAuthError(p: Promise<unknown>, code: string, status = 401): Promise<void> {
  let err: any;
  try {
    await p;
  } catch (e) {
    err = e;
  }
  if (!err) throw new Error(`expected rejection with ${code}, but it resolved`);
  const got = err.code ?? err.errorCode;
  if (got !== code) throw new Error(`expected code ${code}, got ${String(got)} (${String(err.message)})`);
  const st = err.statusCode ?? err.status;
  if (st !== status) throw new Error(`expected status ${status}, got ${String(st)}`);
}

export { createPrivateKey, createPublicKey };
