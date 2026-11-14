// T0D-DEP-01 / LD-179 (1), (4): behaviour of tools/node-ts/register.mjs, the one resolver hook that lets node run the TypeScript sources
// whose imports are spelled './x.js' while only x.ts exists. Every case spawns a REAL child (process.execPath + --import) in a scratch
// directory under os.tmpdir(); nothing is registered in the vitest process. Port-free, no network, no database.
// Run: pnpm --dir services/api exec vitest run src/__tests__
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as nodeModule from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REGISTER_URL = pathToFileURL(join(import.meta.dirname, '..', '..', '..', '..', 'tools', 'node-ts', 'register.mjs')).href;
let dir = '';

const put = (rel: string, body: string): void => {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), body);
};
const run = (entry: string, withHook = true): SpawnSyncReturns<string> =>
  spawnSync(process.execPath, [...(withHook ? ['--import', REGISTER_URL] : []), entry], {
    cwd: dir, encoding: 'utf8', timeout: 60_000, windowsHide: true, env: { ...process.env, NODE_OPTIONS: '' },
  });

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'lims-node-ts-hook-'));
  put('package.json', '{"type":"module"}');
  put('lib/b.ts', 'export const b: number = 41;\n');
  put('lib/both.ts', "export const v: string = 'ts';\n");
  put('lib/both.js', "export const v = 'js';\n");
  put('lib/real.js', "export const r = 'real-js';\n");
  // only-.ts target, imported with the .js spelling, from a .ts importer
  put('a-ok.ts', "import { b } from './lib/b.js';\nconsole.log('RESOLVED', b + 1);\n");
  put('up/deep/c.ts', "import { b } from '../../lib/b.js';\nconsole.log('RESOLVED_UP', b + 1);\n");
  put('a-dynamic.ts', "const m = await import('./lib/b.js');\nconsole.log('RESOLVED_DYN', m.b + 1);\n");
  // a real .js beside a .ts: the .js wins (the hook only acts when the .js file does NOT exist)
  put('a-both.ts', "import { v } from './lib/both.js';\nconsole.log('BOTH', v);\n");
  put('a-real-js.ts', "import { r } from './lib/real.js';\nconsole.log('REAL', r);\n");
  // genuinely missing: neither x.js nor x.ts
  put('a-missing.ts', "import './lib/nope.js';\nconsole.log('SHOULD_NOT_RUN');\n");
  put('a-missing-dyn.ts', "await import('./lib/nope.js');\nconsole.log('SHOULD_NOT_RUN');\n");
  put('a-missing-up.ts', "import '../outside/nope.js';\nconsole.log('SHOULD_NOT_RUN');\n");
  // the hook is limited to relative .js specifiers imported from a .ts file
  put('a-mjs.mjs', "import { b } from './lib/b.js';\nconsole.log('SHOULD_NOT_RUN', b);\n");
  put('a-extless.ts', "import { b } from './lib/b';\nconsole.log('SHOULD_NOT_RUN', b);\n");
  put('a-bare.ts', "import 'no-such-package-xyz-lims';\nconsole.log('SHOULD_NOT_RUN');\n");
  put('a-absurl.ts', `import { b } from ${JSON.stringify(pathToFileURL(join(dir, 'lib', 'b.js')).href)};\nconsole.log('SHOULD_NOT_RUN', b);\n`);
  put('a-builtin.ts', "import { sep } from 'node:path';\nconsole.log('BUILTIN', typeof sep);\n");
});
afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

const notFound = (r: SpawnSyncReturns<string>): void => {
  expect(r.status, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`).not.toBe(0);
  expect(r.stderr).toMatch(/ERR_MODULE_NOT_FOUND/);
  expect(r.stdout).not.toContain('SHOULD_NOT_RUN');
};

describe('node precondition', () => {
  it('this node has module.registerHooks (else LD-179 says: blocking CR, never switch to tsx)', () => {
    expect(typeof (nodeModule as { registerHooks?: unknown }).registerHooks).toBe('function');
  });
  it('without the hook node cannot map ./x.js to x.ts (the defect LD-179 fixes)', () => {
    notFound(run('a-ok.ts', false));
  });
});

describe('tools/node-ts/register.mjs resolves ./x.js to x.ts only when x.js is absent and x.ts exists', () => {
  it('./b.js -> b.ts from a .ts importer (static import)', () => {
    const r = run('a-ok.ts');
    expect(r.stderr).not.toMatch(/ERR_/);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('RESOLVED 42');
  });
  it('../../lib/b.js -> b.ts', () => {
    const r = run('up/deep/c.ts');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('RESOLVED_UP 42');
  });
  it('dynamic import() of ./b.js -> b.ts', () => {
    const r = run('a-dynamic.ts');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('RESOLVED_DYN 42');
  });
  it('an existing x.js wins over x.ts', () => {
    const r = run('a-both.ts');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('BOTH js');
  });
  it('a real .js file with no .ts twin is untouched', () => {
    const r = run('a-real-js.ts');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('REAL real-js');
  });
  it('node: builtins are untouched', () => {
    const r = run('a-builtin.ts');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('BUILTIN string');
  });
});

describe('the hook does not hide a genuinely missing module', () => {
  it('neither nope.js nor nope.ts exists -> ERR_MODULE_NOT_FOUND, non-zero exit', () => { notFound(run('a-missing.ts')); });
  it('same for dynamic import()', () => { notFound(run('a-missing-dyn.ts')); });
  it('same for ../ specifiers', () => { notFound(run('a-missing-up.ts')); });
  it('a bare package that is not installed still fails', () => { notFound(run('a-bare.ts')); });
});

describe('the hook stays inside its rule', () => {
  it('a .mjs importer is not remapped (importer must be a .ts file)', () => { notFound(run('a-mjs.mjs')); });
  it('an extensionless specifier is not remapped', () => { notFound(run('a-extless.ts')); });
  it('an absolute file: URL specifier is not remapped (relative specifiers only)', () => { notFound(run('a-absurl.ts')); });
});
