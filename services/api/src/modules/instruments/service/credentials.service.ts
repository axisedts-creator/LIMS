// Device credential issue/hash, kind gate and last_used_at touch (02-TRD §7.1; 07-SECURITY AB3/AB4; AC-01.6, AC-01.7).
// [CONV] relative import until @lims/shared-ts is a services/api dependency (same as reporting/domain/tokens.ts).
import { randomToken, sha256Bytes } from '../../../../../../packages/shared-ts/src/crypto/index.js';
import { AuthError } from '../../../core/auth/errors.js';
import type { CredentialKind } from '../domain/credential.state.js';

export interface QueryTx {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

export const hashCredential = (s: string): Uint8Array => sha256Bytes(Buffer.from(s, 'utf8'));

function issue(prefix: 'lmsd_' | 'lmse_', bytes: 16 | 32): { token: string; secretSha256: Uint8Array } {
  const token = prefix + randomToken(bytes);
  return { token, secretSha256: hashCredential(token) };
}
/** `lmsd_` + 43 base64url (256-bit). */
export const generateDeviceToken = () => issue('lmsd_', 32);
/** `lmse_` + 22 base64url (128-bit). */
export const generateEnrolmentCode = () => issue('lmse_', 16);

/** enrolAgent: 'enrolment_code'; every other device op: 'device_token'. Anything else -> 401 (fails closed). */
export function requireCredentialKind(claims: { credential_kind?: unknown }, expected: CredentialKind): void {
  if (claims?.credential_kind !== expected) throw new AuthError('auth.device_token_invalid');
}

/** Run on the REQUEST tx. Throttled in SQL: at most one write per `touchSeconds` per credential. */
export async function touchCredential(tx: QueryTx, credentialId: string, touchSeconds: number): Promise<void> {
  if (!Number.isSafeInteger(touchSeconds) || touchSeconds <= 0) throw new RangeError('touchCredential: touchSeconds must be a positive integer');
  await tx.query(
    `UPDATE instruments.agent_credentials SET last_used_at = now()
      WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - make_interval(secs => $2))`,
    [credentialId, touchSeconds],
  );
}
