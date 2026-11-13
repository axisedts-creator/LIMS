// C14 T25 load-test helpers (not a test file). Synthetic data only.
// MODEL: no real database/ports here, so latency is VIRTUAL: each emulated call adds its 02-TRD §11 budget to `sim.ms`; a measured duration is
// (real wall time of the service code) + (virtual ms of the calls it made). Samples run one at a time, so the sum is exact and deterministic —
// no sleeping, no timer jitter. The test therefore catches: extra/serial round trips (N+1), CPU regressions, and budget composition errors.
// It does NOT measure real PostgreSQL/port latency (that needs the live stack; see .orchestra/notes/C14.T25-tests.md).
import { performance } from 'node:perf_hooks';
import { vi } from 'vitest';
import {
  bindingsRepoFake, blocksRepoFake, codedSetsRepoFake, groupsRepoFake, libraryRepoFake, mappingsRepoFake, rulesRepoFake, summariesRepoFake,
} from '../t12.fakes.js';

export const sim = { ms: 0, scale: 1 };
export const add = (ms: number): void => { sim.ms += ms * sim.scale; };

/** 02-TRD §11 budgets (ports) and a small per-statement cost for indexed repository calls (write total ≤ 15 ms in the TRD row). */
export const PORT_MS = { getOrderSummary: 15, getOrderResults: 80, getTest: 2, getAnalyteHistory: 40 } as const;
export const REPO_MS: Record<string, number> = {
  getLiveSummaryByOrder: 2, findSummaryByDeterminismKey: 2, insertSummary: 7, updateSummary: 3, insertBinding: 2, getSummary: 2,
  getApprovedLibraryVersion: 2, listBlocks: 2, listRules: 2, listMappings: 2, listGroupSettings: 2,
};
export const LOCK_MS = 1;

/** Wraps every function of a repository emulator so each call adds its virtual latency (vi.fn kept: callers may inspect mock.calls). */
export function withLatency<T extends Record<string, any>>(repo: T): T {
  const out: Record<string, any> = {};
  for (const [k, f] of Object.entries(repo)) out[k] = typeof f === 'function' ? vi.fn(async (...a: any[]) => { add(REPO_MS[k] ?? 1); return f(...a); }) : f;
  return out as T;
}
export const latent = {
  summaries: withLatency(summariesRepoFake), bindings: withLatency(bindingsRepoFake), library: withLatency(libraryRepoFake), blocks: withLatency(blocksRepoFake),
  rules: withLatency(rulesRepoFake), mappings: withLatency(mappingsRepoFake), groups: withLatency(groupsRepoFake), codedSets: withLatency(codedSetsRepoFake),
};

/** A BuildCtx whose ports and advisory-lock query add their virtual latency. */
export function latentPorts(ctx: any): any {
  const wrap = (port: Record<string, any>, ms: Record<string, number>): Record<string, any> =>
    Object.fromEntries(Object.entries(port).map(([k, f]) => [k, async (...a: any[]) => { add(ms[k] ?? 0); return f.apply(port, a); }]));
  ctx.ports = { FrontdeskPort: wrap(ctx.ports.FrontdeskPort, PORT_MS), LabPort: wrap(ctx.ports.LabPort, PORT_MS), CatalogPort: wrap(ctx.ports.CatalogPort, PORT_MS) };
  const q = ctx.tx.query;
  ctx.tx.query = async (...a: any[]) => { add(LOCK_MS); return q(...a); };
  return ctx;
}

/** Duration of fn in ms: real elapsed + virtual latency added while it ran. Sequential use only. */
export async function timed(fn: () => Promise<unknown>): Promise<number> {
  const s0 = sim.ms; const t0 = performance.now();
  await fn();
  return performance.now() - t0 + (sim.ms - s0);
}
/** Nearest-rank percentile. */
export const pct = (xs: number[], p: number): number => { const s = [...xs].sort((a, b) => a - b); return s[Math.max(0, Math.ceil(p * s.length) - 1)]!; };
export const fmt = (xs: number[]): string => `n=${xs.length} p50=${pct(xs, 0.5).toFixed(1)} p95=${pct(xs, 0.95).toFixed(1)} max=${Math.max(...xs).toFixed(1)} ms`;
