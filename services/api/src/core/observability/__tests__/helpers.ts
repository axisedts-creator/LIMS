// Shared helpers for the T0D-10 tests (observability + health).
// Interface these tests expect (documented in .orchestra/notes/T0D-10-tests.md):
//   bootstrap({ config, modulesDir, healthChecks?, logStream? })   core/bootstrap.ts
//     - repoRoot omitted -> the real contracts/openapi/core.yaml is mounted with the core's own health handlers
//     - healthChecks = { db(), ratelimit() }: each resolves 'ok' | 'degraded' | 'down'
//     - logStream = { write(line: string): void } receives every log line (JSON, one per line)
//   app.metrics: CoreMetrics (core/observability/metrics.ts)
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { bootstrap } from '../../bootstrap.js';
import { loadConfig } from '../../config.js';

const here = fileURLToPath(new URL('.', import.meta.url));
export const EMPTY_MODULES = join(here, 'fixtures', 'empty');

export const RID = '0190a000-0000-7000-8000-0000000000f1'; // valid UUIDv7
export type CheckState = 'ok' | 'degraded' | 'down';
export interface Checks { db(): Promise<CheckState>; ratelimit(): Promise<CheckState> }
export const okChecks = (): Checks => ({ db: async () => 'ok', ratelimit: async () => 'ok' });

const open: FastifyInstance[] = [];
export const closeAll = async (): Promise<void> => {
  await Promise.all(open.splice(0).map((a) => a.close()));
};

export type ObsApp = FastifyInstance & { metrics: { render(): Promise<string>; inc(n: string, l?: object): void } };

export async function bootObs(
  o: { checks?: Checks; env?: Record<string, string> } = {},
): Promise<{ app: ObsApp; logs: string[]; lines: () => Record<string, any>[] }> {
  const logs: string[] = [];
  const app = (await bootstrap({
    config: loadConfig({ LIMS_CORE_ENV: 'ci', LIMS_CORE_LOG_LEVEL: 'info', ...o.env }),
    modulesDir: EMPTY_MODULES,
    healthChecks: o.checks ?? okChecks(),
    logStream: { write: (l: string) => { logs.push(l); } },
  } as any)) as ObsApp;
  open.push(app);
  const lines = () => logs.join('').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, any>);
  return { app, logs, lines };
}

export interface Sample { name: string; labels: Record<string, string>; value: number }
/** Parse Prometheus text exposition into samples (comment lines skipped). */
export function samples(text: string): Sample[] {
  const out: Sample[] = [];
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const m = /^([a-zA-Z_:][\w:]*)(?:\{(.*)\})?\s+(\S+)$/.exec(line);
    if (!m) throw new Error(`unparsable metrics line: ${line}`);
    const labels: Record<string, string> = {};
    for (const l of (m[2] ?? '').matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g)) labels[l[1]!] = l[2]!;
    out.push({ name: m[1]!, labels, value: Number(m[3]) });
  }
  return out;
}
export const find = (text: string, name: string, labels: Record<string, string> = {}): Sample[] =>
  samples(text).filter((s) => s.name === name && Object.entries(labels).every(([k, v]) => s.labels[k] === v));
