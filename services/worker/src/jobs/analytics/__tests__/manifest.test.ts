// AN-T01 (C8) — worker manifest CI check (06-IMPLEMENTATION-PLAN row AN-T01; 02-TRD §9.3/§9.4; C0 TRD §7.2).
// done_when: "worker manifest passes C0 CI check (subscriptions = IC §3.25 C8 list)".
// Expects ../index.ts to `export const manifest: WorkerManifest` (module 'analytics'; SEAM: export name `manifest`, like the other modules).
// Subscriptions are compared with the 12 events whose IC §3.25 "Consumers" cell lists C8 (parsed from the spec), with
// EVENT_CONSUMERS.analytics, and with the literal of TRD §9.4. Tasks/crontab/maxAttempts/taskOptions = TRD §9.3/§9.4 literal.
// SEAM: TRD §9.3 lists max_attempts 3 for the sweeps/purge but the §9.4 literal sets maxAttempts only for refresh_tenant,
//       build_export, dispatch_schedules; the literal is what is asserted (no invented attempts).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EVENT_CONSUMERS } from '../../../../../../contracts/ports/generated/events.js';
import { REPO_ROOT } from '../../../../../api/src/core/module.js';
import { setup } from '../../../core/__tests__/helpers.js';
import { validateManifests } from '../../../core/manifest.js';
import { manifest } from '../index.js';

const TASKS = [
  'analytics.refresh_tenant', 'analytics.sweep_recent', 'analytics.sweep_nightly', 'analytics.self_check',
  'analytics.build_export', 'analytics.dispatch_schedules', 'analytics.purge', 'analytics.backfill',
];
const CRON: Record<string, string> = {
  'analytics.sweep_recent': '*/10 * * * *',
  'analytics.sweep_nightly': '45 20 * * *',
  'analytics.dispatch_schedules': '*/15 * * * *',
  'analytics.purge': '15 21 * * *',
};
const SUBSCRIPTIONS = [
  'billing.invoice.cancelled.v1', 'billing.invoice.issued.v1', 'frontdesk.order.cancelled.v1', 'frontdesk.order.created.v1',
  'instruments.agent.health_changed.v1', 'lab.critical_value.detected.v1', 'lab.result.amended.v1', 'lab.result.approved.v1',
  'lab.result.verified.v1', 'lab.specimen.status_changed.v1', 'reporting.delivery.status_changed.v1', 'reporting.report.released.v1',
];

/** Event types in IC §3.25 whose Consumers cell contains the token C8 (rows 1..26 of the matrix). */
function icConsumedByC8(): string[] {
  const text = readFileSync(join(REPO_ROOT, 'spec', 'program', '03-INTERFACE-CATALOG.md'), 'utf8');
  const start = text.indexOf('### 3.25 Event summary matrix');
  const end = text.indexOf('\n### 3.26', start);
  expect(start, 'IC §3.25 heading not found').toBeGreaterThan(-1);
  expect(end, 'IC §3.26 heading not found').toBeGreaterThan(start);
  const out: string[] = [];
  for (const line of text.slice(start, end).split('\n')) {
    const cells = line.split('|').map((c) => c.trim());
    const m = /^([a-z_]+(?:\.[a-z_]+)+\.v\d+)\b/.exec(cells[2] ?? '');
    if (m && /\bC8\b/.test(cells[4] ?? '')) out.push(m[1]!);
  }
  return out;
}

describe('AN-T01 worker manifest (analytics)', () => {
  it('is module analytics and passes the build-time manifest checks (validateManifests)', () => {
    expect(manifest.module).toBe('analytics');
    expect(() => validateManifests([manifest])).not.toThrow();
  });

  it('the IC §3.25 parse finds the 12 C8 events (guards the comparison below against an empty parse)', () => {
    expect(icConsumedByC8().sort()).toEqual(SUBSCRIPTIONS);
  });

  it('subscriptions equal IC §3.25 C8 consumer list and EVENT_CONSUMERS.analytics (no extra, none missing)', () => {
    const subs = Object.keys(manifest.subscriptions ?? {}).sort();
    expect(subs).toEqual(icConsumedByC8().sort());
    expect(subs).toEqual([...(EVENT_CONSUMERS.analytics ?? [])].sort());
    expect(subs).toHaveLength(12);
  });

  it('every subscription has a handler function, and none is one of its own events (C8 produces nothing)', () => {
    for (const [type, h] of Object.entries(manifest.subscriptions ?? {})) {
      expect(typeof h, type).toBe('function');
      expect(type.startsWith('analytics.'), type).toBe(false);
    }
  });

  it('declares exactly the 8 TRD §9.3 tasks, all analytics.* with a handler', () => {
    expect(Object.keys(manifest.tasks ?? {}).sort()).toEqual([...TASKS].sort());
    for (const [id, h] of Object.entries(manifest.tasks ?? {})) {
      expect(id).toMatch(/^analytics\.[a-z0-9_]+$/);
      expect(typeof h, id).toBe('function');
    }
  });

  it('crontab = the four TRD §9.4 rows, all per_tenant (no platform cron)', () => {
    const cron = manifest.crontab ?? [];
    expect(cron.map((c) => c.identifier).sort()).toEqual(Object.keys(CRON).sort());
    for (const c of cron) {
      expect(c.schedule.trim().split(/\s+/).join(' '), c.identifier).toBe(CRON[c.identifier]);
      expect(c.tenantScope, c.identifier).toBe('per_tenant');
    }
  });

  it('refresh_tenant, self_check, build_export, backfill are enqueued, never cron-driven', () => {
    const ids = (manifest.crontab ?? []).map((c) => c.identifier);
    for (const t of ['analytics.refresh_tenant', 'analytics.self_check', 'analytics.build_export', 'analytics.backfill']) expect(ids).not.toContain(t);
  });

  it('maxAttempts and taskOptions equal the TRD §9.4 literal (nightly sweep and backfill run at 120 s, CR-C8-012)', () => {
    expect(manifest.maxAttempts).toEqual({ 'analytics.refresh_tenant': 5, 'analytics.build_export': 3, 'analytics.dispatch_schedules': 5 });
    expect(manifest.taskOptions).toEqual({
      'analytics.sweep_nightly': { statementTimeoutMs: 120000 },
      'analytics.backfill': { statementTimeoutMs: 120000 },
    });
  });

  it('the built task list registers every task per_tenant, the four crons with their schedule, and one consumer per subscription', async () => {
    const s = await setup([manifest]);
    for (const id of TASKS) expect(s.entry(id), id).toMatchObject({ module: 'analytics', kind: 'task', scope: 'per_tenant' });
    expect(s.entry('analytics.refresh_tenant')).toMatchObject({ maxAttempts: 5 });
    expect(s.entry('analytics.build_export')).toMatchObject({ maxAttempts: 3 });
    expect(s.entry('analytics.dispatch_schedules')).toMatchObject({ maxAttempts: 5 });
    for (const [id, match] of Object.entries(CRON)) expect(s.built.cronItems.find((x: any) => x.identifier === id)?.match, id).toBe(match);
    for (const type of SUBSCRIPTIONS) expect(s.entry(`evt.analytics.${type}`), type).toMatchObject({ module: 'analytics', kind: 'consumer', scope: 'per_tenant' });
  });

  // Adversarial: the CI check must actually bite (guards the done_when check itself).
  it('validateManifests rejects a drifted manifest: extra subscription, foreign task id, cron on an undeclared task', () => {
    const h = async () => undefined;
    expect(() => validateManifests([{ ...manifest, subscriptions: { ...manifest.subscriptions, 'catalog.changed.v1': h } }])).toThrow('catalog.changed.v1');
    expect(() => validateManifests([{ ...manifest, tasks: { ...manifest.tasks, 'lab.steal': h } }])).toThrow('lab.steal');
    expect(() => validateManifests([{ ...manifest, crontab: [...(manifest.crontab ?? []), { identifier: 'analytics.nope', schedule: '* * * * *', tenantScope: 'per_tenant' }] }]))
      .toThrow('analytics.nope');
  });
});
