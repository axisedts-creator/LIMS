// AN-T04 service/refresh.service.ts (02-TRD §9.2 partition replace, §9.3 `analytics.refresh_tenant`; PRD US-20.2-4; 05-SCHEMA refresh_state/dirty_partitions/refresh_runs; 08 A17 P-22).
// ASSUMED API (spec fixes SQL + behaviour, not signatures; the writer may dispute via the reviewer):
//   refreshTenant(ctx, { tenantId, trigger?, chunkDays?, backlogLookbackDays? }): Promise<unknown>
//     ctx = the worker JobContext subset { actor:{id}, db:{ tx(fn: (c) => …) } (c.tx.query), now(): ISO string }.
//     SEAM: `run_started_at` = ctx.now() read ONCE, before the marks are read; that same value is the bound `last_marked_at <= $n` guard of every
//           mark delete of the run. trigger defaults to 'event'; chunkDays defaults to 7 (LIMS_ANALYTICS_SWEEP_CHUNK_DAYS).
//     The marks are read in their own short tx (no writes); each contiguous <=chunkDays range of one family is ONE `ctx.db.tx`:
//     pg_advisory_xact_lock first, then the §9.2 replace (via repository/refresh.repo.replacePartition), then the guarded mark delete, then the
//     refresh_state upsert (+ refresh_runs). On failure that tx rolls back, a SEPARATE tx records the failure path, and the original error is rethrown.
// Black-box over SQL text: the model in ./refreshFake.ts classifies statements by their §9.2 shape (see header there). Nothing here needs a DB.
import { describe, expect, it } from 'vitest';
import { FAMILIES, FAMILY_TABLE, SNAPSHOT_DATE, type Family } from '../../domain/families.js';
import { refreshTenant } from '../refresh.service.js';
import { ACTOR, T0, addDay, createCtx, createFakeDb, type HookArg } from './refreshFake.js';

const TA = '01a1a98a-ac40-7000-8000-00000000a001', TB = '01a1a98a-ac40-7000-8000-00000000b001';
const D = '2026-11-01';
const mark = (family: Family, date: string, tenant = TA, last?: string) => ({ tenant, family, date, ...(last ? { last } : {}) });
const run = (fake: ReturnType<typeof createFakeDb>, input: Record<string, unknown> = {}, ctx = createCtx(fake)) =>
  refreshTenant(ctx as never, { tenantId: TA, ...input } as never);
const replaces = (f: ReturnType<typeof createFakeDb>) => f.committed('replace');
const boom = (code = '57014') => Object.assign(new Error('relation failed for patient Sita Rai 9841000000'), { code });
const failOn = (pred: (a: HookArg) => boolean, err: unknown) => (a: HookArg) => { if (pred(a)) throw err; };

describe('refreshTenant: nothing dirty', () => {
  it('no marks -> no replace, no refresh_state, no refresh_runs, no lock; refresh_state is NOT eagerly seeded (P-22)', async () => {
    const f = createFakeDb();
    await run(f);
    expect(f.log.some((l) => ['lock', 'replaceDelete', 'insertRollup', 'deleteMarks', 'stateUpsert', 'runInsert'].includes(l.kind))).toBe(false);
    expect(f.log.some((l) => /analytics\.refresh_state/i.test(l.text))).toBe(false);
  });

  it('marks of another tenant are not read, replaced or deleted', async () => {
    const f = createFakeDb({ marks: [mark('income', D, TB)] });
    await run(f);
    expect(f.log.some((l) => l.kind === 'insertRollup')).toBe(false);
    expect(f.model.marks.size).toBe(1);
  });
});

describe('refreshTenant: one dirty family -> one family-range transaction (§9.3)', () => {
  it('lock first, then replace, guarded mark delete, refresh_state upsert; all in ONE committed tx; marks cleared; partition new', async () => {
    const f = createFakeDb({ marks: [mark('income', D)] });
    await run(f);
    const rep = replaces(f);
    expect(rep).toHaveLength(1);
    expect(rep[0]).toMatchObject({ family: 'income', table: 'daily_income', from: D, to: addDay(D, 1) });
    const txId = rep[0]!.tx;
    const stmts = f.log.filter((l) => l.tx === txId);
    expect(stmts[0]!.kind).toBe('lock');
    const kinds = stmts.map((s) => s.kind);
    expect(kinds.indexOf('replaceDelete')).toBeLessThan(kinds.indexOf('insertRollup'));
    expect(kinds.indexOf('insertRollup')).toBeLessThan(kinds.indexOf('deleteMarks'));
    expect(kinds).toContain('stateUpsert');                       // same tx as the replace: success is recorded atomically with the data
    expect(f.txs[txId]!.status).toBe('committed');
    expect(f.model.partitions.get('daily_income')).toBe('new');
    expect(f.model.marks.size).toBe(0);
  });

  it('advisory lock is pg_advisory_xact_lock(hashtext(\'analytics:\' || tenant || \':\' || family)): xact-scoped, key derived from tenant AND family', async () => {
    const f = createFakeDb({ marks: [mark('income', D), mark('results', D), mark('income', D, TB)] });
    await run(f);
    const ctxB = createCtx(f);
    await refreshTenant(ctxB as never, { tenantId: TB } as never);
    const locks = f.log.filter((l) => l.kind === 'lock');
    expect(locks.length).toBe(3);
    for (const l of locks) {
      expect(l.text).toMatch(/pg_advisory_xact_lock\s*\(\s*hashtext\s*\(/i);
      expect(l.text).not.toMatch(/pg_advisory_lock\b|pg_try_advisory/i);
      expect(l.text).toContain('analytics:');
    }
    const key = (l: (typeof locks)[number]) => l.text + JSON.stringify(l.values);
    expect(new Set(locks.map(key)).size).toBe(3);                 // (A,income) (A,results) (B,income) all different
    expect(JSON.stringify(locks[0]!.values) + locks[0]!.text).toMatch(/income|results/);
    expect(locks.some((l) => (l.text + JSON.stringify(l.values)).includes(TB))).toBe(true);
  });

  it('no row locks on marks or anywhere (no FOR UPDATE/SHARE, no LOCK TABLE); the marks are read in a tx without writes, ordered by family, business_date', async () => {
    const f = createFakeDb({ marks: [mark('income', D), mark('orders', D)] });
    await run(f);
    for (const l of f.log) expect(l.text).not.toMatch(/\bFOR\s+(NO\s+KEY\s+)?(UPDATE|SHARE)\b|\bLOCK\s+TABLE\b|\bSKIP\s+LOCKED\b/i);
    const read = f.log.find((l) => l.kind === 'readMarks')!;
    expect(read.text).toMatch(/ORDER\s+BY\s+family\s*,\s*business_date/i);
    expect(read.text).toMatch(/tenant_id\s*=\s*\$1/i);
    expect(read.values[0]).toBe(TA);
    expect(f.log.filter((l) => l.tx === read.tx && ['replaceDelete', 'insertRollup', 'deleteMarks', 'lock', 'stateUpsert'].includes(l.kind))).toEqual([]);
  });

  it('business_date is read as text (to_char / ::text): a pg DATE parsed into a JS Date shifts a day at UTC+05:45', async () => {
    const f = createFakeDb({ marks: [mark('income', D)] });
    await run(f);
    expect(f.log.find((l) => l.kind === 'readMarks')!.text).toMatch(/business_date\s*::\s*text|to_char\s*\(\s*business_date/i);
  });

  it('refresh_state: lazy INSERT … ON CONFLICT (tenant_id, family) DO UPDATE, success columns, created_by = system actor; only the refreshed family gets a row', async () => {
    const f = createFakeDb({ marks: [mark('income', D)] });
    await run(f);
    const ups = f.committed('state_success');
    expect(ups).toHaveLength(1);
    const u = ups[0]!;
    expect(u.family).toBe('income');
    expect(u.text).toMatch(/INSERT\s+INTO\s+analytics\.refresh_state/i);
    expect(u.text).toMatch(/ON\s+CONFLICT\s*\(\s*tenant_id\s*,\s*family\s*\)\s*DO\s+UPDATE/i);
    expect(u.text).toMatch(/last_success_at/i);
    expect(u.text).toMatch(/consecutive_failures\s*=\s*0/i);
    expect(u.text).toMatch(/last_error_code\s*=\s*NULL/i);
    expect(u.text).toMatch(/last_run_id/i);
    expect(u.text).toMatch(/created_by/i);
    expect(u.values).toContain(ACTOR);
    expect(u.values).toContain(TA);
    expect(f.committed('state_success').concat(f.committed('state_failure')).map((e) => e.family)).toEqual(['income']);
    expect(f.log.filter((l) => l.kind === 'stateUpsert')).toHaveLength(1);
  });

  it('refresh_runs: one row per family-range with trigger, range, rows_written, expires_at = started_at + 90 days, status succeeded', async () => {
    const f = createFakeDb({ marks: [mark('income', D)], rowCount: 7 });
    await run(f, { trigger: 'sweep_nightly' });
    const runs = f.committed('run');
    expect(runs.length).toBeGreaterThanOrEqual(1);
    const all = runs.map((r) => r.text).join('\n');
    const vals = runs.flatMap((r) => r.values);
    expect(all).toMatch(/analytics\.refresh_runs/i);
    expect(all).toMatch(/succeeded/i);
    expect(all).toMatch(/expires_at/i);
    expect(/interval\s+'90 days'/i.test(all) || vals.some((v) => typeof v === 'string' && Date.parse(v) === Date.parse(T0) + 90 * 86_400_000)).toBe(true);
    expect(vals).toContain(TA);
    expect(vals).toContain('income');
    expect(vals).toContain('sweep_nightly');
    expect(vals).toContain(D);
    expect(vals).toContain(addDay(D, 1));
    expect(vals).toContain(7);                                    // rows_written = what the INSERT reported
  });

  it('trigger defaults to \'event\'', async () => {
    const f = createFakeDb({ marks: [mark('income', D)] });
    await run(f);
    expect(f.committed('run').flatMap((r) => r.values)).toContain('event');
  });
});

describe('refreshTenant: ranges (contiguous dates per family, chunked, half-open)', () => {
  it('income D1..D3 + D5 -> [D1,D4) and [D5,D6): two transactions', async () => {
    const f = createFakeDb({ marks: ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-05'].map((d) => mark('income', d)) });
    await run(f);
    const rep = replaces(f).filter((e) => e.family === 'income');
    expect(rep.map((e) => [e.from, e.to])).toEqual([['2026-11-01', '2026-11-04'], ['2026-11-05', '2026-11-06']]);
    expect(new Set(rep.map((e) => e.tx)).size).toBe(2);
    expect(f.model.marks.size).toBe(0);
  });

  it('a range never spans a month end gap and handles month rollover (2026-10-30..11-02 is one range)', async () => {
    const f = createFakeDb({ marks: ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02'].map((d) => mark('results', d)) });
    await run(f);
    expect(replaces(f).map((e) => [e.from, e.to])).toEqual([['2026-10-30', '2026-11-03']]);
  });

  it('10 contiguous days with the default chunk (7) -> [d1,d8) then [d8,d11)', async () => {
    const days = Array.from({ length: 10 }, (_, i) => addDay('2026-10-20', i));
    const f = createFakeDb({ marks: days.map((d) => mark('income', d)) });
    await run(f);
    expect(replaces(f).map((e) => [e.from, e.to])).toEqual([['2026-10-20', '2026-10-27'], ['2026-10-27', '2026-10-30']]);
    expect(f.model.marks.size).toBe(0);
  });

  it('chunkDays is honoured (3)', async () => {
    const days = Array.from({ length: 7 }, (_, i) => addDay('2026-10-20', i));
    const f = createFakeDb({ marks: days.map((d) => mark('income', d)) });
    await run(f, { chunkDays: 3 });
    expect(replaces(f).map((e) => [e.from, e.to])).toEqual([['2026-10-20', '2026-10-23'], ['2026-10-23', '2026-10-26'], ['2026-10-26', '2026-10-27']]);
  });

  it('ranges of different families are never merged; each family replaces its own table', async () => {
    const f = createFakeDb({ marks: [mark('income', D), mark('department_income', D), mark('referrer_billing', D)] });
    await run(f);
    expect(replaces(f).map((e) => e.table).sort()).toEqual(['daily_department_income', 'daily_income', 'daily_referrer_billing']);
    expect(new Set(replaces(f).map((e) => e.tx)).size).toBe(3);
  });

  it('report_backlog (snapshot sentinel 1970-01-01): one whole-snapshot replace, never merged into the date ranges of another family', async () => {
    const f = createFakeDb({ marks: [mark('report_backlog', SNAPSHOT_DATE), mark('orders', D)] });
    await run(f);
    const bl = replaces(f).find((e) => e.family === 'report_backlog')!;
    expect(bl.table).toBe('report_backlog');
    expect(bl.text).not.toMatch(/1970/);
    expect(replaces(f).filter((e) => e.family === 'report_backlog')).toHaveLength(1);
    expect(f.model.marks.size).toBe(0);                           // sentinel mark deleted after the snapshot run
  });

  it('every one of the 16 families is replaced from its own mark, into its own table, then its mark is gone', async () => {
    const f = createFakeDb({ marks: FAMILIES.map((fam) => mark(fam, fam === 'report_backlog' ? SNAPSHOT_DATE : D)) });
    await run(f);
    expect(replaces(f).map((e) => e.table).sort()).toEqual(FAMILIES.map((fam) => FAMILY_TABLE[fam]).sort());
    expect(f.model.marks.size).toBe(0);
    expect(f.committed('state_success').map((e) => e.family).sort()).toEqual([...FAMILIES].sort());
  });
});

describe('refreshTenant: marks that arrive during the run survive (US-20.2, §9.2 guard)', () => {
  it('a NEW mark on a neighbouring date inserted mid-run (last_marked_at > run_started_at) is not deleted; the older marks of the range are', async () => {
    const f = createFakeDb({
      marks: [mark('income', '2026-11-01'), mark('income', '2026-11-02')],
      hook: (a) => {
        if (a.kind === 'insertRollup' && !a.model.marks.has(`${TA}|income|2026-11-03`)) {
          a.model.clock.now = '2026-11-08T06:00:05.000Z';
          a.model.marks.set(`${TA}|income|2026-11-03`, { tenant: TA, family: 'income', date: '2026-11-03', first: a.model.clock.now, last: a.model.clock.now });
        }
      },
    });
    await run(f);
    expect([...f.model.marks.keys()]).toEqual([`${TA}|income|2026-11-03`]);
  });

  it('an EXISTING mark re-marked mid-run (ON CONFLICT bumps last_marked_at) survives; an un-bumped sibling in the same range does not', async () => {
    const f = createFakeDb({
      marks: [mark('income', '2026-11-01'), mark('income', '2026-11-02')],
      hook: (a) => {
        if (a.kind === 'insertRollup') {
          a.model.clock.now = '2026-11-08T06:00:07.000Z';
          const m = a.model.marks.get(`${TA}|income|2026-11-02`)!;
          m.last = a.model.clock.now;
        }
      },
    });
    await run(f);
    expect([...f.model.marks.keys()]).toEqual([`${TA}|income|2026-11-02`]);
  });

  it('the guard value is the DB run start (SELECT now() before the marks are read), the same bound value in every mark delete; NOT the worker host clock (review #3)', async () => {
    const f = createFakeDb({
      marks: [mark('income', D), mark('results', D)],
      hook: (a) => { if (a.kind === 'insertRollup') a.model.clock.now = '2026-11-08T06:09:09.000Z'; },
    });
    expect(f.model.hostClock.now).not.toBe(T0);                    // host clock is ahead of the DB clock in this model
    await run(f);
    const iNow = f.log.findIndex((l) => l.kind === 'dbNow');
    const iRead = f.log.findIndex((l) => l.kind === 'readMarks');
    expect(iNow).toBeGreaterThanOrEqual(0);
    expect(iNow).toBeLessThan(iRead);
    expect(f.log[iNow]!.text).toMatch(/now\s*\(\s*\)(\s*::\s*text)?\s+AS\s+run_started_at/i);
    const dels = f.log.filter((l) => l.kind === 'deleteMarks');
    expect(dels).toHaveLength(2);
    for (const d of dels) {
      expect(d.text).toMatch(/last_marked_at\s*<=\s*\$\d+/i);
      expect(d.values).toContain(T0);                              // DB now() at run start
      expect(d.values).not.toContain(f.model.hostClock.now);       // never ctx.now()
      expect(d.values).not.toContain('2026-11-08T06:09:09.000Z');
    }
  });

  it('host clock ahead of the DB: a mark made mid-run (DB now() > run_started_at, but < host time) still survives the delete', async () => {
    const f = createFakeDb({
      marks: [mark('income', '2026-11-01')],
      hook: (a) => {
        if (a.kind === 'insertRollup') {
          a.model.clock.now = '2026-11-08T06:00:02.000Z';          // 58 s before the host clock reads
          a.model.marks.set(`${TA}|income|2026-11-01`, { ...a.model.marks.get(`${TA}|income|2026-11-01`)!, last: a.model.clock.now });
        }
      },
    });
    await run(f);
    expect(f.model.marks.size).toBe(1);
  });

  it('the mark delete is scoped by tenant, family and the range: other families / dates / tenants are untouched', async () => {
    const f = createFakeDb({ marks: [mark('income', D), mark('income', '2026-11-20'), mark('results', D), mark('income', D, TB)] });
    await run(f, { chunkDays: 1 });
    expect([...f.model.marks.keys()]).toEqual([`${TB}|income|${D}`]);   // TA's three marks consumed, tenant B's mark untouched
    const g = createFakeDb({ marks: [mark('income', D, TB), mark('income', D)] });
    await run(g);
    expect([...g.model.marks.keys()]).toEqual([`${TB}|income|${D}`]);   // … tenant B's mark stays
  });
});

describe('refreshTenant: failure mid-run (US-20.4)', () => {
  const marks = [mark('income', '2026-11-01'), mark('income', '2026-11-02')];
  for (const [name, at] of [
    ['during the INSERT of the new partition', (a: HookArg) => a.kind === 'insertRollup'],
    ['at the guarded mark delete (after the data was replaced)', (a: HookArg) => a.kind === 'deleteMarks'],
    ['at the refresh_state upsert (last statement of the tx)', (a: HookArg) => a.kind === 'stateUpsert' && !/consecutive_failures\s*\+\s*1/i.test(a.text)],
  ] as const) {
    it(`${name}: old partition kept, marks kept, success not recorded, error rethrown`, async () => {
      const err = boom();
      const f = createFakeDb({ marks, hook: failOn(at, err) });
      await expect(run(f)).rejects.toMatchObject({ code: '57014' });
      expect(f.model.partitions.get('daily_income') ?? 'old').toBe('old');   // delete+insert rolled back as one
      expect(f.model.marks.size).toBe(2);
      expect(f.committed('replace')).toEqual([]);
      expect(f.committed('state_success')).toEqual([]);
      const failed = f.txs.filter((t) => t.status === 'rolled_back');
      expect(failed.length).toBeGreaterThanOrEqual(1);
    });
  }

  it('failure path = a SEPARATE committed tx: refresh_state upsert with consecutive_failures + 1, last_error_code = the error code, no last_success_at; refresh_runs failed', async () => {
    const f = createFakeDb({ marks, hook: failOn((a) => a.kind === 'insertRollup', boom('57014')) });
    await expect(run(f)).rejects.toBeTruthy();
    const fails = f.committed('state_failure');
    expect(fails).toHaveLength(1);
    const u = fails[0]!;
    const failedTx = f.log.find((l) => l.kind === 'insertRollup')!.tx;
    expect(u.tx).not.toBe(failedTx);
    expect(f.txs[failedTx]!.status).toBe('rolled_back');
    expect(f.txs[u.tx]!.status).toBe('committed');
    expect(u.family).toBe('income');
    expect(u.text).toMatch(/INSERT\s+INTO\s+analytics\.refresh_state/i);
    expect(u.text).toMatch(/ON\s+CONFLICT\s*\(\s*tenant_id\s*,\s*family\s*\)\s*DO\s+UPDATE/i);
    expect(u.text).toMatch(/consecutive_failures\s*=\s*analytics\.refresh_state\.consecutive_failures\s*\+\s*1/i);
    expect(u.text).toMatch(/last_error_code/i);
    expect(u.text).not.toMatch(/last_success_at\s*=/i);
    expect(u.values).toContain('57014');
    expect(u.values).toContain(TA);
    expect(u.values).toContain(ACTOR);
    // the failed tx touched neither partition nor marks in the failure tx
    expect(f.log.filter((l) => l.tx === u.tx).every((l) => ['stateUpsert', 'runInsert', 'runUpdate', 'other'].includes(l.kind))).toBe(true);
    const runs = f.committed('run').filter((r) => /failed/i.test(r.text));
    expect(runs.length).toBeGreaterThanOrEqual(1);
    expect(runs.flatMap((r) => r.values)).toContain('57014');
  });

  it('only the error CODE is stored (<= 64 chars): never the message (it can carry row data / PHI)', async () => {
    const f = createFakeDb({ marks, hook: failOn((a) => a.kind === 'insertRollup', boom('57014')) });
    await expect(run(f)).rejects.toBeTruthy();
    const stored = f.log.filter((l) => l.kind === 'stateUpsert' || l.kind === 'runInsert' || l.kind === 'runUpdate');
    expect(JSON.stringify(stored)).not.toMatch(/Sita|9841000000|relation failed/);
  });

  it('an error without a code still records a short code (<= 64 chars), not undefined/NULL success', async () => {
    const f = createFakeDb({ marks, hook: failOn((a) => a.kind === 'insertRollup', new Error('plain')) });
    await expect(run(f)).rejects.toThrow('plain');
    const u = f.committed('state_failure')[0]!;
    const codes = u.values.filter((v) => typeof v === 'string' && !/^[0-9a-f-]{36}$/.test(v) && v !== 'income');
    expect(codes.length).toBeGreaterThanOrEqual(1);
    for (const c of codes) expect((c as string).length).toBeLessThanOrEqual(64);
  });

  it('if recording the failure itself fails, the ORIGINAL error is what the job sees (Graphile retries on it)', async () => {
    const f = createFakeDb({
      marks,
      hook: (a) => {
        if (a.kind === 'insertRollup') throw boom('57014');
        if (a.kind === 'stateUpsert') throw Object.assign(new Error('recorder down'), { code: '08006' });
      },
    });
    await expect(run(f)).rejects.toMatchObject({ code: '57014' });
    expect(f.model.marks.size).toBe(2);
  });

  it('serialization failure on the TAT subject move (23505, §9.2 statement 3) rolls back and keeps the marks for the retry', async () => {
    const f = createFakeDb({ marks: [mark('tat', D)], hook: failOn((a) => a.kind === 'insertRollup' && a.table === 'tat_facts', boom('23505')) });
    await expect(run(f)).rejects.toMatchObject({ code: '23505' });
    expect(f.model.marks.size).toBe(1);
    expect(f.model.partitions.get('tat_facts') ?? 'old').toBe('old');
    expect(f.committed('state_failure')[0]!.family).toBe('tat');
  });

  it('a later successful run clears the failure: success upsert (consecutive_failures = 0, last_error_code = NULL) and the marks are consumed', async () => {
    let fail = true;
    const f = createFakeDb({ marks, hook: (a) => { if (fail && a.kind === 'insertRollup') throw boom(); } });
    await expect(run(f)).rejects.toBeTruthy();
    fail = false;
    await run(f);
    expect(f.model.marks.size).toBe(0);
    expect(f.committed('state_success')).toHaveLength(1);
    expect(f.model.partitions.get('daily_income')).toBe('new');
  });
});

// Real worker runtime (C0 02-TRD:602, review #1/#2): the task runs in ONE job tx and every `ctx.db.tx` is a SAVEPOINT inside it.
// A statement error aborts the job tx (25P02 for anything issued next) until the failing savepoint is rolled back.
describe('refreshTenant: inside one worker job tx (nested db.tx = savepoint)', () => {
  const marks = [mark('income', '2026-11-01'), mark('results', '2026-11-01')];
  const inJob = async (f: ReturnType<typeof createFakeDb>, input: Record<string, unknown> = {}) => {
    const j = f.job();
    try { await run(f, input, createCtx(f, { db: j.db })); } catch (e) { j.end(e); return { j, err: e }; }
    j.end();
    return { j, err: undefined };
  };

  it('happy path: both family-ranges are savepoints of one job; their effects appear only when the job commits', async () => {
    const f = createFakeDb({ marks });
    const j = f.job();
    await run(f, {}, createCtx(f, { db: j.db }));
    expect(f.committed('replace')).toEqual([]);                    // job not committed yet
    j.end();
    expect(f.committed('replace').map((e) => e.family).sort()).toEqual(['income', 'results']);
    expect(j.scope.abortedStmts).toEqual([]);
    expect(f.model.marks.size).toBe(0);
  });

  it('a failing family-range is rolled back as its own savepoint; the failure is recorded only AFTER that rollback (no statement ever hits an aborted tx, no 25P02)', async () => {
    const f = createFakeDb({ marks, hook: failOn((a) => a.kind === 'insertRollup' && a.table === 'daily_income', boom('57014')) });
    const { j, err } = await inJob(f);
    expect(err).toMatchObject({ code: '57014' });                  // the ORIGINAL error, not 25P02
    expect(j.scope.abortedStmts).toEqual([]);
    const failedTx = f.log.find((l) => l.kind === 'insertRollup' && l.table === 'daily_income')!.tx;
    expect(f.txs[failedTx]!.status).toBe('rolled_back');
    const rec = f.log.filter((l) => l.kind === 'stateUpsert' && /consecutive_failures\s*=\s*analytics\.refresh_state\.consecutive_failures\s*\+\s*1/i.test(l.text));
    expect(rec).toHaveLength(1);                                   // the failure record was actually issued, and accepted (not 25P02)
    expect(rec[0]!.tx).not.toBe(failedTx);
    expect(rec[0]!.values).toContain('57014');
  });

  it('the failing range leaves its own partition and marks untouched at the moment of the rollback (savepoint undo), not just at job end', async () => {
    const f = createFakeDb({ marks: [mark('income', '2026-11-01')], hook: failOn((a) => a.kind === 'deleteMarks', boom()) });
    const { err } = await inJob(f);
    expect(err).toBeTruthy();
    expect(f.model.partitions.get('daily_income') ?? 'old').toBe('old');
    expect(f.model.marks.size).toBe(1);
  });

  it('advisory locks of a range that was rolled back are free again: a later job for the same family-range gets the lock and succeeds', async () => {
    let fail = true;
    const f = createFakeDb({ marks: [mark('income', '2026-11-01')], hook: (a) => { if (fail && a.kind === 'insertRollup') throw boom(); } });
    const first = await inJob(f);
    expect(first.err).toBeTruthy();
    fail = false;
    const second = await inJob(f);
    expect(second.err).toBeUndefined();
    expect(f.committed('replace')).toHaveLength(1);
    expect(f.model.marks.size).toBe(0);
  });
  // NOT asserted here: that the failure record survives the rethrow (refresh_state.last_error_code persisted). In one job tx the rethrow rolls
  // the whole job back; persistence needs an independent tx from C0 — see the CR the reviewer asked the writer to raise (review #1). Re-test after it is ruled.
});

describe('refreshTenant: concurrent runs (advisory lock per family-range tx)', () => {
  it('two simultaneous runs for one tenant never interleave inside a family-range tx; both finish; no tx is rolled back; marks consumed once', async () => {
    const f = createFakeDb({ marks: [mark('income', D), mark('results', D)] });
    const [a, b] = await Promise.allSettled([run(f), run(f)]);
    expect(a.status).toBe('fulfilled');
    expect(b.status).toBe('fulfilled');
    expect(f.txs.filter((t) => t.status === 'rolled_back')).toEqual([]);
    const byKey = new Map<string, { tx: number; first: number; last: number }[]>();
    const lockOf = new Map<number, { key: string; acquiredAt: number }>();
    for (const l of f.log) if (l.kind === 'lock') lockOf.set(l.tx, { key: l.text + JSON.stringify(l.values), acquiredAt: l.acquiredAt! });
    for (const [tx, { key, acquiredAt }] of lockOf) {
      expect(acquiredAt).toBeTypeOf('number');
      const idxs = f.log.map((l, i) => (l.tx === tx ? i : -1)).filter((i) => i >= 0);
      // span starts at lock *acquisition* (a waiting tx may already have issued the lock request itself)
      (byKey.get(key) ?? byKey.set(key, []).get(key)!).push({ tx, first: acquiredAt, last: idxs[idxs.length - 1]! });
    }
    for (const spans of byKey.values()) {
      const s = [...spans].sort((x, y) => x.first - y.first);
      for (let i = 1; i < s.length; i++) expect(s[i]!.first).toBeGreaterThan(s[i - 1]!.last);   // serialised, not overlapping
    }
    expect(f.model.marks.size).toBe(0);
    expect(f.model.partitions.get('daily_income')).toBe('new');
  });

  it('a mark bumped while run 1 replaces survives run 1 and is consumed by the next run (nothing lost)', async () => {
    let injected = false;
    const f = createFakeDb({
      marks: [mark('income', D)],
      hook: (a) => {
        if (a.kind === 'insertRollup' && !injected) {
          injected = true;
          a.model.clock.now = '2026-11-08T06:00:03.000Z';
          a.model.marks.set(`${TA}|income|${D}`, { ...a.model.marks.get(`${TA}|income|${D}`)!, last: a.model.clock.now });
        }
      },
    });
    await run(f);
    expect(f.model.marks.size).toBe(1);                           // bumped mark survived run 1; the next run (clock moved on) will take it
    await run(f);
    expect(f.model.marks.size).toBe(0);
  });
});

describe('refreshTenant: statement hygiene + input', () => {
  it('tenant and dates are bound parameters, never interpolated; every statement that names tenant_id binds the tenant', async () => {
    const f = createFakeDb({ marks: [mark('income', D), mark('report_backlog', SNAPSHOT_DATE)] });
    await run(f);
    for (const l of f.log) {
      expect(l.text).not.toContain(TA);
      expect(l.text).not.toContain(ACTOR);
      expect(l.text).not.toMatch(/'2026-11-0\d'/);
      if (/tenant_id/i.test(l.text)) expect(l.values).toContain(TA);
    }
  });

  it('every statement targets analytics.* or a published v_pub_* view only (CV §5.13)', async () => {
    const f = createFakeDb({ marks: FAMILIES.map((fam) => mark(fam, fam === 'report_backlog' ? SNAPSHOT_DATE : D)) });
    await run(f);
    for (const l of f.log) for (const m of l.text.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE)\s+([a-z_]+\.[a-z_0-9]+)/gi)) {
      expect(m[1]!.toLowerCase()).toMatch(/^analytics\.|^\w+\.v_pub_\w+$/);
    }
  });

  it('a non-uuid tenant id is rejected before any statement', async () => {
    const f = createFakeDb({ marks: [mark('income', D)] });
    await expect(refreshTenant(createCtx(f) as never, { tenantId: "x'; DROP TABLE analytics.daily_income;--" } as never)).rejects.toBeTruthy();
    expect(f.log).toEqual([]);
  });

  it('an unknown trigger is rejected before any statement (refresh_runs__trigger__ck)', async () => {
    const f = createFakeDb({ marks: [mark('income', D)] });
    await expect(run(f, { trigger: 'whenever' })).rejects.toBeTruthy();
    expect(f.log.filter((l) => l.kind === 'insertRollup')).toEqual([]);
  });

  it('a mark for a family outside the 16 (stale/foreign row) is never turned into SQL on a table name', async () => {
    const f = createFakeDb({ marks: [mark('income', D), { tenant: TA, family: '_manual' as Family, date: D }, { tenant: TA, family: 'x; DROP TABLE t' as Family, date: D }] });
    await run(f).catch(() => undefined);
    for (const l of f.log) expect(l.text).not.toMatch(/DROP\s+TABLE/i);
    expect(replaces(f).map((e) => e.table)).not.toContain('_manual');
  });
});
