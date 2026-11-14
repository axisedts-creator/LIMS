// T0D-DEP-02 (LD-174): one reader for the web BFF key; env fallback LIMS_WEB_BFF_KEY only when LIMS_CORE_ENV is exactly dev|ci|staging.
// Fails now because ../bff-key does not exist yet.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBffKey } from '../bff-key';

const SRC = fileURLToPath(new URL('../../../', import.meta.url)); // apps/web/src/
const ENV_KEY = 'synthetic-env-key-7f3a91';
const FILE_KEY = 'synthetic-file-key-c04b22';
const NOT_SET = 'LIMS_WEB_BFF_KEY_FILE is not set';

let dir: string;
let keyFile: string;
let emptyFile: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'dep02-'));
  keyFile = join(dir, 'key');
  emptyFile = join(dir, 'empty');
  writeFileSync(keyFile, `  ${FILE_KEY}\n`);
  writeFileSync(emptyFile, ' \n');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

type Env = Record<string, string | undefined>;
const run = (env: Env) => readBffKey(env as NodeJS.ProcessEnv);
const err = (env: Env): Error => {
  try { run(env); } catch (e) { return e as Error; }
  throw new Error('expected readBffKey to throw');
};

describe('readBffKey', () => {
  it('file only: reads and trims the file', () => {
    expect(run({ LIMS_WEB_BFF_KEY_FILE: keyFile })).toBe(FILE_KEY);
  });

  it.each(['dev', 'ci', 'staging'])('env only with LIMS_CORE_ENV=%s: accepted, trimmed', (core) => {
    expect(run({ LIMS_CORE_ENV: core, LIMS_WEB_BFF_KEY: `  ${ENV_KEY}\n` })).toBe(ENV_KEY);
  });

  it.each([['production'], [undefined], [''], ['Staging'], ['prod'], ['DEV'], ['development']])(
    'env only with LIMS_CORE_ENV=%j: refused with the not-set message',
    (core) => {
      expect(err({ LIMS_CORE_ENV: core, LIMS_WEB_BFF_KEY: ENV_KEY }).message).toBe(NOT_SET);
    },
  );

  it('neither set: not-set message', () => {
    expect(err({ LIMS_CORE_ENV: 'dev' }).message).toBe(NOT_SET);
  });

  it('both set: file wins, env ignored', () => {
    expect(run({ LIMS_CORE_ENV: 'dev', LIMS_WEB_BFF_KEY_FILE: keyFile, LIMS_WEB_BFF_KEY: ENV_KEY })).toBe(FILE_KEY);
  });

  it('both set but file empty: file-branch error, env NOT used as fallback', () => {
    expect(err({ LIMS_CORE_ENV: 'dev', LIMS_WEB_BFF_KEY_FILE: emptyFile, LIMS_WEB_BFF_KEY: ENV_KEY }).message).toBe('LIMS_WEB_BFF_KEY_FILE is empty');
  });

  it('empty file: throws "LIMS_WEB_BFF_KEY_FILE is empty"', () => {
    expect(err({ LIMS_WEB_BFF_KEY_FILE: emptyFile }).message).toBe('LIMS_WEB_BFF_KEY_FILE is empty');
  });

  it('whitespace-only env value (dev): throws "LIMS_WEB_BFF_KEY is empty"', () => {
    expect(err({ LIMS_CORE_ENV: 'dev', LIMS_WEB_BFF_KEY: '   \n' }).message).toBe('LIMS_WEB_BFF_KEY is empty');
  });

  it('empty-string env value (dev) never yields a key', () => {
    const m = err({ LIMS_CORE_ENV: 'dev', LIMS_WEB_BFF_KEY: '' }).message;
    expect([NOT_SET, 'LIMS_WEB_BFF_KEY is empty']).toContain(m);
  });

  it('NODE_ENV is never read: development+production core env refused; production NODE_ENV+staging accepted', () => {
    expect(err({ NODE_ENV: 'development', LIMS_CORE_ENV: 'production', LIMS_WEB_BFF_KEY: ENV_KEY }).message).toBe(NOT_SET);
    expect(err({ NODE_ENV: 'development', LIMS_WEB_BFF_KEY: ENV_KEY }).message).toBe(NOT_SET);
    expect(run({ NODE_ENV: 'production', LIMS_CORE_ENV: 'staging', LIMS_WEB_BFF_KEY: ENV_KEY })).toBe(ENV_KEY);
  });

  it('no error message or stack contains the key value', () => {
    const cases: Env[] = [
      { LIMS_CORE_ENV: 'production', LIMS_WEB_BFF_KEY: ENV_KEY },
      { LIMS_CORE_ENV: 'Staging', LIMS_WEB_BFF_KEY: ENV_KEY },
      { LIMS_WEB_BFF_KEY_FILE: emptyFile, LIMS_WEB_BFF_KEY: ENV_KEY },
      { LIMS_CORE_ENV: 'dev', LIMS_WEB_BFF_KEY: '  ' },
    ];
    for (const c of cases) {
      const e = err(c);
      expect(e.message).not.toContain(ENV_KEY);
      expect(String(e.stack)).not.toContain(ENV_KEY);
    }
  });

  it('defaults to process.env', () => {
    const names = ['LIMS_WEB_BFF_KEY_FILE', 'LIMS_CORE_ENV', 'LIMS_WEB_BFF_KEY'];
    const saved = names.map((k) => [k, process.env[k]] as const);
    try {
      delete process.env.LIMS_WEB_BFF_KEY_FILE;
      process.env.LIMS_CORE_ENV = 'ci';
      process.env.LIMS_WEB_BFF_KEY = ENV_KEY;
      expect(readBffKey()).toBe(ENV_KEY);
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

function walk(d: string): string[] {
  return readdirSync(d).flatMap((n) => {
    const p = join(d, n);
    if (statSync(p).isDirectory()) return n === 'node_modules' || n === '__tests__' ? [] : walk(p);
    return /\.(ts|tsx|mjs|js)$/.test(n) && !/\.(test|spec)\./.test(n) ? [p] : [];
  });
}

describe('static: single reader', () => {
  const files = walk(SRC);
  const rel = (f: string) => f.slice(SRC.length).replace(/\\/g, '/');

  it('only core/session/bff-key.ts mentions LIMS_WEB_BFF_KEY[_FILE] under apps/web/src', () => {
    const offenders = files.filter((f) => /LIMS_WEB_BFF_KEY/.test(readFileSync(f, 'utf8')) && rel(f) !== 'core/session/bff-key.ts');
    expect(offenders.map(rel)).toEqual([]);
  });

  it('c2.ts and admin auth actions.ts call readBffKey and keep no own file read', () => {
    for (const r of ['core/session/c2.ts', 'features/admin/auth/actions.ts']) {
      const s = readFileSync(join(SRC, r), 'utf8');
      expect(s, r).toMatch(/readBffKey\(/);
      expect(s, r).not.toMatch(/readFileSync\(/);
    }
  });

  it('c2.ts keeps its per-process cache', () => {
    expect(readFileSync(join(SRC, 'core/session/c2.ts'), 'utf8')).toMatch(/cachedKey/);
  });

  it('bff-key.ts: no NEXT_PUBLIC_ name, NODE_ENV never read, no logging; importers are not client files', () => {
    const s = readFileSync(join(SRC, 'core/session/bff-key.ts'), 'utf8');
    expect(s).not.toMatch(/NEXT_PUBLIC_/);
    expect(s).not.toMatch(/NODE_ENV/);
    expect(s).not.toMatch(/console\./);
    const importers = files.filter((f) => /from ['"][^'"]*bff-key['"]/.test(readFileSync(f, 'utf8')));
    expect(importers.length).toBeGreaterThanOrEqual(2);
    for (const f of importers) expect(readFileSync(f, 'utf8'), rel(f)).not.toMatch(/^['"]use client['"]/m);
  });
});
