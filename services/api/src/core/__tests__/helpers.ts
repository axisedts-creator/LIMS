// Shared helpers for the T0D-01 boot tests.
// Interface these tests expect (documented in .orchestra/notes/T0D-01-tests.md):
//   loadConfig(env): CoreConfig            core/config.ts   (throws Error naming the bad LIMS_CORE_* key)
//   bootstrap({ config, repoRoot?, modulesDir? }): Promise<FastifyInstance>   core/bootstrap.ts
//     - resolves after app.ready(); rejects (boot fails) on any autoload/spec/handler problem
//     - repoRoot  = directory holding contracts/openapi/<m>.yaml  (default: the real repo root)
//     - modulesDir = directory scanned for <m>/index.ts            (default: services/api/src/modules)
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { bootstrap } from '../bootstrap.js';
import { loadConfig } from '../config.js';

const here = fileURLToPath(new URL('.', import.meta.url));
export const FIXTURES = join(here, 'fixtures');
export const SHARED_ROOT = join(FIXTURES, 'shared');
export const caseDir = (name: string): string => join(FIXTURES, name);

export const cfg = (extra: Record<string, string> = {}) => loadConfig({ LIMS_CORE_ENV: 'ci', ...extra });

const open: FastifyInstance[] = [];
export const closeAll = async (): Promise<void> => {
  await Promise.all(open.splice(0).map((a) => a.close()));
};

/** Boot a fixture case against the shared fixture contracts. */
export async function boot(name: string, extra: Record<string, string> = {}): Promise<FastifyInstance> {
  const app = await bootstrap({ config: cfg(extra), repoRoot: SHARED_ROOT, modulesDir: caseDir(name) });
  open.push(app);
  return app;
}

/** Boot a fixture case that must fail; returns the error message. Fails the test if boot succeeds. */
export async function bootError(name: string, extra: Record<string, string> = {}): Promise<string> {
  try {
    await boot(name, extra);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error(`boot of fixture "${name}" succeeded but must fail`);
}

export const calls = (): string[] => ((globalThis as any).__bootCalls ??= []) as string[];
