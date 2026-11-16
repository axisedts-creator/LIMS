// T0B-ASYNC-1 helper: jobs/payments/index.ts validates its config AT IMPORT (loadPaymentsConfig), so importing "every manifest" needs these
// variables (synthetic values; the KEK is a throwaway random 32-byte key written to the OS temp dir). Real staging needs the same three names
// set for the worker process: the runbook must list them (async-manifests.test.ts checks).
import { mkdtempSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const PAYMENTS_ENV_NAMES = ['LIMS_PAYMENTS_PUBLIC_BASE_URL', 'LIMS_PAYMENTS_KEK_FILE', 'LIMS_PAYMENTS_RETURN_URL_ALLOWLIST', 'LIMS_PAYMENTS_ESEWA_FORM_URL'] as const;

export function stubPaymentsEnv(): void {
  if (process.env.LIMS_PAYMENTS_KEK_FILE && process.env.LIMS_PAYMENTS_ESEWA_FORM_URL) return;
  const dir = mkdtempSync(join(tmpdir(), 'lims-async-kek-'));
  const file = join(dir, 'kek.json');
  writeFileSync(file, JSON.stringify({ keys: { k1: randomBytes(32).toString('base64') }, active: 'k1' }));
  process.env.LIMS_PAYMENTS_PUBLIC_BASE_URL ??= 'https://api.example.invalid';
  process.env.LIMS_PAYMENTS_KEK_FILE = file;
  process.env.LIMS_PAYMENTS_ESEWA_FORM_URL ??= 'https://uat.esewa.com.np/api/epay/main/v2/form';   // the UAT default is "UNVERIFIED": required in uat
  process.env.LIMS_PAYMENTS_RETURN_URL_ALLOWLIST ??= 'https://staff.example.invalid/,https://portal.example.invalid/';
}
