// T0B-ASYNC-2 (CR-C0-T0B-ASYNC-1-001; LD-279, LD-189): jobs/homecollection/index.ts exports `manifest` (WorkerManifest, module 'homecollection')
// that declares the two tasks the API enqueues, using the task handlers that already exist (no task file is rewritten).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateManifests } from '../../../core/manifest.js';
import { setup } from '../../../core/__tests__/helpers.js';
import { manifest } from '../index.js';
import { flagHandoverDiscrepancy } from '../tasks/flag_handover_discrepancy.js';

// homecollection.refresh_visit_specimens is NOT declared: its task needs ctx.ports.LabPort, absent from JobContext (CR-C0-T0B-ASYNC-2-001).
const ENQUEUED = ['homecollection.flag_handover_discrepancy'] as const;
const JOBS = join(import.meta.dirname, '..');

describe('homecollection worker manifest', () => {
  it('is the homecollection module and passes validateManifests', () => {
    expect(manifest.module).toBe('homecollection');
    expect(() => validateManifests([manifest])).not.toThrow();
  });

  it('declares flag_handover_discrepancy with the handler its existing task file exports, and not refresh_visit_specimens (no LabPort in JobContext)', () => {
    const tasks = manifest.tasks ?? {};
    for (const id of ENQUEUED) expect(Object.keys(tasks), id).toContain(id);
    expect(tasks['homecollection.flag_handover_discrepancy']).toBe(flagHandoverDiscrepancy);
    expect(Object.keys(tasks)).not.toContain('homecollection.refresh_visit_specimens');
  });

  it('declares only tasks that have a task file in this folder, all inside the homecollection.* namespace', () => {
    for (const id of Object.keys(manifest.tasks ?? {})) {
      expect(id).toMatch(/^homecollection\.[a-z0-9_]+$/);
      expect(existsSync(join(JOBS, 'tasks', `${id.slice('homecollection.'.length)}.ts`)), `tasks/${id}`).toBe(true);
    }
  });

  it('every crontab entry the manifest carries is a declared task and matches ./cron.ts (cron is not re-declared by hand)', async () => {
    const ids = Object.keys(manifest.tasks ?? {});
    for (const c of manifest.crontab ?? []) expect(ids, c.identifier).toContain(c.identifier);
    const { crontab } = await import('../cron.js');
    if ((manifest.crontab ?? []).length > 0) expect([...(manifest.crontab ?? [])]).toEqual([...crontab]);
  });

  it('every subscription is a consumer file that exists in ./consumers (none invented)', () => {
    for (const type of Object.keys(manifest.subscriptions ?? {})) expect(existsSync(join(JOBS, 'consumers', `${type}.ts`)), type).toBe(true);
  });

  it('buildTaskList registers the identifier as a homecollection task (what registry-sync writes)', async () => {
    const s = await setup([manifest]);
    for (const id of ENQUEUED) expect(s.entry(id), id).toMatchObject({ module: 'homecollection' });
  });

  it('the index file adds no SQL of its own: it declares tasks only (a new app.* call needs a grant change request, LD-189)', () => {
    const src = readFileSync(join(JOBS, 'index.ts'), 'utf8');
    expect(src).not.toMatch(/\bapp\.[a-z_]+\s*\(/);
    expect(src).not.toMatch(/\b(SELECT|INSERT|UPDATE|DELETE)\b\s/);
  });
});
