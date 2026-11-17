// T0B-DEPFIX-1 (LD-310, LD-312) done_when (1): the credential scan fails on real key material and ignores variable NAMES. Both directions.
// All values below are synthetic and assembled at run time so this file itself holds no key-shaped literal.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { findCredentialMaterial } from './credential-scan.js';

const kinds = (t: string) => findCredentialMaterial(t).map((h) => h.kind);
const seg = (n: number, ch: string) => ch.repeat(n);

describe('scan ignores variable NAMES (the T0B-PERF-1 red test)', () => {
  it.each([
    ["REQUIRED_ENV list in health.ts", "const REQUIRED_ENV = ['LIMS_CORE_JWT_KEY_FILE', 'LIMS_CORE_STORAGE_KEY_FILE'];"],
    ['the name as an import binding', "import { STORAGE_KEY_ENV } from './storage/env.js'; // LIMS_CORE_STORAGE_KEY_FILE"],
    ['the name read from env', 'const f = process.env.LIMS_CORE_STORAGE_KEY_FILE;'],
    ['a SERVICE_ROLE name with no value', "const NAME = 'SUPABASE_SERVICE_ROLE_KEY';"],
    ['a constant holding the name', "export const STORAGE_KEY_ENV = 'LIMS_CORE_STORAGE_KEY_FILE';"],
    ['a file path value', "const p = '/run/secrets/lims_core_storage_key';"],
    ['an uuid and a kebab identifier', "const a = '0190a000-0000-7000-8000-00000000a5a5'; const b = 'frontdesk-trf-bucket-name-with-many-parts-ok';"],
  ])('%s: no hit', (_n, text) => { expect(findCredentialMaterial(text)).toEqual([]); });
});

describe('scan still fails on real key material', () => {
  it('PEM private key block', () => {
    expect(kinds(`const k = \`${'-----BEGIN ' + 'PRIVATE KEY-----'}\\nMIIE\\n${'-----END ' + 'PRIVATE KEY-----'}\`;`)).toContain('pem');
  });
  it('RSA PEM block header', () => { expect(kinds('-----BEGIN ' + 'RSA PRIVATE KEY-----')).toContain('pem'); });
  it('64 char hex literal', () => { expect(kinds(`const k = '${'0123456789abcdef'.repeat(4)}';`)).toContain('hex'); });
  it('48 char base64 literal with letters and digits', () => { expect(kinds(`const k = "${'Ab3dEf6hIj9lMn2pQr5tUv8xYz1B'}${'c4D7f0H3j6L9n2P5r8T1'}";`)).toContain('base64'); });
  it('JWT shaped literal (a service role key)', () => {
    const jwt = ['eyJ' + 'hbGciOiJIUzI1NiJ9', 'eyJ' + 'yb2xlIjoic2VydmljZV9yb2xlIn0', seg(20, 'a') + '1234567'].join('.');
    expect(kinds(`const k = '${jwt}';`)).toContain('jwt');
  });
  it('service role variable assigned a literal', () => {
    expect(kinds(`SUPABASE_SERVICE_ROLE_KEY = 'synthetic-value-${seg(8, 'x')}'`)).toContain('named-assignment');
    expect(kinds(`{ LIMS_CORE_STORAGE_KEY: 'synthetic-value-${seg(8, 'x')}' }`)).toContain('named-assignment');
  });
  it('the same material is found even when a variable name sits next to it', () => {
    expect(kinds(`const REQUIRED_ENV = ['LIMS_CORE_STORAGE_KEY_FILE']; const k = '${'ab12'.repeat(16)}';`)).toContain('hex');
  });
});

describe('real sources: api core and worker core hold no key material outside core/storage', () => {
  const CORE = fileURLToPath(new URL('../../', import.meta.url));
  const WORKER_CORE = join(CORE, '..', '..', '..', 'worker', 'src', 'core');
  const sources = (dir: string, out: string[] = []): string[] => {
    for (const n of readdirSync(dir)) {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) { if (!['__tests__', 'node_modules', '__fixtures__'].includes(n)) sources(p, out); }
      else if (/\.(ts|js|mjs)$/.test(n)) out.push(p);
    }
    return out;
  };
  it('no hit in any non-test source, and core/health.ts is scanned', () => {
    const all = [...sources(CORE), ...sources(WORKER_CORE)];
    expect(all.some((f) => f.endsWith(`${sep}core${sep}health.ts`))).toBe(true);
    for (const f of all) expect(findCredentialMaterial(readFileSync(f, 'utf8')), f).toEqual([]);
  });
});
