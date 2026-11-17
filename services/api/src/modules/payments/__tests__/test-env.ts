// PG-T01 test env defaults (convention: src/__tests__/setup-env.ts). The payments module validates its config at import
// (TRD §9.3), so every test that autoloads modules/ needs a valid LIMS_PAYMENTS_* set. Applied only when unset.
// Synthetic only: the KEK is 32 random bytes generated now under os.tmpdir(); nothing here is a secret.
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'lims-payments-test-env-'));
const kekFile = join(dir, 'payments-kek.json');
writeFileSync(kekFile, JSON.stringify({ keys: { 'kek-test-1': randomBytes(32).toString('base64') }, active: 'kek-test-1' }), { mode: 0o600 });

export default {
  LIMS_PAYMENTS_GATEWAY_ENV: 'uat',
  LIMS_PAYMENTS_PUBLIC_BASE_URL: 'https://api.lims.test',
  LIMS_PAYMENTS_RETURN_URL_ALLOWLIST: 'https://app.lims.test/,https://portal.lims.test/,https://api.lims.test/v1/payments/result',
  LIMS_PAYMENTS_ESEWA_FORM_URL: 'https://uat.esewa.com.np/api/epay/main/v2/form', // UAT value UNVERIFIED (TRD §9.1); synthetic here
  LIMS_PAYMENTS_KEK_FILE: kekFile,
} as Record<string, string>;
