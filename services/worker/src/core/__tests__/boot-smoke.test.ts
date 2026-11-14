// T0D-DEP-01 / LD-179 (4): the worker must START AS A PROCESS, which vitest never did (it maps .js specifiers to .ts; node does not).
// Spawns REAL children with process.execPath and the SAME --import flag as the scripts of services/worker/package.json, cwd =
// services/worker (as in the image). No database, no Graphile runner, no metrics server, no port: port-free so lanes sharing the
// host cannot collide. Run: pnpm --dir services/worker exec vitest run src/core/__tests__/boot-smoke.test.ts
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SERVICE_DIR = join(import.meta.dirname, '..', '..', '..'); // services/worker

/** The --import flag exactly as the package.json script spells it (LD-179 (2)). */
function importFlags(script: string, target: string): string[] {
  const scripts = JSON.parse(readFileSync(join(SERVICE_DIR, 'package.json'), 'utf8')).scripts as Record<string, string | undefined>;
  const m = new RegExp(`^node --import (\\S+) ${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`).exec(scripts[script] ?? '');
  if (!m) throw new Error(`services/worker package.json scripts[${JSON.stringify(script)}] must be 'node --import <path to register.mjs> ${target}', got ${JSON.stringify(scripts[script])}`);
  return ['--import', m[1]!];
}

function runChild(flags: string[], entry: string, args: string[] = []): SpawnSyncReturns<string> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const k of ['LIMS_CORE_WORKER_DATABASE_URL', 'LIMS_CORE_DATABASE_URL', 'NODE_OPTIONS']) delete env[k];
  return spawnSync(process.execPath, [...flags, entry, ...args], { cwd: SERVICE_DIR, env: env as NodeJS.ProcessEnv, encoding: 'utf8', timeout: 120_000, windowsHide: true });
}

describe('worker starts as a real node process with the production --import flag (LD-179)', () => {
  it('the main.ts + replay.ts import graph loads: exit 0, no ERR_ on stderr', () => {
    const r = runChild(importFlags('start', 'src/main.ts'), 'src/core/__tests__/boot-smoke-child.ts');
    expect(r.error, `spawn failed or timed out: ${r.error}`).toBeUndefined();
    expect(r.stderr, `stderr of the child:\n${r.stderr}`).not.toMatch(/\bERR_[A-Z_]+/);
    expect(r.status, `exit ${r.status}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`).toBe(0);
    expect(r.stdout).toContain('WORKER_GRAPH_OK');
  }, 130_000);

  it('worker:replay runs as the entry file: its graph loads, then it rejects missing arguments before touching a database', () => {
    const r = runChild(importFlags('worker:replay', 'src/core/replay.ts'), 'src/core/replay.ts');
    expect(r.error, `spawn failed or timed out: ${r.error}`).toBeUndefined();
    expect(r.stderr, `stderr of the child:\n${r.stderr}`).not.toMatch(/\bERR_[A-Z_]+/);
    expect(r.stderr).toContain('worker:replay: --event-type is required');
    expect(r.status).toBe(1);
  }, 130_000);

  it('start and worker:replay use the same register path', () => {
    expect(importFlags('worker:replay', 'src/core/replay.ts')).toEqual(importFlags('start', 'src/main.ts'));
  });
});
