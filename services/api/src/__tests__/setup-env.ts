// Test-only env setup for services/api (vitest `setupFiles`; LD-53 (2), T0D-01). Never imported by production code.
//
// CONVENTION: a module that needs env to boot in tests adds ONE file `src/modules/<module>/__tests__/test-env.ts`
// whose default export is a `Record<string, string>` of env defaults. They are applied only when the variable is still
// unset, so an explicit process env (CI, a developer shell) always wins, and no shared file needs editing.
// Only env names that already exist in core/config.ts or modules/*/config.ts may be used. Key material is generated at
// test start under os.tmpdir(); nothing here is a real secret and nothing is committed.
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

type Env = Record<string, string | undefined>;

const MODULES_DIR = join(import.meta.dirname, '..', 'modules');
let scratch: string | undefined;
const scratchFile = (name: string, data: string | Buffer): string => {
  scratch ??= mkdtempSync(join(tmpdir(), 'lims-api-test-env-'));
  const p = join(scratch, name);
  writeFileSync(p, data, { mode: 0o600 });
  return p;
};

export async function applyTestEnv(env: Env = process.env, modulesDir: string = MODULES_DIR): Promise<void> {
  const setIfUnset = (k: string, v: () => string): void => {
    if (env[k] === undefined) env[k] = v();
  };
  setIfUnset('LIMS_CORE_ENV', () => 'ci');
  // modules/reporting/index.ts reads this at import (TRD 10.1): >= 32 bytes.
  setIfUnset('LIMS_REPORTING_OTP_HMAC_KEY_FILE', () => scratchFile('reporting-otp-hmac.key', randomBytes(32)));
  // bearerJwt operations need all four LIMS_CORE_JWT_* (core/config.ts); ES256 public key, generated now.
  setIfUnset('LIMS_CORE_JWT_ALG', () => 'ES256');
  setIfUnset('LIMS_CORE_JWT_ISSUER', () => 'https://gotrue.lims.test/auth/v1');
  setIfUnset('LIMS_CORE_JWT_AUDIENCE', () => 'authenticated');
  setIfUnset('LIMS_CORE_JWT_KEY_FILE', () => {
    const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    return scratchFile('jwt-es256-pub.pem', publicKey.export({ type: 'spki', format: 'pem' }));
  });
  if (!existsSync(modulesDir)) return;
  for (const m of readdirSync(modulesDir).sort()) {
    const f = join(modulesDir, m, '__tests__', 'test-env.ts');
    if (!existsSync(f)) continue;
    const defaults = ((await import(pathToFileURL(f).href)) as { default?: Record<string, string> }).default ?? {};
    for (const [k, v] of Object.entries(defaults)) setIfUnset(k, () => v);
  }
}

await applyTestEnv();
