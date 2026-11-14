// C6-T02 tokens.ts (02-TRD §4.7; AC-10.5; 08 R24). Generation via @lims/shared-ts/crypto only.
// Assumed API: TOKEN_KINDS, issueToken(kind) -> {token, tokenSha256: Uint8Array(32)}; hashToken(token) -> Uint8Array(32).
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { TOKEN_KINDS, hashToken, issueToken } from '../tokens.js';

const b64url = (n: number) => new RegExp('^[A-Za-z0-9_-]{' + n + '}$');

describe('token sizes (§4.7)', () => {
  it('kinds are qr, link, session, callback', () => {
    expect([...TOKEN_KINDS].sort()).toEqual(['callback', 'link', 'qr', 'session']);
  });
  it.each(['qr', 'link'] as const)('%s = 128 bits = 22 base64url chars (AC-10.5)', (kind) => {
    const { token } = issueToken(kind);
    expect(token).toMatch(b64url(22));
    expect(Buffer.from(token, 'base64url')).toHaveLength(16);
  });
  it.each(['session', 'callback'] as const)('%s = 256 bits = 43 base64url chars', (kind) => {
    const { token } = issueToken(kind);
    expect(token).toMatch(b64url(43));
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
  });
  it('rejects an unknown kind', () => {
    expect(() => issueToken('bogus' as never)).toThrow();
  });
});

describe('only the SHA-256 is stored (AC-10.5, 08 R24)', () => {
  it('tokenSha256 is the raw 32-byte SHA-256 of the token text', () => {
    const { token, tokenSha256 } = issueToken('qr');
    expect(tokenSha256).toBeInstanceOf(Uint8Array);
    expect(tokenSha256).toHaveLength(32);
    expect(Buffer.from(tokenSha256).equals(createHash('sha256').update(token, 'utf8').digest())).toBe(true);
  });
  it('hashToken is deterministic, 32 bytes, and matches issueToken', () => {
    const { token, tokenSha256 } = issueToken('link');
    expect(hashToken(token)).toHaveLength(32);
    expect(Buffer.from(hashToken(token)).equals(Buffer.from(tokenSha256))).toBe(true);
    expect(Buffer.from(hashToken(token + 'x')).equals(Buffer.from(tokenSha256))).toBe(false);
  });
  it('the hash bytes never contain the token text (hex or utf8)', () => {
    const { token, tokenSha256 } = issueToken('qr');
    expect(Buffer.from(tokenSha256).toString('hex')).not.toContain(token);
    expect(Buffer.from(tokenSha256).toString('utf8')).not.toContain(token);
  });
  it('no field of the issued record other than `token` carries the plaintext', () => {
    const { token, ...rest } = issueToken('qr');
    expect(JSON.stringify(rest)).not.toContain(token);
  });
});

describe('uniqueness', () => {
  it('2000 QR tokens are distinct', () => {
    const s = new Set(Array.from({ length: 2000 }, () => issueToken('qr').token));
    expect(s.size).toBe(2000);
  });
});
