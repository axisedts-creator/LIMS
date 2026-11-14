// C9 T-26 review item 1 (.orchestra/notes/C9.T-26-review.md): behavioural proof that a quality job's metric emission reaches the real registry through the worker runtime.
// Runs quality.sync_qc_observations through core `taskRun` (-> jobContext) with a real createMetrics() and the real observation service on a fake repo (no database).
// Fails now: jobContext (worker core/consumer.ts) does not copy deps.metrics onto the JobContext, so `ctx.metrics?.set(...)` is a no-op and the series is absent from the exposition.
// Passes once the core owner (C0-0D, CR C9.T-26) adds `metrics` to JobContext/jobContext. Synthetic data only.
import { describe, expect, it } from 'vitest';
import { taskRun } from '../../../core/consumer.js';
import { createSyncQcObservationsHandler } from '../tasks/sync_qc_observations.js';
import { createMetrics } from '../../../../../api/src/core/observability/metrics.js';
import { createObservationService } from '../../../../../api/src/modules/quality/service/observation.service.js';
import { baseSeed, makeSyncRepo, makeAssembler, TENANT_A } from '../../../../../api/src/modules/quality/__tests__/observation.helpers.js';

const SYS = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
const NOW = new Date('2026-11-13T18:00:30.000Z');
const METRIC = 'lims_quality_qc_sync_last_success_timestamp_seconds';

describe('C9.T-26 quality metrics reach /metrics through the worker job context', () => {
  it(`${METRIC}{tenant_id} appears in the exposition after quality.sync_qc_observations runs via taskRun`, async () => {
    const metrics = createMetrics();
    const seed = baseSeed(); seed.view = [];
    const real = createObservationService({ repo: makeSyncRepo(seed).repo, assembler: makeAssembler().assembler, config: { syncBatch: 500, syncOverlapSeconds: 600, syncTimeBudgetSeconds: 25 } } as never);
    // The service reads the tenant zone through ctx.ports.IdentityPort; the job ctx has none here, so the test supplies it. `metrics` is deliberately NOT supplied: it must come from jobContext.
    const service = { syncQcObservations: (ctx: any) => real.syncQcObservations({ ...ctx, ports: { IdentityPort: { getTenantSettings: async () => ({ timezone: 'Asia/Kathmandu' }) } } }) };
    const tx = { async query() { return { rows: [] }; } };
    const deps: any = {
      db: { tx: async (_input: unknown, fn: (t: unknown) => Promise<unknown>) => fn(tx) },
      withTenantScope: async (_t: unknown, _id: string, _a: string, fn: () => Promise<unknown>) => fn(),
      systemActorOf: () => SYS, coreActorId: SYS, metrics, now: () => NOW,
      log: { child() { return this; }, info() {}, warn() {}, error() {} },
      events: {}, core: {}, storage: {}, files: {}, audit: {},
    };
    const entry: any = { identifier: 'quality.sync_qc_observations', module: 'quality', kind: 'task', scope: 'per_tenant', maxAttempts: 5 };
    await taskRun(deps, entry, createSyncQcObservationsHandler({ service } as never), undefined)({ tenant_id: TENANT_A }, { id: '1', attempts: 1, max_attempts: 5 } as never);
    const text = await metrics.render();
    expect(text).toMatch(new RegExp(`^${METRIC}\\{tenant_id="${TENANT_A}"\\} \\d`, 'm'));
  });
});
