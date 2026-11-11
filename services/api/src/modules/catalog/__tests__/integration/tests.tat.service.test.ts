// T-14 (C3) — setTestTatTargets (#28) over the tests service: AC-10.1 (targets stored, one segment per test, `/targets/1/segment`), AC-10.2 (end-and-insert,
// history via asOf, open row unique), AC-10.3 (data only: no alert, no job, one catalog.changed.v1).
// Spec: 02-TRD §5.2 #28 (`{targets[] (<=2, one per priority), effective_from?}` ends current rows, inserts new; same segment) + §5.1 TatTarget
//       (target_seconds 60–2592000, effective_from/effective_to) + §3 (bump stamps the OWNING TEST's orderable) + §9.1 (entity_type tat_target, created);
//       05-SCHEMA catalog.tat_targets (tat_targets__open__p_uq partial unique, window CHECK, no DELETE grant); 07-SECURITY S-1, S-5, AB-20, REQ-SEC-082.
// SEAM (spec silent on names; .orchestra/notes/C3.T-14-tests.md): the method `setTestTatTargets(ctx, { id, expectedVersion, body })` on createTestsService, exactly
//   like replaceTestSpecimenRequirements: body = { targets, effective_from? } as sent; expectedVersion = integer from If-Match (undefined = header absent) -> Test (200 body).
// ASSUMPTIONS beyond the spec text (a writer who disagrees disputes them): PUT = replace the set (every open row ends, even for a priority not in the call);
//   tests.version bumps (OpenAPI has If-Match: 428/409); one bump per call (entity_type tat_target, change_kind created, entity_id = a NEW row id);
//   Test.tat_targets = rows with effective_from <= as_of < effective_to (null = open), routine before urgent; an effective_from earlier than an open row's start is a 4xx.
import { describe, expect, it } from 'vitest';
import { TENANT_A, TENANT_B, USER, UUIDV7 } from '../helpers/catalogDb.js';
import { ID, pnl, tat, tsr, tst } from '../helpers/testsDb.js';
import { EDTA, HAEM, HAEM_B, ISO_UTC, LAV, T, errPaths, events, lims, rejection, setup, t6Own, validation400 } from '../helpers/t6.js';

const NOW = '2026-11-07T12:00:00.000Z';                       // ctx.now() of the fake
const JAN1 = new Date(Date.UTC(2026, 0, 1));
const iso = (v: unknown) => new Date(v as never).toISOString();

const seed = (rows: (testId: string) => Array<Record<string, unknown>> = () => []) => {
  const t1 = tst(1, TENANT_A, HAEM.id, { code: 'CBC', name: 'Complete blood count' });
  const tb = tst(2, TENANT_B, HAEM_B.id, { code: 'BONLY', name: 'Tenant B only' });
  const p = pnl(1, TENANT_A, { code: 'CBCP', name: 'CBC panel' });
  const bRows = [tat(50, TENANT_B, tb.test.id, { target_seconds: 7200 }), tat(51, TENANT_B, tb.test.id, { priority: 'urgent', target_seconds: 900 })];
  return {
    t1, tb, p,
    ...setup({ t6: {
      orderables: [t1.orderable, tb.orderable, p.orderable], tests: [t1.test, tb.test], panels: [p.panel],
      test_specimen_types: [tsr(t1.test.id, EDTA.id, TENANT_A, { is_preferred: true, container_id: LAV.id, min_volume_ul: 2000 })],
      tat_targets: [...rows(t1.test.id), ...bRows],
    } }),
  };
};
type Env = ReturnType<typeof seed>;
const open = (testId: string) => [tat(1, TENANT_A, testId, { target_seconds: 14400 }), tat(2, TENANT_A, testId, { priority: 'urgent', target_seconds: 3600 })];
const seeded = () => seed(open);

const R = (priority: string, target_seconds: number, segment = 'within_lab') => ({ priority, segment, target_seconds });
const BOTH = [R('routine', 14400), R('urgent', 3600)];
const set = (e: Env, body: unknown, o: { id?: string; expectedVersion?: unknown; tenantId?: string } = {}) =>
  e.db.run((ctx) => e.svc['setTestTatTargets']!(ctx, { id: 'id' in o ? o.id : e.t1.test.id, expectedVersion: 'expectedVersion' in o ? o.expectedVersion : 1, body }), o.tenantId ? { tenantId: o.tenantId } : {});
const detail = (e: Env, as_of?: string, tenantId?: string, id?: string) =>
  e.db.run((ctx) => e.svc['getTestDetail']!(ctx, { id: id ?? e.t1.test.id, ...(as_of ? { as_of } : {}) }), tenantId ? { tenantId } : {});
const tatRows = (e: Env, tenant = TENANT_A) => e.db.rows('tat_targets', tenant);
const mine = (e: Env) => tatRows(e).filter((r) => r['test_id'] === e.t1.test.id);
const openRows = (e: Env) => mine(e).filter((r) => r['effective_to'] == null);
const snapshot = (e: Env) => JSON.stringify([e.db.rows('tat_targets'), e.db.row('tests', e.t1.test.id), e.db.orderableRevision(e.t1.test.id)]);
const untouched = (e: Env, before: string) => {
  expect(snapshot(e)).toBe(before);
  expect(events(e.db)).toHaveLength(0);
  expect(e.db.revisionOf(TENANT_A)).toBe(417);
};

// ============================================================================================================ AC-10.1
describe('AC-10.1 — set the targets of a test (first set)', () => {
  it('CBC routine 4 h + urgent 1 h (within_lab): 200 Test DTO with tat_targets routine-then-urgent, ISO effective_from = now, no effective_to, no internal columns; version 2', { timeout: T }, async () => {
    const e = seed();
    const out = await set(e, { targets: BOTH });
    expect(out.tat_targets).toEqual([
      { priority: 'routine', segment: 'within_lab', target_seconds: 14400, effective_from: NOW },
      { priority: 'urgent', segment: 'within_lab', target_seconds: 3600, effective_from: NOW },
    ]);
    expect(out).toMatchObject({ id: e.t1.test.id, kind: 'test', code: 'CBC', version: 2 });
    for (const k of ['tenant_id', 'created_by', 'updated_by', 'created_at', 'id']) expect(out.tat_targets[0]).not.toHaveProperty(k);
  });

  it('writes two OPEN rows: uuidv7 ids, tenant A, created_by/updated_by = actor, version 1, active, effective_from = ctx.now(); tests.version 1 -> 2; other tenants\' rows untouched', { timeout: T }, async () => {
    const e = seed();
    const bBefore = JSON.stringify(tatRows(e, TENANT_B));
    await set(e, { targets: BOTH });
    const rows = mine(e).sort((a, b) => String(a['priority']).localeCompare(String(b['priority'])));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ tenant_id: TENANT_A, test_id: e.t1.test.id, priority: 'routine', segment: 'within_lab', target_seconds: 14400, effective_to: null, version: 1, is_active: true, created_by: USER, updated_by: USER });
    expect(rows[1]).toMatchObject({ priority: 'urgent', target_seconds: 3600, effective_to: null });
    for (const r of rows) { expect(r['id']).toMatch(UUIDV7); expect(iso(r['effective_from'])).toBe(NOW); }
    expect(e.db.row('tests', e.t1.test.id)).toMatchObject({ version: 2, updated_by: USER });
    expect(JSON.stringify(tatRows(e, TENANT_B))).toBe(bBefore);
  });

  it('getTest after the call returns the same targets (AC-10.1: routine 14400, urgent 3600, one segment within_lab)', { timeout: T }, async () => {
    const e = seed();
    await set(e, { targets: BOTH });
    const out = await detail(e);
    expect(out.tat_targets.map((x: any) => [x.priority, x.target_seconds, x.segment])).toEqual([['routine', 14400, 'within_lab'], ['urgent', 3600, 'within_lab']]);
    expect(out.tat_targets.every((x: any) => ISO_UTC.test(x.effective_from) && !('effective_to' in x))).toBe(true);
  });

  it('a request may carry one target only (the OpenAPI example), the segment may be `total`, and an explicit effective_from is honoured', { timeout: T }, async () => {
    const e = seed();
    const out = await set(e, { targets: [R('routine', 3600, 'total')], effective_from: '2026-11-05T04:15:00.000Z' });
    expect(out.tat_targets).toEqual([{ priority: 'routine', segment: 'total', target_seconds: 3600, effective_from: '2026-11-05T04:15:00.000Z' }]);
  });

  it('target_seconds boundaries 60 and 2592000 are accepted (1 min–30 days)', { timeout: T }, async () => {
    const e = seed();
    const out = await set(e, { targets: [R('routine', 60), R('urgent', 2592000)] });
    expect(out.tat_targets.map((x: any) => x.target_seconds)).toEqual([60, 2592000]);
  });

  it('different segments in one call -> 400 common.validation_failed at path /targets/1/segment; nothing written, no event, version unchanged', { timeout: T }, async () => {
    const e = seeded();
    const before = snapshot(e);
    for (const targets of [[R('routine', 14400, 'within_lab'), R('urgent', 3600, 'total')], [R('routine', 14400, 'total'), R('urgent', 3600, 'within_lab')], [R('urgent', 3600, 'within_lab'), R('routine', 14400, 'total')]]) {
      const err = await rejection(set(e, { targets }));
      lims(err, 'common.validation_failed', 400);
      expect(errPaths(err)).toContain('/targets/1/segment');
    }
    untouched(e, before);
  });

  it.each([
    ['two routine rows', [R('routine', 3600), R('routine', 7200)], '/targets/1/priority'],
    ['two urgent rows', [R('urgent', 3600), R('urgent', 7200)], '/targets/1/priority'],
    ['three targets (<= 2)', [R('routine', 3600), R('urgent', 600), R('routine', 7200)], '/targets'],
    ['target_seconds 59', [R('routine', 59)], '/targets/0/target_seconds'],
    ['target_seconds 2592001', [R('routine', 2592001)], '/targets/0/target_seconds'],
    ['target_seconds 0', [R('routine', 0)], '/targets/0/target_seconds'],
    ['target_seconds -1', [R('routine', -1)], '/targets/0/target_seconds'],
    ['target_seconds 150.5 (not an integer)', [R('routine', 150.5)], '/targets/0/target_seconds'],
    ['target_seconds "3600" (string)', [{ ...R('routine', 1), target_seconds: '3600' }], '/targets/0/target_seconds'],
    ['target_seconds null', [{ ...R('routine', 1), target_seconds: null }], '/targets/0/target_seconds'],
    ['target_seconds beyond int32', [R('routine', 2 ** 31)], '/targets/0/target_seconds'],
    ['priority "normal"', [R('normal', 3600)], '/targets/0/priority'],
    ['priority "Routine" (case)', [R('Routine', 3600)], '/targets/0/priority'],
    ['priority number', [{ ...R('routine', 3600), priority: 1 }], '/targets/0/priority'],
    ['segment "any"', [R('routine', 3600, 'any')], '/targets/0/segment'],
    ['segment "Within_Lab" (case)', [R('routine', 3600, 'Within_Lab')], '/targets/0/segment'],
    ['priority missing', [{ segment: 'within_lab', target_seconds: 3600 }], '/targets/0/priority'],
    ['segment missing', [{ priority: 'routine', target_seconds: 3600 }], '/targets/0/segment'],
    ['target_seconds missing', [{ priority: 'routine', segment: 'within_lab' }], '/targets/0/target_seconds'],
    ['a target that is not an object', ['routine'], '/targets/0'],
    ['a target that is null', [null], '/targets/0'],
  ] as const)('invalid input: %s -> 400 at the named path, nothing written', { timeout: T }, async (_n, targets, path) => {
    const e = seeded();
    const before = snapshot(e);
    const err = await rejection(set(e, { targets }));
    validation400(err);
    if (err.code === 'common.validation_failed') expect(errPaths(err), JSON.stringify(err.errors)).toContain(path);
    untouched(e, before);
  });

  it.each([
    ['targets missing', {}, '/targets'],
    ['targets not an array', { targets: R('routine', 3600) }, '/targets'],
    ['targets null', { targets: null }, '/targets'],
    ['effective_from not a date', { targets: [R('routine', 3600)], effective_from: 'yesterday' }, '/effective_from'],
    ['effective_from without Z / ms', { targets: [R('routine', 3600)], effective_from: '2026-11-05T04:15:00+05:45' }, '/effective_from'],
    ['effective_from number', { targets: [R('routine', 3600)], effective_from: 1762300000000 }, '/effective_from'],
  ] as const)('invalid body: %s -> 400 at the named path, nothing written', { timeout: T }, async (_n, b, path) => {
    const e = seeded();
    const before = snapshot(e);
    const err = await rejection(set(e, b));
    validation400(err);
    if (err.code === 'common.validation_failed') expect(errPaths(err)).toContain(path);
    untouched(e, before);
  });

  it('a body that is not an object (null / array / string) -> 400, nothing written', { timeout: T }, async () => {
    const e = seeded();
    const before = snapshot(e);
    for (const b of [null, [], 'targets', 5]) validation400(await rejection(set(e, b)));
    untouched(e, before);
  });
});

// ============================================================================================================ AC-10.2
describe('AC-10.2 — a new target ends the previous row and creates a new one; history stays queryable with asOf', () => {
  const FROM = '2026-11-07T10:00:00.000Z';

  it('end-and-insert: the open rows get effective_to = the new effective_from and are otherwise unchanged (ids, values); two new open rows start at that instant', { timeout: T }, async () => {
    const e = seeded();
    const old = mine(e).map((r) => ({ ...r }));
    await set(e, { targets: [R('routine', 7200), R('urgent', 1800)], effective_from: FROM });
    const rows = mine(e);
    expect(rows).toHaveLength(4);
    for (const o of old) {
      const after = rows.find((r) => r['id'] === o['id'])!;                       // the SAME row, ended — not deleted, not re-created
      expect(iso(after['effective_to'])).toBe(FROM);
      expect(after).toMatchObject({ priority: o['priority'], segment: o['segment'], target_seconds: o['target_seconds'], test_id: o['test_id'] });
      expect(iso(after['effective_from'])).toBe(iso(o['effective_from']));
    }
    const fresh = rows.filter((r) => !old.some((o) => o['id'] === r['id']));
    expect(fresh.map((r) => [r['priority'], r['target_seconds'], r['effective_to']]).sort()).toEqual([['routine', 7200, null], ['urgent', 1800, null]]);
    for (const r of fresh) expect(iso(r['effective_from'])).toBe(FROM);
  });

  it('effective_from omitted -> ctx.now(): the old row\'s effective_to equals the new row\'s effective_from (no gap, no overlap)', { timeout: T }, async () => {
    const e = seeded();
    await set(e, { targets: BOTH.map((t) => ({ ...t, target_seconds: t.target_seconds * 2 })) });
    for (const p of ['routine', 'urgent']) {
      const rs = mine(e).filter((r) => r['priority'] === p).sort((a, b) => +new Date(a['effective_from'] as never) - +new Date(b['effective_from'] as never));
      expect(rs).toHaveLength(2);
      expect(iso(rs[0]!['effective_to'])).toBe(NOW);
      expect(iso(rs[1]!['effective_from'])).toBe(NOW);
      expect(rs[1]!['effective_to']).toBeNull();
    }
  });

  it('open-row unique holds after every call: exactly one open row per (test, priority) through five successive PUTs, and the chain is contiguous', { timeout: T }, async () => {
    const e = seeded();
    let version = 1;
    for (let i = 1; i <= 5; i++) {
      const out = await set(e, { targets: [R('routine', 600 * i), R('urgent', 60 * i)], effective_from: `2026-11-0${i}T00:00:00.000Z` }, { expectedVersion: version });
      version = out.version;
      expect(openRows(e).map((r) => r['priority']).sort()).toEqual(['routine', 'urgent']);
    }
    expect(version).toBe(6);
    for (const p of ['routine', 'urgent']) {
      const chain = mine(e).filter((r) => r['priority'] === p).sort((a, b) => +new Date(a['effective_from'] as never) - +new Date(b['effective_from'] as never));
      expect(chain).toHaveLength(6);
      chain.slice(0, -1).forEach((r, i) => expect(iso(r['effective_to'])).toBe(iso(chain[i + 1]!['effective_from'])));
    }
  });

  it('history with asOf: before the change -> old values (with effective_to), at the change instant and after -> new values, before any row -> []', { timeout: T }, async () => {
    const e = seeded();
    await set(e, { targets: [R('routine', 7200), R('urgent', 1800)], effective_from: FROM });
    const at = async (asOf?: string) => (await detail(e, asOf)).tat_targets.map((x: any) => [x.priority, x.target_seconds]);
    expect(await at('2026-06-01T00:00:00.000Z')).toEqual([['routine', 14400], ['urgent', 3600]]);
    expect(await at('2026-11-07T09:59:59.999Z')).toEqual([['routine', 14400], ['urgent', 3600]]);   // half-open [from, to)
    expect(await at(FROM)).toEqual([['routine', 7200], ['urgent', 1800]]);
    expect(await at('2026-12-01T00:00:00.000Z')).toEqual([['routine', 7200], ['urgent', 1800]]);
    expect(await at()).toEqual([['routine', 7200], ['urgent', 1800]]);                               // default as_of = now (12:00 > 10:00)
    expect(await at('2025-12-31T23:59:59.999Z')).toEqual([]);
    const old = (await detail(e, '2026-06-01T00:00:00.000Z')).tat_targets[0];
    expect(old).toEqual({ priority: 'routine', segment: 'within_lab', target_seconds: 14400, effective_from: JAN1.toISOString(), effective_to: FROM });
  });

  it('PUT replaces the SET [assumption]: setting only routine ends the urgent row too — no urgent target is open afterwards', { timeout: T }, async () => {
    const e = seeded();
    const out = await set(e, { targets: [R('routine', 7200)] });
    expect(out.tat_targets.map((x: any) => x.priority)).toEqual(['routine']);
    expect(openRows(e).map((r) => r['priority'])).toEqual(['routine']);
    const urgent = mine(e).filter((r) => r['priority'] === 'urgent');
    expect(urgent).toHaveLength(1);
    expect(iso(urgent[0]!['effective_to'])).toBe(NOW);
  });

  it('the segment may change across versions (both rows move together); the ended rows keep their old segment', { timeout: T }, async () => {
    const e = seeded();
    const out = await set(e, { targets: [R('routine', 14400, 'total'), R('urgent', 3600, 'total')] });
    expect(out.tat_targets.map((x: any) => x.segment)).toEqual(['total', 'total']);
    expect(mine(e).filter((r) => r['effective_to'] != null).map((r) => r['segment'])).toEqual(['within_lab', 'within_lab']);
  });

  it('rows are only ever ENDED and INSERTED: no DELETE, and the UPDATE touches effective_to (+ audit columns/version) — never priority, segment or target_seconds; end precedes insert', { timeout: T }, async () => {
    const e = seeded();
    await set(e, { targets: [R('routine', 7200), R('urgent', 1800)] });
    const own = t6Own(e.db).filter((s) => /catalog\.tat_targets\b/i.test(s.text));
    expect(own.some((s) => /^\s*DELETE/i.test(s.text))).toBe(false);
    const upd = own.filter((s) => /^\s*UPDATE/i.test(s.text));
    expect(upd.length).toBeGreaterThan(0);
    for (const s of upd) {
      const setClause = /\bSET\b([\s\S]*?)\bWHERE\b/i.exec(s.text)![1]!;
      expect(setClause).toMatch(/\beffective_to\b/);
      expect(setClause).not.toMatch(/\b(priority|segment|target_seconds|test_id|effective_from|tenant_id)\b/);
    }
    const firstInsert = own.findIndex((s) => /^\s*INSERT/i.test(s.text));
    const lastUpdate = own.map((s, i) => (/^\s*UPDATE/i.test(s.text) ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
    expect(firstInsert).toBeGreaterThan(lastUpdate);            // the partial unique index is not deferrable: end first, then insert
  });

  it('an effective_from EARLIER than the start of an open row cannot be applied: 4xx, nothing changes (no half-ended set) [assumption on the code]', { timeout: T }, async () => {
    const e = seeded();
    const before = snapshot(e);
    const err = await rejection(set(e, { targets: BOTH, effective_from: '2025-06-01T00:00:00.000Z' }));
    expect(err.statusCode, err.code ?? err.message).toBeGreaterThanOrEqual(400);
    expect(err.statusCode).toBeLessThan(500);
    untouched(e, before);
  });

  it('a test with ended history only (no open row) accepts a fresh set', { timeout: T }, async () => {
    const e = seed((id) => [tat(1, TENANT_A, id, { effective_to: new Date(Date.UTC(2026, 5, 1)) })]);
    const out = await set(e, { targets: [R('routine', 5400)] });
    expect(out.tat_targets.map((x: any) => x.target_seconds)).toEqual([5400]);
    expect(mine(e)).toHaveLength(2);
  });
});

// ============================================================================================================ If-Match / concurrency
describe('If-Match (428 / 409 / 400) and concurrent writers', () => {
  it('no If-Match -> 428 common.precondition_required; stale -> 409 common.version_conflict; version unchanged and nothing written either way', { timeout: T }, async () => {
    const e = seeded();
    const before = snapshot(e);
    lims(await rejection(set(e, { targets: BOTH }, { expectedVersion: undefined })), 'common.precondition_required', 428);
    lims(await rejection(set(e, { targets: BOTH }, { expectedVersion: 2 })), 'common.version_conflict', 409);
    untouched(e, before);
  });

  it.each([[0], [-1], [1.5], ['1'], [null], [2 ** 31], [Number.NaN]])('malformed expectedVersion %j -> 400, never 500 and never a write', { timeout: T }, async (ev) => {
    const e = seeded();
    const before = snapshot(e);
    const err = await rejection(set(e, { targets: BOTH }, { expectedVersion: ev }));
    expect(err.statusCode).toBe(400);
    untouched(e, before);
  });

  it('a second call with the version it just read succeeds (2 -> 3); replaying the first version is a 409', { timeout: T }, async () => {
    const e = seeded();
    const a = await set(e, { targets: [R('routine', 7200)] });
    expect(a.version).toBe(2);
    const b = await set(e, { targets: [R('routine', 9000)] }, { expectedVersion: 2 });
    expect(b.version).toBe(3);
    lims(await rejection(set(e, { targets: [R('routine', 1)] }, { expectedVersion: 1 })), 'common.version_conflict', 409);
    expect(openRows(e).map((r) => r['target_seconds'])).toEqual([9000]);
  });

  it('20 concurrent writers with the same If-Match: exactly one wins, 19 get 409; one open row per priority; the chain has no overlap', { timeout: 60_000 }, async () => {
    const e = seeded();
    const res = await Promise.allSettled(Array.from({ length: 20 }, (_v, i) => set(e, { targets: [R('routine', 600 + i), R('urgent', 60 + i)] })));
    const ok = res.filter((r) => r.status === 'fulfilled');
    const bad = res.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(bad).toHaveLength(19);
    for (const b of bad) lims(b.reason, 'common.version_conflict', 409);
    expect(openRows(e)).toHaveLength(2);
    expect(mine(e)).toHaveLength(4);
    expect(e.db.row('tests', e.t1.test.id)!['version']).toBe(2);
    expect(e.db.revisionOf(TENANT_A)).toBe(418);
  });
});

// ============================================================================================================ revision / event / atomicity
describe('catalog revision + catalog.changed.v1 (02-TRD §3, §9.1) and AC-10.3 (data only)', () => {
  it('one bump per call: revision 417 -> 418, ONE event {entity_type tat_target, change_kind created, entity_id = a new row id}, the OWNING test\'s orderable stamped, key tenant:catalog:418', { timeout: T }, async () => {
    const e = seeded();
    await set(e, { targets: [R('routine', 7200), R('urgent', 1800)] });
    const ev = events(e.db);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.envelope.payload).toMatchObject({ catalog_revision: 418, entity_type: 'tat_target', change_kind: 'created' });
    expect(ev[0]!.envelope.payload.effective_from).toMatch(ISO_UTC);
    expect(ev[0]!.key).toBe(`${TENANT_A}:catalog:418`);
    const fresh = mine(e).filter((r) => r['effective_to'] == null).map((r) => r['id']);
    expect(fresh).toContain(ev[0]!.envelope.payload.entity_id);
    expect(e.db.revisionOf(TENANT_A)).toBe(418);
    expect(e.db.orderableRevision(e.t1.test.id)).toBe(418);
    expect(e.db.orderableRevision(e.p.panel.id)).toBe(0);                  // panels containing the test are not re-stamped; other tests untouched
    expect(e.db.orderableRevision(e.tb.test.id)).toBe(0);
  });

  it('AC-10.3: the only event is catalog.changed.v1 — no alert, no TAT event; the module declares no job/schedule; the DTO carries targets only (data, no "late"/"breach" fields)', { timeout: T }, async () => {
    const e = seeded();
    const out = await set(e, { targets: BOTH });
    expect(new Set(e.db.events.map((x) => x.eventType))).toEqual(new Set(['catalog.changed.v1']));
    expect(JSON.stringify(out)).not.toMatch(/alert|late|breach|overdue|escalat/i);
    const { manifest } = await import('../../index.js');
    expect(Object.keys(manifest).filter((k) => /job|schedule|cron|worker/i.test(k))).toEqual([]);
    expect((manifest as { produces: readonly string[] }).produces).toEqual(['catalog.changed.v1']);
  });

  it('the rows, the version bump, the revision and the event commit together: the write is in ONE transaction, end -> insert -> event', { timeout: T }, async () => {
    const e = seeded();
    await set(e, { targets: [R('routine', 7200)] });
    const mineStmts = e.db.stmts.filter((s) => s.tenantId === TENANT_A);
    const at = (re: RegExp) => mineStmts.findIndex((s) => re.test(s.text));
    const ins = at(/^\s*INSERT\s+INTO\s+catalog\.tat_targets\b/i), ev = at(/INSERT INTO core\.event_log/i);
    expect(ins).toBeGreaterThanOrEqual(0);
    expect(ev).toBeGreaterThan(ins);
    expect(new Set(mineStmts.map((s) => s.txId)).size).toBe(1);
  });

  it('rollback / a failing INSERT of the new rows / a failing event insert leave the ended rows OPEN, the version, revision and event untouched (no half-applied end-and-insert)', { timeout: T }, async () => {
    await set(seeded(), { targets: BOTH });                    // control: without the failure injected the call succeeds (a missing method must not pass this test)
    const a = seeded();
    const before = snapshot(a);
    await rejection(a.db.run((ctx) => a.svc['setTestTatTargets']!(ctx, { id: a.t1.test.id, expectedVersion: 1, body: { targets: BOTH } }), { rollback: true }));
    untouched(a, before);
    const b = seeded(); b.db.fail(/INSERT INTO catalog\.tat_targets/i);
    const bBefore = snapshot(b);
    await rejection(set(b, { targets: BOTH }));
    untouched(b, bBefore);
    expect(openRows(b)).toHaveLength(2);
    const c = seeded(); c.db.fail(/INSERT INTO core\.event_log/i);
    const cBefore = snapshot(c);
    await rejection(set(c, { targets: BOTH }));
    untouched(c, cBefore);
  });
});

// ============================================================================================================ DB-level rules the service relies on
describe('the open-row unique index and grants (05-SCHEMA) are what protect the service', () => {
  it('a second OPEN row for the same (test, priority) is refused by the database (23505 tat_targets__open__p_uq) — inserting before ending is a bug the fake catches', { timeout: T }, async () => {
    const e = seeded();
    const err = await rejection(e.db.run((ctx) => (ctx.tx as any).query(
      'INSERT INTO catalog.tat_targets (id, tenant_id, test_id, priority, segment, target_seconds, effective_from, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)',
      [e.db.newId(), TENANT_A, e.t1.test.id, 'routine', 'within_lab', 3600, NOW, USER])));
    expect(err.code).toBe('23505');
    expect(String(err.constraint ?? err.message)).toContain('tat_targets__open__p_uq');
  });
});

// ============================================================================================================ security
describe('security — S-1 tenancy, S-5 mass assignment, AB-20 no echo, REQ-SEC-082 parameterised SQL', () => {
  it('S-1: tenant B\'s test id (and a panel id, and an unknown id) -> 404 common.not_found; no B row changed, no event, nothing disclosed', { timeout: T }, async () => {
    const e = seeded();
    const bBefore = JSON.stringify([tatRows(e, TENANT_B), e.db.row('tests', e.tb.test.id)]);
    const before = snapshot(e);
    for (const id of [e.tb.test.id, e.p.panel.id, ID(0xdead)]) {
      const err = await rejection(set(e, { targets: BOTH }, { id }));
      lims(err, 'common.not_found', 404);
      expect(JSON.stringify([err.message, err.detail, err.errors])).not.toMatch(/BONLY|Tenant B only/);
    }
    expect(JSON.stringify([tatRows(e, TENANT_B), e.db.row('tests', e.tb.test.id)])).toBe(bBefore);
    untouched(e, before);
  });

  it('S-1: the same ids from the OTHER tenant\'s context: tenant B cannot end/insert targets of tenant A\'s test, and A\'s rows are intact', { timeout: T }, async () => {
    const e = seeded();
    const before = snapshot(e);
    lims(await rejection(set(e, { targets: BOTH }, { id: e.t1.test.id, tenantId: TENANT_B })), 'common.not_found', 404);
    untouched(e, before);
    expect(openRows(e)).toHaveLength(2);
  });

  it('S-1: getTestDetail never shows another tenant\'s targets (tenant B reads its own test: B\'s 7200/900 only; A\'s id is a 404)', { timeout: T }, async () => {
    const e = seeded();
    const b = await detail(e, undefined, TENANT_B, e.tb.test.id);
    expect(b.tat_targets.map((x: any) => x.target_seconds)).toEqual([7200, 900]);
    lims(await rejection(detail(e, undefined, TENANT_B, e.t1.test.id)), 'common.not_found', 404);
    const a = await detail(e);
    expect(a.tat_targets.map((x: any) => x.target_seconds)).toEqual([14400, 3600]);
  });

  it('bad path id -> 400 at /id before any SQL', { timeout: T }, async () => {
    const e = seeded();
    for (const id of ['nope', '', 42, null, undefined, '../etc']) {
      const err = await rejection(set(e, { targets: BOTH }, { id: id as never }));
      validation400(err);
      if (err.code === 'common.validation_failed') expect(errPaths(err)).toContain('/id');
    }
    expect(e.db.stmts.filter((s) => s.tenantId === TENANT_A)).toHaveLength(0);
  });

  it.each([
    ['tenant_id', TENANT_B], ['id', ID(0xbad)], ['test_id', ID(0xbad)], ['version', 9], ['status', 'published'], ['is_active', false], ['revision', 5],
    ['created_by', USER], ['updated_by', USER], ['effective_to', '2030-01-01T00:00:00.000Z'], ['__proto__x', 1],
  ])('S-5: undeclared body field %s -> 400, nothing written', { timeout: T }, async (k, v) => {
    const e = seeded();
    const before = snapshot(e);
    validation400(await rejection(set(e, { targets: BOTH, [k]: v })));
    untouched(e, before);
  });

  it.each([
    ['tenant_id', TENANT_B], ['id', ID(0xbad)], ['test_id', ID(0xbad)], ['version', 9], ['effective_from', NOW], ['effective_to', NOW], ['is_active', false], ['created_by', USER],
  ])('S-5: undeclared field %s INSIDE a target -> 400 (a target cannot carry its own window, owner or tenant), nothing written', { timeout: T }, async (k, v) => {
    const e = seeded();
    const before = snapshot(e);
    const err = await rejection(set(e, { targets: [{ ...R('routine', 3600), [k]: v }] }));
    validation400(err);
    if (err.code === 'common.validation_failed' || err.code === 'common.unknown_field') expect(errPaths(err).join()).toContain('/targets/0');
    untouched(e, before);
  });

  it('AB-20: a rejected value is never echoed back in the error (planted string in priority / segment / effective_from)', { timeout: T }, async () => {
    const e = seeded();
    const planted = 'PLANTED-9c2d\';DROP TABLE catalog.tat_targets;--';
    for (const body of [{ targets: [R(planted, 3600)] }, { targets: [R('routine', 3600, planted)] }, { targets: [R('routine', 3600)], effective_from: planted }]) {
      const err = await rejection(set(e, body));
      validation400(err);
      expect(JSON.stringify({ m: err.message, d: err.detail, errs: err.errors })).not.toContain('PLANTED-9c2d');
    }
  });

  it('REQ-SEC-082: SQL stays parameterised (no value, id or planted text in any tat_targets statement) and every SELECT/UPDATE/DELETE carries an explicit tenant_id = $n predicate; INSERTs bind the tenant', { timeout: T }, async () => {
    const e = seeded();
    await set(e, { targets: [R('routine', 7200), R('urgent', 1800)], effective_from: '2026-11-07T10:00:00.000Z' });
    const own = t6Own(e.db).filter((s) => /catalog\.tat_targets\b/i.test(s.text));
    expect(own.length).toBeGreaterThan(0);
    for (const s of own) {
      expect(s.text).not.toMatch(/7200|1800|2026-11-07|DROP TABLE/);
      expect(s.text).not.toContain(e.t1.test.id);
      if (/^\s*(SELECT|UPDATE|DELETE)/i.test(s.text)) expect(s.text, s.text).toMatch(/\btenant_id\s*=\s*\$\d+/i);
      if (/^\s*INSERT/i.test(s.text)) expect(s.values).toContain(TENANT_A);
    }
  });

  it('the TatTarget table cannot be deleted from by the app role (no DELETE grant -> 42501): history is append/end only', { timeout: T }, async () => {
    const e = seeded();
    const err = await rejection(e.db.run((ctx) => (ctx.tx as any).query('DELETE FROM catalog.tat_targets WHERE tenant_id = $1 AND test_id = $2', [TENANT_A, e.t1.test.id])));
    expect(err.code).toBe('42501');
    expect(openRows(e)).toHaveLength(2);
  });
});
