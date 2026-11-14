// C16-T01 test env defaults (convention: src/__tests__/setup-env.ts). modules/engagement/index.ts validates LIMS_ENGAGEMENT_* at import
// (02-TRD §10.1), so every test that autoloads modules/ needs these key files. Applied only when unset. Synthetic: random bytes under os.tmpdir().
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'lims-engagement-test-env-'));
const raw = (name: string) => {
  const f = join(dir, name);
  writeFileSync(f, randomBytes(32), { mode: 0o600 });
  return f;
};
const encKeys = join(dir, 'otp-enc-keys.json');
writeFileSync(encKeys, JSON.stringify({ 'k-test-1': randomBytes(32).toString('base64') }), { mode: 0o600 });

export default {
  LIMS_ENGAGEMENT_OTP_HMAC_KEY_FILE: raw('otp-hmac.key'),
  LIMS_ENGAGEMENT_OTP_ENC_KEYS_FILE: encKeys,
  LIMS_ENGAGEMENT_LINK_HMAC_KEY_FILE: raw('link-hmac.key'),
  LIMS_ENGAGEMENT_PHONE_HMAC_KEY_FILE: raw('phone-hmac.key'),
} as Record<string, string>;
