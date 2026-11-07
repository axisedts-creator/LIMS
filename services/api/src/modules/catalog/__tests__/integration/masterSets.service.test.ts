// T-05 (C3) — units (#17–#19) and value sets (#20–#22): global shadowing, global rows read-only, in-use value-set protection.
// Spec: 06-PLAN row T-05 (done_when "global rows read-only; in-use value-set protection"; AC-02.6 value-set existence/is_ordered data);
//       02-TRD §5 table rows 17–22 + DTOs `Unit`/`ValueSet` (L159–160), §5.0 conventions (If-Match), §9.1 events (`unit`, `value_set`),
//       §3 revision rule; 05-SCHEMA g_*/cs_* (global tables: GRANT SELECT only; "service rejects a tenant code equal to a global code");
//       01-PRD D-C3-01; 04-UI-UX SCR-05; 03-APP-FLOW §5 SCR-05 banner (`catalog.version_in_use`); 07-SECURITY S-1, S-5, AB-20.
// Real core `createEvents({producer:'catalog'})` over the SQL fake helpers/setsDb.ts; the revision bump is T-03's real service.
// Interface expected from the writer (SEAM names; see .orchestra/notes/T-05-tests.md) — same factory as T-04, six more methods:
//   service/masters.service.ts  createMastersService({events}) ->
//     listUnits(ctx, {scope?, is_active?:'true'|'false'|'all'}) -> { data: Unit[] }        (no `page`: UnitList has none)
//     createUnit(ctx, {code, display})                        -> Unit (the 201 body)
//     updateUnit(ctx, {id, expectedVersion, patch})           -> Unit
//     listValueSets(ctx, {scope?})                            -> { data: ValueSet[] }
//     createValueSet(ctx, {code, display, is_ordered, values}) -> ValueSet
//     updateValueSet(ctx, {id, expectedVersion, patch})       -> ValueSet
//   DTOs are the snake_case schemas in contracts/openapi/catalog.yaml. Global rows carry `scope:'global'` and NO id/version (TRD: "id (tenant rows)").
//   The global ∪ tenant list is two SELECTs merged in code (the fake has no UNION). All writes in ONE tx with the bumpRevision call.
import { describe, expect, it } from 'vitest';
import { createEvents } from '../../../../core/events/publish.js';
import { isLimsError } from '../../../../core/errors.js';
import { createMastersService } from '../../service/masters.service.js';
import { ROOT_A, TENANT_A, TENANT_B, USER, UUIDV7 } from '../helpers/catalogDb.js';
import { ID, type Row } from '../helpers/mastersDb.js';
import { av, gSet, gUnit, gVal, makeSetsDb, unit, vset, vval, type SetTable } from '../helpers/setsDb.js';

const T = 20_000;
type Svc = Record<string, (ctx: any, input?: any) => Promise<any>>;
const seedState = { state: { [TENANT_A]: { rootId: ROOT_A, revision: 417 } } };

const setup = (rows: Partial<Record<SetTable, Row[]>> = {}, catalog: any = seedState) => {
  const db = makeSetsDb({ rows, catalog });
  const svc = createMastersService({ events: createEvents({ producer: 'catalog' } as never) } as never) as unknown as Svc;
  return { db, svc };
};
type Db = ReturnType<typeof setup>['db'];
// A TypeError ("svc.x is not a function", a crash) is never an acceptable rejection: no test here expects one.
const rejection = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { expect(e, `crash: ${(e as Error)?.message}`).not.toBeInstanceOf(TypeError); return e; } throw new Error('expected rejection, got success'); };
const lims = (e: any, code: string, status: number) => { expect(isLimsError(e, code), `got ${e?.code ?? e?.message}`).toBe(true); expect(e.statusCode).toBe(status); };
const validation400 = (e: any) => { expect(isLimsError(e), `got ${e?.code ?? e?.message}`).toBe(true); expect(e.statusCode).toBe(400); expect(['common.validation_failed', 'common.unknown_field']).toContain(e.code); };
const events = (db: Db, tenant = TENANT_A) => db.events.filter((e) => e.tenantId === tenant && e.eventType === 'catalog.changed.v1');
const ownStmts = (db: Db, tenant = TENANT_A) => db.stmts.filter((s) => s.tenantId === tenant);
const writesToGlobal = (db: Db) => db.stmts.filter((s) => /^\s*(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+catalog\.g_/i.test(s.text));
const codesOf = (r: { data: any[] }) => r.data.map((x) => x.code).sort();
const upd = (svc: Svc, op: string, db: Db, id: string, version: number | undefined, patch: object, tenantId = TENANT_A) =>
  db.run((ctx) => svc[op]!(ctx, { id, expectedVersion: version, patch }), { tenantId });

// Fixtures. Global: units g_dl, g_l, pct; sets URINE_SEMIQ (ordered), POS_NEG (unordered).
const G_UNITS = [gUnit(1, { code: 'g_dl', display: 'g/dL' }), gUnit(2, { code: 'g_l', display: 'g/L' }), gUnit(3, { code: 'pct', display: '%' })];
const G_URINE = gSet(1, { code: 'URINE_SEMIQ', display: 'Urine semi-quantitative', is_ordered: true });
const G_POSNEG = gSet(2, { code: 'POS_NEG', display: 'Positive / negative', is_ordered: false });
const G_SETS = [G_URINE, G_POSNEG];
const G_VALUES = [
  gVal('URINE_SEMIQ', 3, { code: '2+', display: '2+', sort_order: 30 }), gVal('URINE_SEMIQ', 1, { code: 'NEG', display: 'Negative', sort_order: 10 }),
  gVal('URINE_SEMIQ', 2, { code: 'TRACE', display: 'Trace', sort_order: 20 }), gVal('URINE_SEMIQ', 4, { code: '1+', display: '1+', sort_order: 25, is_active: false }),
  gVal('POS_NEG', 1, { code: 'NEG', display: 'Negative', sort_order: 10 }), gVal('POS_NEG', 2, { code: 'POS', display: 'Positive', sort_order: 20 }),
];
const GLOBALS = { g_units: G_UNITS, g_value_sets: G_SETS, g_value_set_values: G_VALUES };

// ====================================================================================================== UNITS
describe('listUnits (#17) — global ∪ tenant, tenant shadows global by code', () => {
  it('returns global and own tenant units with scope; never another tenant\'s; global rows have no id/version, tenant rows have both', { timeout: T }, async () => {
    const mine = unit(1, TENANT_A, { code: 'lab_x', display: 'lab x' });
    const { db, svc } = setup({ ...GLOBALS, cs_units: [mine, unit(2, TENANT_B, { code: 'b_only' })] });
    const out = await db.run((ctx) => svc['listUnits']!(ctx, {}));
    expect(codesOf(out)).toEqual(['g_dl', 'g_l', 'lab_x', 'pct']);
    expect(out.data.find((u: any) => u.code === 'g_dl')).toEqual({ code: 'g_dl', display: 'g/dL', scope: 'global', is_active: true });
    expect(out.data.find((u: any) => u.code === 'lab_x')).toEqual({ id: mine.id, code: 'lab_x', display: 'lab x', scope: 'tenant', is_active: true, version: 1 });
    expect(JSON.stringify(out)).not.toContain('b_only');
  });

  it('shadowing: a tenant row with the code of a global unit replaces it — exactly one entry, scope tenant, the tenant display', { timeout: T }, async () => {
    const shadow = unit(1, TENANT_A, { code: 'g_dl', display: 'g/dl (lab)' });
    const { db, svc } = setup({ ...GLOBALS, cs_units: [shadow] });
    const out = await db.run((ctx) => svc['listUnits']!(ctx, {}));
    expect(out.data.filter((u: any) => u.code === 'g_dl')).toEqual([{ id: shadow.id, code: 'g_dl', display: 'g/dl (lab)', scope: 'tenant', is_active: true, version: 1 }]);
    expect(out.data).toHaveLength(3);                                    // g_l, pct, g_dl(tenant)
    const other = await db.run((ctx) => svc['listUnits']!(ctx, {}), { tenantId: TENANT_B });
    expect(other.data.find((u: any) => u.code === 'g_dl')).toMatchObject({ scope: 'global', display: 'g/dL' });   // B still sees the global one
  });

  it('shadowing by an INACTIVE tenant row still hides the global one (the lab switched that unit off)', { timeout: T }, async () => {
    const { db, svc } = setup({ ...GLOBALS, cs_units: [unit(1, TENANT_A, { code: 'pct', display: '%', is_active: false })] });
    const out = await db.run((ctx) => svc['listUnits']!(ctx, { is_active: 'all' }));
    expect(out.data.filter((u: any) => u.code === 'pct')).toMatchObject([{ scope: 'tenant', is_active: false }]);
    expect(codesOf(await db.run((ctx) => svc['listUnits']!(ctx, {})))).not.toContain('pct');   // default = active only: neither the inactive tenant row nor the shadowed global one
  });

  it('scope filter: global -> only global rows, tenant -> only own tenant rows', { timeout: T }, async () => {
    const { db, svc } = setup({ ...GLOBALS, cs_units: [unit(1, TENANT_A, { code: 'lab_x' }), unit(2, TENANT_B, { code: 'b_only' })] });
    expect(codesOf(await db.run((ctx) => svc['listUnits']!(ctx, { scope: 'global' })))).toEqual(['g_dl', 'g_l', 'pct']);
    expect(codesOf(await db.run((ctx) => svc['listUnits']!(ctx, { scope: 'tenant' })))).toEqual(['lab_x']);
  });

  it('is_active (contract enum true|false|all, default true): default and "true" -> active only; "false" -> inactive only (global + tenant); "all" -> everything', { timeout: T }, async () => {
    const { db, svc } = setup({ g_units: [...G_UNITS, gUnit(4, { code: 'old_g', display: 'old', is_active: false })], cs_units: [unit(1, TENANT_A, { code: 'lab_off', is_active: false }), unit(2, TENANT_A, { code: 'lab_on' })] });
    const list = async (q: object) => codesOf(await db.run((ctx) => svc['listUnits']!(ctx, q)));
    expect(await list({})).toEqual(['g_dl', 'g_l', 'lab_on', 'pct']);
    expect(await list({ is_active: 'true' })).toEqual(['g_dl', 'g_l', 'lab_on', 'pct']);
    expect(await list({ is_active: 'false' })).toEqual(['lab_off', 'old_g']);
    expect(await list({ is_active: 'all' })).toEqual(['g_dl', 'g_l', 'lab_off', 'lab_on', 'old_g', 'pct']);
  });

  it('is_active=false keeps shadowing: an active tenant row hides the inactive global one, so the code is not listed as inactive', { timeout: T }, async () => {
    const { db, svc } = setup({ g_units: [...G_UNITS, gUnit(4, { code: 'old_g', display: 'old', is_active: false })], cs_units: [unit(1, TENANT_A, { code: 'old_g', display: 'old (lab)' })] });
    expect(codesOf(await db.run((ctx) => svc['listUnits']!(ctx, { is_active: 'false' })))).toEqual([]);
    expect(codesOf(await db.run((ctx) => svc['listUnits']!(ctx, {})))).toContain('old_g');
  });

  it.each([['scope other', { scope: 'all' }], ['scope upper case', { scope: 'GLOBAL' }], ['is_active upper case', { is_active: 'TRUE' }], ['is_active yes', { is_active: 'yes' }],
    ['is_active boolean', { is_active: true }], ['unknown param', { sort: 'code' }], ['limit (lists are unpaged)', { limit: 5 }]])('invalid query (%s) -> 400, nothing read as a side effect', { timeout: T }, async (_n, q) => {
    const { db, svc } = setup(GLOBALS);
    validation400(await rejection(db.run((ctx) => svc['listUnits']!(ctx, q))));
    expect(events(db)).toHaveLength(0);
  });

  it('is a pure read: no INSERT/UPDATE, no event, no revision bump', { timeout: T }, async () => {
    const { db, svc } = setup({ ...GLOBALS, cs_units: [unit(1, TENANT_A)] });
    await db.run((ctx) => svc['listUnits']!(ctx, {}));
    expect(ownStmts(db).filter((s) => /^\s*(INSERT|UPDATE|DELETE)/i.test(s.text) )).toEqual([]);
    expect(events(db)).toHaveLength(0);
    expect(db.revisionOf(TENANT_A)).toBe(417);
  });
});

describe('createUnit (#18)', () => {
  const body = { code: 'mg_x', display: 'mg/x' };

  it('201 DTO: code kept exactly as sent (unit codes are case-sensitive, global ones are lower-case), scope tenant, version 1, is_active true, no internal columns', { timeout: T }, async () => {
    const { db, svc } = setup(GLOBALS);
    const out = await db.run((ctx) => svc['createUnit']!(ctx, { code: 'Mg_X', display: 'mg/x' }));
    expect(out).toEqual({ id: out.id, code: 'Mg_X', display: 'mg/x', scope: 'tenant', is_active: true, version: 1 });
    expect(out.id).toMatch(UUIDV7);
    expect(db.row('cs_units', out.id)).toMatchObject({ tenant_id: TENANT_A, code: 'Mg_X', version: 1, is_active: true, created_by: USER, updated_by: USER });
    expect(writesToGlobal(db)).toEqual([]);
  });

  it('catalog.changed.v1 {entity_type unit, change_kind created, entity_id = new id} in the same transaction; revision +1; insert before event', { timeout: T }, async () => {
    const { db, svc } = setup(GLOBALS);
    const out = await db.run((ctx) => svc['createUnit']!(ctx, body));
    const ev = events(db);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.envelope.payload).toMatchObject({ catalog_revision: 418, entity_type: 'unit', entity_id: out.id, change_kind: 'created' });
    expect(db.revisionOf(TENANT_A)).toBe(418);
    const mine = ownStmts(db);
    const insertAt = mine.findIndex((s) => /^\s*INSERT\s+INTO\s+catalog\.cs_units\b/i.test(s.text));
    expect(insertAt).toBeGreaterThanOrEqual(0);
    expect(mine.findIndex((s) => /INSERT INTO core\.event_log/i.test(s.text))).toBeGreaterThan(insertAt);
    expect(new Set(mine.map((s) => s.txId)).size).toBe(1);
  });

  it('rollback after create discards row, revision and event; a failing event insert fails the create and leaves no row', { timeout: T }, async () => {
    const a = setup(GLOBALS);
    await rejection(a.db.run((ctx) => a.svc['createUnit']!(ctx, body), { rollback: true }));
    expect(a.db.rows('cs_units')).toHaveLength(0); expect(events(a.db)).toHaveLength(0); expect(a.db.revisionOf(TENANT_A)).toBe(417);
    const b = setup(GLOBALS);
    b.db.fail(/INSERT INTO core\.event_log/i);
    await rejection(b.db.run((ctx) => b.svc['createUnit']!(ctx, body)));
    expect(b.db.rows('cs_units')).toHaveLength(0); expect(b.db.revisionOf(TENANT_A)).toBe(417);
  });

  it('first write of a tenant with no catalog_state row works (revision 1)', { timeout: T }, async () => {
    const { db, svc } = setup(GLOBALS, {});
    await db.run((ctx) => svc['createUnit']!(ctx, body));
    expect(db.revisionOf(TENANT_A)).toBe(1);
  });

  it('409 catalog.code_duplicate when a GLOBAL unit has the code ("also if global code exists") — no row, no event, no revision, no write to g_*', { timeout: T }, async () => {
    const { db, svc } = setup(GLOBALS);
    lims(await rejection(db.run((ctx) => svc['createUnit']!(ctx, { code: 'g_dl', display: 'mine' }))), 'catalog.code_duplicate', 409);
    expect(db.rows('cs_units')).toHaveLength(0);
    expect(events(db)).toHaveLength(0);
    expect(db.revisionOf(TENANT_A)).toBe(417);
    expect(writesToGlobal(db)).toEqual([]);
  });

  it('409 also when the global unit is INACTIVE (the code stays reserved)', { timeout: T }, async () => {
    const { db, svc } = setup({ g_units: [gUnit(1, { code: 'retired_u', display: 'x', is_active: false })] });
    lims(await rejection(db.run((ctx) => svc['createUnit']!(ctx, { code: 'retired_u', display: 'x' }))), 'catalog.code_duplicate', 409);
  });

  it('409 for a duplicate of the tenant\'s own unit, active or inactive; no second row, no event', { timeout: T }, async () => {
    const { db, svc } = setup({ cs_units: [unit(1, TENANT_A, { code: 'mg_x' }), unit(2, TENANT_A, { code: 'old', is_active: false })] });
    lims(await rejection(db.run((ctx) => svc['createUnit']!(ctx, body))), 'catalog.code_duplicate', 409);
    lims(await rejection(db.run((ctx) => svc['createUnit']!(ctx, { code: 'old', display: 'x' }))), 'catalog.code_duplicate', 409);
    expect(db.rows('cs_units', TENANT_A)).toHaveLength(2);
    expect(events(db)).toHaveLength(0);
  });

  it('another tenant owning the code does not block this tenant (S-1); B untouched', { timeout: T }, async () => {
    const { db, svc } = setup({ cs_units: [unit(1, TENANT_B, { code: 'mg_x' })] });
    const out = await db.run((ctx) => svc['createUnit']!(ctx, body));
    expect(out.scope).toBe('tenant');
    expect(db.rows('cs_units', TENANT_B)).toHaveLength(1);
    expect(events(db, TENANT_B)).toHaveLength(0);
  });

  it('race: two concurrent creates of the same code -> one wins, the loser gets catalog.code_duplicate (not a raw 23505), one event', { timeout: T }, async () => {
    const { db, svc } = setup(GLOBALS);
    const res = await Promise.allSettled([db.run((ctx) => svc['createUnit']!(ctx, body)), db.run((ctx) => svc['createUnit']!(ctx, body))]);
    expect(res.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    lims((res.find((x) => x.status === 'rejected') as PromiseRejectedResult).reason, 'catalog.code_duplicate', 409);
    expect(db.rows('cs_units', TENANT_A)).toHaveLength(1);
    expect(events(db)).toHaveLength(1);
    expect(db.revisionOf(TENANT_A)).toBe(418);
  });

  it.each([['empty', ''], ['space inside', 'mg x'], ['hyphen', 'mg-x'], ['slash', 'mg/x'], ['33 chars', 'x'.repeat(33)], ['dotless i', 'ıdx'], ['fullwidth', 'ＡＢＣ'],
    ['newline', 'mg\nx'], ['number', 5], ['null', null], ['object', { a: 1 }]])('invalid code (%s) -> 400 path /code, nothing written', { timeout: T }, async (_n, code) => {
    const { db, svc } = setup(GLOBALS);
    const e = await rejection(db.run((ctx) => svc['createUnit']!(ctx, { ...body, code })));
    validation400(e);
    if (e.code === 'common.validation_failed') expect(e.errors?.[0]?.path).toBe('/code');
    expect(db.rows('cs_units')).toHaveLength(0); expect(events(db)).toHaveLength(0);
  });

  it.each([['display empty (contract minLength 1)', { display: '' }], ['display 33', { display: 'd'.repeat(33) }], ['display number', { display: 3 }], ['display missing', { display: undefined }], ['code missing', { code: undefined }]])
  ('%s -> 400', { timeout: T }, async (_n, o) => {
    const { db, svc } = setup(GLOBALS);
    validation400(await rejection(db.run((ctx) => svc['createUnit']!(ctx, Object.fromEntries(Object.entries({ ...body, ...o }).filter(([, v]) => v !== undefined))))));
    expect(db.rows('cs_units')).toHaveLength(0);
  });

  it.each([['tenant_id', TENANT_B], ['id', ID(0xbad)], ['version', 7], ['scope', 'global'], ['is_active', false], ['created_by', USER], ['sort_order', 1]])
  ('S-5 mass assignment: %s in the body -> 400, nothing written', { timeout: T }, async (k, v) => {
    const { db, svc } = setup(GLOBALS);
    validation400(await rejection(db.run((ctx) => svc['createUnit']!(ctx, { ...body, [k]: v }))));
    expect(db.rows('cs_units')).toHaveLength(0); expect(events(db)).toHaveLength(0);
  });

  it('AB-20: a rejected value is never echoed in the error', { timeout: T }, async () => {
    const { db, svc } = setup(GLOBALS);
    const e = await rejection(db.run((ctx) => svc['createUnit']!(ctx, { code: 'PLANTED bad-9c2d', display: 'PLANTED-display-9c2d'.repeat(3) })));
    validation400(e);
    expect(JSON.stringify({ m: e.message, d: e.detail, errs: e.errors })).not.toContain('9c2d');
  });
});

describe('updateUnit (#19) — If-Match, tenant rows only, global rows read-only', () => {
  const mine = unit(1, TENANT_A, { code: 'lab_x', display: 'lab x' });

  it('PATCH display -> 200, version 2, code/scope unchanged, event unit/updated, revision +1 in the same tx', { timeout: T }, async () => {
    const { db, svc } = setup({ ...GLOBALS, cs_units: [mine] });
    const out = await upd(svc, 'updateUnit', db, mine.id, 1, { display: 'lab x2' });
    expect(out).toEqual({ id: mine.id, code: 'lab_x', display: 'lab x2', scope: 'tenant', is_active: true, version: 2 });
    expect(db.row('cs_units', mine.id)).toMatchObject({ version: 2, updated_by: USER });
    const ev = events(db);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.envelope.payload).toMatchObject({ catalog_revision: 418, entity_type: 'unit', entity_id: mine.id, change_kind: 'updated' });
    expect(new Set(ownStmts(db).map((s) => s.txId)).size).toBe(1);
  });

  it('is_active true -> false is change_kind deactivated; false -> true is updated; the global row with the same code is untouched', { timeout: T }, async () => {
    const { db, svc } = setup({ ...GLOBALS, cs_units: [mine] });
    await upd(svc, 'updateUnit', db, mine.id, 1, { is_active: false });
    await upd(svc, 'updateUnit', db, mine.id, 2, { is_active: true });
    expect(events(db).map((e) => e.envelope.payload.change_kind)).toEqual(['deactivated', 'updated']);
    expect(writesToGlobal(db)).toEqual([]);
  });

  it('S-1 / done_when "global rows read-only": the id of a GLOBAL unit -> 404 common.not_found; the row is unchanged; no event, no revision bump, no write to g_*', { timeout: T }, async () => {
    const { db, svc } = setup(GLOBALS);
    for (const g of G_UNITS) {
      lims(await rejection(upd(svc, 'updateUnit', db, g.id, 1, { display: 'hacked' })), 'common.not_found', 404);
      lims(await rejection(upd(svc, 'updateUnit', db, g.id, 1, { is_active: false })), 'common.not_found', 404);
      expect(db.row('g_units', g.id)).toMatchObject({ display: g.display, is_active: true });
    }
    expect(events(db)).toHaveLength(0);
    expect(db.revisionOf(TENANT_A)).toBe(417);
    expect(writesToGlobal(db)).toEqual([]);
  });

  it('S-1: the id of tenant B\'s unit -> 404, B row untouched, no event for either tenant', { timeout: T }, async () => {
    const theirs = unit(2, TENANT_B);
    const { db, svc } = setup({ cs_units: [theirs] });
    lims(await rejection(upd(svc, 'updateUnit', db, theirs.id, 1, { display: 'x' })), 'common.not_found', 404);
    expect(db.row('cs_units', theirs.id)).toMatchObject({ version: 1, display: theirs.display });
    expect(db.events).toHaveLength(0);
  });

  it('unknown id -> 404; id not a uuid -> 400', { timeout: T }, async () => {
    const { db, svc } = setup({ cs_units: [mine] });
    lims(await rejection(upd(svc, 'updateUnit', db, ID(0xfeed), 1, { display: 'x' })), 'common.not_found', 404);
    validation400(await rejection(upd(svc, 'updateUnit', db, 'not-a-uuid', 1, { display: 'x' })));
  });

  it('AC-01.6 pattern: no If-Match -> 428 common.precondition_required; stale -> 409 common.version_conflict; row unchanged each time', { timeout: T }, async () => {
    const { db, svc } = setup({ cs_units: [{ ...mine, version: 3 }] });
    lims(await rejection(upd(svc, 'updateUnit', db, mine.id, undefined, { display: 'x' })), 'common.precondition_required', 428);
    lims(await rejection(upd(svc, 'updateUnit', db, mine.id, 2, { display: 'x' })), 'common.version_conflict', 409);
    expect(db.row('cs_units', mine.id)).toMatchObject({ version: 3, display: mine.display });
    expect(events(db)).toHaveLength(0);
  });

  it.each([[0], [-1], [1.5], [99999999999], ['1'], [null]])('malformed expectedVersion %j -> 400, never a write', { timeout: T }, async (v) => {
    const { db, svc } = setup({ cs_units: [mine] });
    validation400(await rejection(upd(svc, 'updateUnit', db, mine.id, v as number, { display: 'x' })));
    expect(db.row('cs_units', mine.id)!.version).toBe(1);
  });

  it('race: two PATCHes with the same If-Match -> one 200, one 409 common.version_conflict; version 2; one event', { timeout: T }, async () => {
    const { db, svc } = setup({ cs_units: [mine] });
    const res = await Promise.allSettled([upd(svc, 'updateUnit', db, mine.id, 1, { display: 'a' }), upd(svc, 'updateUnit', db, mine.id, 1, { display: 'b' })]);
    expect(res.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    lims((res.find((x) => x.status === 'rejected') as PromiseRejectedResult).reason, 'common.version_conflict', 409);
    expect(db.row('cs_units', mine.id)!.version).toBe(2);
    expect(events(db)).toHaveLength(1);
  });

  it('rollback after update / failing event insert leaves the row at its old version', { timeout: T }, async () => {
    const { db, svc } = setup({ cs_units: [mine] });
    await rejection(db.run((ctx) => svc['updateUnit']!(ctx, { id: mine.id, expectedVersion: 1, patch: { display: 'z' } }), { rollback: true }));
    expect(db.row('cs_units', mine.id)).toMatchObject({ version: 1, display: mine.display });
    db.fail(/INSERT INTO core\.event_log/i);
    await rejection(upd(svc, 'updateUnit', db, mine.id, 1, { display: 'z' }));
    expect(db.row('cs_units', mine.id)).toMatchObject({ version: 1, display: mine.display });
  });

  it.each([['display empty', { display: '' }], ['display 33', { display: 'd'.repeat(33) }], ['display number', { display: 5 }], ['is_active string', { is_active: 'yes' }]])
  ('invalid patch (%s) -> 400, unchanged', { timeout: T }, async (_n, patch) => {
    const { db, svc } = setup({ cs_units: [mine] });
    validation400(await rejection(upd(svc, 'updateUnit', db, mine.id, 1, patch)));
    expect(db.row('cs_units', mine.id)!.version).toBe(1);
  });

  it.each([['code', 'other'], ['scope', 'global'], ['tenant_id', TENANT_B], ['id', ID(0xbad)], ['version', 9], ['sort_order', 1], ['created_by', USER]])
  ('S-5: %s in the patch -> 400 (unit codes are immutable), unchanged', { timeout: T }, async (k, v) => {
    const { db, svc } = setup({ cs_units: [mine] });
    validation400(await rejection(upd(svc, 'updateUnit', db, mine.id, 1, { display: 'ok', [k]: v })));
    expect(db.row('cs_units', mine.id)).toMatchObject({ version: 1, code: 'lab_x', display: 'lab x', tenant_id: TENANT_A });
    expect(events(db)).toHaveLength(0);
  });
});

// ====================================================================================================== VALUE SETS
const posNegValues = (names = ['NEG', 'POS']) => names.map((c, i) => ({ code: c, display: c === 'NEG' ? 'Negative' : c === 'POS' ? 'Positive' : c, sort_order: (i + 1) * 10, is_active: true }));
const setBody = (o: Record<string, unknown> = {}) => ({ code: 'URINE_GRADE', display: 'Urine grade', is_ordered: true, values: [{ code: 'NEG', display: 'Negative', sort_order: 10 }, { code: '1+', display: '1+', sort_order: 20 }, { code: '2+', display: '2+', sort_order: 30 }], ...o });

describe('listValueSets (#20) — global ∪ tenant with embedded values', () => {
  it('returns global and own sets with scope, is_ordered and values (sort_order asc, inactive values included with is_active false); global rows have no id/version', { timeout: T }, async () => {
    const own = vset(1, TENANT_A, { code: 'LAB_GRADE', display: 'Lab grade', is_ordered: true });
    const { db, svc } = setup({ ...GLOBALS, cs_value_sets: [own, vset(2, TENANT_B, { code: 'B_ONLY' })],
      cs_value_set_values: [vval(own.id, 2, TENANT_A, { code: 'HIGH', display: 'High', sort_order: 20 }), vval(own.id, 1, TENANT_A, { code: 'LOW', display: 'Low', sort_order: 10 })] });
    const out = await db.run((ctx) => svc['listValueSets']!(ctx, {}));
    expect(codesOf(out)).toEqual(['LAB_GRADE', 'POS_NEG', 'URINE_SEMIQ']);
    const urine = out.data.find((s: any) => s.code === 'URINE_SEMIQ');
    expect(urine).toEqual({
      code: 'URINE_SEMIQ', display: 'Urine semi-quantitative', is_ordered: true, scope: 'global', is_active: true,
      values: [{ code: 'NEG', display: 'Negative', sort_order: 10, is_active: true }, { code: 'TRACE', display: 'Trace', sort_order: 20, is_active: true },
        { code: '1+', display: '1+', sort_order: 25, is_active: false }, { code: '2+', display: '2+', sort_order: 30, is_active: true }],
    });
    expect(out.data.find((s: any) => s.code === 'LAB_GRADE')).toEqual({
      id: own.id, code: 'LAB_GRADE', display: 'Lab grade', is_ordered: true, scope: 'tenant', is_active: true, version: 1,
      values: [{ code: 'LOW', display: 'Low', sort_order: 10, is_active: true }, { code: 'HIGH', display: 'High', sort_order: 20, is_active: true }],
    });
    expect(JSON.stringify(out)).not.toContain('B_ONLY');
  });

  it('AC-02.6 data: is_ordered is reported faithfully for ordered and unordered sets', { timeout: T }, async () => {
    const { db, svc } = setup({ ...GLOBALS, cs_value_sets: [vset(1, TENANT_A, { code: 'LAB_UNORD', is_ordered: false }), vset(2, TENANT_A, { code: 'LAB_ORD', is_ordered: true })] });
    const out = await db.run((ctx) => svc['listValueSets']!(ctx, {}));
    expect(Object.fromEntries(out.data.map((s: any) => [s.code, s.is_ordered]))).toEqual({ URINE_SEMIQ: true, POS_NEG: false, LAB_UNORD: false, LAB_ORD: true });
  });

  it('shadowing: a tenant set with the code of a global set replaces it entirely — its is_ordered and ITS values only (no merge with the global values)', { timeout: T }, async () => {
    const shadow = vset(1, TENANT_A, { code: 'POS_NEG', display: 'Lab pos/neg', is_ordered: true });
    const { db, svc } = setup({ ...GLOBALS, cs_value_sets: [shadow], cs_value_set_values: [vval(shadow.id, 1, TENANT_A, { code: 'NEG', display: 'Not detected', sort_order: 1 })] });
    const out = await db.run((ctx) => svc['listValueSets']!(ctx, {}));
    expect(out.data.filter((s: any) => s.code === 'POS_NEG')).toEqual([{
      id: shadow.id, code: 'POS_NEG', display: 'Lab pos/neg', is_ordered: true, scope: 'tenant', is_active: true, version: 1,
      values: [{ code: 'NEG', display: 'Not detected', sort_order: 1, is_active: true }],
    }]);
    const other = await db.run((ctx) => svc['listValueSets']!(ctx, {}), { tenantId: TENANT_B });
    expect(other.data.find((s: any) => s.code === 'POS_NEG')).toMatchObject({ scope: 'global', is_ordered: false });
    expect(other.data.find((s: any) => s.code === 'POS_NEG').values).toHaveLength(2);
  });

  it('scope filter; inactive sets are listed (flag is_active false)', { timeout: T }, async () => {
    const { db, svc } = setup({ ...GLOBALS, cs_value_sets: [vset(1, TENANT_A, { code: 'LAB_OFF', is_active: false })] });
    expect(codesOf(await db.run((ctx) => svc['listValueSets']!(ctx, { scope: 'global' })))).toEqual(['POS_NEG', 'URINE_SEMIQ']);
    const t = await db.run((ctx) => svc['listValueSets']!(ctx, { scope: 'tenant' }));
    expect(t.data).toMatchObject([{ code: 'LAB_OFF', is_active: false, scope: 'tenant', values: [] }]);
  });

  it('S-1: tenant B\'s values never appear, even if B\'s set has the same code as one of mine', { timeout: T }, async () => {
    const mine = vset(1, TENANT_A, { code: 'SAME' }); const theirs = vset(2, TENANT_B, { code: 'SAME' });
    const { db, svc } = setup({ cs_value_sets: [mine, theirs], cs_value_set_values: [vval(mine.id, 1, TENANT_A, { code: 'A1' }), vval(theirs.id, 1, TENANT_B, { code: 'B1' })] });
    const out = await db.run((ctx) => svc['listValueSets']!(ctx, {}));
    expect(out.data).toHaveLength(1);
    expect(out.data[0].values.map((v: any) => v.code)).toEqual(['A1']);
  });

  it.each([['scope other', { scope: 'all' }], ['is_active (not a parameter of #20)', { is_active: 'true' }], ['unknown', { q: 'x' }]])('invalid query (%s) -> 400', { timeout: T }, async (_n, q) => {
    const { db, svc } = setup(GLOBALS);
    validation400(await rejection(db.run((ctx) => svc['listValueSets']!(ctx, q))));
  });

  it('is a pure read', { timeout: T }, async () => {
    const { db, svc } = setup(GLOBALS);
    await db.run((ctx) => svc['listValueSets']!(ctx, {}));
    expect(ownStmts(db).filter((s) => /^\s*(INSERT|UPDATE|DELETE)/i.test(s.text))).toEqual([]);
    expect(events(db)).toHaveLength(0);
  });
});

describe('createValueSet (#21)', () => {
  it('201 DTO: scope tenant, version 1, is_active true, values stored with their sort_order and is_active default true; set + values + revision + event in ONE tx', { timeout: T }, async () => {
    const { db, svc } = setup(GLOBALS);
    const out = await db.run((ctx) => svc['createValueSet']!(ctx, setBody()));
    expect(out).toEqual({
      id: out.id, code: 'URINE_GRADE', display: 'Urine grade', is_ordered: true, scope: 'tenant', is_active: true, version: 1,
      values: [{ code: 'NEG', display: 'Negative', sort_order: 10, is_active: true }, { code: '1+', display: '1+', sort_order: 20, is_active: true }, { code: '2+', display: '2+', sort_order: 30, is_active: true }],
    });
    expect(out.id).toMatch(UUIDV7);
    expect(db.row('cs_value_sets', out.id)).toMatchObject({ tenant_id: TENANT_A, is_ordered: true, version: 1, created_by: USER });
    const rows = db.rows('cs_value_set_values', TENANT_A);
    expect(rows.map((r) => r.code).sort()).toEqual(['1+', '2+', 'NEG']);
    expect(rows.every((r) => r.value_set_id === out.id && r.tenant_id === TENANT_A && r.is_active === true)).toBe(true);
    const ev = events(db);
    expect(ev).toHaveLength(1);                                          // one event per request, not per value
    expect(ev[0]!.envelope.payload).toMatchObject({ catalog_revision: 418, entity_type: 'value_set', entity_id: out.id, change_kind: 'created' });
    expect(db.revisionOf(TENANT_A)).toBe(418);
    expect(new Set(ownStmts(db).map((s) => s.txId)).size).toBe(1);
    expect(writesToGlobal(db)).toEqual([]);
  });

  it('accepts the minimal value form {code}; the response still satisfies ValueSetValue (display string ≤40, integer sort_order 0–9999, is_active true)', { timeout: T }, async () => {
    const { db, svc } = setup(GLOBALS);
    const out = await db.run((ctx) => svc['createValueSet']!(ctx, setBody({ code: 'MIN', is_ordered: false, values: [{ code: 'POS' }, { code: 'NEG' }] })));
    expect(out.values).toHaveLength(2);
    for (const v of out.values) {
      expect(typeof v.display).toBe('string'); expect(v.display.length).toBeGreaterThanOrEqual(1); expect(v.display.length).toBeLessThanOrEqual(40);
      expect(Number.isInteger(v.sort_order) && v.sort_order >= 0 && v.sort_order <= 9999).toBe(true);
      expect(v.is_active).toBe(true);
    }
    expect(new Set(out.values.map((v: any) => v.sort_order)).size).toBe(2);   // distinct, so "ordered" can mean something
  });

  it('values: [] is accepted when the contract requires the key (empty set) — or rejected with 400, never a 500', { timeout: T }, async () => {
    const { db, svc } = setup(GLOBALS);
    const r = await db.run((ctx) => svc['createValueSet']!(ctx, setBody({ values: [] }))).then((x) => ({ ok: x }), (e) => ({ err: e }));
    if ('err' in r) validation400(r.err); else expect(r.ok.values).toEqual([]);
  });

  it('is_active:false values at create are kept', { timeout: T }, async () => {
    const { db, svc } = setup(GLOBALS);
    const out = await db.run((ctx) => svc['createValueSet']!(ctx, setBody({ values: [{ code: 'A', display: 'A', sort_order: 1, is_active: false }, { code: 'B', display: 'B', sort_order: 2 }] })));
    expect(out.values.map((v: any) => [v.code, v.is_active])).toEqual([['A', false], ['B', true]]);
  });

  it('409 catalog.code_duplicate for a GLOBAL set code (active or inactive), for an own set (active or inactive) — nothing is created: no set, no values, no event, no revision', { timeout: T }, async () => {
    const { db, svc } = setup({ ...GLOBALS, g_value_sets: [...G_SETS, gSet(3, { code: 'OLD_G', is_active: false })], cs_value_sets: [vset(1, TENANT_A, { code: 'MINE' }), vset(2, TENANT_A, { code: 'MINE_OFF', is_active: false })] });
    for (const code of ['POS_NEG', 'OLD_G', 'MINE', 'MINE_OFF']) lims(await rejection(db.run((ctx) => svc['createValueSet']!(ctx, setBody({ code })))), 'catalog.code_duplicate', 409);
    expect(db.rows('cs_value_sets', TENANT_A)).toHaveLength(2);
    expect(db.rows('cs_value_set_values')).toHaveLength(0);
    expect(events(db)).toHaveLength(0);
    expect(db.revisionOf(TENANT_A)).toBe(417);
    expect(writesToGlobal(db)).toEqual([]);
  });

  it('another tenant\'s set with the same code does not block (S-1)', { timeout: T }, async () => {
    const { db, svc } = setup({ cs_value_sets: [vset(1, TENANT_B, { code: 'URINE_GRADE' })] });
    expect((await db.run((ctx) => svc['createValueSet']!(ctx, setBody()))).scope).toBe('tenant');
    expect(db.rows('cs_value_sets', TENANT_B)).toHaveLength(1);
  });

  it('race: two concurrent creates of the same code -> one wins, the other catalog.code_duplicate; values inserted once', { timeout: T }, async () => {
    const { db, svc } = setup(GLOBALS);
    const res = await Promise.allSettled([db.run((ctx) => svc['createValueSet']!(ctx, setBody())), db.run((ctx) => svc['createValueSet']!(ctx, setBody()))]);
    expect(res.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    lims((res.find((x) => x.status === 'rejected') as PromiseRejectedResult).reason, 'catalog.code_duplicate', 409);
    expect(db.rows('cs_value_sets', TENANT_A)).toHaveLength(1);
    expect(db.rows('cs_value_set_values', TENANT_A)).toHaveLength(3);
    expect(events(db)).toHaveLength(1);
  });

  it('atomic: a failure while inserting a value (or the event) leaves no set row, no value rows, no revision bump', { timeout: T }, async () => {
    for (const pattern of [/INSERT INTO catalog\.cs_value_set_values/i, /INSERT INTO core\.event_log/i]) {
      const { db, svc } = setup(GLOBALS);
      db.fail(pattern);
      await rejection(db.run((ctx) => svc['createValueSet']!(ctx, setBody())));
      expect(db.rows('cs_value_sets')).toHaveLength(0); expect(db.rows('cs_value_set_values')).toHaveLength(0); expect(db.revisionOf(TENANT_A)).toBe(417);
    }
  });

  const bad: Array<[string, Record<string, unknown>, string]> = [
    ['code empty', { code: '' }, '/code'], ['code with space', { code: 'A B' }, '/code'], ['code 33 chars', { code: 'A'.repeat(33) }, '/code'], ['code with hyphen', { code: 'A-B' }, '/code'],
    ['code number', { code: 5 }, '/code'], ['code missing', { code: undefined }, '/code'],
    ['display empty', { display: '' }, '/display'], ['display 81', { display: 'd'.repeat(81) }, '/display'], ['display missing', { display: undefined }, '/display'],
    ['is_ordered missing', { is_ordered: undefined }, '/is_ordered'], ['is_ordered string', { is_ordered: 'true' }, '/is_ordered'],
    ['values missing', { values: undefined }, '/values'], ['values not an array', { values: 'NEG' }, '/values'],
    ['51 values', { values: Array.from({ length: 51 }, (_, i) => ({ code: `C${i}`, display: 'x', sort_order: i })) }, '/values'],
    ['value code empty', { values: [{ code: '', display: 'x', sort_order: 1 }] }, '/values/0/code'],
    ['value code with space', { values: [{ code: 'A B', display: 'x', sort_order: 1 }] }, '/values/0/code'],
    ['value code 17 chars', { values: [{ code: 'A'.repeat(17), display: 'x', sort_order: 1 }] }, '/values/0/code'],
    ['value display 41', { values: [{ code: 'A', display: 'd'.repeat(41), sort_order: 1 }] }, '/values/0/display'],
    ['value sort_order -1', { values: [{ code: 'A', display: 'x', sort_order: -1 }] }, '/values/0/sort_order'],
    ['value sort_order 10000', { values: [{ code: 'A', display: 'x', sort_order: 10000 }] }, '/values/0/sort_order'],
    ['value sort_order 1.5', { values: [{ code: 'A', display: 'x', sort_order: 1.5 }] }, '/values/0/sort_order'],
    ['value is_active string', { values: [{ code: 'A', display: 'x', sort_order: 1, is_active: 'no' }] }, '/values/0/is_active'],
    ['value not an object', { values: ['NEG'] }, '/values/0'],
  ];
  it.each(bad)('invalid input (%s) -> 400, nothing written', { timeout: T }, async (_n, o, path) => {
    const { db, svc } = setup(GLOBALS);
    const e = await rejection(db.run((ctx) => svc['createValueSet']!(ctx, Object.fromEntries(Object.entries(setBody(o)).filter(([, v]) => v !== undefined)))));
    validation400(e);
    if (e.code === 'common.validation_failed') expect(e.errors?.map((x: any) => x.path)).toContain(path);
    expect(db.rows('cs_value_sets')).toHaveLength(0); expect(db.rows('cs_value_set_values')).toHaveLength(0); expect(events(db)).toHaveLength(0);
  });

  it('exactly 50 values is fine (contract maxItems 50)', { timeout: T }, async () => {
    const { db, svc } = setup(GLOBALS);
    const out = await db.run((ctx) => svc['createValueSet']!(ctx, setBody({ values: Array.from({ length: 50 }, (_, i) => ({ code: `C${i}`, display: `c${i}`, sort_order: i })) })));
    expect(out.values).toHaveLength(50);
  });

  it('duplicate value codes in one request -> 400 (path under /values), nothing written — not a raw 23505/500', { timeout: T }, async () => {
    const { db, svc } = setup(GLOBALS);
    const e = await rejection(db.run((ctx) => svc['createValueSet']!(ctx, setBody({ values: [{ code: 'NEG', display: 'a', sort_order: 1 }, { code: 'NEG', display: 'b', sort_order: 2 }] }))));
    validation400(e);
    if (e.code === 'common.validation_failed') expect(e.errors.some((x: any) => x.path.startsWith('/values'))).toBe(true);
    expect(db.rows('cs_value_sets')).toHaveLength(0); expect(db.rows('cs_value_set_values')).toHaveLength(0);
  });

  it.each([['tenant_id', TENANT_B], ['id', ID(0xbad)], ['version', 4], ['scope', 'global'], ['is_active', false]])('S-5: %s in the body -> 400, nothing written', { timeout: T }, async (k, v) => {
    const { db, svc } = setup(GLOBALS);
    validation400(await rejection(db.run((ctx) => svc['createValueSet']!(ctx, setBody({ [k]: v })))));
    expect(db.rows('cs_value_sets')).toHaveLength(0);
  });

  it.each([['id', ID(0xbad)], ['value_set_id', ID(0x1)], ['tenant_id', TENANT_B], ['version', 2]])('S-5: %s inside a value -> 400 (cannot attach a value to another set/tenant)', { timeout: T }, async (k, v) => {
    const { db, svc } = setup(GLOBALS);
    validation400(await rejection(db.run((ctx) => svc['createValueSet']!(ctx, setBody({ values: [{ code: 'A', display: 'a', sort_order: 1, [k]: v }] })))));
    expect(db.rows('cs_value_sets')).toHaveLength(0); expect(db.rows('cs_value_set_values')).toHaveLength(0);
  });

  it('AB-20: a rejected value is never echoed', { timeout: T }, async () => {
    const { db, svc } = setup(GLOBALS);
    const e = await rejection(db.run((ctx) => svc['createValueSet']!(ctx, setBody({ code: 'PLANTED bad 9c2d', values: [{ code: 'PLANTED-9c2d-xx', display: 'PLANTED-9c2d' }] }))));
    validation400(e);
    expect(JSON.stringify({ m: e.message, d: e.detail, errs: e.errors })).not.toContain('9c2d');
  });
});

describe('updateValueSet (#22) — If-Match, global read-only, in-use protection', () => {
  const S = vset(1, TENANT_A, { code: 'LAB_GRADE', display: 'Lab grade', is_ordered: true });
  const V = (n: number, code: string, sort: number, o: Row = {}) => vval(S.id, n, TENANT_A, { code, display: `d ${code}`, sort_order: sort, ...o });
  const seed = (extra: Partial<Record<SetTable, Row[]>> = {}) => setup({
    ...GLOBALS, cs_value_sets: [S], cs_value_set_values: [V(1, 'LOW', 10), V(2, 'MID', 20), V(3, 'HIGH', 30)], ...extra,
  });
  const valuesOf = (db: Db) => Object.fromEntries(db.rows('cs_value_set_values', TENANT_A).map((r) => [r.code, [r.display, r.sort_order, r.is_active]]));
  const inUse = { analyte_versions: [av(1, TENANT_A, 'LAB_GRADE', 'published')] };
  const BASE_VALUES = { LOW: ['d LOW', 10, true], MID: ['d MID', 20, true], HIGH: ['d HIGH', 30, true] };

  describe('plain edits (set not in use)', () => {
    it('PATCH display / is_active -> 200, version 2, values untouched, event value_set/updated (deactivated when is_active goes false)', { timeout: T }, async () => {
      const { db, svc } = seed();
      const a = await upd(svc, 'updateValueSet', db, S.id, 1, { display: 'Lab grade 2' });
      expect(a).toMatchObject({ id: S.id, code: 'LAB_GRADE', display: 'Lab grade 2', is_ordered: true, scope: 'tenant', is_active: true, version: 2 });
      expect(a.values.map((v: any) => v.code)).toEqual(['LOW', 'MID', 'HIGH']);
      await upd(svc, 'updateValueSet', db, S.id, 2, { is_active: false });
      expect(events(db).map((e) => [e.envelope.payload.entity_type, e.envelope.payload.change_kind])).toEqual([['value_set', 'updated'], ['value_set', 'deactivated']]);
      expect(valuesOf(db)).toEqual(BASE_VALUES);
    });

    it('values matched by code: edit display/is_active of existing, append new codes; ONE version bump, ONE event, ONE revision step; result lists values sorted by sort_order', { timeout: T }, async () => {
      const { db, svc } = seed();
      const out = await upd(svc, 'updateValueSet', db, S.id, 1, { values: [{ code: 'MID', display: 'Medium', is_active: false }, { code: 'VHIGH', display: 'Very high', sort_order: 40 }] });
      expect(out.version).toBe(2);
      expect(out.values).toEqual([
        { code: 'LOW', display: 'd LOW', sort_order: 10, is_active: true }, { code: 'MID', display: 'Medium', sort_order: 20, is_active: false },
        { code: 'HIGH', display: 'd HIGH', sort_order: 30, is_active: true }, { code: 'VHIGH', display: 'Very high', sort_order: 40, is_active: true },
      ]);
      expect(valuesOf(db)).toEqual({ ...BASE_VALUES, MID: ['Medium', 20, false], VHIGH: ['Very high', 40, true] });
      expect(events(db)).toHaveLength(1);
      expect(db.revisionOf(TENANT_A)).toBe(418);
      expect(new Set(ownStmts(db).map((s) => s.txId)).size).toBe(1);
    });

    it('when the set is NOT in use, existing codes may be re-ordered (sort_order edit allowed)', { timeout: T }, async () => {
      const { db, svc } = seed();
      const out = await upd(svc, 'updateValueSet', db, S.id, 1, { values: [{ code: 'LOW', sort_order: 99 }] });
      expect(out.values.map((v: any) => v.code)).toEqual(['MID', 'HIGH', 'LOW']);
    });

    it('a PATCH with values only (no display/is_active) still bumps the set version and the revision', { timeout: T }, async () => {
      const { db, svc } = seed();
      await upd(svc, 'updateValueSet', db, S.id, 1, { values: [{ code: 'NEW', display: 'n', sort_order: 99 }] });
      expect(db.row('cs_value_sets', S.id)!.version).toBe(2);
      expect(db.revisionOf(TENANT_A)).toBe(418);
    });

    it('cannot exceed 50 values in total (contract maxItems on ValueSet.values): 50 existing + 1 new -> 400, nothing written', { timeout: T }, async () => {
      const many = Array.from({ length: 50 }, (_, i) => V(i + 1, `C${i}`, i));
      const { db, svc } = setup({ cs_value_sets: [S], cs_value_set_values: many });
      validation400(await rejection(upd(svc, 'updateValueSet', db, S.id, 1, { values: [{ code: 'EXTRA', display: 'x', sort_order: 99 }] })));
      expect(db.rows('cs_value_set_values')).toHaveLength(50);
      expect(db.row('cs_value_sets', S.id)!.version).toBe(1);
    });
  });

  describe('done_when: in-use value-set protection (a published analyte version references the set code)', () => {
    it('re-ordering an existing code -> 409 catalog.version_in_use; NOTHING changes (set version, values, event, revision) even when other edits in the same PATCH were valid', { timeout: T }, async () => {
      const { db, svc } = seed(inUse);
      const e = await rejection(upd(svc, 'updateValueSet', db, S.id, 1, { display: 'renamed', values: [{ code: 'NEWC', display: 'n', sort_order: 99 }, { code: 'LOW', sort_order: 25 }] }));
      lims(e, 'catalog.version_in_use', 409);
      expect(db.row('cs_value_sets', S.id)).toMatchObject({ version: 1, display: 'Lab grade' });
      expect(valuesOf(db)).toEqual(BASE_VALUES);                       // the appended NEWC was rolled back / never written
      expect(events(db)).toHaveLength(0);
      expect(db.revisionOf(TENANT_A)).toBe(417);
    });

    it('a PATCH that omits existing codes can never remove them: either 409 catalog.version_in_use, or success with every original code still present', { timeout: T }, async () => {
      const { db, svc } = seed(inUse);
      const r = await upd(svc, 'updateValueSet', db, S.id, 1, { values: [{ code: 'LOW', display: 'Low!' }] }).then((x) => ({ ok: x }), (err) => ({ err }));
      if ('err' in r) lims(r.err, 'catalog.version_in_use', 409);
      else expect(r.ok.values.map((v: any) => v.code).sort()).toEqual(['HIGH', 'LOW', 'MID']);
      expect(Object.keys(valuesOf(db)).sort()).toEqual(['HIGH', 'LOW', 'MID']);
    });

    it('still allowed while in use: edit display, hide (is_active false) a value, append a new code, resend an existing value with its CURRENT sort_order', { timeout: T }, async () => {
      const { db, svc } = seed(inUse);
      const out = await upd(svc, 'updateValueSet', db, S.id, 1, { display: 'Lab grade v2', values: [
        { code: 'LOW', display: 'Low (renamed)', sort_order: 10 }, { code: 'MID', is_active: false }, { code: 'EXTREME', display: 'Extreme', sort_order: 40 }] });
      expect(out).toMatchObject({ display: 'Lab grade v2', version: 2 });
      expect(valuesOf(db)).toEqual({ LOW: ['Low (renamed)', 10, true], MID: ['d MID', 20, false], HIGH: ['d HIGH', 30, true], EXTREME: ['Extreme', 40, true] });
      expect(events(db)).toHaveLength(1);
    });

    it('the rule is per set code and per tenant: a published version using ANOTHER code, or tenant B\'s published version using the same code, does not block', { timeout: T }, async () => {
      const { db, svc } = seed({ analyte_versions: [av(1, TENANT_A, 'OTHER_SET', 'published'), av(2, TENANT_B, 'LAB_GRADE', 'published'), av(3, TENANT_A, null, 'published')] });
      const out = await upd(svc, 'updateValueSet', db, S.id, 1, { values: [{ code: 'LOW', sort_order: 11 }] });
      expect(out.values.find((v: any) => v.code === 'LOW').sort_order).toBe(11);
    });

    it('draft and discarded analyte versions do not count as "in use"', { timeout: T }, async () => {
      const { db, svc } = seed({ analyte_versions: [av(1, TENANT_A, 'LAB_GRADE', 'draft'), av(2, TENANT_A, 'LAB_GRADE', 'discarded')] });
      const out = await upd(svc, 'updateValueSet', db, S.id, 1, { values: [{ code: 'LOW', sort_order: 11 }] });
      expect(out.version).toBe(2);
    });

    it('the check reads the DB inside the same transaction as the write (tenant-scoped, bind params only)', { timeout: T }, async () => {
      const { db, svc } = seed(inUse);
      await rejection(upd(svc, 'updateValueSet', db, S.id, 1, { values: [{ code: 'LOW', sort_order: 11 }] }));
      const reads = ownStmts(db).filter((s) => /FROM\s+catalog\.analyte_versions/i.test(s.text));
      expect(reads.length).toBeGreaterThan(0);
      for (const s of reads) { expect(s.values).toContain(TENANT_A); expect(s.values).toContain('LAB_GRADE'); expect(s.text).not.toContain('LAB_GRADE'); }
      expect(new Set(ownStmts(db).map((s) => s.txId)).size).toBe(1);
    });
  });

  describe('done_when: global rows read-only', () => {
    it('the id of a GLOBAL value set -> 404 common.not_found for any patch; g_* rows unchanged; no write to g_*; no event, no revision bump', { timeout: T }, async () => {
      const { db, svc } = seed();
      for (const patch of [{ display: 'hacked' }, { is_active: false }, { values: [{ code: 'NEG', display: 'hacked' }] }, { values: [{ code: 'NEW', display: 'n', sort_order: 99 }] }]) {
        for (const g of G_SETS) lims(await rejection(upd(svc, 'updateValueSet', db, g.id, 1, patch)), 'common.not_found', 404);
      }
      expect(db.row('g_value_sets', G_POSNEG.id)).toMatchObject({ display: 'Positive / negative', is_active: true });
      expect(db.rows('g_value_set_values')).toHaveLength(G_VALUES.length);
      expect(db.rows('g_value_set_values').find((v) => v.value_set_code === 'POS_NEG' && v.code === 'NEG')!.display).toBe('Negative');
      expect(writesToGlobal(db)).toEqual([]);
      expect(events(db)).toHaveLength(0);
      expect(db.revisionOf(TENANT_A)).toBe(417);
    });

    it('S-1: tenant B\'s set id -> 404; B\'s set and values untouched; no event', { timeout: T }, async () => {
      const theirs = vset(5, TENANT_B, { code: 'THEIRS' });
      const { db, svc } = seed({ cs_value_sets: [S, theirs], cs_value_set_values: [vval(theirs.id, 1, TENANT_B)] });
      lims(await rejection(upd(svc, 'updateValueSet', db, theirs.id, 1, { display: 'x', values: [{ code: 'V1', display: 'x' }] })), 'common.not_found', 404);
      expect(db.row('cs_value_sets', theirs.id)).toMatchObject({ version: 1, display: theirs.display });
      expect(db.rows('cs_value_set_values', TENANT_B)).toHaveLength(1);
      expect(db.events).toHaveLength(0);
    });

    it('a value patch can only touch values of THE set in the path: a same-code value in another own set is unchanged', { timeout: T }, async () => {
      const other = vset(2, TENANT_A, { code: 'OTHER' });
      const ov = vval(other.id, 1, TENANT_A, { code: 'LOW', display: 'other low', sort_order: 10 });
      const { db, svc } = seed({ cs_value_sets: [S, other], cs_value_set_values: [V(1, 'LOW', 10), ov] });
      await upd(svc, 'updateValueSet', db, S.id, 1, { values: [{ code: 'LOW', display: 'changed' }] });
      expect(db.row('cs_value_set_values', ov.id)).toMatchObject({ display: 'other low', version: 1 });
    });
  });

  describe('concurrency and preconditions', () => {
    it('no If-Match -> 428; stale -> 409 common.version_conflict; unknown id -> 404; malformed id -> 400; set and values unchanged each time', { timeout: T }, async () => {
      const { db, svc } = seed({ cs_value_sets: [{ ...S, version: 3 }] });
      lims(await rejection(upd(svc, 'updateValueSet', db, S.id, undefined, { display: 'x' })), 'common.precondition_required', 428);
      lims(await rejection(upd(svc, 'updateValueSet', db, S.id, 2, { display: 'x', values: [{ code: 'N', display: 'n', sort_order: 99 }] })), 'common.version_conflict', 409);
      lims(await rejection(upd(svc, 'updateValueSet', db, ID(0xfeed), 1, { display: 'x' })), 'common.not_found', 404);
      validation400(await rejection(upd(svc, 'updateValueSet', db, 'nope', 1, { display: 'x' })));
      expect(db.row('cs_value_sets', S.id)).toMatchObject({ version: 3, display: 'Lab grade' });
      expect(valuesOf(db)).toEqual(BASE_VALUES);
      expect(events(db)).toHaveLength(0);
    });

    it('race: two PATCHes with the same If-Match appending different codes -> one 200, one 409; only the winner\'s value exists; one event', { timeout: T }, async () => {
      const { db, svc } = seed();
      const res = await Promise.allSettled([
        upd(svc, 'updateValueSet', db, S.id, 1, { values: [{ code: 'AAA', display: 'a', sort_order: 91 }] }),
        upd(svc, 'updateValueSet', db, S.id, 1, { values: [{ code: 'BBB', display: 'b', sort_order: 92 }] }),
      ]);
      expect(res.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
      lims((res.find((x) => x.status === 'rejected') as PromiseRejectedResult).reason, 'common.version_conflict', 409);
      const added = Object.keys(valuesOf(db)).filter((c) => c === 'AAA' || c === 'BBB');
      expect(added).toHaveLength(1);
      expect(db.row('cs_value_sets', S.id)!.version).toBe(2);
      expect(events(db)).toHaveLength(1);
    });

    it('atomic: a failure while writing a value or the event leaves set version, values and revision as before', { timeout: T }, async () => {
      for (const pattern of [/(INSERT INTO|UPDATE) catalog\.cs_value_set_values/i, /INSERT INTO core\.event_log/i]) {
        const { db, svc } = seed();
        db.fail(pattern);
        await rejection(upd(svc, 'updateValueSet', db, S.id, 1, { display: 'z', values: [{ code: 'LOW', display: 'changed' }, { code: 'NEWV', display: 'n', sort_order: 99 }] }));
        expect(db.row('cs_value_sets', S.id)).toMatchObject({ version: 1, display: 'Lab grade' });
        expect(valuesOf(db)).toEqual(BASE_VALUES);
        expect(db.revisionOf(TENANT_A)).toBe(417);
      }
    });
  });

  describe('validation (all -> 400, nothing written)', () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['display empty', { display: '' }], ['display 81', { display: 'd'.repeat(81) }], ['is_active string', { is_active: 'no' }],
      ['values not an array', { values: 'LOW' }], ['value without code', { values: [{ display: 'x' }] }], ['value code with space',{ values: [{ code: 'A B' }] }],
      ['value code 17', { values: [{ code: 'A'.repeat(17) }] }], ['value display 41', { values: [{ code: 'LOW', display: 'd'.repeat(41) }] }],
      ['value sort_order 10000', { values: [{ code: 'NEWV', display: 'n', sort_order: 10000 }] }], ['value sort_order 1.5', { values: [{ code: 'NEWV', display: 'n', sort_order: 1.5 }] }],
      ['duplicate codes in the request', { values: [{ code: 'NEWV', display: 'a', sort_order: 91 }, { code: 'NEWV', display: 'b', sort_order: 92 }] }],
      ['51 values', { values: Array.from({ length: 51 }, (_, i) => ({ code: `N${i}`, display: 'x', sort_order: i })) }],
      ['is_ordered (immutable, not in ValueSetUpdate)', { is_ordered: false }], ['code (immutable)', { code: 'OTHER' }], ['scope', { scope: 'global' }],
      ['tenant_id', { tenant_id: TENANT_B }], ['id', { id: ID(0xbad) }], ['version', { version: 9 }],
      ['value with id', { values: [{ code: 'LOW', id: ID(0xbad) }] }], ['value with value_set_id', { values: [{ code: 'NEWV', display: 'n', sort_order: 99, value_set_id: ID(0x1) }] }],
      ['value sort_order string', { values: [{ code: 'NEWV', display: 'n', sort_order: '5' }] }],
    ];
    it.each(cases)('%s', { timeout: T }, async (_n, patch) => {
      const { db, svc } = seed();
      validation400(await rejection(upd(svc, 'updateValueSet', db, S.id, 1, patch)));
      expect(db.row('cs_value_sets', S.id)).toMatchObject({ version: 1, display: 'Lab grade', is_ordered: true, code: 'LAB_GRADE' });
      expect(valuesOf(db)).toEqual(BASE_VALUES);
      expect(events(db)).toHaveLength(0);
    });

    it('AB-20: a rejected value is never echoed', { timeout: T }, async () => {
      const { db, svc } = seed();
      const e = await rejection(upd(svc, 'updateValueSet', db, S.id, 1, { values: [{ code: 'PLANTED bad 9c2d' }] }));
      validation400(e);
      expect(JSON.stringify({ m: e.message, d: e.detail, errs: e.errors })).not.toContain('9c2d');
    });
  });
});
