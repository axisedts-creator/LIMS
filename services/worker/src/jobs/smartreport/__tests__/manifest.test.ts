// C14 T01 — worker manifest CI check (06-PLAN row T01; 02-TRD §9.1/§9.2; C0 TRD §7.2).
// done_when: "worker manifest subscriptions validated by C0 CI check". Expects ../index.ts to `export const manifest: WorkerManifest`
// (module 'smartreport'; SEAM: export name `manifest`, like analytics). TRD §9.2 literal: two tasks, two subscriptions, crontab [].
// Fails now: ../index.js does not exist.
import { describe, expect, it } from 'vitest';
import { EVENT_CONSUMERS } from '../../../../../../contracts/ports/generated/events.js';
import { setup } from '../../../core/__tests__/helpers.js';
import { validateManifests } from '../../../core/manifest.js';
import { manifest } from '../index.js';

const TASKS = ['smartreport.llm_rephrase', 'smartreport.prebuild_summary'];
const SUBSCRIPTIONS = ['lab.result.amended.v1', 'lab.result.approved.v1'];

describe('C14-T01 worker manifest (smartreport)', () => {
  it('is module smartreport and passes the build-time manifest checks (validateManifests)', () => {
    expect(manifest.module).toBe('smartreport');
    expect(() => validateManifests([manifest])).not.toThrow();
  });

  it('subscriptions = exactly lab.result.approved.v1 + lab.result.amended.v1 = EVENT_CONSUMERS.smartreport, each with a handler; no own events', () => {
    const subs = Object.keys(manifest.subscriptions ?? {}).sort();
    expect(subs).toEqual(SUBSCRIPTIONS);
    expect(subs).toEqual([...(EVENT_CONSUMERS.smartreport ?? [])].sort());
    for (const [type, h] of Object.entries(manifest.subscriptions ?? {})) {
      expect(typeof h, type).toBe('function');
      expect(type.startsWith('smartreport.'), type).toBe(false);
    }
  });

  it('declares exactly the two TRD §9.2 tasks, all smartreport.* with a handler', () => {
    expect(Object.keys(manifest.tasks ?? {}).sort()).toEqual(TASKS);
    for (const [id, h] of Object.entries(manifest.tasks ?? {})) {
      expect(id).toMatch(/^smartreport\.[a-z0-9_]+$/);
      expect(typeof h, id).toBe('function');
    }
  });

  it('crontab is empty (no cron, no purge job: TRD §9.1)', () => {
    expect([...(manifest.crontab ?? [])]).toEqual([]);
  });

  it('declares no systemPermissions (they live once, in the API ModuleManifest: TRD §9.2)', () => {
    expect((manifest as any).systemPermissions).toBeUndefined();
  });

  it('the built task list registers both tasks and one consumer per subscription, all scoped per tenant', async () => {
    const s = await setup([manifest]);
    for (const id of TASKS) expect(s.entry(id), id).toMatchObject({ module: 'smartreport', kind: 'task', scope: 'per_tenant' });
    for (const type of SUBSCRIPTIONS) expect(s.entry(`evt.smartreport.${type}`), type).toMatchObject({ module: 'smartreport', kind: 'consumer', scope: 'per_tenant' });
    expect(s.built.cronItems.filter((x: any) => String(x.identifier).startsWith('smartreport.'))).toEqual([]);
  });
});
