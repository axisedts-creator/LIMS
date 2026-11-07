// T0D-08 ctx.core.deadLetters (02-TRD §6.8, §7.4; 08 A6.4, A8.4, A8.5, A9.1-A9.3, A10.1, A23.2).
// AC-0D-5.7 .. 5.14. Contract assumed (see .orchestra/notes/T0D-08-tests.md):
//   core-repo/index.ts      createCoreRepo({ withTenantScope(tx, tenantId, systemActorId, fn), systemActorOf(module), log?, metrics? }) -> CoreRepository
//   core-repo/dead-letters.ts  stripPayload(r) (02-TRD §6.8)
import { describe, expect, it } from 'vitest';
import { LimsError } from '../../errors.js';
import { createCoreRepo } from '../index.js';
import { stripPayload } from '../dead-letters.js';
import {
  BILLING_ACTOR, CATALOG_ACTOR, DEAD_LETTER_ROW_KEYS, PLATFORM_USER, SECRET, TENANT_A, TENANT_B,
  day, dl, idN, makeDeadLetterDb, platformCtx, recorder, rejection, systemActorOf, type DlRow,
} from './helpers.js';

function setup(rows: DlRow[]) {
  const db = makeDeadLetterDb(rows);
  const rec = recorder();
  const repo = createCoreRepo({ withTenantScope: db.withTenantScope, systemActorOf, log: rec.log, metrics: rec.metrics } as never);
  const dls = (repo as any).deadLetters;
  return { db, rec, dls, ctx: platformCtx(db) as any };
}
type S = ReturnType<typeof setup>;
const replay = (s: S, id: string, expectedVersion: unknown, reasonText?: string, opts?: { rollbackOnError?: boolean }) =>
  s.db.transaction(() => s.dls.replay(s.ctx, { deadLetterId: id, expectedVersion, ...(reasonText === undefined ? {} : { reasonText }) }), opts);
const discard = (s: S, id: string, expectedVersion: unknown, reasonText?: unknown, opts?: { rollbackOnError?: boolean }) =>
  s.db.transaction(() => s.dls.discard(s.ctx, { deadLetterId: id, expectedVersion, reasonText }), opts);
const NO_ROLLBACK = { rollbackOnError: false } as const;
const mutating = (s: S) => s.db.stmts.filter((x) => /UPDATE|dl_resolve|enqueue_job/i.test(x.text));

const kinds = [
  ['tenant row', () => dl({ tenant_id: TENANT_A, version: 3 })],
  ['platform row (tenant_id IS NULL)', () => dl({ tenant_id: null, version: 3 })],
] as const;

describe('AC-0D-5.7 expectedVersion guard (409 common.version_conflict)', () => {
  for (const [label, make] of kinds) {
    for (const op of ['replay', 'discard'] as const) {
      const call = (s: S, id: string, v: unknown, o?: { rollbackOnError?: boolean }) => (op === 'replay' ? replay(s, id, v, undefined, o) : discard(s, id, v, 'duplicate of an earlier failure', o));
      for (const wrong of [4, 2, 0]) {
        it(`${op} ${label} with expectedVersion ${wrong} ≠ 3: 409, row stays open at version 3, nothing enqueued`, async () => {
          const row = make();
          const s = setup([row]);
          const e = await rejection(call(s, row.id, wrong, NO_ROLLBACK));
          expect(e).toBeInstanceOf(LimsError);
          expect(e.code).toBe('common.version_conflict');
          expect(e.statusCode).toBe(409);
          const after = s.db.row(row.id);          // no rollback here: the UPDATE itself must have been guarded
          expect([after.state, after.version, after.resolution_note, after.resolved_at, after.resolved_by]).toEqual(['open', 3, null, null, null]);
          expect(s.db.jobs).toHaveLength(0);
          expect(s.db.events.filter((x) => x.type !== 'scope-exit' && x.type !== 'scope-enter')).toHaveLength(0);
        });
      }
      it(`${op} ${label} with expectedVersion = 3: state changes and version becomes 4`, async () => {
        const row = make();
        const s = setup([row]);
        const out = await call(s, row.id, 3);
        expect(out).toBeUndefined();
        const after = s.db.row(row.id);
        expect(after.state).toBe(op === 'replay' ? 'replayed' : 'discarded');
        expect(after.version).toBe(4);
      });
    }
  }

  it('a second replay of the same row is impossible (only open rows are replayed): no second job', async () => {
    for (const [, make] of kinds) {
      const row = make();
      const s = setup([row]);
      await replay(s, row.id, 3);
      await rejection(replay(s, row.id, 4));
      expect(s.db.jobs).toHaveLength(1);
      expect(s.db.row(row.id).version).toBe(4);
    }
  });

  it('a discarded row cannot be replayed, a replayed row cannot be discarded', async () => {
    const a = dl({ version: 3 }); const b = dl({ tenant_id: null, version: 3 });
    const s = setup([a, b]);
    await discard(s, a.id, 3, 'not needed'); await discard(s, b.id, 3, 'not needed');
    await rejection(replay(s, a.id, 4)); await rejection(replay(s, b.id, 4));
    expect(s.db.jobs).toHaveLength(0);
    const c = dl({ version: 3 }); const t = setup([c]);
    await replay(t, c.id, 3);
    await rejection(discard(t, c.id, 4, 'too late'));
    expect(t.db.row(c.id).state).toBe('replayed');
  });

  it('expectedVersion that is missing / not a positive integer is rejected, the row is untouched and nothing is enqueued', async () => {
    for (const bad of [undefined, null, '3', 3.5, NaN, -1]) {
      for (const make of [() => dl({ version: 3 }), () => dl({ tenant_id: null, version: 3 })]) {
        const row = make();
        const s = setup([row]);
        await rejection(replay(s, row.id, bad, undefined, NO_ROLLBACK));
        await rejection(discard(s, row.id, bad, 'reason', NO_ROLLBACK));
        expect([s.db.row(row.id).state, s.db.row(row.id).version], String(bad)).toEqual(['open', 3]);
        expect(s.db.jobs).toHaveLength(0);
        expect(mutating(s).filter((x) => /enqueue_job/i.test(x.text))).toHaveLength(0);
      }
    }
  });
});

describe('AC-0D-5.8 discard stores reasonText in resolution_note', () => {
  for (const [label, make] of kinds) {
    it(`${label}: state discarded, resolution_note = reasonText, resolved_by/resolved_at set, version 4, nothing enqueued`, async () => {
      const row = make();
      const s = setup([row]);
      await discard(s, row.id, 3, 'duplicate of DL-1001, handled manually');
      const a = s.db.row(row.id);
      expect(a).toMatchObject({ state: 'discarded', resolution_note: 'duplicate of DL-1001, handled manually', resolved_by: PLATFORM_USER, version: 4 });
      expect(a.resolved_at).toBeInstanceOf(Date);
      expect(s.db.jobs).toHaveLength(0);
      expect(s.db.events.some((e) => e.type === 'scope-enter')).toBe(false);
    });
    it(`${label}: 1-char and 500-char notes are accepted`, async () => {
      for (const n of [1, 500]) {
        const row = make();
        const s = setup([row]);
        await discard(s, row.id, 3, 'n'.repeat(n));
        expect(s.db.row(row.id).resolution_note).toHaveLength(n);
      }
    });
    it(`${label}: missing, 0-char and 501-char reasonText are rejected and the row is untouched`, async () => {
      for (const bad of [undefined, null, '', 'n'.repeat(501)]) {
        const row = make();
        const s = setup([row]);
        await rejection(discard(s, row.id, 3, bad, NO_ROLLBACK));
        const a = s.db.row(row.id);
        expect([a.state, a.version, a.resolution_note], JSON.stringify(bad)?.slice(0, 20)).toEqual(['open', 3, null]);
      }
    });
  }
});

describe('AC-0D-5.12 replay stores the optional reasonText', () => {
  for (const [label, make] of kinds) {
    it(`${label}: with reasonText the note is stored and state is replayed`, async () => {
      const row = make();
      const s = setup([row]);
      await replay(s, row.id, 3, 'upstream outage fixed');
      expect(s.db.row(row.id)).toMatchObject({ state: 'replayed', resolution_note: 'upstream outage fixed', version: 4 });
    });
    it(`${label}: without reasonText resolution_note stays NULL`, async () => {
      const row = make();
      const s = setup([row]);
      await replay(s, row.id, 3);
      expect(s.db.row(row.id)).toMatchObject({ state: 'replayed', resolution_note: null, version: 4 });
    });
    it(`${label}: a 501-char replay note is rejected and nothing is enqueued`, async () => {
      const row = make();
      const s = setup([row]);
      await rejection(replay(s, row.id, 3, 'n'.repeat(501), NO_ROLLBACK));
      expect(s.db.row(row.id).state).toBe('open');
      expect(s.db.jobs).toHaveLength(0);
    });
  }
});

describe('AC-0D-5.9 list returns DeadLetterRow without job_payload', () => {
  const rows = () => [
    dl({ tenant_id: TENANT_A, version: 3, dead_at: day(3) }),
    dl({ tenant_id: TENANT_A, state: 'discarded', resolved_by: PLATFORM_USER, resolved_at: day(4), resolution_note: 'dup', version: 2, dead_at: day(2) }),
    dl({ tenant_id: null, version: 7, dead_at: day(5) }),
  ];
  it('every item has exactly the DeadLetterRow keys, version and resolutionNote, and no payload anywhere', async () => {
    const s = setup(rows());
    for (const input of [{}, { platformRows: true }]) {
      const page = await s.dls.list(s.ctx, input);
      expect(page.items.length).toBeGreaterThan(0);
      for (const it of page.items) {
        expect(Object.keys(it).sort()).toEqual(DEAD_LETTER_ROW_KEYS);
        expect(typeof it.version).toBe('number');
        expect('resolutionNote' in it).toBe(true);
      }
      expect(JSON.stringify(page)).not.toContain(SECRET);
    }
  });
  it('maps columns: ISO-UTC timestamps, null tenantId for platform rows, resolution note and version from the row', async () => {
    const s = setup(rows());
    const t = (await s.dls.list(s.ctx, {})).items;
    const p = (await s.dls.list(s.ctx, { platformRows: true })).items;
    expect(t.map((x: any) => x.tenantId)).toEqual([TENANT_A, TENANT_A]);
    expect(p.map((x: any) => x.tenantId)).toEqual([null]);
    expect(p[0]).toMatchObject({ version: 7, state: 'open', resolutionNote: null, resolvedBy: null, resolvedAt: null, deadAt: day(5).toISOString(), firstFailedAt: day(1).toISOString(), attempts: 10, lastErrorCode: 'common.internal', lastErrorMessageRedacted: 'handler failed' });
    expect(t[1]).toMatchObject({ state: 'discarded', resolutionNote: 'dup', resolvedBy: PLATFORM_USER, resolvedAt: day(4).toISOString(), version: 2 });
  });
  it('the list SQL never reads job_payload (nor SELECT *)', async () => {
    const s = setup(rows());
    await s.dls.list(s.ctx, {}); await s.dls.list(s.ctx, { platformRows: true });
    for (const t of s.db.texts()) { expect(t).not.toMatch(/job_payload|job_key/i); expect(t).not.toMatch(/select\s+(distinct\s+)?(\w+\.)?\*|\.\*/i); }
  });
});

describe('AC-0D-5.10 get', () => {
  for (const [label, make] of kinds) {
    it(`${label}: returns the DeadLetterRow with version and resolutionNote, no job_payload`, async () => {
      const row = make();
      const s = setup([row, dl({ tenant_id: TENANT_B })]);
      const r = await s.dls.get(s.ctx, { deadLetterId: row.id });
      expect(Object.keys(r).sort()).toEqual(DEAD_LETTER_ROW_KEYS);
      expect(r).toMatchObject({ id: row.id, tenantId: row.tenant_id, taskIdentifier: row.task_identifier, version: 3, resolutionNote: null, state: 'open' });
      expect(JSON.stringify(r)).not.toContain(SECRET);
      for (const t of s.db.texts()) expect(t).not.toMatch(/job_payload|job_key/i);
    });
  }
  it('unknown id throws common.not_found (404)', async () => {
    const s = setup([dl(), dl({ tenant_id: null })]);
    const e = await rejection(s.dls.get(s.ctx, { deadLetterId: idN(0xdead) }));
    expect(e).toBeInstanceOf(LimsError);
    expect([e.code, e.statusCode]).toEqual(['common.not_found', 404]);
  });
});

describe('AC-0D-5.11 list filters and paging', () => {
  const F = { state: 'replayed', tenantId: TENANT_B, taskIdentifier: 'billing.recompute_balance', deadAtFrom: '2026-11-02T00:00:00.000Z', deadAtTo: '2026-11-05T00:00:00.000Z' } as const;
  const bound = (s: S) => s.db.stmts.flatMap((x) => x.values).map((v) => (v instanceof Date ? v.toISOString() : v));
  const sql = (s: S) => s.db.texts().join('\n');

  async function run(input: Record<string, unknown>) {
    const s = setup([dl(), dl({ tenant_id: null })]);
    await s.dls.list(s.ctx, input);
    return s;
  }

  it('state: bound, and the SQL filters on state', async () => {
    const s = await run({ state: F.state });
    expect(bound(s)).toContain(F.state); expect(sql(s)).toMatch(/\bstate\b/i);
  });
  it('tenantId: bound, and the SQL filters on tenant_id', async () => {
    const s = await run({ tenantId: F.tenantId });
    expect(bound(s)).toContain(F.tenantId); expect(sql(s)).toMatch(/\btenant_id\s*=\s*\$\d+/i);
  });
  it('taskIdentifier: bound, and the SQL filters on task_identifier', async () => {
    const s = await run({ taskIdentifier: F.taskIdentifier });
    expect(bound(s)).toContain(F.taskIdentifier); expect(sql(s)).toMatch(/\btask_identifier\b/i);
  });
  it('deadAtFrom is inclusive (>=) and deadAtTo is exclusive (<)', async () => {
    const s = await run({ deadAtFrom: F.deadAtFrom, deadAtTo: F.deadAtTo });
    expect(bound(s)).toEqual(expect.arrayContaining([F.deadAtFrom, F.deadAtTo]));
    expect(sql(s)).toMatch(/dead_at\s*>=\s*\$\d+/i);
    expect(sql(s)).toMatch(/dead_at\s*<\s*\$\d+/i);
    expect(sql(s)).not.toMatch(/dead_at\s*(<=|>)\s*\$\d+/i);
  });
  it('platformRows: true goes through app.dl_list_platform and never reads core.dead_letters directly', async () => {
    const s = await run({ platformRows: true, state: 'open', taskIdentifier: 'core.retention_purge', deadAtFrom: F.deadAtFrom, deadAtTo: F.deadAtTo });
    expect(sql(s)).toMatch(/app\.dl_list_platform\s*\(/i);
    expect(sql(s)).not.toMatch(/FROM\s+core\.dead_letters/i);
    expect(bound(s)).toEqual(expect.arrayContaining(['open', 'core.retention_purge', F.deadAtFrom, F.deadAtTo]));
  });
  it('platformRows: true combined with tenantId matches nothing (platform rows have tenant_id IS NULL)', async () => {
    const s = setup([dl({ tenant_id: TENANT_A }), dl({ tenant_id: null })]);
    const r: any = await s.dls.list(s.ctx, { platformRows: true, tenantId: TENANT_A });
    expect(r.items).toEqual([]);
    expect(r.nextCursor).toBeUndefined();
  });
  it('without platformRows the platform function is not used', async () => {
    const s = await run({ state: 'open' });
    expect(sql(s)).not.toMatch(/dl_list_platform/i);
    expect(sql(s)).toMatch(/FROM\s+core\.dead_letters/i);
  });
  it('all filters combined (tenant path): every value bound, in one statement', async () => {
    const s = await run({ ...F });
    const stmt = s.db.stmts.find((x) => /FROM\s+core\.dead_letters/i.test(x.text))!;
    const v = stmt.values.map((x) => (x instanceof Date ? x.toISOString() : x));
    expect(v).toEqual(expect.arrayContaining([F.state, F.tenantId, F.taskIdentifier, F.deadAtFrom, F.deadAtTo]));
  });
  it('a filter that was not given is not bound (no stray values)', async () => {
    const s = await run({ state: 'open' });
    const v = bound(s);
    for (const x of [F.tenantId, F.taskIdentifier, F.deadAtFrom, F.deadAtTo]) expect(v).not.toContain(x);
  });
  it('order is dead_at DESC, id DESC', async () => {
    const s = await run({});
    expect(sql(s)).toMatch(/ORDER\s+BY\s+(\w+\.)?dead_at\s+DESC\s*,\s*(\w+\.)?id\s+DESC/i);
  });
  it('limit defaults to 50 and one extra row is requested to detect the next page; an explicit limit is honoured', async () => {
    const a = await run({});
    expect(bound(a)).toContain(51);
    const b = await run({ limit: 2 });
    expect(bound(b)).toContain(3);
    const c = await run({ platformRows: true, limit: 2 });
    expect(bound(c)).toContain(3);
  });

  const dataset = () => {
    const mk = (tenant: string | null, d: number, h: number) => dl({ tenant_id: tenant, dead_at: day(d, h) });
    // five tenant rows, two of them with the same dead_at (tie broken by id), and five platform rows
    return [mk(TENANT_A, 6, 0), mk(TENANT_A, 5, 0), mk(TENANT_B, 5, 0), mk(TENANT_A, 4, 0), mk(TENANT_B, 3, 0),
      mk(null, 6, 0), mk(null, 5, 0), mk(null, 5, 0), mk(null, 4, 0), mk(null, 3, 0)];
  };
  for (const [label, input, want] of [['tenant rows', {}, (r: DlRow) => r.tenant_id !== null], ['platform rows', { platformRows: true }, (r: DlRow) => r.tenant_id === null]] as const) {
    it(`paging ${label}: cursor/limit return every matching row exactly once, in dead_at DESC, id DESC order`, async () => {
      const rows = dataset();
      const s = setup(rows);
      const expected = rows.filter(want).sort((a, b) => b.dead_at.getTime() - a.dead_at.getTime() || (a.id < b.id ? 1 : -1)).map((r) => r.id);
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await s.dls.list(s.ctx, { ...input, limit: 2, ...(cursor ? { cursor } : {}) });
        expect(page.items.length).toBeLessThanOrEqual(2);
        seen.push(...page.items.map((i: any) => i.id));
        cursor = page.nextCursor;
        expect(cursor === undefined || typeof cursor === 'string').toBe(true);
        pages += 1;
      } while (cursor && pages < 10);
      expect(seen).toEqual(expected);
      expect(new Set(seen).size).toBe(seen.length);
      expect(pages).toBe(3);
    });
  }
});

describe('stripPayload (02-TRD §6.8)', () => {
  const full = { id: idN(1), tenantId: null, taskIdentifier: 't', lastErrorCode: 'c', lastErrorMessageRedacted: 'm', attempts: 1,
    firstFailedAt: '2026-11-01T00:00:00.000Z', deadAt: '2026-11-02T00:00:00.000Z', state: 'replayed', resolvedBy: PLATFORM_USER,
    resolvedAt: '2026-11-07T12:00:00.000Z', resolutionNote: null, version: 4, jobPayload: { a: SECRET } } as const;
  it('splits the payload from a row that has exactly the DeadLetterRow keys', () => {
    const { row, payload } = (stripPayload as any)(full);
    expect(payload).toEqual({ a: SECRET });
    expect(Object.keys(row).sort()).toEqual(DEAD_LETTER_ROW_KEYS);
    expect(JSON.stringify(row)).not.toContain(SECRET);
  });
  it('null payload (discarded) stays null; the input is not mutated', () => {
    const copy = JSON.parse(JSON.stringify({ ...full, jobPayload: null }));
    const { row, payload } = (stripPayload as any)(copy);
    expect(payload).toBeNull();
    expect('jobPayload' in row).toBe(false);
    expect(copy.jobPayload).toBeNull();
  });
});

describe('AC-0D-5.13 platform-row replay: payload from app.dl_resolve, same transaction, never returned or logged', () => {
  const platformRow = (over: Partial<DlRow> = {}) => dl({ tenant_id: null, version: 5, job_key: 'core.retention_purge:2026-11-07T10:15', ...over });

  it('calls app.dl_resolve(id, expectedVersion, replayed, note) and enqueues one job with the stored payload and the replay key', async () => {
    const row = platformRow();
    const s = setup([row]);
    const out = await replay(s, row.id, 5, 'retry after fix');
    expect(out).toBeUndefined();
    const r = s.db.stmts.find((x) => /app\.dl_resolve\s*\(/i.test(x.text))!;
    expect(r).toBeDefined();
    expect(r.values).toEqual(expect.arrayContaining([row.id, 5, 'retry after fix']));
    expect(r.values.includes('replayed') || /'replayed'/.test(r.text)).toBe(true);
    expect(s.db.jobs).toHaveLength(1);
    expect(s.db.jobs[0]).toMatchObject({ identifier: 'core.retention_purge', payload: row.job_payload, jobKey: 'core.retention_purge:2026-11-07T10:15:replay:6', scopeTenant: null });
    expect(s.db.row(row.id)).toMatchObject({ state: 'replayed', version: 6, resolution_note: 'retry after fix' });
  });

  it('a row without a job_key uses task_identifier:id as the base of the replay key', async () => {
    const row = platformRow({ job_key: null });
    const s = setup([row]);
    await replay(s, row.id, 5);
    expect(s.db.jobs[0]!.jobKey).toBe(`core.retention_purge:${row.id}:replay:6`);
  });

  it('platform scope: no withTenantScope is entered', async () => {
    const row = platformRow();
    const s = setup([row]);
    await replay(s, row.id, 5);
    expect(s.db.events.some((e) => e.type === 'scope-enter')).toBe(false);
  });

  it('state change and enqueue are one unit: a failing enqueue leaves the row open at version 5 and no job', async () => {
    const row = platformRow();
    const s = setup([row]);
    s.db.fail(/app\.enqueue_job/i, () => new Error('queue unavailable'));
    await rejection(replay(s, row.id, 5));
    expect(s.db.row(row.id)).toMatchObject({ state: 'open', version: 5, resolution_note: null });
    expect(s.db.jobs).toHaveLength(0);
  });

  it('expectedVersion ≠ n: version_conflict, app.enqueue_job is never called', async () => {
    const row = platformRow();
    const s = setup([row]);
    const e = await rejection(replay(s, row.id, 4, undefined, NO_ROLLBACK));
    expect(e.code).toBe('common.version_conflict');
    expect(s.db.stmts.some((x) => /enqueue_job/i.test(x.text))).toBe(false);
    expect(s.db.jobs).toHaveLength(0);
  });

  it('the job_payload never appears in the return value, any DeadLetterRow, any log line, any metric label or an error', async () => {
    const row = platformRow();
    const other = platformRow({ job_key: null });
    const failing = platformRow();
    const s = setup([row, other, failing]);
    const seen: unknown[] = [];
    seen.push(await replay(s, row.id, 5, 'ok'));
    seen.push(await s.dls.get(s.ctx, { deadLetterId: other.id }));
    seen.push(await s.dls.list(s.ctx, { platformRows: true }));
    seen.push(await s.dls.list(s.ctx, {}));
    await discard(s, other.id, 5, 'discarded; dl_resolve returns a NULL payload for this state');
    s.db.fail(/app\.enqueue_job/i, () => new Error('queue unavailable'));
    const e = await rejection(replay(s, failing.id, 5));
    seen.push(e.message, e.detail, e.errors);
    await rejection(replay(s, failing.id, 1));     // version conflict path
    expect(JSON.stringify([seen, s.rec.logs, s.rec.incs])).not.toContain(SECRET);
  });

  it('the enqueue is the only place the payload goes: the payload value is bound to app.enqueue_job and nowhere else', async () => {
    const row = platformRow();
    const s = setup([row]);
    await replay(s, row.id, 5);
    const carriers = s.db.stmts.filter((x) => JSON.stringify(x.values).includes(SECRET));
    expect(carriers.length).toBeGreaterThan(0);
    for (const c of carriers) expect(c.text).toMatch(/app\.enqueue_job/i);
  });
});

describe('AC-0D-5.14 tenant-row replay inside withTenantScope with the A23.2 replay key', () => {
  it('enqueues exactly one job inside withTenantScope(row.tenant_id, owning module system actor) with coalesce(job_key, task:id):replay:n+1', async () => {
    const row = dl({ tenant_id: TENANT_A, version: 3, job_key: 'billing.recompute_balance:inv-42' });
    const s = setup([row]);
    await replay(s, row.id, 3, 'fixed upstream');
    expect(s.db.jobs).toHaveLength(1);
    expect(s.db.jobs[0]).toMatchObject({
      identifier: 'billing.recompute_balance', payload: row.job_payload, jobKey: 'billing.recompute_balance:inv-42:replay:4',
      scopeTenant: TENANT_A, scopeActor: BILLING_ACTOR,
    });
    const scopes = s.db.events.filter((e) => e.type === 'scope-enter');
    expect(scopes).toEqual([expect.objectContaining({ tenantId: TENANT_A, actorId: BILLING_ACTOR })]);
    const order = s.db.events.map((e) => e.type);
    expect(order).toEqual(['scope-enter', 'enqueue', 'scope-exit']);
    expect(s.db.row(row.id)).toMatchObject({ state: 'replayed', version: 4, resolution_note: 'fixed upstream' });
  });

  it('a row without a job_key uses task_identifier:id', async () => {
    const row = dl({ tenant_id: TENANT_A, version: 3, job_key: null });
    const s = setup([row]);
    await replay(s, row.id, 3);
    expect(s.db.jobs[0]!.jobKey).toBe(`billing.recompute_balance:${row.id}:replay:4`);
  });

  it('the system actor comes from the owning module in the task registry, not a constant', async () => {
    const row = dl({ tenant_id: TENANT_B, task_identifier: 'catalog.publish_revision', job_payload: { tenant_id: TENANT_B, revision: 7 }, version: 3 });
    const s = setup([row]);
    await replay(s, row.id, 3);
    expect(s.db.jobs[0]).toMatchObject({ identifier: 'catalog.publish_revision', scopeTenant: TENANT_B, scopeActor: CATALOG_ACTOR });
  });

  it('the state change runs under platform claims; only the enqueue runs inside the tenant scope', async () => {
    const row = dl({ tenant_id: TENANT_A, version: 3 });
    const s = setup([row]);
    await replay(s, row.id, 3);
    const update = s.db.stmts.find((x) => /UPDATE\s+core\.dead_letters/i.test(x.text))!;
    const enqueue = s.db.stmts.find((x) => /app\.enqueue_job/i.test(x.text))!;
    expect(update.scope).toBeNull();
    expect(enqueue.scope).toBe(TENANT_A);
    for (const x of s.db.stmts.filter((x) => x.scope !== null)) expect(x.text).toMatch(/enqueue_job|set_config/i);
  });

  it('the platform actor never enqueues a tenant job directly: every enqueue statement is inside a scope', async () => {
    const row = dl({ tenant_id: TENANT_A, version: 3 });
    const s = setup([row]);
    await replay(s, row.id, 3);
    for (const x of s.db.stmts.filter((x) => /enqueue_job/i.test(x.text))) expect(x.scope).toBe(TENANT_A);
  });

  it('state change and enqueue commit or roll back together', async () => {
    const row = dl({ tenant_id: TENANT_A, version: 3 });
    const s = setup([row]);
    s.db.fail(/app\.enqueue_job/i, () => new Error('queue unavailable'));
    await rejection(replay(s, row.id, 3));
    expect(s.db.row(row.id)).toMatchObject({ state: 'open', version: 3 });
    expect(s.db.jobs).toHaveLength(0);
  });

  it('version conflict: the tenant scope is never entered and nothing is enqueued', async () => {
    const row = dl({ tenant_id: TENANT_A, version: 3 });
    const s = setup([row]);
    await rejection(replay(s, row.id, 9, undefined, NO_ROLLBACK));
    expect(s.db.events).toEqual([]);
    expect(s.db.jobs).toHaveLength(0);
  });

  it('payload of a tenant row is also never returned or logged', async () => {
    const row = dl({ tenant_id: TENANT_A, version: 3 });
    const s = setup([row]);
    const out = await replay(s, row.id, 3);
    expect(JSON.stringify([out, s.rec.logs, s.rec.incs])).not.toContain(SECRET);
  });
});
