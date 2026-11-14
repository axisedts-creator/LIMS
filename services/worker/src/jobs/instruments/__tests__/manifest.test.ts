// API-T14 — worker manifest of the instruments module (02-TRD §10, §9.2; 08 A13 P-6). Expected: ../index.ts exports `manifest` (WorkerManifest, module 'instruments').
import { describe, expect, it } from 'vitest';
import { validateManifests } from '../../../core/manifest.js';
import { setup } from '../../../core/__tests__/helpers.js';
import { manifest } from '../index.js';

const CRON: Record<string, { schedule: string; scope: 'per_tenant' | 'platform'; attempts: number }> = {
  'instruments.evaluate_agent_health': { schedule: '* * * * *', scope: 'per_tenant', attempts: 1 },
  'instruments.export_agent_state_metrics': { schedule: '* * * * *', scope: 'platform', attempts: 1 },
  'instruments.expire_credentials_and_commands': { schedule: '*/15 * * * *', scope: 'per_tenant', attempts: 3 },
  'instruments.publish_release_configs': { schedule: '7,22,37,52 * * * *', scope: 'per_tenant', attempts: 3 },
  'instruments.purge_archive': { schedule: '50 20 * * *', scope: 'per_tenant', attempts: 3 },
};

describe('instruments worker manifest', () => {
  it('is the instruments module and passes validateManifests', () => {
    expect(manifest.module).toBe('instruments');
    expect(() => validateManifests([manifest])).not.toThrow();
  });

  it('declares the six T14 tasks, all inside the instruments.* namespace', () => {
    const ids = Object.keys(manifest.tasks ?? {});
    for (const id of [...Object.keys(CRON), 'instruments.refresh_observed_code_mapping']) expect(ids).toContain(id);
    for (const id of ids) expect(id).toMatch(/^instruments\.[a-z0-9_]+$/);
  });

  it('subscribes only to catalog.changed.v1 (TRD §9.2) and never to its own events', () => {
    expect(Object.keys(manifest.subscriptions ?? {})).toEqual(['catalog.changed.v1']);
  });

  it.each(Object.entries(CRON))('%s: cron %j is declared in code with the scope and attempts of TRD §10', async (id, want) => {
    const c = (manifest.crontab ?? []).find((x) => x.identifier === id);
    expect(c, `crontab entry ${id}`).toBeDefined();
    expect(c!.schedule.trim().split(/\s+/).join(' ')).toBe(want.schedule);
    expect(c!.tenantScope).toBe(want.scope);
    const s = await setup([manifest]);
    expect(s.entry(id)).toMatchObject({ module: 'instruments', scope: want.scope, maxAttempts: want.attempts });
    expect(s.built.cronItems.find((x: any) => x.identifier === id)?.match).toBe(want.schedule);
  });

  it('the refresh task is not cron-driven (enqueued by the consumer) and has 10 attempts; the consumer task exists with the generated id', async () => {
    expect((manifest.crontab ?? []).some((c) => c.identifier === 'instruments.refresh_observed_code_mapping')).toBe(false);
    const s = await setup([manifest]);
    expect(s.entry('instruments.refresh_observed_code_mapping')).toMatchObject({ module: 'instruments', maxAttempts: 10 });
    expect(s.entry('evt.instruments.catalog.changed.v1')).toMatchObject({ kind: 'consumer', scope: 'per_tenant' });
  });

  it('the only platform-scope cron is the metrics export (every other cron is per_tenant, P-6)', () => {
    const platform = (manifest.crontab ?? []).filter((c) => c.tenantScope === 'platform').map((c) => c.identifier);
    expect(platform).toEqual(['instruments.export_agent_state_metrics']);
  });
});
