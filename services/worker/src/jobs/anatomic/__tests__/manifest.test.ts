// C11 T-01 — worker manifest CI check (06-PLAN row T-01; 02-TRD §3.2 WorkerManifest, §9; C0 TRD §7.2).
// done_when: "API and worker boot with fakes". Expects ../index.ts to `export const manifest: WorkerManifest` (module 'anatomic'; SEAM: export name `manifest`, like smartreport).
// T-01 scope: WorkerManifest WITHOUT `permissions`/`systemPermissions`; updated by T-27 (CR-C11-011): the two lab.result.* subscriptions
// (and their handlers) now belong to the manifest alongside lab.specimen.status_changed.v1. crontab [] (TRD §9: no cron jobs).
// Fails now: ../index.js does not exist.
import { beforeAll, describe, expect, it } from 'vitest';
import { EVENT_CONSUMERS } from '../../../../../../contracts/ports/generated/events.js';
import { setup } from '../../../core/__tests__/helpers.js';
import { validateManifests } from '../../../core/manifest.js';
import { manifest } from '../index.js';

// pay the lazy worker-graph transform (setup() imports tasklist) outside a test's 5s budget
beforeAll(async () => { await setup([manifest]); }, 120_000);

describe('C11-T01 worker manifest (anatomic)', () => {
  it('is module anatomic and passes the build-time manifest checks (validateManifests)', () => {
    expect(manifest.module).toBe('anatomic');
    expect(() => validateManifests([manifest])).not.toThrow();
  });

  it('subscribes only declared C11 consumers (lab.specimen.status_changed.v1 + the two lab.result.* of T-27/CR-C11-011), each with a handler; no own events', () => {
    const subs = Object.keys(manifest.subscriptions ?? {}).sort();
    expect(subs).toEqual(['lab.result.amended.v1', 'lab.result.approved.v1', 'lab.specimen.status_changed.v1']);
    for (const t of subs) expect([...(EVENT_CONSUMERS.anatomic ?? [])]).toContain(t);
    for (const [type, h] of Object.entries(manifest.subscriptions ?? {})) {
      expect(typeof h, type).toBe('function');
      expect(type.startsWith('anatomic.'), type).toBe(false);
    }
  });

  it('every task id (if any are declared at T-01) is anatomic.* with a handler; crontab is empty (no cron, no purge job: TRD §9)', () => {
    for (const [id, h] of Object.entries(manifest.tasks ?? {})) {
      expect(id).toMatch(/^anatomic\.[a-z0-9_]+$/);
      expect(typeof h, id).toBe('function');
    }
    expect([...(manifest.crontab ?? [])]).toEqual([]);
  });

  it('declares no permissions / systemPermissions (they live once, in the API ModuleManifest: TRD §3.2)', () => {
    expect((manifest as any).permissions).toBeUndefined();
    expect((manifest as any).systemPermissions).toBeUndefined();
  });

  it('the built task list registers one per_tenant consumer for lab.specimen.status_changed.v1 and no anatomic cron item', async () => {
    const s = await setup([manifest]);
    expect(s.entry('evt.anatomic.lab.specimen.status_changed.v1')).toMatchObject({ module: 'anatomic', kind: 'consumer', scope: 'per_tenant' });
    expect(s.entry('evt.anatomic.lab.result.approved.v1')).toMatchObject({ module: 'anatomic', kind: 'consumer', scope: 'per_tenant' });   // T-27
    expect(s.entry('evt.anatomic.lab.result.amended.v1')).toMatchObject({ module: 'anatomic', kind: 'consumer', scope: 'per_tenant' });
    expect(s.built.cronItems.filter((x: any) => String(x.identifier).startsWith('anatomic.'))).toEqual([]);
  });
});
