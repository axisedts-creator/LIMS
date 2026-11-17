// C13 T01 — worker manifest CI check (06-IMPLEMENTATION-PLAN row T01; 02-TRD §3.5, §7.2, §8.1, §8.2; C0 TRD §7.2).
// done_when: "worker manifest loads". Expects ../index.ts to `export const manifest: WorkerManifest` (module 'partners'; SEAM: export name `manifest`).
// Subscriptions = the 4 events whose IC §3.25 "Consumers" cell lists C13 = EVENT_CONSUMERS.partners = TRD §7.2.
// Tasks = TRD §8.1 (9 tasks). Crontab = TRD §8.2 (6 rows, all per_tenant); TRD gives Asia/Kathmandu local times, the manifest holds 5 UTC fields
// (core validateManifests), so schedules are compared after converting UTC -> Asia/Kathmandu (UTC+05:45, no DST).
// SEAM: TRD gives no §9.4-style literal for maxAttempts; this test pins only what §8.1 states (10 or 3) and only for entries the manifest declares.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EVENT_CONSUMERS } from '../../../../../../contracts/ports/generated/events.js';
import { REPO_ROOT } from '../../../../../api/src/core/module.js';
import { setup } from '../../../core/__tests__/helpers.js';
import { validateManifests } from '../../../core/manifest.js';
import { manifest } from '../index.js';

const TASKS = [
  'partners.convert_manifest_line', 'partners.sync_price_list', 'partners.sync_statements', 'partners.reconcile_orders',
  'partners.expire_drafts', 'partners.redact_expired_lines', 'partners.enrich_report', 'partners.issue_access_slip',
  'partners.purge_access_slips',
];
/** TRD §8.2: Asia/Kathmandu local schedule. `h: '*'` = every hour at minute m; `step` = every N minutes. */
const CRON_LOCAL: Record<string, { h?: number | '*'; m?: number; step?: number }> = {
  'partners.sync_price_list': { h: 2, m: 10 },
  'partners.sync_statements': { h: '*', m: 23 },
  'partners.reconcile_orders': { step: 10 },
  'partners.expire_drafts': { h: 1, m: 40 },
  'partners.redact_expired_lines': { h: 2, m: 40 },
  'partners.purge_access_slips': { h: 2, m: 50 },
};
const SUBSCRIPTIONS = [
  'catalog.changed.v1', 'frontdesk.order.cancelled.v1', 'lab.specimen.status_changed.v1', 'reporting.report.released.v1',
];
/** TRD §8.1 "Attempts" column. */
const ATTEMPTS: Record<string, number> = {
  'partners.convert_manifest_line': 10, 'partners.enrich_report': 10, 'partners.sync_price_list': 10, 'partners.sync_statements': 10,
  'partners.reconcile_orders': 10, 'partners.issue_access_slip': 10,
  'partners.expire_drafts': 3, 'partners.redact_expired_lines': 3, 'partners.purge_access_slips': 3,
};

/** Event types in IC §3.25 whose Consumers cell contains the token C13. */
function icConsumedByC13(): string[] {
  const text = readFileSync(join(REPO_ROOT, 'spec', 'program', '03-INTERFACE-CATALOG.md'), 'utf8');
  const start = text.indexOf('### 3.25 Event summary matrix');
  const end = text.indexOf('\n### 3.26', start);
  expect(start, 'IC §3.25 heading not found').toBeGreaterThan(-1);
  expect(end, 'IC §3.26 heading not found').toBeGreaterThan(start);
  const out: string[] = [];
  for (const line of text.slice(start, end).split('\n')) {
    const cells = line.split('|').map((c) => c.trim());
    const m = /^([a-z_]+(?:\.[a-z_]+)+\.v\d+)\b/.exec(cells[2] ?? '');
    if (m && /\bC13\b/.test(cells[4] ?? '')) out.push(m[1]!);
  }
  return out;
}

/** UTC 5-field cron -> Asia/Kathmandu (+5:45) daily/hourly/step description comparable with CRON_LOCAL. */
function toLocal(schedule: string): { h?: number | '*'; m?: number; step?: number } {
  const [min, hour, dom, mon, dow] = schedule.trim().split(/\s+/);
  expect([dom, mon, dow], `${schedule}: only daily/hourly/step schedules expected`).toEqual(['*', '*', '*']);
  const step = /^\*\/(\d+)$/.exec(min!);
  if (step) { expect(hour).toBe('*'); return { step: Number(step[1]) }; }
  const utcMin = Number(min);
  const local = (utcMin + 45) % 60;
  const carry = utcMin + 45 >= 60 ? 1 : 0;
  if (hour === '*') return { h: '*', m: local };
  return { h: (Number(hour) + 5 + carry) % 24, m: local };
}

describe('T01 worker manifest (partners)', () => {
  it('is module partners and passes the build-time manifest checks (validateManifests)', () => {
    expect(manifest.module).toBe('partners');
    expect(() => validateManifests([manifest])).not.toThrow();
  });

  it('the IC §3.25 parse finds the 4 C13 events (guards the comparison below against an empty parse)', () => {
    expect(icConsumedByC13().sort()).toEqual(SUBSCRIPTIONS);
  });

  it('subscriptions equal IC §3.25 C13 consumer list and EVENT_CONSUMERS.partners (no extra, none missing)', () => {
    const subs = Object.keys(manifest.subscriptions ?? {}).sort();
    expect(subs).toEqual(icConsumedByC13().sort());
    expect(subs).toEqual([...(EVENT_CONSUMERS.partners ?? [])].sort());
    expect(subs).toHaveLength(4);
  });

  it('every subscription has a handler function, and none is one of its own events (C13 produces nothing)', () => {
    for (const [type, h] of Object.entries(manifest.subscriptions ?? {})) {
      expect(typeof h, type).toBe('function');
      expect(type.startsWith('partners.'), type).toBe(false);
    }
  });

  it('declares exactly the 9 TRD §8.1 tasks, all partners.* with a handler', () => {
    expect(Object.keys(manifest.tasks ?? {}).sort()).toEqual([...TASKS].sort());
    for (const [id, h] of Object.entries(manifest.tasks ?? {})) {
      expect(id).toMatch(/^partners\.[a-z0-9_]+$/);
      expect(typeof h, id).toBe('function');
    }
  });

  /** ids whose stub a later task has replaced; that task moves its ids here (tester-owned list). */
  const IMPLEMENTED: readonly string[] = ['partners.expire_drafts', 'partners.redact_expired_lines', 'partners.issue_access_slip', 'partners.purge_access_slips']; // T21, T14
  it('T01 stubs fail closed: a not-yet-implemented task/consumer rejects (retry / dead-letter), never silently acks', async () => {
    const ctx = { tenantId: '01940e00-0000-7000-8000-c13000000001', actor: { type: 'system', id: 'partners' }, requestId: 'r', tx: {}, db: { tx: async (f: any) => f(ctx) } } as any;
    for (const [id, h] of Object.entries(manifest.tasks ?? {}).filter(([k]) => !IMPLEMENTED.includes(k))) await expect(h({ tenant_id: ctx.tenantId }, ctx), id).rejects.toThrow();
    for (const [type, h] of Object.entries(manifest.subscriptions ?? {}).filter(([k]) => !IMPLEMENTED.includes(k))) await expect(h({ event_id: 'e', type }, ctx), type).rejects.toThrow();
  });

  it('crontab = the six TRD §8.2 rows, all per_tenant (no platform cron), schedule = TRD local time in UTC', () => {
    const cron = manifest.crontab ?? [];
    expect(cron.map((c) => c.identifier).sort()).toEqual(Object.keys(CRON_LOCAL).sort());
    for (const c of cron) {
      expect(c.tenantScope, c.identifier).toBe('per_tenant');
      expect(toLocal(c.schedule), c.identifier).toEqual(CRON_LOCAL[c.identifier]);
    }
  });

  it('event/enqueue-driven tasks are never cron-driven (convert, enrich, access slip)', () => {
    const ids = (manifest.crontab ?? []).map((c) => c.identifier);
    for (const t of ['partners.convert_manifest_line', 'partners.enrich_report', 'partners.issue_access_slip']) expect(ids).not.toContain(t);
  });

  it('declared maxAttempts only name known tasks and equal the TRD §8.1 Attempts column', () => {
    for (const [id, n] of Object.entries(manifest.maxAttempts ?? {})) {
      expect(TASKS, id).toContain(id);
      expect(n, id).toBe(ATTEMPTS[id]);
    }
    for (const id of Object.keys(manifest.taskOptions ?? {})) expect(TASKS, id).toContain(id);
  });

  it('the built task list registers every task per_tenant, the six crons, and one consumer per subscription', async () => {
    const s = await setup([manifest]);
    for (const id of TASKS) expect(s.entry(id), id).toMatchObject({ module: 'partners', kind: 'task', scope: 'per_tenant' });
    for (const id of Object.keys(CRON_LOCAL)) expect(s.built.cronItems.some((x: any) => x.identifier === id), id).toBe(true);
    for (const type of SUBSCRIPTIONS) expect(s.entry(`evt.partners.${type}`), type).toMatchObject({ module: 'partners', kind: 'consumer', scope: 'per_tenant' });
  }, 60_000); // LD-152 load (cold core tasklist import under 12 lanes)

  // Adversarial: the CI check must actually bite (guards the done_when check itself).
  it('validateManifests rejects a drifted manifest: extra subscription, foreign task id, cron on an undeclared task', () => {
    const h = async () => undefined;
    expect(() => validateManifests([{ ...manifest, subscriptions: { ...manifest.subscriptions, 'billing.invoice.issued.v1': h } }])).toThrow('billing.invoice.issued.v1');
    expect(() => validateManifests([{ ...manifest, tasks: { ...manifest.tasks, 'lab.steal': h } }])).toThrow('lab.steal');
    expect(() => validateManifests([{ ...manifest, crontab: [...(manifest.crontab ?? []), { identifier: 'partners.nope', schedule: '* * * * *', tenantScope: 'per_tenant' }] }]))
      .toThrow('partners.nope');
  });
});
