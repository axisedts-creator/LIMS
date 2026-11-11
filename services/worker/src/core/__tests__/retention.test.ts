// core.retention_purge (02-TRD §7.6; AC-0D-5.16; 08 A25 D-200). The five app.purge_*() DEFINERs are simulated by the fake world:
// batched delete loop with a 4-minute cap read from an injectable (fault-injected) clock; the metric `table` label is the function
// name without `app.purge_` (idempotency_keys, event_log, event_inboxes, dead_letters, ratelimit_counters).
import { describe, expect, it } from 'vitest';
import { CORE_ACTOR, PURGE_TABLES, makeSimClock, rejects, setup } from './helpers.js';

const ROWS = 10_500;                                   // AC-0D-5.16: "10,000+ row expired seed per table"
async function seeded(clock = makeSimClock()) {
  const s = await setup([], { clock });
  for (const t of PURGE_TABLES) s.world.seedPurge(t, ROWS);
  return s;
}
const purgeTxs = (s: Awaited<ReturnType<typeof seeded>>) => s.world.txLog.filter((t) => t.stmts.some((x) => /app\.purge_/i.test(x.text)));

describe('AC-0D-5.16: core.retention_purge', () => {
  it('declares taskOptions statementTimeoutMs 300000 and max_attempts 5, platform scope', async () => {
    const s = await seeded();
    expect(s.built.taskOptions['core.retention_purge']).toEqual({ statementTimeoutMs: 300000 });
    expect(s.entry('core.retention_purge')).toMatchObject({ kind: 'core', scope: 'platform', maxAttempts: 5 });
  });

  it('runs every purge function in its OWN transaction with statement_timeout = 300000 under core (platform) claims', async () => {
    const s = await seeded();
    await s.run('core.retention_purge', {});
    const txs = purgeTxs(s);
    expect(txs).toHaveLength(5);
    for (const t of txs) {
      expect(t.stmts.filter((x) => /app\.purge_/i.test(x.text))).toHaveLength(1);       // one purge per transaction
      expect(t.statementTimeoutMs).toBe(300000);
      expect(t.outcome).toBe('commit');
      expect(t.claims0.tenant_id).toBeUndefined();
      expect(t.claims0.sub).toBe(CORE_ACTOR);
    }
    const names = txs.map((t) => /app\.(purge_\w+)\s*\(/i.exec(t.stmts.find((x) => /app\.purge_/i.test(x.text))!.text)![1]).sort();
    expect(names).toEqual(['purge_dead_letters', 'purge_event_inboxes', 'purge_event_log', 'purge_idempotency_keys', 'purge_ratelimit_counters']);
  });

  it('calls the purge functions without arguments (the 90-day predicates live in the functions, A12.4/A15.4)', async () => {
    const s = await seeded();
    await s.run('core.retention_purge', {});
    for (const st of s.world.stmtsMatching(/app\.purge_/i)) {
      expect(st.text).toMatch(/app\.purge_\w+\(\s*\)/i);
      expect(st.values).toEqual([]);
    }
  });

  it('a 10,000+ row expired seed per table is fully deleted; deleted is exported as lims_core_retention_purged_total{table} and logged', async () => {
    const s = await seeded();
    await s.run('core.retention_purge', {});
    for (const t of PURGE_TABLES) {
      expect(s.world.purge[t]).toBe(0);
      expect(s.metrics.total('lims_core_retention_purged_total', { table: t })).toBe(ROWS);
      expect(s.metrics.total('lims_core_retention_purge_capped_total', { table: t })).toBe(0);
      expect(s.logs.lines.some((l) => { const j = JSON.stringify(l.args); return j.includes(t) && j.includes(String(ROWS)); })).toBe(true);
    }
  });

  it('fault-injected clock: a function that hits the 4-minute cap returns capped = true, increments the capped metric, and the next run resumes', async () => {
    const clock = makeSimClock();
    const s = await seeded(clock);
    clock.jumpAfter('event_log', 3, 241_000);                 // clock jumps 4m01s after the 3rd batch of event_log only
    await expect(s.run('core.retention_purge', {})).resolves.toBeUndefined();          // capped is not a failure

    expect(s.world.purge['event_log']).toBe(ROWS - 3 * 1000);                          // stopped at the cap, rows remain
    expect(s.metrics.total('lims_core_retention_purged_total', { table: 'event_log' })).toBe(3000);
    expect(s.metrics.total('lims_core_retention_purge_capped_total', { table: 'event_log' })).toBe(1);
    for (const t of PURGE_TABLES.filter((x) => x !== 'event_log')) {
      expect(s.world.purge[t]).toBe(0);
      expect(s.metrics.total('lims_core_retention_purge_capped_total', { table: t })).toBe(0);
    }
    expect(s.world.deadLetters).toHaveLength(0);

    clock.clearFaults();                                                               // "next day's run continues"
    await s.run('core.retention_purge', {}, { attempts: 1 });
    expect(s.world.purge['event_log']).toBe(0);
    expect(s.metrics.total('lims_core_retention_purged_total', { table: 'event_log' })).toBe(ROWS);   // 3000 + 7500 = whole seed, nothing twice
    expect(s.metrics.total('lims_core_retention_purge_capped_total', { table: 'event_log' })).toBe(1);  // not capped again
  });

  it('a cap hit right after the first batch deletes only that batch and is counted', async () => {
    const clock = makeSimClock();
    const s = await seeded(clock);
    clock.jumpAfter('dead_letters', 1, 241_000);
    await s.run('core.retention_purge', {});
    expect(s.world.purge['dead_letters']).toBe(ROWS - 1000);
    expect(s.metrics.total('lims_core_retention_purge_capped_total', { table: 'dead_letters' })).toBe(1);
  });

  it('a failing purge rolls back only its own transaction and the task rethrows; the other purges are committed, one per transaction', async () => {
    const s = await seeded();
    s.world.failPurge('dead_letters', () => new Error('purge failed'));
    await rejects(s.run('core.retention_purge', {}));
    for (const t of purgeTxs(s)) {
      expect(t.stmts.filter((x) => /app\.purge_/i.test(x.text))).toHaveLength(1);
      const failing = t.stmts.some((x) => /purge_dead_letters/i.test(x.text));
      expect(t.outcome).toBe(failing ? 'rollback' : 'commit');
    }
    expect(s.metrics.total('lims_core_retention_purged_total', { table: 'dead_letters' })).toBe(0);
  });

  it('metrics carry only the table label (no tenant or row identifiers)', async () => {
    const s = await seeded();
    await s.run('core.retention_purge', {});
    const calls = s.metrics.calls.filter((c) => /retention/.test(c.name));
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => Object.keys(c.labels).join() === 'table')).toBe(true);
  });
});
