// Token issue/hash (02-TRD §4.7; AC-10.5; 08 R24). Generation only via shared crypto; only the 32-byte SHA-256 is stored.
// [CONV] relative import until @lims/shared-ts is a services/api dependency (lockfile is C0-0A's, LD-05).
import { randomToken, sha256Bytes } from '../../../../../../packages/shared-ts/src/crypto/index.js';

const TOKEN_BYTES = { qr: 16, link: 16, session: 32, callback: 32 } as const;
export type TokenKind = keyof typeof TOKEN_BYTES;
export const TOKEN_KINDS = Object.keys(TOKEN_BYTES) as TokenKind[];

export function hashToken(token: string): Uint8Array {
  return sha256Bytes(token);
}

export function issueToken(kind: TokenKind): { token: string; tokenSha256: Uint8Array } {
  if (!Object.hasOwn(TOKEN_BYTES, kind)) throw new RangeError('issueToken: unknown kind');
  const token = randomToken(TOKEN_BYTES[kind]);
  return { token, tokenSha256: hashToken(token) };
}
