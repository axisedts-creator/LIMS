// AN-T06 (C8) - analytics.purge (02-TRD §9.5, 05-SCHEMA §3/§716; 08 A17 P-18(c); PRD US-20 retention). Retention boundaries.
// ASSUMED API: services/worker/src/jobs/analytics/tasks/purge.ts -> `export const purgeTask: TaskHandler`; payload `{ tenant_id }` == ctx.tenantId; system actor.
//   - batches of 10,000 rows per statement: `DELETE FROM analytics.<t> WHERE ctid IN (SELECT ctid FROM analytics.<t> WHERE tenant_id = $1 AND <predicate> LIMIT 10000)`,
//     repeated until a batch deletes < 10,000 rows (the LIMIT may be a literal or a bound parameter);
//   - E tables (order_index, refresh_runs, report_runs, report_run_recipients): `expires_at < now()`; exports (metadata): `requested_at < now() - 400 days` (NOT expires_at,
//     which is the FILE expiry); export_files: `expires_at` or downloads exhausted, parent exports.status -> 'expired';
//   - R tables (15 daily_* + tat_facts): `business_date < $cutoff` (ISO date bound) with cutoff = fiscalYearBs(today - retentionYears years).startsOn,
//     retentionYears from ctx.ports.IdentityPort.getTenantSettings(ctx, { keys: ['retentionYears'] }); tat_facts keep 3 fiscal years [CONV];
//   - report_backlog has NO business_date column (05-SCHEMA): it is never purged by business_date (TRD §9.5 lists it in the R row - spec slip, see notes);
//   - schedules, schedule_recipients, dirty_partitions, refresh_state, event_inbox are never deleted.
import { describe, expect, it } from 'vitest';
import { fiscalYearBs, type IsoDate } from '../../../../../../packages/shared-ts/src/bsdate/index.js';
import { purgeTask } from '../tasks/purge.js';
import { DAY, FAMILY_TABLE, R_TABLES, TA, TB, addDays, createWorld, localDate, type Row, type World } from './tasksFake.js';

const NOW = '2026-11-08T21:15:00.000Z';              // 03:00 local on 2026-11-09
const TODAY = localDate(NOW);
const world = (o: Parameters<typeof createWorld>[0] = {}) => { const w = createWorld({ now: NOW, ...o }); w.purgeMode = true; return w; };
const run = (w: World, payload: Record<string, unknown> = { tenant_id: TA }) => purgeTask(payload as never, w.ctx);
const at = (offsetMs: number) => new Date(Date.parse(NOW) + offsetMs).toISOString();
const ids = (rows: Row[]) => rows.map((r) => r.id).sort();
const YEARS_AGO = (years: number) => String(Number(TODAY.slice(0, 4)) - years) + TODAY.slice(4);
const cutoffOf = (years: number) => fiscalYearBs(YEARS_AGO(years) as IsoDate).startsOn as string;

describe('E tables: expires_at < now() (strict), tenant-scoped', () => {
  for (const table of ['order_index', 'refresh_runs', 'report_runs', 'report_run_recipients']) {
    it(`${table}: expired rows go; a row expiring exactly now, a future row and another tenant's expired row survive`, async () => {
      const w = world();
      w.rows[table] = [
        { id: 'past', tenant: TA, expires_at: at(-DAY) }, { id: 'just-past', tenant: TA, expires_at: at(-1000) },
        { id: 'boundary', tenant: TA, expires_at: at(0) }, { id: 'future', tenant: TA, expires_at: at(DAY) },
        { id: 'other-tenant', tenant: TB, expires_at: at(-DAY) },
      ];
      await run(w);
      expect(ids(w.rows[table]!)).toEqual(['boundary', 'future', 'other-tenant']);
      const stmts = w.purges.filter((p) => p.table === table);
      expect(stmts.length).toBeGreaterThanOrEqual(1);
      for (const s of stmts) expect(s.text).toMatch(/\bexpires_at\s*<\s*(now\(\)|clock_timestamp\(\)|current_timestamp|\$\d+)/i);
    });
  }

  it('re-running is a no-op (idempotent) and never throws on empty tables', async () => {
    const w = world();
    w.rows['refresh_runs'] = [{ id: 'past', tenant: TA, expires_at: at(-DAY) }];
    await run(w); await run(w);
    expect(w.rows['refresh_runs']).toEqual([]);
  });
});

describe('batching (P-18(c), 05-SCHEMA: 10,000-row batches per statement)', () => {
  const many = (n: number): Row[] => Array.from({ length: n }, (_, i) => ({ id: `r${i}`, tenant: TA, expires_at: at(-DAY) }));

  it('25,000 expired rows -> 3 statements of 10,000 / 10,000 / 5,000, each with a ctid + LIMIT 10000 shape', async () => {
    const w = world();
    w.rows['order_index'] = many(25_000);
    await run(w);
    const p = w.purges.filter((x) => x.table === 'order_index');
    expect(p.map((x) => x.deleted)).toEqual([10_000, 10_000, 5_000]);
    for (const s of p) { expect(s.text).toMatch(/ctid/i); expect(s.text + JSON.stringify(s.values)).toMatch(/\b10000\b/); }
    expect(w.rows['order_index']).toEqual([]);
    expect(w.unbatched).toEqual([]);
  });

  it('exactly 20,000 expired rows terminates (no endless loop on an empty last batch) and removes them all', async () => {
    const w = world();
    w.rows['report_runs'] = many(20_000);
    await run(w);
    const p = w.purges.filter((x) => x.table === 'report_runs');
    expect(p.length).toBeLessThanOrEqual(3);
    expect(p.every((x) => x.deleted <= 10_000)).toBe(true);
    expect(w.rows['report_runs']).toEqual([]);
  });

  it('a future row in the middle of a big expired set is never deleted by a batch', async () => {
    const w = world();
    const rows = many(10_500); rows.splice(5_000, 0, { id: 'future', tenant: TA, expires_at: at(DAY) });
    w.rows['order_index'] = rows;
    await run(w);
    expect(ids(w.rows['order_index']!)).toEqual(['future']);
  });
});

describe('exports', () => {
  it('exports metadata: deleted by requested_at older than 400 days (strict), never by expires_at (the file expiry)', async () => {
    const w = world();
    w.rows['exports'] = [
      { id: 'old', tenant: TA, requested_at: at(-401 * DAY) }, { id: 'edge', tenant: TA, requested_at: at(-400 * DAY) },
      { id: 'recent', tenant: TA, requested_at: at(-399 * DAY) }, { id: 'old-other', tenant: TB, requested_at: at(-500 * DAY) },
    ];
    await run(w);
    expect(ids(w.rows['exports']!)).toEqual(['edge', 'old-other', 'recent']);
    const stmt = w.purges.find((p) => p.table === 'exports')!;
    expect(stmt.text).toMatch(/requested_at/i);
    expect(stmt.text).not.toMatch(/expires_at/i);
  });

  it('export_files: deleted at expires_at or when downloads are exhausted; the parent export becomes status expired', async () => {
    const w = world();
    await run(w);
    const del = w.texts.find((t) => /^\s*DELETE\s+FROM\s+analytics\.export_files\b/i.test(t));
    expect(del, 'a DELETE on analytics.export_files').toBeTruthy();
    expect(del).toMatch(/expires_at/i);
    expect(del).toMatch(/downloads_used\s*>=\s*downloads_allowed|downloads_allowed\s*<=\s*downloads_used/i);
    expect(w.texts.some((t) => /^\s*UPDATE\s+analytics\.exports\b[\s\S]*'expired'/i.test(t))).toBe(true);
  });
});

describe('R tables: business_date < FY-start cutoff (retentionYears from IdentityPort, default 5)', () => {
  it('the 15 daily_* rollups keep retentionYears + the current FY: the day before the cutoff goes, the cutoff day stays', async () => {
    const w = world({ retentionYears: 5 });
    const cutoff = cutoffOf(5);
    for (const t of R_TABLES.filter((x) => x !== 'tat_facts')) w.rows[t] = [
      { id: 'before', tenant: TA, business_date: addDays(cutoff, -1) }, { id: 'on', tenant: TA, business_date: cutoff },
      { id: 'after', tenant: TA, business_date: addDays(cutoff, 1) }, { id: 'recent', tenant: TA, business_date: addDays(TODAY, -1) },
      { id: 'other', tenant: TB, business_date: addDays(cutoff, -400) },
    ];
    await run(w);
    for (const t of R_TABLES.filter((x) => x !== 'tat_facts')) expect(ids(w.rows[t]!), t).toEqual(['after', 'on', 'other', 'recent']);
  });

  it('retentionYears is honoured: 7 years moves the cutoff back (a row between the 5- and 7-year cutoffs survives)', async () => {
    const w = world({ retentionYears: 7 });
    w.rows['daily_income'] = [{ id: 'six-years', tenant: TA, business_date: cutoffOf(6) }, { id: 'eight-years', tenant: TA, business_date: addDays(cutoffOf(8), -1) }];
    await run(w);
    expect(ids(w.rows['daily_income']!)).toEqual(['six-years']);
  });

  it('the settings are read through the IdentityPort with the retentionYears key', async () => {
    const w = world();
    let seen: unknown;
    const orig = w.ctx.ports.IdentityPort.getTenantSettings;
    w.ctx.ports.IdentityPort.getTenantSettings = async (c: unknown, i: { keys: readonly string[] }) => { seen = i; return orig(c, i); };
    await run(w);
    expect((seen as { keys: string[] }).keys).toContain('retentionYears');
  });

  it('fail closed: a missing / zero / negative / fractional / non-numeric retentionYears deletes NOTHING and rejects', async () => {
    for (const bad of [undefined, 0, -1, 2.5, NaN, '5', null, Infinity]) {
      const w = world({ retentionYears: bad });
      w.rows['daily_income'] = [{ id: 'old', tenant: TA, business_date: '2000-01-01' }];
      w.rows['order_index'] = [{ id: 'past', tenant: TA, expires_at: at(-DAY) }];
      await expect(run(w), String(bad)).rejects.toBeTruthy();
      expect(w.rows['daily_income']!.length, String(bad)).toBe(1);
    }
  });

  it('tat_facts keep 3 fiscal years [CONV]: a 4-year-old fact goes (older than the rollup cutoff would keep it), a 1-year-old fact stays', async () => {
    const w = world({ retentionYears: 5 });
    w.rows['tat_facts'] = [
      { id: 'four-years', tenant: TA, business_date: YEARS_AGO(4) }, { id: 'one-year', tenant: TA, business_date: YEARS_AGO(1) },
      { id: 'other', tenant: TB, business_date: YEARS_AGO(9) },
    ];
    await run(w);
    expect(ids(w.rows['tat_facts']!)).toEqual(['one-year', 'other']);
  });

  it('report_backlog (no business_date column) is never deleted by business_date', async () => {
    const w = world();
    await run(w);
    expect(w.backlogPurges.filter((t) => /business_date/i.test(t))).toEqual([]);
  });
});

describe('scope and trust', () => {
  it('every purge statement is bound to the job tenant; nothing runs unscoped, unbatched, or against a non-purge table', async () => {
    const w = world();
    for (const t of ['order_index', 'refresh_runs', 'report_runs', 'report_run_recipients']) w.rows[t] = [{ id: `${t}-past`, tenant: TA, expires_at: at(-DAY) }];
    await run(w);
    expect(w.purges.length).toBeGreaterThan(0);
    for (const p of w.purges) expect(p.values.filter((v) => typeof v === 'string' && /^[0-9a-f]{8}-/.test(v)), p.table).toEqual([TA]);
    expect(w.unscoped).toEqual([]); expect(w.unbatched).toEqual([]);
    expect(w.forbidden).toEqual([]);
    expect(w.texts.filter((t) => /schedules|schedule_recipients|event_inbox|refresh_state|dirty_partitions/i.test(t) && /^\s*(DELETE|TRUNCATE)/i.test(t))).toEqual([]);
    expect(w.texts.filter((t) => /^\s*TRUNCATE\b/i.test(t))).toEqual([]);
  });

  it('payload trust: bad / foreign tenant payloads are refused before any statement', async () => {
    for (const payload of [{}, { tenant_id: '' }, { tenant_id: 'x' }, { tenant_id: TB }, { tenant_id: ["' OR 1=1"] }]) {
      const w = world({ tenantId: TA });
      w.rows['order_index'] = [{ id: 'past', tenant: TB, expires_at: at(-DAY) }, { id: 'past-a', tenant: TA, expires_at: at(-DAY) }];
      await expect(run(w, payload), JSON.stringify(payload)).rejects.toBeTruthy();
      expect(w.texts).toEqual([]); expect(w.rows['order_index']!.length).toBe(2);
    }
  });

  it('a failing DELETE rejects the task (retried by Graphile); it is not swallowed', async () => {
    const w = world();
    w.rows['order_index'] = [{ id: 'past', tenant: TA, expires_at: at(-DAY) }];
    const orig = w.ctx.tx.query;
    w.ctx.tx.query = async (t: string, v?: unknown[]) => { if (/DELETE\s+FROM\s+analytics\.order_index/i.test(t)) throw Object.assign(new Error('boom'), { code: '57014' }); return orig(t, v); };
    const od = w.ctx.db.tx;
    w.ctx.db.tx = (fn: (c: any) => Promise<unknown>) => od((c: any) => fn({ tx: { query: (t: string, v?: unknown[]) => (/DELETE\s+FROM\s+analytics\.order_index/i.test(t) ? Promise.reject(Object.assign(new Error('boom'), { code: '57014' })) : c.tx.query(t, v)) } }));
    await expect(run(w)).rejects.toMatchObject({ code: '57014' });
  });
});

export { FAMILY_TABLE };
