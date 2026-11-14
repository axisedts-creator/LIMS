// T-03 (C3) — revision service + catalog.changed.v1 publisher.
// Spec: 06-PLAN row T-03; 02-TRD §3 (bumpRevision rules, stamping), §9.1 (event + trigger table); 03-APP-FLOW F-19;
//       03-IC §3.19; PRD AC-19.2, AC-19.3, AC-01.1 (event half); 07-SECURITY A6/E2–E3 (revision decrease, lock window), S-6.
// Real core `createEvents({ producer: 'catalog' })` (schemas from contracts/events) + an in-memory Postgres fake with a
// real row lock (helpers/catalogDb.ts), so the envelope schema is enforced and concurrency is genuine.
// Interface expected from the writer (names marked SEAM are not fixed by the spec; see .orchestra/notes/T-03-tests.md):
//   catalog/repo/catalogState.repo.ts   (SEAM, not imported here; all SQL goes through ctx.tx.query)
//   catalog/events/publish.ts           export function createCatalogEvents(events: { publish(ctx, type, input) })           (SEAM)
//        -> { catalogChanged(ctx, payload, { catalogRootId }) }  payload = the 03-IC payload verbatim (snake_case);
//           calls events.publish(ctx, 'catalog.changed.v1', { aggregate: { type: 'catalog', id: catalogRootId, seq: payload.catalog_revision },
//                                                              idempotencyKey: `${ctx.tenantId}:catalog:${payload.catalog_revision}`, payload })
//   catalog/service/revision.service.ts export function createRevisionService(deps: { events: { publish(ctx, type, input) } })  (SEAM)
//        -> { bumpRevision(ctx, { entityType, entityId, changeKind, effectiveFrom }): Promise<{ revision: number }> }
//           ctx = core HandlerContext subset { tenantId, actor, requestId, tx }; effectiveFrom = ISO-UTC string (…sssZ).
//           For entityType 'test' | 'panel' the root is orderables.id = entityId: UPDATE catalog.orderables SET revision = <new> (bound value)
//           WHERE id = <entityId> in the same tx. Other entity types touch no orderables row (owner lookup for analyte/range/… is T-06+).
import { describe, expect, it } from 'vitest';
import { createEvents } from '../../../../core/events/publish.js';
import { createCatalogEvents } from '../../events/publish.js';
import { createRevisionService } from '../../service/revision.service.js';
import { manifest } from '../../index.js';
import {
  makeCatalogDb, ROOT_A, ROOT_B, TENANT_A, TENANT_B, USER, UUIDV7, V7,
} from '../helpers/catalogDb.js';

const T = 20_000;
const DEPT = V7('000000100001');
const TEST_ID = V7('000000200001');
const PANEL_ID = V7('000000200002');
const OTHER_ID = V7('000000200003');
const EFFECTIVE = '2026-11-06T00:00:00.000Z';

const setup = (seed?: Parameters<typeof makeCatalogDb>[0]) => {
  const db = makeCatalogDb(seed);
  const svc = createRevisionService({ events: createEvents({ producer: 'catalog' } as never) } as never) as {
    bumpRevision(ctx: unknown, input: Record<string, unknown>): Promise<{ revision: number }>;
  };
  return { db, svc };
};
const bump = (s: ReturnType<typeof setup>, ctx: unknown, over: Record<string, unknown> = {}) =>
  s.svc.bumpRevision(ctx, { entityType: 'department', entityId: DEPT, changeKind: 'created', effectiveFrom: EFFECTIVE, ...over });
const at418 = () => setup({ state: { [TENANT_A]: { rootId: ROOT_A, revision: 417 } } });

describe('AC-19.2 bump increments the tenant catalog_revision by exactly 1', () => {
  it('417 -> 418 -> 419, returned and persisted', async () => {
    const s = at418();
    const a = await s.db.run((ctx) => bump(s, ctx));
    expect(a.revision).toBe(418);
    expect(typeof a.revision).toBe('number');           // pg returns bigint as a string; the service must hand back a number
    expect(s.db.revisionOf(TENANT_A)).toBe(418);
    const b = await s.db.run((ctx) => bump(s, ctx, { entityId: V7('000000100002') }));
    expect(b.revision).toBe(419);
    expect(s.db.revisionOf(TENANT_A)).toBe(419);
  });

  it('first ever write of a tenant lazily creates the state row: revision 1, root id is a fresh UUIDv7, created_by = actor', async () => {
    const s = setup();
    const out = await s.db.run((ctx) => bump(s, ctx));
    expect(out.revision).toBe(1);
    expect(s.db.hasState(TENANT_A)).toBe(true);
    expect(s.db.rootOf(TENANT_A)).toMatch(UUIDV7);
    expect(s.db.createdByOf(TENANT_A)).toBe(USER);
  });

  it('the catalog_state UPDATE is scoped by tenant_id explicitly (bound = tx tenant), not by RLS alone (03-APP-FLOW §168)', async () => {
    const s = at418();
    await s.db.run((ctx) => bump(s, ctx));
    const upd = s.db.stmts.filter((x) => /^\s*UPDATE\s+catalog\.catalog_state/i.test(x.text));
    expect(upd).toHaveLength(1);
    expect(upd[0]!.text).toMatch(/WHERE\s+tenant_id\s*=\s*\$1/i);
    expect(upd[0]!.values[0]).toBe(TENANT_A);
    expect(upd[0]!.values[0]).toBe(upd[0]!.tenantId);
  });

  it('two roots changed in ONE transaction -> two increments, two events (one per increment)', async () => {
    const s = at418();
    const out = await s.db.run(async (ctx) => [
      await bump(s, ctx, { entityType: 'department', entityId: DEPT }),
      await bump(s, ctx, { entityType: 'panel', entityId: PANEL_ID, changeKind: 'updated' }),
    ]);
    expect(out.map((o) => o.revision)).toEqual([418, 419]);
    expect(s.db.revisionOf(TENANT_A)).toBe(419);
    expect(s.db.events.map((e) => e.key)).toEqual([`${TENANT_A}:catalog:418`, `${TENANT_A}:catalog:419`]);
  });

  it('tenants have independent counters', async () => {
    const s = setup({ state: { [TENANT_A]: { rootId: ROOT_A, revision: 10 }, [TENANT_B]: { rootId: ROOT_B, revision: 500 } } });
    await s.db.run((ctx) => bump(s, ctx));
    await s.db.run((ctx) => bump(s, ctx), { tenantId: TENANT_B });
    expect(s.db.revisionOf(TENANT_A)).toBe(11);
    expect(s.db.revisionOf(TENANT_B)).toBe(501);
    expect(s.db.events.map((e) => e.key).sort()).toEqual([`${TENANT_A}:catalog:11`, `${TENANT_B}:catalog:501`].sort());
  });
});

describe('stamps the root row (02-TRD §3 revision stamping)', () => {
  const seed = () => setup({
    state: { [TENANT_A]: { rootId: ROOT_A, revision: 417 } },
    orderables: {
      [TEST_ID]: { tenantId: TENANT_A, revision: 400 }, [PANEL_ID]: { tenantId: TENANT_A, revision: 401 },
      [OTHER_ID]: { tenantId: TENANT_A, revision: 402 },
    },
  });

  it.each([['test', TEST_ID], ['panel', PANEL_ID]])('a %s bump sets orderables.revision = new revision on that orderable only', async (entityType, id) => {
    const s = seed();
    const out = await s.db.run((ctx) => bump(s, ctx, { entityType, entityId: id, changeKind: 'updated' }));
    expect(out.revision).toBe(418);
    expect(s.db.orderableRevision(id)).toBe(418);
    const others = [TEST_ID, PANEL_ID, OTHER_ID].filter((x) => x !== id);
    expect(others.map((x) => s.db.orderableRevision(x))).toEqual(others.map((x) => ({ [TEST_ID]: 400, [PANEL_ID]: 401, [OTHER_ID]: 402 })[x]));
  });

  it('a department bump touches no orderables row', async () => {
    const s = seed();
    await s.db.run((ctx) => bump(s, ctx));
    expect(s.db.stmts.filter((x) => /catalog\.orderables/i.test(x.text))).toHaveLength(0);
    expect(s.db.orderableRevision(TEST_ID)).toBe(400);
  });

  it('stamp and counter commit or roll back together', async () => {
    const s = seed();
    await expect(s.db.run((ctx) => bump(s, ctx, { entityType: 'test', entityId: TEST_ID, changeKind: 'updated' }), { rollback: true })).rejects.toThrow();
    expect(s.db.orderableRevision(TEST_ID)).toBe(400);
    expect(s.db.revisionOf(TENANT_A)).toBe(417);
  });

  it('never stamps another tenant\'s orderable (RLS scope; id from tenant B is invisible to tenant A)', async () => {
    const s = setup({
      state: { [TENANT_A]: { rootId: ROOT_A, revision: 1 }, [TENANT_B]: { rootId: ROOT_B, revision: 1 } },
      orderables: { [TEST_ID]: { tenantId: TENANT_B, revision: 7 } },
    });
    await s.db.run((ctx) => bump(s, ctx, { entityType: 'test', entityId: TEST_ID, changeKind: 'updated' }));
    expect(s.db.orderableRevision(TEST_ID)).toBe(7);
  });
});

describe('event contract: catalog.changed.v1 (03-IC §3.19, 02-TRD §9.1)', () => {
  it('AC-01.1 (event half): department created is published in the SAME transaction, with exact envelope + payload', async () => {
    const s = at418();
    let seenInsideTx = 0;
    await s.db.run(async (ctx) => {
      await bump(s, ctx, { entityType: 'department', entityId: DEPT, changeKind: 'created' });
      seenInsideTx = s.db.stmts.filter((x) => /INSERT\s+INTO\s+core\.event_log/i.test(x.text)).length;
    });
    expect(seenInsideTx).toBe(1);                       // issued through ctx.tx before COMMIT, not after
    expect(s.db.events).toHaveLength(1);
    const e = s.db.events[0]!;
    expect(e.eventType).toBe('catalog.changed.v1');
    expect(e.key).toBe(`${TENANT_A}:catalog:418`);
    expect(e.envelope).toMatchObject({
      event_type: 'catalog.changed.v1', tenant_id: TENANT_A, producer: 'catalog', idempotency_key: `${TENANT_A}:catalog:418`,
      aggregate: { type: 'catalog', id: ROOT_A, seq: 418 }, actor: { type: 'user', id: USER },
    });
    expect(e.envelope.payload).toEqual({
      catalog_revision: 418, entity_type: 'department', entity_id: DEPT, change_kind: 'created', effective_from: EFFECTIVE,
    });
    expect(typeof e.envelope.payload.catalog_revision).toBe('number');
    expect(s.db.jobs).toHaveLength(1);                  // core.event_fanout enqueued in the same tx
  });

  it('payload carries exactly the 5 IC keys (no names/prices/contact data: PHI class P0)', async () => {
    const s = at418();
    await s.db.run((ctx) => bump(s, ctx, { entityType: 'doctor', entityId: V7('000000300001'), changeKind: 'updated' }));
    expect(Object.keys(s.db.events[0]!.envelope.payload).sort())
      .toEqual(['catalog_revision', 'change_kind', 'effective_from', 'entity_id', 'entity_type']);
  });

  const ENTITY_TYPES = ['department', 'specimen_type', 'container', 'test', 'analyte', 'panel', 'reference_range', 'critical_limit', 'comment_code',
    'doctor', 'credit_party', 'price_list', 'surcharge_rule', 'tat_target', 'instrument_code_map', 'global_reference', 'method', 'unit',
    'value_set', 'tax_rule', 'catalog_import'];
  it.each(ENTITY_TYPES)('entity_type %s validates against the schema and is passed through unchanged', async (entityType) => {
    const s = at418();
    await s.db.run((ctx) => bump(s, ctx, { entityType, changeKind: 'versioned' }));
    expect(s.db.events[0]!.envelope.payload.entity_type).toBe(entityType);
  });

  it.each(['created', 'updated', 'deactivated', 'versioned'])('change_kind %s is accepted', async (changeKind) => {
    const s = at418();
    await s.db.run((ctx) => bump(s, ctx, { changeKind }));
    expect(s.db.events[0]!.envelope.payload.change_kind).toBe(changeKind);
  });

  it('catalog_import: one bump, one event, entity_id = import id, change_kind updated (08 A13 D-21)', async () => {
    const s = at418();
    const importId = V7('000000400001');
    await s.db.run((ctx) => bump(s, ctx, { entityType: 'catalog_import', entityId: importId, changeKind: 'updated' }));
    expect(s.db.revisionOf(TENANT_A)).toBe(418);
    expect(s.db.events).toHaveLength(1);
    expect(s.db.events[0]!.envelope.payload).toMatchObject({ entity_type: 'catalog_import', entity_id: importId, change_kind: 'updated' });
  });

  it('manifest declares the event it produces', () => {
    expect([...manifest.produces]).toContain('catalog.changed.v1');
  });

  it('createCatalogEvents.catalogChanged calls events.publish once with aggregate catalog/root/seq and key <tenant>:catalog:<rev>', async () => {
    const calls: Array<{ ctx: any; type: string; input: any }> = [];
    const events = { publish: async (ctx: unknown, type: string, input: unknown) => { calls.push({ ctx: ctx as any, type, input }); return { eventId: 'e', duplicate: false }; } };
    const pub = createCatalogEvents(events as never) as any;
    const payload = { catalog_revision: 418, entity_type: 'price_list', entity_id: V7('000000180001'), change_kind: 'versioned', effective_from: EFFECTIVE };
    const db = makeCatalogDb();
    const ctx = db.ctxFor(db.begin(TENANT_A));
    await pub.catalogChanged(ctx, payload, { catalogRootId: ROOT_A });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.type).toBe('catalog.changed.v1');
    expect(calls[0]!.input.aggregate).toEqual({ type: 'catalog', id: ROOT_A, seq: 418 });
    expect(calls[0]!.input.idempotencyKey).toBe(`${TENANT_A}:catalog:418`);
    expect(calls[0]!.input.payload).toEqual(payload);
  });
});

describe('rollback publishes nothing (AC-19.2)', () => {
  it('rolled-back transaction: no event_log row, no fan-out job, counter unchanged', async () => {
    const s = at418();
    await expect(s.db.run((ctx) => bump(s, ctx), { rollback: true })).rejects.toThrow('forced rollback');
    expect(s.db.events).toHaveLength(0);
    expect(s.db.jobs).toHaveLength(0);
    expect(s.db.revisionOf(TENANT_A)).toBe(417);
  });

  it('after a rollback the next writer gets the SAME revision (no gap)', async () => {
    const s = at418();
    await expect(s.db.run((ctx) => bump(s, ctx), { rollback: true })).rejects.toThrow();
    const out = await s.db.run((ctx) => bump(s, ctx));
    expect(out.revision).toBe(418);
    expect(s.db.events.map((e) => e.key)).toEqual([`${TENANT_A}:catalog:418`]);
  });

  it('a failing publish (fan-out enqueue throws) rejects bumpRevision and leaves nothing behind', async () => {
    const s = at418();
    s.db.fail(/app\.enqueue_job/i);
    await expect(s.db.run((ctx) => bump(s, ctx))).rejects.toThrow();
    expect(s.db.events).toHaveLength(0);
    expect(s.db.revisionOf(TENANT_A)).toBe(417);
  });

  it.each([
    ['entityId not a UUIDv7', { entityId: 'not-a-uuid' }],
    ['unknown change_kind', { changeKind: 'deleted' }],
    ['effectiveFrom not ISO-UTC ms', { effectiveFrom: '2026-11-06' }],
    ['tenant_id smuggled as an extra field is not accepted into the payload', { entityType: 'doctor', tenant_id: TENANT_B }],
  ])('invalid input (%s): schema check fails closed; if it rejects, the counter is unchanged', async (_n, over) => {
    const s = at418();
    const p = s.db.run((ctx) => bump(s, ctx, over));
    if ('tenant_id' in over) {
      await p;                                          // extra input keys are ignored, never copied to the payload
      expect(Object.keys(s.db.events[0]!.envelope.payload)).not.toContain('tenant_id');
      expect(s.db.events[0]!.envelope.tenant_id).toBe(TENANT_A);
      return;
    }
    await expect(p).rejects.toThrow();
    expect(s.db.events).toHaveLength(0);
    expect(s.db.revisionOf(TENANT_A)).toBe(417);
  });
});

describe('AC-19.3 concurrent writers: strictly increasing, gapless, no duplicates (row lock on catalog_state)', () => {
  const keys = (s: ReturnType<typeof setup>, t: string) =>
    s.db.events.filter((e) => e.tenantId === t).map((e) => Number(e.key.split(':')[2])).sort((a, b) => a - b);
  const seq = (from: number, n: number) => Array.from({ length: n }, (_, i) => from + i);

  it('20 concurrent writers on an existing state row get 101..120 exactly once each', async () => {
    const s = setup({ state: { [TENANT_A]: { rootId: ROOT_A, revision: 100 } } });
    const got = await Promise.all(seq(0, 20).map((i) => s.db.run((ctx) => bump(s, ctx, { entityId: V7(`0000005000${String(i).padStart(2, '0')}`) }))));
    expect(got.map((g) => g.revision).sort((a, b) => a - b)).toEqual(seq(101, 20));
    expect(s.db.revisionOf(TENANT_A)).toBe(120);
    expect(keys(s, TENANT_A)).toEqual(seq(101, 20));
    expect(new Set(s.db.events.map((e) => e.key)).size).toBe(20);
    expect(s.db.jobs).toHaveLength(20);
  }, T);

  it('20 concurrent FIRST writers (state row does not exist yet) get 1..20: lazy create does not race', async () => {
    const s = setup();
    const got = await Promise.all(seq(0, 20).map(() => s.db.run((ctx) => bump(s, ctx))));
    expect(got.map((g) => g.revision).sort((a, b) => a - b)).toEqual(seq(1, 20));
    expect(keys(s, TENANT_A)).toEqual(seq(1, 20));
    expect(s.db.rootOf(TENANT_A)).toMatch(UUIDV7);
    // every event carries the same (single) root id
    expect(new Set(s.db.events.map((e) => e.envelope.aggregate.id))).toEqual(new Set([s.db.rootOf(TENANT_A)]));
  }, T);

  it('commit order equals revision order (strictly increasing by exactly 1 along the commit log)', async () => {
    const s = setup({ state: { [TENANT_A]: { rootId: ROOT_A, revision: 0 } } });
    await Promise.all(seq(0, 20).map(() => s.db.run((ctx) => bump(s, ctx))));
    const log = s.db.commitLog.map((c) => c.revisions[TENANT_A]!);
    expect(log).toEqual(seq(1, 20));
  }, T);

  it('writers that roll back leave no gap: 20 writers, every 4th rolls back after its bump -> 1..15 committed', async () => {
    const s = setup();
    const results = await Promise.allSettled(seq(0, 20).map((i) => s.db.run((ctx) => bump(s, ctx), { rollback: i % 4 === 3 })));
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(5);
    expect(s.db.revisionOf(TENANT_A)).toBe(15);
    expect(keys(s, TENANT_A)).toEqual(seq(1, 15));
    expect(s.db.commitLog.map((c) => c.revisions[TENANT_A])).toEqual(seq(1, 15));
  }, T);

  it('two tenants written concurrently are each gapless and do not block or mix', async () => {
    const s = setup({ state: { [TENANT_A]: { rootId: ROOT_A, revision: 0 }, [TENANT_B]: { rootId: ROOT_B, revision: 40 } } });
    await Promise.all(seq(0, 20).map((i) => s.db.run((ctx) => bump(s, ctx), { tenantId: i % 2 ? TENANT_B : TENANT_A })));
    expect(keys(s, TENANT_A)).toEqual(seq(1, 10));
    expect(keys(s, TENANT_B)).toEqual(seq(41, 10));
    expect(s.db.events.every((e) => e.key.startsWith(e.tenantId + ':catalog:'))).toBe(true);
  }, T);

  it('a writer that bumps twice in one tx while others queue does not deadlock (lock is re-entrant per tx)', async () => {
    const s = setup({ state: { [TENANT_A]: { rootId: ROOT_A, revision: 0 } } });
    await Promise.all(seq(0, 6).map(() => s.db.run(async (ctx) => { await bump(s, ctx); await bump(s, ctx); })));
    expect(s.db.revisionOf(TENANT_A)).toBe(12);
    expect(keys(s, TENANT_A)).toEqual(seq(1, 12));
  }, T);

  it('the counter is locked BEFORE the event and the stamp are written (lock window covers read-increment-publish)', async () => {
    const s = setup({ state: { [TENANT_A]: { rootId: ROOT_A, revision: 3 } }, orderables: { [TEST_ID]: { tenantId: TENANT_A, revision: 1 } } });
    await s.db.run((ctx) => bump(s, ctx, { entityType: 'test', entityId: TEST_ID, changeKind: 'updated' }));
    const idx = (re: RegExp) => s.db.stmts.findIndex((x) => re.test(x.text));
    const lock = Math.min(...[/FOR UPDATE/i, /UPDATE\s+catalog\.catalog_state/i].map(idx).filter((i) => i >= 0));
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(lock).toBeLessThan(idx(/INSERT\s+INTO\s+core\.event_log/i));
    expect(lock).toBeLessThan(idx(/UPDATE\s+catalog\.orderables/i));
  });
});

describe('adversarial: SQL injection / identifiers (07-SECURITY S-6, REQ-SEC-080)', () => {
  it('every id and tenant reaches Postgres as a bind value, never interpolated into statement text', async () => {
    const s = setup({ state: { [TENANT_A]: { rootId: ROOT_A, revision: 5 } }, orderables: { [TEST_ID]: { tenantId: TENANT_A, revision: 1 } } });
    await s.db.run((ctx) => bump(s, ctx, { entityType: 'test', entityId: TEST_ID, changeKind: 'updated' }));
    for (const st of s.db.stmts) {
      expect(st.text).not.toContain(TENANT_A);
      expect(st.text).not.toContain(TEST_ID);
      expect(st.text).not.toContain(ROOT_A);
    }
  });

  it('an entityId that looks like SQL is rejected before any catalog write is visible', async () => {
    const s = at418();
    await expect(s.db.run((ctx) => bump(s, ctx, { entityId: `${DEPT}'; DROP TABLE catalog.catalog_state;--` }))).rejects.toThrow();
    expect(s.db.revisionOf(TENANT_A)).toBe(417);
    expect(s.db.events).toHaveLength(0);
  });
});
