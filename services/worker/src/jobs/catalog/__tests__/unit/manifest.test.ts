// T0B-ASYNC-2 (CR-C0-T0B-ASYNC-1-001; LD-279, LD-189): jobs/catalog/index.ts exports `manifest` (WorkerManifest, module 'catalog') that declares
// the three tasks the API enqueues, using the task handlers that already exist (no task file is rewritten).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateManifests } from '../../../../core/manifest.js';
import { setup } from '../../../../core/__tests__/helpers.js';
import { manifest } from '../../index.js';
import { exportBuild } from '../../tasks/catalog.export_build.js';
import { importCommit } from '../../tasks/catalog.import_commit.js';
import { importValidate } from '../../tasks/catalog.import_validate.js';

const ENQUEUED = ['catalog.export_build', 'catalog.import_validate', 'catalog.import_commit'] as const;
const JOBS = join(import.meta.dirname, '..', '..');

describe('catalog worker manifest', () => {
  it('is the catalog module and passes validateManifests', () => {
    expect(manifest.module).toBe('catalog');
    expect(() => validateManifests([manifest])).not.toThrow();
  });

  it('declares export_build, import_validate and import_commit, each with the handler its existing task file exports', () => {
    const tasks = manifest.tasks ?? {};
    for (const id of ENQUEUED) expect(Object.keys(tasks), id).toContain(id);
    expect(tasks['catalog.export_build']).toBe(exportBuild);
    expect(tasks['catalog.import_validate']).toBe(importValidate);
    expect(tasks['catalog.import_commit']).toBe(importCommit);
  });

  it('declares only tasks that have a task file in this folder, all inside the catalog.* namespace', () => {
    for (const id of Object.keys(manifest.tasks ?? {})) {
      expect(id).toMatch(/^catalog\.[a-z0-9_]+$/);
      expect(existsSync(join(JOBS, 'tasks', `${id}.ts`)), `tasks/${id}.ts`).toBe(true);
    }
  });

  it('no stub: a declared handler is a function that is not the "not implemented" placeholder of the analytics scaffold', () => {
    for (const [id, h] of Object.entries(manifest.tasks ?? {})) {
      expect(typeof h, id).toBe('function');
      expect(String(h), id).not.toMatch(/not implemented/);
    }
  });

  it('every crontab entry the manifest carries is a declared task and matches ./cron.ts (cron is not re-declared by hand)', async () => {
    const ids = Object.keys(manifest.tasks ?? {});
    for (const c of manifest.crontab ?? []) expect(ids, c.identifier).toContain(c.identifier);
    const { crontab } = await import('../../cron.js');
    if ((manifest.crontab ?? []).length > 0) expect([...(manifest.crontab ?? [])]).toEqual([...crontab]);
  });

  it('subscribes to nothing (the catalog worker is task driven; its tasks are enqueued by the API)', () => {
    expect(Object.keys(manifest.subscriptions ?? {})).toEqual([]);
  });

  it('buildTaskList registers the three identifiers as catalog tasks (what registry-sync writes)', async () => {
    const s = await setup([manifest]);
    for (const id of ENQUEUED) expect(s.entry(id), id).toMatchObject({ module: 'catalog' });
  });

  it('the index file adds no SQL of its own: it declares tasks only (a new app.* call needs a grant change request, LD-189)', () => {
    const src = readFileSync(join(JOBS, 'index.ts'), 'utf8');
    expect(src).not.toMatch(/\bapp\.[a-z_]+\s*\(/);
    expect(src).not.toMatch(/\b(SELECT|INSERT|UPDATE|DELETE)\b\s/);
  });
});
