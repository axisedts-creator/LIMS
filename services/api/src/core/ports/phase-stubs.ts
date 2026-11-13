// Committed phase-stub allowlist (02-TRD §6.x stubs paragraph, 08 R9, AC-0D-6.3). Remove a port here in the same PR that ships its owner module.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_MODULES_DIR, PORT_OWNERS } from '../module.js';

export const PHASE_STUBS: readonly string[] = Object.freeze([] as string[]);

export interface PhaseStubCheckOpts {
  readonly phaseStubs?: readonly string[];
  readonly modulesDir?: string;
  readonly owners?: Readonly<Record<string, string>>;
}

/** Listed ports whose owner module exists (`<modulesDir>/<owner>/index.ts`, same glob as the autoloader). */
export function findStalePhaseStubs(opts: PhaseStubCheckOpts = {}): Array<{ port: string; owner: string }> {
  const { phaseStubs = PHASE_STUBS, modulesDir = DEFAULT_MODULES_DIR, owners = PORT_OWNERS } = opts;
  const stale: Array<{ port: string; owner: string }> = [];
  for (const port of phaseStubs) {
    const owner = Object.hasOwn(owners, port) ? owners[port] : undefined;
    if (!owner) throw new Error(`phase-stubs.ts: ${port} is not a known port (PORT_OWNERS)`);
    if (existsSync(join(modulesDir, owner, 'index.ts'))) stale.push({ port, owner });
  }
  return stale;
}

/** CI gate (AC-0D-6.3): throws when a listed port's owner module exists. */
export function assertPhaseStubsCurrent(opts: PhaseStubCheckOpts = {}): void {
  const stale = findStalePhaseStubs(opts);
  if (stale.length) {
    throw new Error(`phase-stubs.ts is stale: remove ${stale.map((s) => `${s.port} (owner module ${s.owner} exists)`).join(', ')} from phase-stubs.ts`);
  }
}
