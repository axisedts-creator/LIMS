// C6-T01 — worker module scaffold (02-TRD §3.3, §9; 08 A13 P-6). Expected: ../index.ts exports `manifest` (WorkerManifest, module 'reporting').
// At T01 the task/consumer set may still be empty; whatever is declared must satisfy the core manifest checks.
import { describe, expect, it } from 'vitest';
import { validateManifests } from '../../../core/manifest.js';
import { manifest } from '../index.js';

describe('reporting worker manifest', () => {
  it('is the reporting module and passes validateManifests', () => {
    expect(manifest.module).toBe('reporting');
    expect(() => validateManifests([manifest])).not.toThrow();
  });
  it('declares only reporting.* task ids', () => {
    for (const id of Object.keys(manifest.tasks ?? {})) expect(id).toMatch(/^reporting\.[a-z0-9_]+$/);
  });
  it('every cron row is per_tenant (08 A13 P-6: C6 has no platform cron)', () => {
    for (const c of manifest.crontab ?? []) expect(c.tenantScope).toBe('per_tenant');
  });
  it('never subscribes to its own events', () => {
    for (const t of Object.keys(manifest.subscriptions ?? {})) expect(t.startsWith('reporting.')).toBe(false);
  });
});
