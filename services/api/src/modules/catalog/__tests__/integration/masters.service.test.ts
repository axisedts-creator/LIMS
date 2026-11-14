// T-04 (C3) — masters service: departments, specimen types, containers, methods (operations #5–#16).
// Spec: 06-PLAN row T-04; 02-TRD §5 "Masters" table (#5–#16), §5.0 conventions (If-Match, lists, codes), §9.1 (event table: create ->
//       created, is_active->false -> deactivated, other update -> updated, method -> entity_type 'method'); 03-APP-FLOW F-01;
//       PRD AC-01.1 … AC-01.6; 07-SECURITY S-1 (cross-tenant), S-5 (mass assignment), AB-20 (no value echo), §3 revision rule.
// Real core `createEvents({producer:'catalog'})` (envelope + catalog.changed.v1 schema enforced) over the SQL fake in helpers/mastersDb.ts
// (RLS, row locks, UNIQUE/CHECK/FK, READ COMMITTED). The revision bump is T-03's real service — T-04 must call it in the same transaction.
// Interface expected from the writer (names marked SEAM are not fixed by the spec; see .orchestra/notes/T-04-tests.md):
//   catalog/service/masters.service.ts  export function createMastersService(deps: { events: { publish(ctx, type, input) } }) (SEAM)
//     -> one method per operationId, snake_case DTOs exactly as contracts/openapi/catalog.yaml:
//        list<R>s(ctx, query)  query = { id?, is_active?: 'true'|'false'|'all', sort?, cursor?, limit? }  -> { data: DTO[], page: { limit, next_cursor? } }
//        create<R>(ctx, body)  body = <R>Create (as sent)                                                  -> DTO (the 201 body)
//        update<R>(ctx, { id, expectedVersion, patch })  expectedVersion = integer parsed from If-Match, undefined when the header is absent
//                                                                                                         -> DTO (the 200 body)
//     ctx = core HandlerContext subset { tenantId, actor, requestId, tx, now, events }. Errors are LimsError (core/errors.ts).
//   It must call revision.service.bumpRevision in the SAME tx (T-03) with entityType department|specimen_type|container|method.
import { describe, expect, it } from 'vitest';
import { createEvents } from '../../../../core/events/publish.js';
import { isLimsError } from '../../../../core/errors.js';
import { createMastersService } from '../../service/masters.service.js';
import { ROOT_A, TENANT_A, TENANT_B, USER, UUIDV7 } from '../helpers/catalogDb.js';
import { cont, dept, ID, makeMastersDb, meth, spec as specimen, type Row, type Table } from '../helpers/mastersDb.js';

const T = 20_000;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
type Svc = Record<string, (ctx: any, input?: any) => Promise<any>>;
const seedState = { state: { [TENANT_A]: { rootId: ROOT_A, revision: 417 } } };

const setup = (rows: Partial<Record<Table, Row[]>> = {}, catalog: any = seedState) => {
  const db = makeMastersDb({ rows, catalog });
  const svc = createMastersService({ events: createEvents({ producer: 'catalog' } as never) } as never) as unknown as Svc;
  return { db, svc };
};
const rejection = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { return e; } throw new Error('expected rejection, got success'); };
const lims = (e: any, code: string, status: number) => { expect(isLimsError(e, code), `got ${e?.code ?? e?.message}`).toBe(true); expect(e.statusCode).toBe(status); };
const validation400 = (e: any) => { expect(isLimsError(e), `got ${e?.code ?? e?.message}`).toBe(true); expect(e.statusCode).toBe(400); expect(['common.validation_failed', 'common.unknown_field']).toContain(e.code); };

interface Res {
  R: string; table: Table; entity: string; seedFn: (n: number, t: string, o?: Row) => Row;
  body: Record<string, unknown>; norm: Record<string, unknown>; patch: Record<string, unknown>;
  badBodies: Array<[string, Record<string, unknown>]>; badPatches: Array<[string, Record<string, unknown>]>;
}
const RES: Res[] = [
  {
    R: 'Department', table: 'departments', entity: 'department', seedFn: dept,
    body: { code: 'haem', name: 'Hematology', report_order: 10 },
    norm: { code: 'HAEM', name: 'Hematology', report_order: 10 },
    patch: { name: 'Haematology', report_order: 20, report_heading: 'HAEMATOLOGY' },
    badBodies: [['report_order -1', { report_order: -1 }], ['report_order 10000', { report_order: 10000 }], ['report_order 1.5', { report_order: 1.5 }],
      ['report_order string', { report_order: '10' }], ['report_order missing', { report_order: undefined }], ['name empty', { name: '' }],
      ['name 101', { name: 'x'.repeat(101) }], ['name missing', { name: undefined }], ['heading 101', { report_heading: 'h'.repeat(101) }]],
    badPatches: [['report_order 10000', { report_order: 10000 }], ['name empty', { name: '' }], ['heading 101', { report_heading: 'h'.repeat(101) }]],
  },
  {
    R: 'SpecimenType', table: 'specimen_types', entity: 'specimen_type', seedFn: specimen,
    body: { code: 'edta_wb', name: 'EDTA whole blood', report_label: 'EDTA WHOLE BLOOD' },
    norm: { code: 'EDTA_WB', name: 'EDTA whole blood', report_label: 'EDTA WHOLE BLOOD' },
    patch: { name: 'EDTA WB', report_label: 'EDTA BLOOD' },
    badBodies: [['report_label missing', { report_label: undefined }], ['report_label empty', { report_label: '' }], ['report_label 101', { report_label: 'l'.repeat(101) }],
      ['name 101', { name: 'x'.repeat(101) }]],
    badPatches: [['report_label empty', { report_label: '' }], ['name 101', { name: 'x'.repeat(101) }]],
  },
  {
    R: 'Container', table: 'containers', entity: 'container', seedFn: cont,
    body: { code: 'lav_top', name: 'Lavender top tube', additive: 'K2EDTA', cap_colour_display: 'Lavender' },
    norm: { code: 'LAV_TOP', name: 'Lavender top tube', additive: 'K2EDTA', cap_colour_display: 'Lavender' },
    patch: { name: 'Lavender tube', additive: 'K3EDTA', cap_colour_display: 'Purple' },
    badBodies: [['additive 61', { additive: 'a'.repeat(61) }], ['cap colour 41', { cap_colour_display: 'c'.repeat(41) }], ['default_specimen_type_id not a uuid', { default_specimen_type_id: 'not-a-uuid' }],
      ['name 101', { name: 'x'.repeat(101) }]],
    badPatches: [['additive 61', { additive: 'a'.repeat(61) }], ['default_specimen_type_id not a uuid', { default_specimen_type_id: 'nope' }]],
  },
  {
    R: 'Method', table: 'methods', entity: 'method', seedFn: meth,
    body: { code: 'impedance', name: 'Electrical impedance' },
    norm: { code: 'IMPEDANCE', name: 'Electrical impedance' },
    patch: { name: 'Impedance counting' },
    badBodies: [['name 121 (methods allow 120)', { name: 'x'.repeat(121) }], ['name empty', { name: '' }]],
    badPatches: [['name 121', { name: 'x'.repeat(121) }]],
  },
];
const bodyOf = (r: Res, o: Record<string, unknown> = {}) => Object.fromEntries(Object.entries({ ...r.body, ...o }).filter(([, v]) => v !== undefined));
const events = (db: ReturnType<typeof setup>['db'], tenant = TENANT_A) => db.events.filter((e) => e.tenantId === tenant && e.eventType === 'catalog.changed.v1');

describe.each(RES)('$R — create (AC-01.1 … AC-01.3)', (r) => {
  const create = `create${r.R}`;
  it('AC-01.1: 201 DTO — code upper-cased, version 1, is_active true, ISO-UTC timestamps, no internal columns', { timeout: T }, async () => {
    const { db, svc } = setup();
    const out = await db.run((ctx) => svc[create]!(ctx, bodyOf(r)));
    expect(out).toMatchObject({ ...r.norm, version: 1, is_active: true });
    expect(out.id).toMatch(UUIDV7);
    expect(out.created_at).toMatch(ISO_UTC);
    expect(out.updated_at).toMatch(ISO_UTC);
    for (const k of ['tenant_id', 'created_by', 'updated_by']) expect(out).not.toHaveProperty(k);
    const row = db.row(r.table, out.id)!;
    expect(row).toMatchObject({ tenant_id: TENANT_A, code: r.norm['code'], version: 1, is_active: true, created_by: USER, updated_by: USER });
  });

  it('AC-01.1: catalog.changed.v1 {entity_type, change_kind created, entity_id = new id} is published in the same transaction, revision +1', { timeout: T }, async () => {
    const { db, svc } = setup();
    const out = await db.run((ctx) => svc[create]!(ctx, bodyOf(r)));
    const ev = events(db);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.envelope.payload).toMatchObject({ catalog_revision: 418, entity_type: r.entity, entity_id: out.id, change_kind: 'created' });
    expect(ev[0]!.envelope.payload.effective_from).toMatch(ISO_UTC);
    expect(ev[0]!.key).toBe(`${TENANT_A}:catalog:418`);
    expect(db.revisionOf(TENANT_A)).toBe(418);
    const mine = db.stmts.filter((s) => s.tenantId === TENANT_A);
    const insertAt = mine.findIndex((s) => new RegExp(`^\\s*INSERT\\s+INTO\\s+catalog\\.${r.table}\\b`, 'i').test(s.text));
    const eventAt = mine.findIndex((s) => /INSERT INTO core\.event_log/i.test(s.text));
    expect(insertAt).toBeGreaterThanOrEqual(0);
    expect(eventAt).toBeGreaterThan(insertAt);
    expect(new Set(mine.map((s) => s.txId)).size).toBe(1);        // one transaction for row + revision + event
  });

  it('rollback after create discards row, revision and event together; a failing event insert fails the create and leaves no row', { timeout: T }, async () => {
    const a = setup();
    await rejection(a.db.run((ctx) => a.svc[create]!(ctx, bodyOf(r)), { rollback: true }));
    expect(a.db.rows(r.table)).toHaveLength(0);
    expect(events(a.db)).toHaveLength(0);
    expect(a.db.revisionOf(TENANT_A)).toBe(417);
    const b = setup();
    b.db.fail(/INSERT INTO core\.event_log/i);
    await rejection(b.db.run((ctx) => b.svc[create]!(ctx, bodyOf(r))));
    expect(b.db.rows(r.table)).toHaveLength(0);
    expect(b.db.revisionOf(TENANT_A)).toBe(417);
  });

  it('is_active:false at create is honoured (event is still change_kind created)', { timeout: T }, async () => {
    const { db, svc } = setup();
    const out = await db.run((ctx) => svc[create]!(ctx, bodyOf(r, { is_active: false })));
    expect(out.is_active).toBe(false);
    expect(events(db)[0]!.envelope.payload.change_kind).toBe('created');
  });

  it('the first write of a tenant with no catalog_state row works (revision 1)', { timeout: T }, async () => {
    const { db, svc } = setup({}, {});
    await db.run((ctx) => svc[create]!(ctx, bodyOf(r)));
    expect(db.revisionOf(TENANT_A)).toBe(1);
    expect(events(db)[0]!.envelope.payload.catalog_revision).toBe(1);
  });

  it.each([[' padded '], ['MiXeD']])('code %j is trimmed and upper-cased on write', { timeout: T }, async (raw) => {
    const { db, svc } = setup();
    const out = await db.run((ctx) => svc[create]!(ctx, bodyOf(r, { code: raw })));
    expect(out.code).toBe(raw.trim().toUpperCase());
    expect(db.row(r.table, out.id)!.code).toBe(raw.trim().toUpperCase());
  });

  it('AC-01.2: the same code in any case -> 409 catalog.code_duplicate; no second row, no event, no revision bump', { timeout: T }, async () => {
    const { db, svc } = setup();
    await db.run((ctx) => svc[create]!(ctx, bodyOf(r)));
    for (const variant of [String(r.body['code']).toLowerCase(), String(r.norm['code']), ` ${String(r.body['code'])} `]) {
      lims(await rejection(db.run((ctx) => svc[create]!(ctx, bodyOf(r, { code: variant })))), 'catalog.code_duplicate', 409);
    }
    expect(db.rows(r.table, TENANT_A)).toHaveLength(1);
    expect(events(db)).toHaveLength(1);
    expect(db.revisionOf(TENANT_A)).toBe(418);
  });

  it('AC-01.2: an INACTIVE row still owns its code', { timeout: T }, async () => {
    const { db, svc } = setup({ [r.table]: [r.seedFn(1, TENANT_A, { code: r.norm['code'], is_active: false })] });
    lims(await rejection(db.run((ctx) => svc[create]!(ctx, bodyOf(r)))), 'catalog.code_duplicate', 409);
  });

  it('AC-01.3: tenant B owning the code does not block tenant A (codes are unique per tenant only); B is untouched', { timeout: T }, async () => {
    const { db, svc } = setup({ [r.table]: [r.seedFn(1, TENANT_B, { code: r.norm['code'] })] });
    const out = await db.run((ctx) => svc[create]!(ctx, bodyOf(r)));
    expect(out.code).toBe(r.norm['code']);
    expect(db.rows(r.table, TENANT_B)).toHaveLength(1);
    expect(db.rows(r.table, TENANT_A)).toHaveLength(1);
    expect(events(db, TENANT_B)).toHaveLength(0);
  });

  it('race: two concurrent creates of the same code -> exactly one wins, the loser gets catalog.code_duplicate (not a raw 23505), one event', { timeout: T }, async () => {
    const { db, svc } = setup();
    const res = await Promise.allSettled([
      db.run((ctx) => svc[create]!(ctx, bodyOf(r))),
      db.run((ctx) => svc[create]!(ctx, bodyOf(r, { code: String(r.body['code']).toLowerCase() }))),
    ]);
    expect(res.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const lost = res.find((x) => x.status === 'rejected') as PromiseRejectedResult;
    lims(lost.reason, 'catalog.code_duplicate', 409);
    expect(db.rows(r.table, TENANT_A)).toHaveLength(1);
    expect(events(db)).toHaveLength(1);
    expect(db.revisionOf(TENANT_A)).toBe(418);
  });

  it.each([
    ['empty', ''], ['blank', '   '], ['space inside', 'bad code'], ['hyphen', 'a-b'], ['33 chars', 'x'.repeat(33)], ['leading underscore', '_LEAD'],
    ['dotless i (case-fold forgery)', 'ıdx'], ['fullwidth letters', 'ＡＢＣ'], ['newline', 'A\nB'], ['number', 123], ['null', null], ['object', { a: 1 }],
  ])('invalid code (%s) -> 400, nothing written (path /code)', { timeout: T }, async (_n, code) => {
    const { db, svc } = setup();
    const e = await rejection(db.run((ctx) => svc[create]!(ctx, { ...bodyOf(r), code })));
    validation400(e);
    if (e.code === 'common.validation_failed') expect(e.errors?.[0]?.path).toBe('/code');
    expect(db.rows(r.table)).toHaveLength(0);
    expect(events(db)).toHaveLength(0);
  });

  it('missing code -> 400', { timeout: T }, async () => {
    const { db, svc } = setup();
    const { code: _c, ...rest } = bodyOf(r);
    validation400(await rejection(db.run((ctx) => svc[create]!(ctx, rest))));
  });

  it.each(r.badBodies)('invalid field: %s -> 400 before any write (service is also called by import commits, so it validates itself)', { timeout: T }, async (_n, over) => {
    const { db, svc } = setup();
    validation400(await rejection(db.run((ctx) => svc[create]!(ctx, bodyOf(r, over)))));
    expect(db.rows(r.table)).toHaveLength(0);
    expect(events(db)).toHaveLength(0);
  });

  it.each([
    ['tenant_id', TENANT_B], ['id', ID(0xbad)], ['version', 9], ['created_by', USER], ['updated_at', '2020-01-01T00:00:00.000Z'], ['status', 'published'], ['revision', 5],
    ['__proto__x', 1],
  ])('S-5 mass assignment: undeclared field %s -> 400, nothing written', { timeout: T }, async (k, v) => {
    const { db, svc } = setup();
    validation400(await rejection(db.run((ctx) => svc[create]!(ctx, { ...bodyOf(r), [k]: v }))));
    expect(db.rows(r.table)).toHaveLength(0);
  });

  it('is_active must be boolean', { timeout: T }, async () => {
    const { db, svc } = setup();
    validation400(await rejection(db.run((ctx) => svc[create]!(ctx, bodyOf(r, { is_active: 'false' })))));
  });

  it('SQL stays parameterised: a quote/semicolon in name round-trips verbatim and never appears in statement text', { timeout: T }, async () => {
    const { db, svc } = setup();
    const planted = "O'Brien; DROP TABLE x;--";
    const out = await db.run((ctx) => svc[create]!(ctx, bodyOf(r, { name: planted })));
    expect(out.name).toBe(planted);
    expect(db.row(r.table, out.id)!.name).toBe(planted);
    for (const s of db.stmts) { expect(s.text).not.toContain('DROP TABLE'); expect(s.text).not.toContain(String(r.norm['code'])); }
  });

  it('error detail never echoes submitted values (AB-20)', { timeout: T }, async () => {
    const { db, svc } = setup();
    const planted = 'PLANTED-VALUE-7f3a';
    const e = await rejection(db.run((ctx) => svc[create]!(ctx, bodyOf(r, { code: planted + ' bad!' }))));
    expect(JSON.stringify({ m: e.message, d: e.detail, errs: e.errors })).not.toContain('PLANTED-VALUE');
  });
});

describe('AC-01.5 specimen type report label', () => {
  it('EDTA_WB with report label "EDTA WHOLE BLOOD" is created and read back with that label (the getTest half is T-06)', { timeout: T }, async () => {
    const { db, svc } = setup();
    const out = await db.run((ctx) => svc['createSpecimenType']!(ctx, { code: 'EDTA_WB', name: 'EDTA whole blood', report_label: 'EDTA WHOLE BLOOD' }));
    const page = await db.run((ctx) => svc['listSpecimenTypes']!(ctx, { id: out.id }));
    expect(page.data).toHaveLength(1);
    expect(page.data[0]).toMatchObject({ code: 'EDTA_WB', report_label: 'EDTA WHOLE BLOOD' });
  });
});

describe('Container default specimen type', () => {
  it('own-tenant specimen type is accepted at create and update; foreign or unknown ids are refused (S-1) with no row/event', { timeout: T }, async () => {
    const mine = specimen(1, TENANT_A); const theirs = specimen(2, TENANT_B);
    const { db, svc } = setup({ specimen_types: [mine, theirs] });
    const ok = await db.run((ctx) => svc['createContainer']!(ctx, { code: 'tube1', name: 'Tube', default_specimen_type_id: mine.id }));
    expect(ok.default_specimen_type_id).toBe(mine.id);
    const before = events(db).length;
    for (const bad of [theirs.id, ID(0xdead)]) {
      const e = await rejection(db.run((ctx) => svc['createContainer']!(ctx, { code: 'tube2', name: 'Tube', default_specimen_type_id: bad })));
      // refused either by the service (404 common.not_found) or by the FK (23503, which core maps to common.not_found) — never created
      if (isLimsError(e)) lims(e, 'common.not_found', 404); else expect(e.code).toBe('23503');
    }
    expect(db.rows('containers', TENANT_A)).toHaveLength(1);
    expect(events(db)).toHaveLength(before);
    const upd = await rejection(db.run((ctx) => svc['updateContainer']!(ctx, { id: ok.id, expectedVersion: 1, patch: { default_specimen_type_id: theirs.id } })));
    if (isLimsError(upd)) lims(upd, 'common.not_found', 404); else expect(upd.code).toBe('23503');
    expect(db.row('containers', ok.id)!.default_specimen_type_id).toBe(mine.id);
  });
});

describe.each(RES)('$R — list (AC-01.4)', (r) => {
  const list = `list${r.R}s`;
  const rows = () => [1, 2, 3, 4, 5].map((n) => r.seedFn(n, TENANT_A, n === 2 || n === 4 ? { is_active: false } : {}));

  it('default = active only; is_active=false = inactive only; all = both; DTO has no internal columns', { timeout: T }, async () => {
    const { db, svc } = setup({ [r.table]: [...rows(), r.seedFn(9, TENANT_B)] });
    const act = await db.run((ctx) => svc[list]!(ctx, {}));
    expect(act.data.every((x: Row) => x.is_active === true)).toBe(true);
    expect(act.data).toHaveLength(3);
    expect(act.page.limit).toBe(50);
    expect((await db.run((ctx) => svc[list]!(ctx, { is_active: 'true' }))).data).toHaveLength(3);
    const off = await db.run((ctx) => svc[list]!(ctx, { is_active: 'false' }));
    expect(off.data).toHaveLength(2);
    expect(off.data.every((x: Row) => x.is_active === false)).toBe(true);
    expect((await db.run((ctx) => svc[list]!(ctx, { is_active: 'all' }))).data).toHaveLength(5);
    for (const x of act.data) for (const k of ['tenant_id', 'created_by', 'updated_by']) expect(x).not.toHaveProperty(k);
    expect(act.data[0].created_at).toMatch(ISO_UTC);
  });

  it('S-1: never returns tenant B rows, and a B id read by tenant A is an empty page', { timeout: T }, async () => {
    const theirs = r.seedFn(9, TENANT_B);
    const { db, svc } = setup({ [r.table]: [...rows(), theirs] });
    const all = await db.run((ctx) => svc[list]!(ctx, { is_active: 'all' }));
    expect(all.data.map((x: Row) => x.id)).not.toContain(theirs.id);
    expect(JSON.stringify(all)).not.toContain(String(theirs['code']));
    const one = await db.run((ctx) => svc[list]!(ctx, { id: theirs.id, is_active: 'all' }));
    expect(one.data).toEqual([]);
    const oneDefault = await db.run((ctx) => svc[list]!(ctx, { id: theirs.id }));
    expect(oneDefault.data).toEqual([]);
  });

  it('AC-01.4: a deactivated row is excluded from the default list but still readable by id', { timeout: T }, async () => {
    const row = r.seedFn(1, TENANT_A);
    const { db, svc } = setup({ [r.table]: [row] });
    const upd = await db.run((ctx) => svc[`update${r.R}`]!(ctx, { id: row.id, expectedVersion: 1, patch: { is_active: false } }));
    expect(upd.is_active).toBe(false);
    expect((await db.run((ctx) => svc[list]!(ctx, {}))).data).toEqual([]);
    const byId = await db.run((ctx) => svc[list]!(ctx, { id: row.id }));
    expect(byId.data).toHaveLength(1);
    expect(byId.data[0]).toMatchObject({ id: row.id, is_active: false });
  });

  it.each([['code', 'asc'], ['-code', 'desc'], ['name', 'asc'], ['-name', 'desc']])('sort=%s orders by that field (id tie-break)', { timeout: T }, async (sort, dir) => {
    const { db, svc } = setup({ [r.table]: rows() });
    const out = await db.run((ctx) => svc[list]!(ctx, { sort, is_active: 'all' }));
    const key = sort.replace('-', '') as 'code' | 'name';
    const got = out.data.map((x: Row) => x[key]);
    expect(got).toEqual([...got].sort((a: string, b: string) => (dir === 'asc' ? (a < b ? -1 : 1) : a < b ? 1 : -1)));
  });

  it('cursor pagination: limit 2 over 5 rows -> 2,2,1, no duplicates or gaps, next_cursor absent on the last page', { timeout: T }, async () => {
    const { db, svc } = setup({ [r.table]: rows() });
    const seen: string[] = []; let cursor: string | undefined; let pages = 0;
    do {
      const p = await db.run((ctx) => svc[list]!(ctx, { is_active: 'all', limit: 2, sort: 'code', ...(cursor ? { cursor } : {}) }));
      expect(p.page.limit).toBe(2);
      expect(p.data.length).toBeLessThanOrEqual(2);
      seen.push(...p.data.map((x: Row) => x.code));
      cursor = p.page.next_cursor;
      if (cursor !== undefined) expect(cursor).toMatch(/^[A-Za-z0-9_-]{1,512}$/);
      pages++;
    } while (cursor !== undefined && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toEqual([...seen].sort());
    expect(new Set(seen).size).toBe(5);
  });

  it.each([['garbage', '!!!not-a-cursor!!!'], ['well-formed base64url but not ours', 'AAAA']])('malformed cursor (%s) -> 400 common.invalid_cursor', { timeout: T }, async (_n, cursor) => {
    const { db, svc } = setup({ [r.table]: rows() });
    const e = await rejection(db.run((ctx) => svc[list]!(ctx, { cursor })));
    expect(e.statusCode).toBe(400);
    expect(['common.invalid_cursor', 'common.validation_failed']).toContain(e.code);
  });

  it.each([['limit 0', { limit: 0 }], ['limit 201', { limit: 201 }], ['limit 1.5', { limit: 1.5 }], ['sort not in enum', { sort: 'password' }],
    ['is_active not in enum', { is_active: 'maybe' }], ['id not a uuid', { id: 'x' }], ['unknown filter', { tenant_id: TENANT_B }]])('invalid query: %s -> 400', { timeout: T }, async (_n, q) => {
    const { db, svc } = setup({ [r.table]: rows() });
    validation400(await rejection(db.run((ctx) => svc[list]!(ctx, q))));
  });

  it('a list is a pure read: no revision bump, no event', { timeout: T }, async () => {
    const { db, svc } = setup({ [r.table]: rows() });
    await db.run((ctx) => svc[list]!(ctx, { is_active: 'all' }));
    expect(db.revisionOf(TENANT_A)).toBe(417);
    expect(events(db)).toHaveLength(0);
  });
});

describe.each(RES)('$R — update (AC-01.4, AC-01.6)', (r) => {
  const update = `update${r.R}`;
  const seeded = () => { const row = r.seedFn(1, TENANT_A); return { row, ...setup({ [r.table]: [row, r.seedFn(7, TENANT_B)] }) }; };

  it('correct If-Match -> DTO with version+1, only the given fields changed, code immutable, one `updated` event, revision +1', { timeout: T }, async () => {
    const { row, db, svc } = seeded();
    const out = await db.run((ctx) => svc[update]!(ctx, { id: row.id, expectedVersion: 1, patch: r.patch }));
    expect(out).toMatchObject({ ...r.patch, id: row.id, code: row['code'], version: 2, is_active: true });
    const after = db.row(r.table, row.id)!;
    expect(after).toMatchObject({ ...r.patch, version: 2, tenant_id: TENANT_A, code: row['code'], created_by: USER });
    const ev = events(db);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.envelope.payload).toMatchObject({ catalog_revision: 418, entity_type: r.entity, entity_id: row.id, change_kind: 'updated' });
    expect(db.revisionOf(TENANT_A)).toBe(418);
  });

  it('a partial patch leaves every other field as it was', { timeout: T }, async () => {
    const { row, db, svc } = seeded();
    const [k] = Object.keys(r.patch) as [string];
    await db.run((ctx) => svc[update]!(ctx, { id: row.id, expectedVersion: 1, patch: { [k]: r.patch[k] } }));
    const after = db.row(r.table, row.id)!;
    for (const c of Object.keys(row)) if (c !== k && c !== 'version' && c !== 'updated_at' && c !== 'updated_by') expect(after[c]).toEqual(row[c]);
    expect(after[k]).toEqual(r.patch[k]);
  });

  it('is_active true -> false is change_kind `deactivated`; false -> true is `updated`; versions advance each time', { timeout: T }, async () => {
    const { row, db, svc } = seeded();
    const off = await db.run((ctx) => svc[update]!(ctx, { id: row.id, expectedVersion: 1, patch: { is_active: false } }));
    expect(off).toMatchObject({ is_active: false, version: 2 });
    const on = await db.run((ctx) => svc[update]!(ctx, { id: row.id, expectedVersion: 2, patch: { is_active: true } }));
    expect(on).toMatchObject({ is_active: true, version: 3 });
    expect(events(db).map((e) => e.envelope.payload.change_kind)).toEqual(['deactivated', 'updated']);
    expect(events(db).map((e) => e.envelope.payload.catalog_revision)).toEqual([418, 419]);
  });

  it('AC-01.6: no If-Match -> 428 common.precondition_required, row/revision/events untouched', { timeout: T }, async () => {
    const { row, db, svc } = seeded();
    lims(await rejection(db.run((ctx) => svc[update]!(ctx, { id: row.id, patch: r.patch }))), 'common.precondition_required', 428);
    expect(db.row(r.table, row.id)).toMatchObject({ version: 1, name: row['name'] });
    expect(db.revisionOf(TENANT_A)).toBe(417);
    expect(events(db)).toHaveLength(0);
  });

  it('AC-01.6: stale If-Match -> 409 common.version_conflict, nothing changed, no event, no revision bump', { timeout: T }, async () => {
    const { row, db, svc } = seeded();
    await db.run((ctx) => svc[update]!(ctx, { id: row.id, expectedVersion: 1, patch: r.patch }));
    const e = await rejection(db.run((ctx) => svc[update]!(ctx, { id: row.id, expectedVersion: 1, patch: { name: 'stale write' } })));
    lims(e, 'common.version_conflict', 409);
    expect(db.row(r.table, row.id)).toMatchObject({ version: 2, name: r.patch['name'] });
    expect(events(db)).toHaveLength(1);
    expect(db.revisionOf(TENANT_A)).toBe(418);
    lims(await rejection(db.run((ctx) => svc[update]!(ctx, { id: row.id, expectedVersion: 99, patch: { name: 'future' } }))), 'common.version_conflict', 409);
  });

  it('race: two concurrent updates with the same If-Match -> one wins, the other is version_conflict (no lost update)', { timeout: T }, async () => {
    const { row, db, svc } = seeded();
    const res = await Promise.allSettled([
      db.run((ctx) => svc[update]!(ctx, { id: row.id, expectedVersion: 1, patch: { name: 'writer one' } })),
      db.run((ctx) => svc[update]!(ctx, { id: row.id, expectedVersion: 1, patch: { name: 'writer two' } })),
    ]);
    expect(res.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    lims((res.find((x) => x.status === 'rejected') as PromiseRejectedResult).reason, 'common.version_conflict', 409);
    expect(db.row(r.table, row.id)!.version).toBe(2);
    expect(events(db)).toHaveLength(1);
    expect(db.revisionOf(TENANT_A)).toBe(418);
  });

  it('the UPDATE is optimistic in SQL (version predicate) and tenant-scoped explicitly, all values bound', { timeout: T }, async () => {
    const { row, db, svc } = seeded();
    await db.run((ctx) => svc[update]!(ctx, { id: row.id, expectedVersion: 1, patch: r.patch }));
    const upd = db.stmts.filter((s) => new RegExp(`^\\s*UPDATE\\s+catalog\\.${r.table}\\b`, 'i').test(s.text));
    expect(upd).toHaveLength(1);
    const where = upd[0]!.text.split(/\bWHERE\b/i)[1] ?? '';
    expect(where).toMatch(/\bversion\s*=\s*\$\d+/i);
    expect(where).toMatch(/\btenant_id\s*=\s*\$\d+/i);
    expect(upd[0]!.values).toEqual(expect.arrayContaining([TENANT_A, row.id, 1]));
    expect(upd[0]!.text).not.toContain(String(r.patch['name']));
  });

  it('unknown id -> 404 common.not_found (no event)', { timeout: T }, async () => {
    const { db, svc } = seeded();
    lims(await rejection(db.run((ctx) => svc[update]!(ctx, { id: ID(0xdead), expectedVersion: 1, patch: r.patch }))), 'common.not_found', 404);
    expect(events(db)).toHaveLength(0);
  });

  it('S-1: tenant A cannot update tenant B\'s row -> 404; B row, B events and A revision unchanged', { timeout: T }, async () => {
    const { db, svc } = seeded();
    const theirs = db.rows(r.table, TENANT_B)[0]!;
    lims(await rejection(db.run((ctx) => svc[update]!(ctx, { id: theirs.id, expectedVersion: 1, patch: r.patch }))), 'common.not_found', 404);
    expect(db.row(r.table, theirs.id)).toMatchObject({ version: 1, name: theirs['name'] });
    expect(events(db)).toHaveLength(0);
    expect(events(db, TENANT_B)).toHaveLength(0);
    expect(db.revisionOf(TENANT_A)).toBe(417);
  });

  it.each([['code (immutable)', { code: 'RENAMED' }], ['tenant_id', { tenant_id: TENANT_B }], ['id', { id: ID(0xbad) }], ['version', { version: 9 }],
    ['created_by', { created_by: USER }], ['status', { status: 'x' }], ['is_active as string', { is_active: 'false' }]])('S-5: patch field %s -> 400, row unchanged', { timeout: T }, async (_n, patch) => {
    const { row, db, svc } = seeded();
    validation400(await rejection(db.run((ctx) => svc[update]!(ctx, { id: row.id, expectedVersion: 1, patch }))));
    expect(db.row(r.table, row.id)).toMatchObject({ version: 1, code: row['code'] });
    expect(events(db)).toHaveLength(0);
  });

  it.each(r.badPatches)('invalid patch: %s -> 400, row unchanged', { timeout: T }, async (_n, patch) => {
    const { row, db, svc } = seeded();
    validation400(await rejection(db.run((ctx) => svc[update]!(ctx, { id: row.id, expectedVersion: 1, patch }))));
    expect(db.row(r.table, row.id)!.version).toBe(1);
  });

  it('rollback after update discards the change, the revision bump and the event together', { timeout: T }, async () => {
    const { row, db, svc } = seeded();
    await rejection(db.run((ctx) => svc[update]!(ctx, { id: row.id, expectedVersion: 1, patch: r.patch }), { rollback: true }));
    expect(db.row(r.table, row.id)).toMatchObject({ version: 1, name: row['name'] });
    expect(db.revisionOf(TENANT_A)).toBe(417);
    expect(events(db)).toHaveLength(0);
  });
});
