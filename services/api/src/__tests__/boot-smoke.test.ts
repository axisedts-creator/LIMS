// T0D-DEP-01 / LD-179 (4): the API must START AS A PROCESS, which vitest never did (it maps .js specifiers to .ts; node does not).
// Spawns a REAL child with process.execPath and the SAME --import flag as the `start` script of services/api/package.json, cwd =
// services/api (as in the image). No listen, no fixed port, no database, no secrets (key files come from setup-env.ts, generated
// under os.tmpdir()). Port-free, so lanes sharing the host cannot collide. Run: pnpm --dir services/api exec vitest run src/__tests__
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SERVICE_DIR = join(import.meta.dirname, '..', '..'); // services/api

/** The --import flag exactly as the package.json `start` script spells it (LD-179 (2)). */
function importFlags(script: string, target: string): string[] {
  const scripts = JSON.parse(readFileSync(join(SERVICE_DIR, 'package.json'), 'utf8')).scripts as Record<string, string | undefined>;
  const m = new RegExp(`^node --import (\\S+) ${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`).exec(scripts[script] ?? '');
  if (!m) throw new Error(`services/api package.json scripts[${JSON.stringify(script)}] must be 'node --import <path to register.mjs> ${target}', got ${JSON.stringify(scripts[script])}`);
  return ['--import', m[1]!];
}

function runChild(flags: string[], entry: string, args: string[] = []): SpawnSyncReturns<string> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const k of ['LIMS_CORE_DATABASE_URL', 'LIMS_CORE_STORAGE_URL', 'LIMS_CORE_STORAGE_KEY_FILE', 'NODE_OPTIONS']) delete env[k];
  return spawnSync(process.execPath, [...flags, entry, ...args], { cwd: SERVICE_DIR, env: env as NodeJS.ProcessEnv, encoding: 'utf8', timeout: 280_000, windowsHide: true });
}

function expectCleanExit(r: SpawnSyncReturns<string>, marker: string): void {
  expect(r.error, `spawn failed or timed out: ${r.error}`).toBeUndefined();
  expect(r.stderr, `stderr of the child:\n${r.stderr}`).not.toMatch(/\bERR_[A-Z_]+/);
  expect(r.status, `exit ${r.status}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`).toBe(0);
  expect(r.stdout).toContain(marker);
}

describe('API starts as a real node process with the production --import flag (LD-179)', () => {
  it('bootstrap -> app.ready -> inject health -> app.close, exit 0, no ERR_ on stderr', () => {
    const r = runChild(importFlags('start', 'src/main.ts'), 'src/__tests__/fixtures/boot-smoke-child.ts');
    expectCleanExit(r, 'BOOT_OK');
  }, 290_000);

  it('the identity:bootstrap-platform-admin script graph loads (same flag, no database)', () => {
    const r = runChild(importFlags('identity:bootstrap-platform-admin', 'src/modules/identity/cli/bootstrap-platform-admin.ts'), 'src/__tests__/fixtures/cli-graph-child.ts');
    expectCleanExit(r, 'CLI_GRAPH_OK');
  }, 290_000);

  it('both scripts use the same register path as start', () => {
    const a = importFlags('start', 'src/main.ts');
    const b = importFlags('identity:bootstrap-platform-admin', 'src/modules/identity/cli/bootstrap-platform-admin.ts');
    expect(b).toEqual(a);
  });
});
