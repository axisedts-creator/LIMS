// Patient OTP helpers (02-TRD §3/§4.1; E3 code ^[0-9]{6}$). Pure; CSPRNG via shared-ts randomDigits.
// [CONV] relative import until @lims/shared-ts is a services/api dependency (lockfile is C0-0A's, LD-05).
import { randomDigits } from '../../../../../../packages/shared-ts/src/crypto/index.js';

export const OTP_LENGTH = 6;
const CODE_RE = /^[0-9]{6}$/;

export const generateOtp = (): string => randomDigits(OTP_LENGTH);
export const isWellFormedOtp = (code: unknown): code is string => typeof code === 'string' && CODE_RE.test(code);
