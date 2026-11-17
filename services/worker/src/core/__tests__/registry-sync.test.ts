// registry-sync.ts (02-TRD §7.7): deploy-time step run as lims_migrator -> SET LOCAL ROLE lims_owner; upserts the full identifier set into
// core.g_task_registry and deactivates removed identifiers (is_active = false, never deleted so queued jobs still resolve).
// syncRegistry(client, entries) with client = { query(text, values) } (pg client); entries = buildTaskList(...).registry.
import { describe, expect, it } from 'vitest';
import { ORDER_CREATED, evtId, setup } from './helpers.js';

const noop = async () => undefined;

function fakeClient(existing: string[] = []) {
  const stmts: Array<{ text: string; values: unknown[] }> = [];
  return {
    stmts,
    async query(text: string, values: unknown[] = []) {
      const t = text.replace(/\s+/g, ' ').trim();
      stmts.push({ text: t, values });
      if (/^SELECT[\s\S]*FROM\s+core\.g_task_registry/i.test(t)) return { rows: existing.map((identifier) => ({ identifier, is_active: true })) };
      return { rows: [] };
    },
  };
}

async function entries() {
  const s = await setup([
    { module: 'lab', subscriptions: { [ORDER_CREATED]: noop }, tasks: { 'lab.rescan': noop } },
    { module: 'reporting', tasks: { 'reporting.nightly_digest': noop }, crontab: [{ identifier: 'reporting.nightly_digest', schedule: '0 2 * * *', tenantScope: 'per_tenant' }] },
  ]);
  return s.built.registry as any[];
}

describe('syncRegistry', () => {
  it('computes core tasks + module tasks + evt.<m>.<event> and writes every identifier', async () => {
    const { syncRegistry } = await import('../registry-sync.js');
    const reg = await entries();
    const wanted = ['core.event_fanout', 'core.retention_purge', 'core.queue_depth_probe', 'lab.rescan', 'reporting.nightly_digest', evtId('lab')];
    for (const id of wanted) expect(reg.map((e) => e.identifier)).toContain(id);
    const c = fakeClient();
    await syncRegistry(c, reg);
    const written = JSON.stringify(c.stmts.filter((s) => /INSERT\s+INTO\s+core\.g_task_registry/i.test(s.text)).map((s) => s.values));
    for (const id of wanted) expect(written).toContain(id);
  });

  it('runs inside one transaction as lims_owner (SET LOCAL ROLE) before any registry write', async () => {
    const { syncRegistry } = await import('../registry-sync.js');
    const c = fakeClient();
    await syncRegistry(c, await entries());
    const texts = c.stmts.map((s) => s.text);
    const role = texts.findIndex((t) => /SET\s+LOCAL\s+ROLE\s+lims_owner/i.test(t));
    const firstWrite = texts.findIndex((t) => /INSERT\s+INTO\s+core\.g_task_registry/i.test(t));
    expect(role).toBeGreaterThanOrEqual(0);
    expect(role).toBeLessThan(firstWrite);
    expect(texts[0]).toMatch(/^BEGIN/i);
    expect(texts.at(-1)).toMatch(/^COMMIT/i);
  });

  it('upsert is idempotent and re-activates a previously deactivated identifier', async () => {
    const { syncRegistry } = await import('../registry-sync.js');
    const c = fakeClient();
    await syncRegistry(c, await entries());
    const up = c.stmts.find((s) => /INSERT\s+INTO\s+core\.g_task_registry/i.test(s.text))!;
    expect(up.text).toMatch(/ON\s+CONFLICT\s*\(\s*identifier\s*\)\s*DO\s+UPDATE/i);
    expect(up.text).toMatch(/is_active\s*=\s*(true|EXCLUDED\.is_active)/i);
  });

  it('removed identifiers are deactivated, never deleted (old queued jobs must still resolve)', async () => {
    const { syncRegistry } = await import('../registry-sync.js');
    const c = fakeClient(['old.removed_task', evtId('lab')]);
    await syncRegistry(c, await entries());
    expect(c.stmts.some((s) => /DELETE|TRUNCATE|DROP/i.test(s.text))).toBe(false);
    const deact = c.stmts.filter((s) => /UPDATE\s+core\.g_task_registry/i.test(s.text) && /is_active\s*=\s*false/i.test(s.text));
    expect(deact.length).toBeGreaterThan(0);
    expect(deact.some((s) => JSON.stringify(s.values).includes('old.removed_task') || /<>\s*ALL|NOT\s+IN|<>\s*ANY/i.test(s.text))).toBe(true);
    expect(JSON.stringify(deact.map((s) => s.values))).not.toContain(evtId('lab') + '"]');   // a still-wanted id is not in the "to deactivate" list
  });

  it('a failure rolls the whole sync back (no half-written registry)', async () => {
    const { syncRegistry } = await import('../registry-sync.js');
    const c = fakeClient();
    const q = c.query.bind(c);
    c.query = async (t: string, v?: unknown[]) => { if (/INSERT\s+INTO\s+core\.g_task_registry/i.test(t)) throw new Error('disk full'); return q(t, v); };
    await expect(syncRegistry(c, await entries())).rejects.toThrow('disk full');
    expect(c.stmts.map((s) => s.text).some((t) => /^ROLLBACK/i.test(t))).toBe(true);
    expect(c.stmts.map((s) => s.text).some((t) => /^COMMIT/i.test(t))).toBe(false);
  });
});
