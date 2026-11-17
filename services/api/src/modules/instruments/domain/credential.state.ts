// Credential machine (03-APP-FLOW §2.3). Terminal: used, expired, revoked. redeem/expire apply to enrolment codes only.
import { LimsError } from '../../../core/errors.js';

export const CREDENTIAL_STATUSES = ['active', 'used', 'expired', 'revoked'] as const;
export type CredentialStatus = (typeof CREDENTIAL_STATUSES)[number];
export type CredentialKind = 'enrolment_code' | 'device_token';
export type CredentialAction = 'redeem' | 'expire' | 'revoke';

const TO: Readonly<Record<CredentialAction, CredentialStatus>> = { redeem: 'used', expire: 'expired', revoke: 'revoked' };

export function credentialNext(from: CredentialStatus, action: CredentialAction, kind: CredentialKind): CredentialStatus {
  const to = TO[action];
  if (from !== 'active' || !to || (kind !== 'enrolment_code' && action !== 'revoke')) {
    throw new LimsError('instruments.invalid_transition');
  }
  return to;
}
