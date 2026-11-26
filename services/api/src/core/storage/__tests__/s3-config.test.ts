// T0B-STORAGE-1 done_when (2), (4), (5): provider chosen only by env NAMES; half set config refused at start up; none keeps proxy streaming;
// repository holds names only; docs for the founder; no route wired; no new dependency. Contract: `parseStorageConfig(env)` in ../s3.js,
// and `loadConfig(env).storage` (core/config.ts) calls it so a bad set stops the boot with `config: <NAME> ...` (same style as the other keys).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../config.js';
import { parseStorageConfig } from '../s3.js';
import { findCredentialMaterial } from './credential-scan.js';

const NAMES = ['STORAGE_PROVIDER', 'STORAGE_ENDPOINT', 'STORAGE_REGION', 'STORAGE_BUCKET', 'STORAGE_ACCESS_KEY_ID', 'STORAGE_SECRET_ACCESS_KEY', 'STORAGE_FORCE_PATH_STYLE'] as const;
const SECRET = 'SENTINEL-S3-SECRET-91c4';
const AKID = 'SENTINEL-S3-AKID-77b2';
const FULL = {
  STORAGE_PROVIDER: 's3_compatible', STORAGE_ENDPOINT: 'https://s3.example.test', STORAGE_REGION: 'ap-south-1', STORAGE_BUCKET: 'lims-test',
  STORAGE_ACCESS_KEY_ID: AKID, STORAGE_SECRET_ACCESS_KEY: SECRET, STORAGE_FORCE_PATH_STYLE: 'true',
} as Record<string, string>;
const REQUIRED = ['STORAGE_ENDPOINT', 'STORAGE_REGION', 'STORAGE_BUCKET', 'STORAGE_ACCESS_KEY_ID', 'STORAGE_SECRET_ACCESS_KEY'] as const;
const msgOf = (f: () => unknown): string => { try { f(); } catch (e) { return String((e as Error).message); } return ''; };
const without = (...k: string[]) => Object.fromEntries(Object.entries(FULL).filter(([n]) => !k.includes(n)));

describe('parseStorageConfig', () => {
  it('nothing set, STORAGE_PROVIDER=none, or the example file copied with every value empty: provider none (API streams files itself)', () => {
    expect(parseStorageConfig({})).toEqual({ provider: 'none' });
    expect(parseStorageConfig({ STORAGE_PROVIDER: 'none' })).toEqual({ provider: 'none' });
    expect(parseStorageConfig(Object.fromEntries(NAMES.map((n) => [n, ''])))).toEqual({ provider: 'none' });
  });
  it('a full set gives a typed config', () => {
    expect(parseStorageConfig(FULL)).toEqual({
      provider: 's3_compatible', endpoint: 'https://s3.example.test', region: 'ap-south-1', bucket: 'lims-test',
      accessKeyId: AKID, secretAccessKey: SECRET, forcePathStyle: true,
    });
  });
  it.each([['true', true], ['false', false], ['', false], [undefined, false]])('STORAGE_FORCE_PATH_STYLE=%s -> %s', (v, want) => {
    const e = without('STORAGE_FORCE_PATH_STYLE'); if (v !== undefined) e.STORAGE_FORCE_PATH_STYLE = v;
    expect((parseStorageConfig(e) as unknown as { forcePathStyle: boolean }).forcePathStyle).toBe(want);
  });
  it.each(['yes', '1', 'TRUE', 'maybe'])('STORAGE_FORCE_PATH_STYLE=%s is refused, naming the key', (v) => {
    expect(msgOf(() => parseStorageConfig({ ...FULL, STORAGE_FORCE_PATH_STYLE: v }))).toContain('STORAGE_FORCE_PATH_STYLE');
  });
  it.each(REQUIRED)('s3_compatible without %s is refused, naming it', (name) => {
    const m = msgOf(() => parseStorageConfig(without(name)));
    expect(m, 'must throw').not.toBe(''); expect(m).toContain(name);
  });
  it.each(REQUIRED)('s3_compatible with an EMPTY %s (blank in the example file) is refused, naming it', (name) => {
    expect(msgOf(() => parseStorageConfig({ ...FULL, [name]: '' }))).toContain(name);
  });
  it('names every missing key at once, and says what to do', () => {
    const m = msgOf(() => parseStorageConfig({ STORAGE_PROVIDER: 's3_compatible', STORAGE_REGION: 'ap-south-1' }));
    for (const n of ['STORAGE_ENDPOINT', 'STORAGE_BUCKET', 'STORAGE_ACCESS_KEY_ID', 'STORAGE_SECRET_ACCESS_KEY']) expect(m).toContain(n);
    expect(m).toMatch(/set|none/i);
  });
  it('keys set but STORAGE_PROVIDER unset is a half set configuration: refused, naming STORAGE_PROVIDER', () => {
    expect(msgOf(() => parseStorageConfig(without('STORAGE_PROVIDER')))).toContain('STORAGE_PROVIDER');
    expect(msgOf(() => parseStorageConfig({ STORAGE_BUCKET: 'b' }))).toContain('STORAGE_PROVIDER');
  });
  it.each(['S3', 'minio', 'supabase', 'aws'])('unknown provider %s is refused and the allowed values are listed', (p) => {
    const m = msgOf(() => parseStorageConfig({ ...FULL, STORAGE_PROVIDER: p }));
    expect(m).toContain('STORAGE_PROVIDER'); expect(m).toContain('s3_compatible'); expect(m).toContain('none');
  });
  it.each(['not a url', 'ftp://s3.example.test', 'https://user:pw@s3.example.test', 's3.example.test'])('endpoint %s is refused, naming STORAGE_ENDPOINT', (ep) => {
    expect(msgOf(() => parseStorageConfig({ ...FULL, STORAGE_ENDPOINT: ep }))).toContain('STORAGE_ENDPOINT');
  });
  it('no error message ever contains a secret, an access key id or an endpoint password', () => {
    const cases = [without('STORAGE_BUCKET'), { ...FULL, STORAGE_PROVIDER: 'x' }, { ...FULL, STORAGE_FORCE_PATH_STYLE: 'x' }, { ...FULL, STORAGE_ENDPOINT: 'https://u:SENTINEL-PW@h.test' }, without('STORAGE_PROVIDER')];
    for (const c of cases) { const m = msgOf(() => parseStorageConfig(c)); expect(m, 'must throw').not.toBe(''); for (const s of [SECRET, AKID, 'SENTINEL-PW']) expect(m).not.toContain(s); }
  });
});

describe('start up (loadConfig) refuses a half set configuration and keeps proxy streaming with none', () => {
  const base = { LIMS_CORE_ENV: 'ci' };
  it('no STORAGE_* names: storage.provider is none', () => { expect(loadConfig(base).storage).toEqual({ provider: 'none' }); });
  it('STORAGE_PROVIDER=none: none, even if the other names are blank', () => {
    expect(loadConfig({ ...base, STORAGE_PROVIDER: 'none', STORAGE_BUCKET: '' }).storage).toEqual({ provider: 'none' });
  });
  it('a full set loads', () => { expect(loadConfig({ ...base, ...FULL }).storage).toMatchObject({ provider: 's3_compatible', bucket: 'lims-test', forcePathStyle: true }); });
  it('a half set stops the boot with a `config:` message naming the missing key and no secret', () => {
    const m = msgOf(() => loadConfig({ ...base, ...without('STORAGE_BUCKET') }));
    expect(m).toMatch(/^config: /); expect(m).toContain('STORAGE_BUCKET'); expect(m).not.toContain(SECRET);
  });
  it('an unknown provider stops the boot', () => { expect(msgOf(() => loadConfig({ ...base, STORAGE_PROVIDER: 'ftp' }))).toContain('STORAGE_PROVIDER'); });
});

describe('repository holds names only; docs; no route wired; no new dependency', () => {
  const ROOT = fileURLToPath(new URL('../../../../../../', import.meta.url));
  const API = join(ROOT, 'services', 'api');
  const STORAGE_DIR = fileURLToPath(new URL('../', import.meta.url));
  const read = (p: string) => readFileSync(p, 'utf8');
  const sources = (dir: string, out: string[] = []): string[] => {
    for (const n of readdirSync(dir)) {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) { if (!['__tests__', 'node_modules', '__fixtures__'].includes(n)) sources(p, out); }
      else if (/\.(ts|js|mjs)$/.test(n)) out.push(p);
    }
    return out;
  };

  it('.env.example lists each of the 7 names as exactly `NAME=` (empty value)', () => {
    const lines = read(join(ROOT, '.env.example')).split(/\r?\n/).map((l) => l.trim());
    for (const n of NAMES) expect(lines, `${n}= missing or carrying a value`).toContain(`${n}=`);
  });
  it('no file the task may touch carries a value for a STORAGE_ name (env example, render.yaml, docs)', () => {
    const files = [join(ROOT, '.env.example'), join(ROOT, 'render.yaml'), join(ROOT, 'docs', 'ops', 'STORAGE.md')].filter(existsSync);
    for (const f of files) for (const [i, l] of read(f).split(/\r?\n/).entries()) {
      const m = /^\s*(?:export\s+)?(STORAGE_(?:ENDPOINT|REGION|BUCKET|ACCESS_KEY_ID|SECRET_ACCESS_KEY|PROVIDER|FORCE_PATH_STYLE))\s*=\s*(\S+)/.exec(l);
      if (m && !/^<.*>$/.test(m[2]!)) throw new Error(`${f}:${i + 1} gives ${m[1]} a value`);
    }
  });
  it('docs/ops/STORAGE.md exists and gives the founder steps (no secrets)', () => {
    const f = join(ROOT, 'docs', 'ops', 'STORAGE.md');
    expect(existsSync(f), 'docs/ops/STORAGE.md').toBe(true);
    const t = read(f);
    for (const n of NAMES) expect(t, n).toContain(n);
    expect(t).toMatch(/supabase/i); expect(t).toMatch(/minio/i);
    expect(t).toMatch(/private bucket/i); expect(t).toMatch(/access key/i);
    expect(t).toMatch(/round[ -]trip/i); expect(t).toMatch(/backup/i); expect(t).toMatch(/restore/i);
    expect(t).toMatch(/real patient data[^.]*(must not|never|not)[^.]*(free|test)/i);
    expect(t).toMatch(/only (the )?endpoint/i);
    expect(t).toMatch(/P-2/);
    expect(findCredentialMaterial(t)).toEqual([]);
  });
  it('the S3 adapter source holds no key material and uses node:crypto, not an SDK', () => {
    const f = join(STORAGE_DIR, 's3.ts');
    expect(existsSync(f), 'core/storage/s3.ts').toBe(true);
    const t = read(f);
    expect(findCredentialMaterial(t)).toEqual([]);
    expect(t).toMatch(/from 'node:crypto'/);
    expect(t).not.toMatch(/from\s+['"](?:@aws-sdk\/[^'"]*|aws-sdk|aws4|minio|@supabase\/[^'"]*)['"]|require\(\s*['"](?:@aws-sdk\/[^'"]*|aws-sdk|aws4|minio|@supabase\/[^'"]*)['"]\s*\)/);
  });
  it('no new dependency: services/api/package.json has no S3, AWS or MinIO package', () => {
    const p = JSON.parse(read(join(API, 'package.json'))) as Record<string, Record<string, string> | undefined>;
    const all = Object.keys({ ...p.dependencies, ...p.devDependencies, ...p.optionalDependencies });
    expect(all.filter((n) => /^@aws-sdk\/|^aws-sdk$|^aws4|^minio$|s3-request-presigner|^@smithy\//.test(n))).toEqual([]);
  });
  // CR TENANT-LOGO-1 changed this on purpose (it was: config.ts only): boot.ts now builds the ONE raw client for ctx.storage (the "Next" step of
  // .orchestra/notes/T0B-STORAGE-1-impl.md). Still no module, handler or route imports the adapter (next case).
  it('only core/config.ts (parse), core/pipeline/boot.ts (the one raw client) and core/storage itself import the S3 adapter', () => {
    const importers = sources(join(API, 'src'))
      .filter((f) => !f.includes(`${sep}core${sep}storage${sep}`))
      .filter((f) => /storage\/s3(\.js)?['"]/.test(read(f)))
      .map((f) => f.slice(API.length + 1).split(sep).join('/'));
    expect(importers.sort()).toEqual(['src/core/config.ts', 'src/core/pipeline/boot.ts']);
  });
  it('the adapter is not exported from the module routes: no handler or route file mentions signUpload', () => {
    const hits = sources(join(API, 'src', 'modules')).filter((f) => /signUpload|createS3RawStorage/.test(read(f)));
    expect(hits).toEqual([]);
  });
});
