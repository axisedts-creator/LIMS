// T-26 (C3) worker integration: catalog.global_release_fanout — AC-19.5 ("after a seed migration bumps the global reference release, within 15 min [cron
// every 10 min] each tenant receives one catalog.changed.v1 with entity_type = global_reference"), 02-TRD §10 (compare catalog.g_reference_release.release_no with the
// tenant's catalog_state.global_release_seen; if greater -> bumpRevision(global_reference) + set seen, in one tx; max_attempts 3), §9.1 (event shape/table row
// "global release (job)"), §3 (revision), 03-APP-FLOW F-20, 08 A13 P-6 (per_tenant: one job per tenant, tenant claims, payload {tenant_id}).
// Task under test: services/worker/src/jobs/catalog/tasks/catalog.global_release_fanout.ts exporting GLOBAL_RELEASE_FANOUT = 'catalog.global_release_fanout' and
//   globalReleaseFanout: TaskHandler; payload { tenant_id }. DB access via ctx.tx.query in the dialect of helpers/cronDb.ts; the event goes out through
//   ctx.events.publish(ctx, 'catalog.changed.v1', input) (as services/api/.../revision.service.ts + events/publish.ts do: aggregate/idempotencyKey/payload).
// ASSUMED (spec silent) — the writer may NOT change these tests, only raise a CR:
//   * a tenant without a catalog_state row is created lazily (as bumpRevision/ensureState does): revision 1 after the bump.
//   * several releases behind (seen 2, release 5) -> ONE bump and ONE event, seen = 5.
//   * seen > release_no (should not happen) and no g_reference_release row -> no-op, no throw.
//   * effective_from = ctx.now() (job run time, TRD §9.1 table).
import { describe, expect, it } from 'vitest';
import { globalReleaseFanout } from '../../tasks/catalog.global_release_fanout.js';
import { NOW, TENANT_A, TENANT_B, USER, V7, makeCronDb, makeRunner, type CronDb } from '../helpers/cronRunner.js';

const ROOT_A = V7('00000000c3a0');
const ROOT_B = V7('00000000c3b0');
const state = (db: CronDb, tenant: string) => db.rows('catalog_state', tenant)[0];
const changed = (r: ReturnType<typeof makeRunner>) => r.events.filter((e) => e.type === 'catalog.changed.v1');

function setup(o: { release?: number; seenA?: number; seenB?: number; revA?: number; revB?: number } = {}) {
  const db = makeCronDb();
  if (o.release !== undefined) db.seed.release(o.release); else db.seed.release(3);
  db.seed.catalogState(TENANT_A, { catalog_revision: o.revA ?? 7, global_release_seen: o.seenA ?? 0 });
  db.seed.catalogState(TENANT_B, { catalog_revision: o.revB ?? 99, global_release_seen: o.seenB ?? 0 });
  const a = makeRunner(db, globalReleaseFanout, { tenantId: TENANT_A });
  const b = makeRunner(db, globalReleaseFanout, { tenantId: TENANT_B });
  return { db, a, b, goA: () => a.run({ tenant_id: TENANT_A }), goB: () => b.run({ tenant_id: TENANT_B }) };
}

describe('catalog.global_release_fanout (T-26, AC-19.5)', () => {
  it('release_no > global_release_seen: bumps the revision once and records the release as seen', async () => {
    const { db, goA } = setup({ release: 3, seenA: 2, revA: 7 });
    await goA();
    expect(Number(state(db, TENANT_A)!.catalog_revision)).toBe(8);
    expect(state(db, TENANT_A)!.global_release_seen).toBe(3);
  });

  it('publishes exactly one catalog.changed.v1 {entity_type global_reference, change_kind updated, entity_id = catalog_root_id, effective_from = job time}', async () => {
    const { a, goA } = setup({ release: 3, seenA: 2, revA: 7 });
    await goA();
    const ev = changed(a);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.input.payload).toEqual({ catalog_revision: 8, entity_type: 'global_reference', entity_id: ROOT_A, change_kind: 'updated', effective_from: NOW });
  });

  it('event envelope follows 02-TRD §9.1: aggregate {catalog, root, seq = revision} and idempotencyKey `<tenant>:catalog:<revision>`', async () => {
    const { a, goA } = setup({ release: 3, seenA: 2, revA: 7 });
    await goA();
    const input = changed(a)[0]!.input;
    expect(input.aggregate).toEqual({ type: 'catalog', id: ROOT_A, seq: 8 });
    expect(input.idempotencyKey).toBe(`${TENANT_A}:catalog:8`);
  });

  it('the event is published under the claimed tenant (ctx.tenantId) — payload carries no names, prices or contact data', async () => {
    const { a, goA } = setup({ release: 3, seenA: 2 });
    await goA();
    expect(changed(a)[0]!.ctx.tenantId).toBe(TENANT_A);
    expect(Object.keys(changed(a)[0]!.input.payload).sort()).toEqual(['catalog_revision', 'change_kind', 'effective_from', 'entity_id', 'entity_type']);
  });

  it('AC-19.5: after one release every tenant gets exactly one event with its own revision and root', async () => {
    const { db, a, b, goA, goB } = setup({ release: 4, seenA: 3, seenB: 3, revA: 7, revB: 99 });
    await goA();
    await goB();
    expect(changed(a)).toHaveLength(1);
    expect(changed(b)).toHaveLength(1);
    expect(changed(a)[0]!.input.payload).toMatchObject({ catalog_revision: 8, entity_id: ROOT_A, entity_type: 'global_reference' });
    expect(changed(b)[0]!.input.payload).toMatchObject({ catalog_revision: 100, entity_id: ROOT_B, entity_type: 'global_reference' });
    expect(changed(b)[0]!.input.idempotencyKey).toBe(`${TENANT_B}:catalog:100`);
    expect(state(db, TENANT_A)!.global_release_seen).toBe(4);
    expect(state(db, TENANT_B)!.global_release_seen).toBe(4);
  });

  it('release_no == global_release_seen: no bump, no event, nothing written', async () => {
    const { db, a, goA } = setup({ release: 3, seenA: 3, revA: 7 });
    const before = JSON.stringify(db.rows('catalog_state'));
    await goA();
    expect(JSON.stringify(db.rows('catalog_state'))).toBe(before);
    expect(a.events).toEqual([]);
  });

  it('is idempotent: a second run for the same release (next cron tick) emits nothing and keeps the revision', async () => {
    const { db, a, goA } = setup({ release: 3, seenA: 2, revA: 7 });
    await goA();
    const once = JSON.stringify(db.rows('catalog_state'));
    await goA();
    await goA();
    expect(JSON.stringify(db.rows('catalog_state'))).toBe(once);
    expect(changed(a)).toHaveLength(1);
  });

  it('a later release is picked up by the next tick: second bump, second event', async () => {
    const { db, a, goA } = setup({ release: 3, seenA: 2, revA: 7 });
    await goA();
    db.seed.release(4);
    await goA();
    expect(changed(a).map((e) => e.input.payload.catalog_revision)).toEqual([8, 9]);
    expect(state(db, TENANT_A)!.global_release_seen).toBe(4);
  });

  it('several releases behind -> one bump, one event, seen jumps to the current release', async () => {
    const { db, a, goA } = setup({ release: 5, seenA: 2, revA: 7 });
    await goA();
    expect(changed(a)).toHaveLength(1);
    expect(Number(state(db, TENANT_A)!.catalog_revision)).toBe(8);
    expect(state(db, TENANT_A)!.global_release_seen).toBe(5);
  });

  it('a brand-new tenant (seen 0, release 1 seeded) is told once: the baseline release also fans out', async () => {
    const { db, a, goA } = setup({ release: 1, seenA: 0, revA: 7 });
    await goA();
    expect(changed(a)).toHaveLength(1);
    expect(state(db, TENANT_A)!.global_release_seen).toBe(1);
  });

  it('a tenant without a catalog_state row gets one (lazy create) and still fans out once', async () => {
    const db = makeCronDb();
    db.seed.release(2);
    const r = makeRunner(db, globalReleaseFanout, { tenantId: TENANT_A });
    await r.run({ tenant_id: TENANT_A });
    const s = state(db, TENANT_A)!;
    expect(Number(s.catalog_revision)).toBe(1);
    expect(s.global_release_seen).toBe(2);
    expect(changed(r)).toHaveLength(1);
    expect(changed(r)[0]!.input.payload).toMatchObject({ catalog_revision: 1, entity_type: 'global_reference', entity_id: s.catalog_root_id });
    await r.run({ tenant_id: TENANT_A });
    expect(changed(r)).toHaveLength(1);
  });

  it('runs under tenant claims: the other tenant\'s state is untouched and gets no event from this run', async () => {
    const { db, a, goA } = setup({ release: 3, seenA: 2, seenB: 2, revB: 99 });
    await goA();
    expect(Number(state(db, TENANT_B)!.catalog_revision)).toBe(99);
    expect(state(db, TENANT_B)!.global_release_seen).toBe(2);
    expect(changed(a).every((e) => e.ctx.tenantId === TENANT_A)).toBe(true);
  });

  it('a payload naming another tenant than the job claims cannot bump that tenant', async () => {
    const { db, a } = setup({ release: 3, seenA: 2, seenB: 2, revB: 99 });
    await a.run({ tenant_id: TENANT_B }).catch(() => undefined);
    expect(Number(state(db, TENANT_B)!.catalog_revision)).toBe(99);
    expect(state(db, TENANT_B)!.global_release_seen).toBe(2);
    expect(a.events.every((e) => e.ctx.tenantId === TENANT_A)).toBe(true);
  });

  it('is atomic: when the event cannot be published, the revision bump and seen update roll back with it and the error surfaces (retry via max_attempts 3)', async () => {
    const db = makeCronDb();
    db.seed.release(3);
    db.seed.catalogState(TENANT_A, { catalog_revision: 7, global_release_seen: 2 });
    const r = makeRunner(db, globalReleaseFanout, { tenantId: TENANT_A, publishError: new Error('event_log unavailable') });
    await expect(r.run({ tenant_id: TENANT_A })).rejects.toThrow();
    expect(Number(state(db, TENANT_A)!.catalog_revision)).toBe(7);
    expect(state(db, TENANT_A)!.global_release_seen).toBe(2);
    expect(r.events).toEqual([]);
  });

  it('is atomic: when "set seen" fails, the bump and its event are discarded', async () => {
    const { db, a, goA } = setup({ release: 3, seenA: 2, revA: 7 });
    db.fail(/global_release_seen\s*=/i, () => Object.assign(new Error('injected'), { code: '40001' }));
    await expect(goA()).rejects.toThrow();
    expect(Number(state(db, TENANT_A)!.catalog_revision)).toBe(7);
    expect(state(db, TENANT_A)!.global_release_seen).toBe(2);
    expect(a.events).toEqual([]);
  });

  it('retry after a failed attempt succeeds exactly once (no double bump)', async () => {
    const db = makeCronDb();
    db.seed.release(3);
    db.seed.catalogState(TENANT_A, { catalog_revision: 7, global_release_seen: 2 });
    db.fail(/global_release_seen\s*=/i, () => new Error('injected'));
    const r = makeRunner(db, globalReleaseFanout, { tenantId: TENANT_A });
    await expect(r.run({ tenant_id: TENANT_A }, 1, 3)).rejects.toThrow();
    db.clearFailures();
    await r.run({ tenant_id: TENANT_A }, 2, 3);
    expect(Number(state(db, TENANT_A)!.catalog_revision)).toBe(8);
    expect(changed(r)).toHaveLength(1);
  });

  it('seen ahead of the release (inconsistent) and a missing release row are no-ops, never errors', async () => {
    const { db, a, goA } = setup({ release: 3, seenA: 9, revA: 7 });
    await expect(goA()).resolves.toBeUndefined();
    expect(a.events).toEqual([]);
    expect(Number(state(db, TENANT_A)!.catalog_revision)).toBe(7);
    const none = makeCronDb();
    none.seed.catalogState(TENANT_A, { catalog_revision: 7, global_release_seen: 0 });
    const r = makeRunner(none, globalReleaseFanout, { tenantId: TENANT_A });
    await expect(r.run({ tenant_id: TENANT_A })).resolves.toBeUndefined();
    expect(r.events).toEqual([]);
  });

  it('writes only catalog_state: no import/export/file rows touched, no job enqueued, no DELETE', async () => {
    const { db, goA } = setup({ release: 3, seenA: 2 });
    db.seed.import(TENANT_A, { status: 'validated', expires_at: new Date(Date.parse(NOW) - 1000) });
    const before = JSON.stringify([db.rows('imports'), db.rows('exports'), db.rows('files'), db.rows('import_issues')]);
    await goA();
    expect(JSON.stringify([db.rows('imports'), db.rows('exports'), db.rows('files'), db.rows('import_issues')])).toBe(before);
    expect(db.jobs).toEqual([]);
    expect(db.stmts.some((s) => /^\s*DELETE\b/i.test(s.text))).toBe(false);
    expect(db.stmts.length).toBeGreaterThan(0);
    expect(new Set(db.stmts.map((s) => s.tenantId))).toEqual(new Set([TENANT_A]));
  });

  it('does not log ids of users or the event payload (S-13)', async () => {
    const { a, goA } = setup({ release: 3, seenA: 2 });
    await goA();
    expect(a.log.text()).not.toContain(USER);
  });
});
