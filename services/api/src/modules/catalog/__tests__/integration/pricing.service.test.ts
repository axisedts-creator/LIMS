// T-17 (C3) — price lists, assignments, versions, items, operations #71–#81 (the quote engine #82 is T-19).
// Spec: 06-PLAN row T-17 (done_when: one default list; one list per owner; draft-only item edits; publish supersedes; merge moves/drops the merged doctor's assignment;
//         tests: integration (trigger), probes incl. tenant-B centre/doctor ids in assignments);
//       01-PRD US-13: AC-13.3 (published v3 from T1 supersedes v2 — windows, version numbers), AC-13.4 (published items immutable -> 409 catalog.version_in_use; changes via a
//         new draft copied from the latest), AC-13.5 (publish needs a change_reason; aal2/x-permission are the core pipeline's), AC-13.6 (one active default list, partial unique),
//         AC-13.7 (one list per doctor / credit party / centre -> 409 catalog.code_duplicate), AC-13.8 (integer paisa 0..999,999,999, no floats);
//       02-TRD §5.0 (If-Match 428/409, codes trimmed + upper-cased, cursor lists), §5.1 PriceList / PriceListVersion DTOs, §5.2 rows 71–81, §9.1 (create -> `price_list`/created;
//         assignments -> updated; publish -> `price_list`/versioned with entity_id = LIST id and effective_from = the version's; draft edits do NOT bump the revision);
//       03-APP-FLOW §2.1 V1–V5 (one draft per list -> 409 common.version_conflict; copy; publish supersedes the open-ended predecessor, effective_to := successor.effective_from;
//         effective_from >= now - 300 s and > the latest sibling's), E1/E2/E11/E22/E25;
//       05-SCHEMA price_lists / price_list_assignments / price_list_versions / price_list_items + §5 triggers (non-draft versions frozen, child rows only while draft);
//       07-SECURITY S-1, S-3, S-5, AB-1 (tenant-B version -> 404, zero rows changed), AB-2 (mixed A/B orderable ids -> per-row common.not_found), AB-3 (tenant-B centre/doctor ids in
//         assignments -> 404 + composite FK backstop), AB-10 (unknown fields -> 400).
// Real core `createEvents({producer:'catalog'})` over the SQL fake in helpers/pricingDb.ts (RLS, row locks, UNIQUE incl. partial, CHECK, composite FK, §5 triggers).
// The revision bump is T-03's real service — the writer must call it in the SAME transaction.
// Interface expected from the writer (SEAM names; see .orchestra/notes/T-17-tests.md):
//   catalog/service/pricing.service.ts  export function createPricingService(deps: { events, identity })  (identity is passed for symmetry; not required by these cases)
//     listPriceLists(ctx, { owner_kind?, owner_id?, is_active?, cursor?, limit? })                  -> { data: PriceList[], page: { limit, next_cursor? } }
//     createPriceList(ctx, body)                                                                    -> PriceList  (creates the list AND an empty draft v1)
//     getPriceListDetail(ctx, { id })                                                               -> PriceListDetail (PriceList + versions[] newest first, <= 50)
//     updatePriceList(ctx, { id, expectedVersion, patch })                                          -> PriceList
//     replacePriceListAssignments(ctx, { id, expectedVersion, body: { owner_ids } })                -> PriceList
//     createPriceListVersionDraft(ctx, { id, body?: { copy_from_version_no? } })                    -> PriceListVersion (the 201 body)
//     listPriceListItems(ctx, { versionId, query?: { orderable_kind?, department_id?, sort?, cursor?, limit? } }) -> { data: PriceItem[], page }
//     upsertPriceListItems(ctx, { versionId, body: { items } })                                     -> { results: [{ orderable_id, outcome, error_code? }] }
//     removePriceListItems(ctx, { versionId, body: { ids } })                                       -> { results: [...] }   (ids = ORDERABLE ids, 02-TRD #79)
//     publishPriceListVersion(ctx, { versionId, expectedVersion, body: { effective_from?, change_reason } }) -> PriceListVersion
//     discardPriceListVersionDraft(ctx, { versionId, expectedVersion })                             -> PriceListVersion
//   DTOs = snake_case PriceList / PriceListDetail / PriceListVersion / PriceItem of contracts/openapi/catalog.yaml; timestamps ISO-8601 UTC strings; money = { amount_paisa, currency:'NPR' }.
//   Single-table SQL only (see pricingDb.ts dialect). x-permission / aal2 / Idempotency-Key are the core pipeline's and are not re-tested here.
import { describe, expect, it } from 'vitest';
import { isLimsError } from '../../../../core/errors.js';
import { createEvents } from '../../../../core/events/publish.js';
import { createPricingService } from '../../service/pricing.service.js';
import { ROOT_A, TENANT_A, TENANT_B, USER } from '../helpers/catalogDb.js';
import { ID, type Row } from '../helpers/mastersDb.js';
import { MANAGE, READ, actorIdentity, centre, defaultList, doc, makePricingDb, orderable, party, passign, pitem, plist, pver } from '../helpers/pricingDb.js';

const T = 20_000;
type Svc = Record<string, (ctx: any, input?: any) => Promise<any>>;
const A = TENANT_A;
const B = TENANT_B;
const seedState = { state: { [A]: { rootId: ROOT_A, revision: 417 } } };
const at = (s: number) => new Date(Date.UTC(2026, 10, 7, 12, 0, s));
const NOW = at(0);
const iso = (d: Date) => d.toISOString();
const DAY = 86_400_000;
const FUTURE = new Date(NOW.getTime() + 30 * DAY);
const T0 = new Date('2026-01-01T00:00:00.000Z');               // effective_from of every seeded published version (helpers/pricingDb.ts pver)

// ---- synthetic world -------------------------------------------------------------------------------------------------------------------------
const O1 = orderable(1, A, { code: 'CBC', kind: 'test' }); const O2 = orderable(2, A, { code: 'FBS', kind: 'test' }); const O3 = orderable(3, A, { code: 'LFT', kind: 'panel' });
const OB = orderable(9, B, { code: 'BSECRET', kind: 'test' });
const C1 = centre(1, A); const C2 = centre(2, A); const CB = centre(9, B);
const P1 = party(1, A); const P2 = party(2, A); const PB = party(9, B);
const X = doc(1, A, { doctor_code: 'DRX1' }); const Y = doc(2, A, { doctor_code: 'DRY1' }); const XB = doc(9, B, { doctor_code: 'DRB1' });
const DEF = defaultList(1, A);                                                      // tenant default
const LP = plist(2, A, { owner_kind: 'credit_party', code: 'HOSP1' });                // credit-party list
const LR = plist(3, A, { owner_kind: 'referrer', code: 'DOCX1' });                    // referrer list
const LC = plist(4, A, { owner_kind: 'centre', code: 'CENT1' });                      // centre list
const LB = plist(9, B, { owner_kind: 'credit_party', code: 'BLIST' });
const BASE_REFS = { orderables: [O1, O2, O3, OB], collection_centres: [C1, C2, CB], credit_parties: [P1, P2, PB], doctors: [X, Y, XB] };

const setup = (rows: Record<string, Row[]> = {}, perms: readonly string[] = [READ, MANAGE], catalog: any = seedState) => {
  const merged: Record<string, Row[]> = { ...BASE_REFS };
  for (const [k, v] of Object.entries(rows)) merged[k] = [...(merged[k] ?? []), ...v];
  const db = makePricingDb({ rows: merged as never, catalog });
  const identity = actorIdentity(perms);
  const svc = createPricingService({ events: createEvents({ producer: 'catalog' } as never), identity } as never) as unknown as Svc;
  return { db, svc, identity };
};
type Db = ReturnType<typeof setup>['db'];
const rejection = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { expect(e, `crash: ${(e as Error)?.message}`).not.toBeInstanceOf(TypeError); return e; } throw new Error('expected rejection, got success'); };
const lims = (e: any, code: string, status: number) => { expect(isLimsError(e, code), `got ${e?.code ?? e?.message}`).toBe(true); expect(e.statusCode).toBe(status); };
const validation400 = (e: any) => { expect(isLimsError(e), `got ${e?.code ?? e?.message}`).toBe(true); expect(e.statusCode).toBe(400); expect(['common.validation_failed', 'common.unknown_field']).toContain(e.code); };
const events = (db: Db, tenant = A) => db.events.filter((e) => e.tenantId === tenant && e.eventType === 'catalog.changed.v1');
const payloads = (db: Db, tenant = A) => events(db, tenant).map((e) => e.envelope.payload as Record<string, any>);
const writes = (db: Db) => db.stmts.filter((s) => s.tenantId === A && /^\s*(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+catalog\./i.test(s.text));
const ms = (v: unknown) => new Date(v as string | Date).getTime();
const snap = (db: Db) => JSON.stringify(['price_lists', 'price_list_assignments', 'price_list_versions', 'price_list_items'].map((t) => db.rows(t as never)));

const create = (db: Db, svc: Svc, body: object, o: { tenantId?: string; at?: Date } = {}) => db.run((ctx) => svc['createPriceList']!(ctx, body), { at: NOW, ...o });
const getD = (db: Db, svc: Svc, id: string, tenantId = A) => db.run((ctx) => svc['getPriceListDetail']!(ctx, { id }), { tenantId, at: NOW });
const list = (db: Db, svc: Svc, query: object = {}, tenantId = A) => db.run((ctx) => svc['listPriceLists']!(ctx, query), { tenantId, at: NOW });
const upd = (db: Db, svc: Svc, id: string, version: number | undefined, patch: object, o: { at?: Date } = {}) =>
  db.run((ctx) => svc['updatePriceList']!(ctx, { id, expectedVersion: version, patch }), { at: NOW, ...o });
const assign = (db: Db, svc: Svc, id: string, version: number | undefined, owner_ids: unknown, o: { at?: Date } = {}) =>
  db.run((ctx) => svc['replacePriceListAssignments']!(ctx, { id, expectedVersion: version, body: { owner_ids } }), { at: NOW, ...o });
const draftOf = (db: Db, svc: Svc, id: string, body?: object, o: { tenantId?: string } = {}) => db.run((ctx) => svc['createPriceListVersionDraft']!(ctx, { id, body }), { at: NOW, ...o });
const items = (db: Db, svc: Svc, versionId: string, query: object = {}, tenantId = A) => db.run((ctx) => svc['listPriceListItems']!(ctx, { versionId, query }), { tenantId, at: NOW });
const money = (n: number) => ({ amount_paisa: n, currency: 'NPR' });
const upsert = (db: Db, svc: Svc, versionId: string, rows: Array<[string, unknown]>, o: { tenantId?: string } = {}) =>
  db.run((ctx) => svc['upsertPriceListItems']!(ctx, { versionId, body: { items: rows.map(([orderable_id, p]) => ({ orderable_id, unit_price: typeof p === 'number' ? money(p) : p })) } }), { at: NOW, ...o });
const remove = (db: Db, svc: Svc, versionId: string, ids: string[], o: { tenantId?: string } = {}) => db.run((ctx) => svc['removePriceListItems']!(ctx, { versionId, body: { ids } }), { at: NOW, ...o });
const publish = (db: Db, svc: Svc, versionId: string, version: number | undefined, body: object, o: { at?: Date; tenantId?: string } = {}) =>
  db.run((ctx) => svc['publishPriceListVersion']!(ctx, { versionId, expectedVersion: version, body }), { at: NOW, ...o });
const discard = (db: Db, svc: Svc, versionId: string, version: number | undefined, o: { tenantId?: string } = {}) =>
  db.run((ctx) => svc['discardPriceListVersionDraft']!(ctx, { versionId, expectedVersion: version }), { at: NOW, ...o });
const sql = (db: Db, text: string, values: unknown[] = []) => db.run((ctx) => ctx.tx.query(text, values), { at: NOW });
const sqlCode = async (p: Promise<unknown>) => { try { await p; } catch (e: any) { return e.code as string; } return 'none'; };
const REASON = 'Synthetic change reason';

/** A list with published v1 [O1=90000, O2=50000] (effective T0) and no draft. */
const V1 = pver(1, A, LP.id as string, 1, { status: 'published' });
const withPublished = (extra: Record<string, Row[]> = {}) => setup({
  price_lists: [DEF, LP], price_list_versions: [V1],
  price_list_items: [pitem(1, A, V1.id as string, O1.id as string, 90_000), pitem(2, A, V1.id as string, O2.id as string, 50_000)], ...extra,
});
const itemRows = (db: Db, versionId: string) => db.rows('price_list_items', A).filter((r) => r.price_list_version_id === versionId);
const priceOf = (db: Db, versionId: string, orderableId: string) => itemRows(db, versionId).find((r) => r.orderable_id === orderableId)?.unit_price_paisa;

// ====================================================================================================== createPriceList (#72)
describe('createPriceList (#72) — AC-13.6, AC-13.7', () => {
  it('creates the list AND an empty draft v1 in one transaction; PriceList DTO; event price_list/created (entity_id = list id); revision +1 (the draft adds none)', { timeout: T }, async () => {
    const { db, svc } = setup();
    const out = await create(db, svc, { code: 'hosp9', name: 'Synthetic Hospital List', owner_kind: 'credit_party', assignments: [{ owner_id: P1.id }] });
    expect(out).toMatchObject({ code: 'HOSP9', name: 'Synthetic Hospital List', owner_kind: 'credit_party', falls_through: true, assignments: [{ owner_id: P1.id }], is_active: true, version: 1 });
    expect(typeof out.id).toBe('string');
    expect(Object.keys(out).sort()).toEqual(expect.arrayContaining(['id', 'code', 'name', 'owner_kind', 'falls_through', 'assignments', 'is_active', 'version', 'draft_version_id']));
    expect(out).not.toHaveProperty('tenant_id'); expect(out).not.toHaveProperty('created_by'); expect(out).not.toHaveProperty('current_version');
    const v = db.rows('price_list_versions', A);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ price_list_id: out.id, version_no: 1, status: 'draft', item_count: 0, effective_from: null });
    expect(out.draft_version_id).toBe(v[0]!.id);
    expect(db.rows('price_list_assignments', A)).toEqual([expect.objectContaining({ price_list_id: out.id, owner_kind: 'credit_party', credit_party_id: P1.id, doctor_id: null, centre_id: null })]);
    const ev = events(db);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.envelope.payload).toMatchObject({ catalog_revision: 418, entity_type: 'price_list', entity_id: out.id, change_kind: 'created' });
    expect(db.revisionOf(A)).toBe(418);
    expect(new Set(db.stmts.filter((s) => s.tenantId === A).map((s) => s.txId)).size).toBe(1);
  });

  it('AC-13.6: a tenant gets exactly ONE default list; owner_kind default takes no assignments; a second default (any code) -> 409 catalog.code_duplicate, nothing written', { timeout: T }, async () => {
    const { db, svc } = setup();
    const out = await create(db, svc, { code: 'DEFAULT', name: 'Walk-in', owner_kind: 'default', assignments: [] });
    expect(out).toMatchObject({ owner_kind: 'default', assignments: [], is_active: true });
    const before = snap(db); const evBefore = events(db).length;
    lims(await rejection(create(db, svc, { code: 'DEFAULT2', name: 'Another', owner_kind: 'default', assignments: [] })), 'catalog.code_duplicate', 409);
    expect(snap(db)).toBe(before); expect(events(db)).toHaveLength(evBefore);
    expect(db.rows('price_lists', A).filter((r) => r.owner_kind === 'default')).toHaveLength(1);
  });

  it('AC-13.6 is also a DB guarantee (partial unique index price_lists__tenant_id__default__p_uq) and per tenant: tenant B may have its own default', { timeout: T }, async () => {
    const { db, svc } = setup({ price_lists: [DEF] });
    expect(await sqlCode(sql(db, 'INSERT INTO catalog.price_lists (id, tenant_id, code, name, owner_kind, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $6)', [ID(0x9001), A, 'DEF9', 'x', 'default', USER]))).toBe('23505');
    const out = await create(db, svc, { code: 'DEFAULT', name: 'B default', owner_kind: 'default', assignments: [] }, { tenantId: B });
    expect(out.owner_kind).toBe('default');
  });

  it('a default list cannot carry assignments -> 400', { timeout: T }, async () => {
    const { db, svc } = setup();
    validation400(await rejection(create(db, svc, { code: 'DEFAULT', name: 'x', owner_kind: 'default', assignments: [{ owner_id: P1.id }] })));
    expect(db.rows('price_lists', A)).toHaveLength(0);
  });

  it('duplicate code -> 409 catalog.code_duplicate (case-insensitive: codes are trimmed and upper-cased); other tenants\' codes do not clash', { timeout: T }, async () => {
    const { db, svc } = setup({ price_lists: [LP, plist(8, B, { code: 'FREE1' })] });
    lims(await rejection(create(db, svc, { code: '  hosp1 ', name: 'Dup', owner_kind: 'centre', assignments: [] })), 'catalog.code_duplicate', 409);
    expect((await create(db, svc, { code: ' free1 ', name: 'Fine', owner_kind: 'centre', assignments: [] })).code).toBe('FREE1');
  });

  it.each([['lowercase-only invalid chars', 'bad code!'], ['starts with underscore', '_X'], ['33 chars', 'A'.repeat(33)], ['empty', '   ']])
  ('invalid code (%s) -> 400, nothing written', { timeout: T }, async (_n, code) => {
    const { db, svc } = setup();
    validation400(await rejection(create(db, svc, { code, name: 'x', owner_kind: 'centre', assignments: [] })));
    expect(db.rows('price_lists', A)).toHaveLength(0);
  });

  it.each([
    ['blank name', { name: '   ' }], ['name 121 chars', { name: 'n'.repeat(121) }], ['unknown owner_kind', { owner_kind: 'vendor' }], ['missing assignments', { assignments: undefined }],
    ['assignments not an array', { assignments: 'x' }], ['assignment without owner_id', { assignments: [{}] }], ['assignment owner_id not a uuid', { assignments: [{ owner_id: 'nope' }] }],
    ['falls_through not boolean', { falls_through: 'yes' }], ['body not an object', null],
  ])('validation: %s -> 400', { timeout: T }, async (_n, patch) => {
    const { db, svc } = setup();
    const base = { code: 'OK1', name: 'x', owner_kind: 'centre', assignments: [] };
    const body = patch === null ? ['not', 'an', 'object'] : { ...base, ...patch };
    validation400(await rejection(create(db, svc, body as object)));
    expect(db.rows('price_lists', A)).toHaveLength(0);
  });

  it('S-5 / AB-10: server-owned or unknown fields (tenant_id, id, version, is_active, status, current_version, created_by) -> 400, nothing written', { timeout: T }, async () => {
    const { db, svc } = setup();
    for (const extra of [{ tenant_id: B }, { id: ID(0xbad) }, { version: 9 }, { is_active: false }, { status: 'published' }, { current_version: {} }, { created_by: B }, { unit_price: 5 }]) {
      validation400(await rejection(create(db, svc, { code: 'OK1', name: 'x', owner_kind: 'centre', assignments: [], ...extra })));
    }
    expect(snap(db)).toBe(JSON.stringify([[], [], [], []]));
  });

  it('AC-13.7: assignments of owner_kind referrer / credit_party / centre are stored in the matching column; falls_through=false is kept', { timeout: T }, async () => {
    const { db, svc } = setup();
    const r = await create(db, svc, { code: 'DOCS', name: 'Doctor list', owner_kind: 'referrer', falls_through: false, assignments: [{ owner_id: X.id }, { owner_id: Y.id }] });
    const c = await create(db, svc, { code: 'CENS', name: 'Centre list', owner_kind: 'centre', assignments: [{ owner_id: C1.id }] });
    expect(r.falls_through).toBe(false);
    expect(r.assignments.map((a: Row) => a.owner_id).sort()).toEqual([X.id, Y.id].sort());
    expect(c.assignments).toEqual([{ owner_id: C1.id }]);
    const rows = db.rows('price_list_assignments', A);
    expect(rows.filter((x) => x.owner_kind === 'referrer').map((x) => x.doctor_id).sort()).toEqual([X.id, Y.id].sort());
    expect(rows.find((x) => x.owner_kind === 'centre')).toMatchObject({ centre_id: C1.id, doctor_id: null, credit_party_id: null });
  });

  it.each([
    ['credit_party', 'credit_party', P1, 'party'], ['referrer', 'referrer', X, 'doctor'], ['centre', 'centre', C1, 'centre'],
  ])('AC-13.7: a second list for the same %s -> 409 catalog.code_duplicate; the failed create leaves NO list, version, assignment or event', { timeout: T }, async (_n, kind, owner) => {
    const first = plist(20, A, { owner_kind: kind, code: 'FIRST1' });
    const col = { credit_party: 'credit_party_id', referrer: 'doctor_id', centre: 'centre_id' }[kind as string]!;
    const { db, svc } = setup({ price_lists: [first], price_list_assignments: [passign(1, A, first.id as string, kind as never, owner.id as string)] });
    const before = snap(db);
    lims(await rejection(create(db, svc, { code: 'SECOND1', name: 'Second', owner_kind: kind, assignments: [{ owner_id: owner.id }] })), 'catalog.code_duplicate', 409);
    expect(snap(db)).toBe(before); expect(events(db)).toHaveLength(0); expect(db.revisionOf(A)).toBe(417);
    expect(db.rows('price_list_assignments', A).filter((r) => r[col] === owner.id)).toHaveLength(1);
  });

  it('duplicate owner ids inside one request -> 400 (never a half-created list)', { timeout: T }, async () => {
    const { db, svc } = setup();
    validation400(await rejection(create(db, svc, { code: 'DUP1', name: 'x', owner_kind: 'referrer', assignments: [{ owner_id: X.id }, { owner_id: X.id }] })));
    expect(snap(db)).toBe(JSON.stringify([[], [], [], []]));
  });

  it('assignments are capped at 500 -> 400', { timeout: T }, async () => {
    const { db, svc } = setup();
    validation400(await rejection(create(db, svc, { code: 'BIG1', name: 'x', owner_kind: 'centre', assignments: Array.from({ length: 501 }, (_, i) => ({ owner_id: ID(0x5000 + i) })) })));
    expect(db.rows('price_lists', A)).toHaveLength(0);
  });

  it.each([
    ['tenant-B centre', 'centre', CB], ['tenant-B doctor', 'referrer', XB], ['tenant-B credit party', 'credit_party', PB], ['unknown centre id', 'centre', { id: ID(0xdead) }],
    ['unknown doctor id', 'referrer', { id: ID(0xdeae) }],
  ])('AB-3 / S-3: assigning a %s -> 404 common.not_found (service check; the composite FK is only the backstop); nothing written; no tenant-B value in the error', { timeout: T }, async (_n, kind, owner) => {
    const { db, svc } = setup({ price_lists: [LB] });
    const e = await rejection(create(db, svc, { code: 'LEAK1', name: 'x', owner_kind: kind, assignments: [{ owner_id: (owner as Row).id }] }));
    lims(e, 'common.not_found', 404);
    expect(JSON.stringify([e.message, e.detail, e.errors])).not.toMatch(/DRB1|BSECRET|Synthetic Party 9|Synthetic Centre 9/);
    expect(db.rows('price_lists', A)).toHaveLength(0); expect(db.rows('price_list_assignments', A)).toHaveLength(0);
    expect(events(db)).toHaveLength(0);
  });

  it('a mix of valid and tenant-B owner ids is rejected as a whole (no partial assignment set)', { timeout: T }, async () => {
    const { db, svc } = setup();
    lims(await rejection(create(db, svc, { code: 'MIX1', name: 'x', owner_kind: 'referrer', assignments: [{ owner_id: X.id }, { owner_id: XB.id }] })), 'common.not_found', 404);
    expect(db.rows('price_list_assignments')).toHaveLength(0);
  });

  it('rolled-back transaction leaves nothing (atomic): list, v1 draft, assignments and the event/revision go together', { timeout: T }, async () => {
    const { db, svc } = setup();
    await expect(db.run((ctx) => svc['createPriceList']!(ctx, { code: 'RB1', name: 'x', owner_kind: 'centre', assignments: [{ owner_id: C1.id }] }), { at: NOW, rollback: true })).rejects.toThrow('forced rollback');
    expect(snap(db)).toBe(JSON.stringify([[], [], [], []])); expect(db.revisionOf(A)).toBe(417); expect(events(db)).toHaveLength(0);
  });

  it('a DB failure on the version insert rolls the whole create back (no orphan list)', { timeout: T }, async () => {
    const { db, svc } = setup();
    db.fail(/INSERT INTO catalog\.price_list_versions/i);
    await rejection(create(db, svc, { code: 'FAIL1', name: 'x', owner_kind: 'centre', assignments: [] }));
    expect(db.rows('price_lists', A)).toHaveLength(0); expect(events(db)).toHaveLength(0);
  });

  it('concurrent creates of the same code: one 201, the other 409 catalog.code_duplicate (unique violation mapped, never 500)', { timeout: T }, async () => {
    const { db, svc } = setup();
    const r = await Promise.allSettled([1, 2, 3].map(() => create(db, svc, { code: 'RACE1', name: 'x', owner_kind: 'centre', assignments: [] })));
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    for (const x of r.filter((y) => y.status === 'rejected') as PromiseRejectedResult[]) lims(x.reason, 'catalog.code_duplicate', 409);
    expect(db.rows('price_lists', A)).toHaveLength(1);
  });

  it('concurrent creates of a second default list: exactly one wins', { timeout: T }, async () => {
    const { db, svc } = setup();
    const r = await Promise.allSettled(['D1', 'D2', 'D3'].map((code) => create(db, svc, { code, name: 'x', owner_kind: 'default', assignments: [] })));
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    for (const x of r.filter((y) => y.status === 'rejected') as PromiseRejectedResult[]) lims(x.reason, 'catalog.code_duplicate', 409);
    expect(db.rows('price_lists', A).filter((l) => l.owner_kind === 'default')).toHaveLength(1);
  });

  it('concurrent creates racing for the same doctor: exactly one wins (AC-13.7)', { timeout: T }, async () => {
    const { db, svc } = setup();
    const r = await Promise.allSettled(['R1', 'R2'].map((code) => create(db, svc, { code, name: 'x', owner_kind: 'referrer', assignments: [{ owner_id: X.id }] })));
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    for (const x of r.filter((y) => y.status === 'rejected') as PromiseRejectedResult[]) lims(x.reason, 'catalog.code_duplicate', 409);
    expect(db.rows('price_list_assignments', A)).toHaveLength(1); expect(db.rows('price_lists', A)).toHaveLength(1);
  });
});

// ====================================================================================================== list / get (#71, #73)
describe('listPriceLists (#71) and getPriceListDetail (#73)', () => {
  const W = () => setup({
    price_lists: [DEF, LP, LR, LC, plist(5, A, { owner_kind: 'centre', code: 'OLDC', is_active: false }), LB],
    price_list_assignments: [passign(1, A, LP.id as string, 'credit_party', P1.id as string), passign(2, A, LR.id as string, 'referrer', X.id as string), passign(3, A, LC.id as string, 'centre', C1.id as string)],
  });
  const codes = (r: { data: Row[] }) => r.data.map((d) => d.code).sort();

  it('default: active lists of the caller\'s tenant only (tenant B\'s list is invisible); is_active=all adds inactive; page.limit echoed', { timeout: T }, async () => {
    const { db, svc } = W();
    const r = await list(db, svc);
    expect(codes(r)).toEqual(['CENT1', 'DEFAULT1', 'DOCX1', 'HOSP1']);
    expect(r.page).toMatchObject({ limit: 50 });
    expect(JSON.stringify(r)).not.toContain('BLIST');
    expect(codes(await list(db, svc, { is_active: 'all' }))).toEqual(['CENT1', 'DEFAULT1', 'DOCX1', 'HOSP1', 'OLDC']);
    expect(codes(await list(db, svc, { is_active: 'false' }))).toEqual(['OLDC']);
  });

  it('filters: owner_kind; owner_id = the list that owner is assigned to', { timeout: T }, async () => {
    const { db, svc } = W();
    expect(codes(await list(db, svc, { owner_kind: 'centre' }))).toEqual(['CENT1']);
    expect(codes(await list(db, svc, { owner_kind: 'default' }))).toEqual(['DEFAULT1']);
    expect(codes(await list(db, svc, { owner_id: X.id }))).toEqual(['DOCX1']);
    expect(codes(await list(db, svc, { owner_id: C1.id }))).toEqual(['CENT1']);
    expect(codes(await list(db, svc, { owner_id: ID(0xdead) }))).toEqual([]);
    expect(codes(await list(db, svc, { owner_id: XB.id }))).toEqual([]);
  });

  it('every item carries assignments[] (≤500) and ids/versions; cursor paging covers every list exactly once', { timeout: T }, async () => {
    const { db, svc } = W();
    const all = await list(db, svc, { is_active: 'all' });
    expect(all.data.find((d: Row) => d.code === 'HOSP1')).toMatchObject({ assignments: [{ owner_id: P1.id }], owner_kind: 'credit_party', version: 1 });
    expect(all.data.find((d: Row) => d.code === 'DEFAULT1')).toMatchObject({ assignments: [] });
    const seen: string[] = []; let cursor: string | undefined;
    for (let i = 0; i < 6; i++) {
      const p = await list(db, svc, { is_active: 'all', limit: 2, ...(cursor ? { cursor } : {}) });
      expect(p.data.length).toBeLessThanOrEqual(2); seen.push(...p.data.map((d: Row) => d.id));
      cursor = p.page.next_cursor; if (!cursor) break;
    }
    expect(seen.sort()).toEqual(all.data.map((d: Row) => d.id).sort());
    expect(new Set(seen).size).toBe(seen.length);
  });

  it.each([{ limit: 0 }, { limit: 201 }, { owner_kind: 'vendor' }, { is_active: 'maybe' }, { cursor: '!!!' }, { owner_id: 'not-a-uuid' }])('bad query %j -> 400', { timeout: T }, async (query) => {
    const { db, svc } = W();
    validation400(await rejection(list(db, svc, query)));
  });

  it('detail: the list + versions[] (newest first) with current_version / scheduled_version / draft_version_id derived from the windows at "now"', { timeout: T }, async () => {
    const v1 = pver(1, A, LP.id as string, 1, { status: 'superseded', effective_to: iso(new Date('2026-06-01T00:00:00.000Z')), item_count: 2 });
    const v2 = pver(2, A, LP.id as string, 2, { status: 'published', effective_from: new Date('2026-06-01T00:00:00.000Z'), item_count: 2 });
    const v3 = pver(3, A, LP.id as string, 3, { status: 'published', effective_from: FUTURE, item_count: 2 });
    const v2b = { ...v2, effective_to: FUTURE };
    const v4 = pver(4, A, LP.id as string, 4);
    const { db, svc } = setup({ price_lists: [DEF, LP], price_list_versions: [v1, v2b, v3, v4], price_list_assignments: [passign(1, A, LP.id as string, 'credit_party', P1.id as string)] });
    const out = await getD(db, svc, LP.id as string);
    expect(out).toMatchObject({ id: LP.id, code: 'HOSP1', assignments: [{ owner_id: P1.id }], draft_version_id: v4.id, is_active: true, version: 1 });
    expect(out.current_version).toMatchObject({ id: v2.id, version_no: 2 });
    expect(ms(out.current_version.effective_from)).toBe(new Date('2026-06-01T00:00:00.000Z').getTime());
    expect(out.scheduled_version).toMatchObject({ id: v3.id, version_no: 3 });
    expect(ms(out.scheduled_version.effective_from)).toBe(FUTURE.getTime());
    expect(out.versions.map((v: Row) => v.version_no)).toEqual([4, 3, 2, 1]);
    expect(out.versions.find((v: Row) => v.version_no === 4)).toMatchObject({ status: 'draft', item_count: 0, price_list_id: LP.id });
    expect(out.versions.find((v: Row) => v.version_no === 1)).toMatchObject({ status: 'superseded' });
    expect(out.versions.find((v: Row) => v.version_no === 1)).toHaveProperty('effective_to');
  });

  it('detail of a list with no published version has no current_version / scheduled_version; versions[] is capped at 50', { timeout: T }, async () => {
    const vs = Array.from({ length: 55 }, (_, i) => pver(100 + i, A, LP.id as string, i + 1, { status: i === 54 ? 'draft' : 'discarded' }));
    const { db, svc } = setup({ price_lists: [LP], price_list_versions: vs });
    const out = await getD(db, svc, LP.id as string);
    expect(out).not.toHaveProperty('current_version'); expect(out).not.toHaveProperty('scheduled_version');
    expect(out.versions).toHaveLength(50);
    expect(out.versions[0]).toMatchObject({ version_no: 55, status: 'draft' });
  });

  it('S-1: tenant B\'s list id and an unknown id -> 404; a non-uuid id -> 400; B\'s data never appears', { timeout: T }, async () => {
    const { db, svc } = W();
    for (const id of [LB.id, ID(0xdead)]) lims(await rejection(getD(db, svc, id as string)), 'common.not_found', 404);
    validation400(await rejection(getD(db, svc, 'nope')));
    expect(JSON.stringify(await getD(db, svc, LB.id as string, B))).toContain('BLIST');           // control: B sees its own
  });
});

// ====================================================================================================== updatePriceList (#74)
describe('updatePriceList (#74)', () => {
  const W = () => setup({ price_lists: [DEF, LP, { ...LR, version: 3 }, LB] });

  it('name / falls_through / is_active -> PriceList, version+1, one event; update -> `updated`, is_active:false -> `deactivated` (entity_id = list id)', { timeout: T }, async () => {
    const { db, svc } = W();
    const out = await upd(db, svc, LP.id as string, 1, { name: 'Renamed', falls_through: false });
    expect(out).toMatchObject({ id: LP.id, name: 'Renamed', falls_through: false, version: 2, code: 'HOSP1', owner_kind: 'credit_party', is_active: true });
    expect(db.row('price_lists', LP.id as string)).toMatchObject({ name: 'Renamed', falls_through: false, version: 2, updated_by: USER });
    expect(payloads(db)).toEqual([expect.objectContaining({ catalog_revision: 418, entity_type: 'price_list', entity_id: LP.id, change_kind: 'updated' })]);
    const off = await upd(db, svc, LP.id as string, 2, { is_active: false });
    expect(off).toMatchObject({ is_active: false, version: 3 });
    expect(payloads(db).at(-1)).toMatchObject({ entity_type: 'price_list', entity_id: LP.id, change_kind: 'deactivated', catalog_revision: 419 });
    const on = await upd(db, svc, LP.id as string, 3, { is_active: true });
    expect(on.is_active).toBe(true);
    expect(db.revisionOf(A)).toBe(420);
  });

  it('E22: the DEFAULT list cannot be deactivated -> 400 common.validation_failed (path /is_active); row, version and events unchanged', { timeout: T }, async () => {
    const { db, svc } = W();
    const e = await rejection(upd(db, svc, DEF.id as string, 1, { is_active: false }));
    validation400(e);
    expect(db.row('price_lists', DEF.id as string)).toMatchObject({ is_active: true, version: 1 });
    expect(events(db)).toHaveLength(0);
  });

  it('the default list can still be renamed / have falls_through changed', { timeout: T }, async () => {
    const { db, svc } = W();
    expect(await upd(db, svc, DEF.id as string, 1, { name: 'Walk-in prices' })).toMatchObject({ name: 'Walk-in prices', is_active: true, owner_kind: 'default' });
  });

  it('If-Match: missing -> 428 common.precondition_required; stale -> 409 common.version_conflict; nothing written either way', { timeout: T }, async () => {
    const { db, svc } = W();
    lims(await rejection(upd(db, svc, LR.id as string, undefined, { name: 'x' })), 'common.precondition_required', 428);
    lims(await rejection(upd(db, svc, LR.id as string, 2, { name: 'x' })), 'common.version_conflict', 409);
    expect(db.row('price_lists', LR.id as string)).toMatchObject({ version: 3, name: 'Synthetic List 3' });
    expect(events(db)).toHaveLength(0);
    expect(await upd(db, svc, LR.id as string, 3, { name: 'ok' })).toMatchObject({ version: 4 });
  });

  it('two writers with the same If-Match: exactly one succeeds, the other gets 409 common.version_conflict', { timeout: T }, async () => {
    const { db, svc } = W();
    const r = await Promise.allSettled([upd(db, svc, LP.id as string, 1, { name: 'A1' }), upd(db, svc, LP.id as string, 1, { name: 'A2' })]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    lims((r.find((x) => x.status === 'rejected') as PromiseRejectedResult).reason, 'common.version_conflict', 409);
    expect(db.row('price_lists', LP.id as string)!.version).toBe(2);
  });

  it.each([
    ['code', { code: 'NEWCODE' }], ['owner_kind', { owner_kind: 'centre' }], ['tenant_id', { tenant_id: B }], ['version', { version: 9 }], ['id', { id: ID(0xbad) }],
    ['assignments', { assignments: [] }], ['draft_version_id', { draft_version_id: ID(1) }], ['created_by', { created_by: B }],
  ])('S-5: immutable / server-owned field %s in PATCH -> 400, nothing written', { timeout: T }, async (_n, patch) => {
    const { db, svc } = W();
    validation400(await rejection(upd(db, svc, LP.id as string, 1, patch)));
    expect(db.row('price_lists', LP.id as string)).toMatchObject({ code: 'HOSP1', owner_kind: 'credit_party', version: 1 });
    expect(events(db)).toHaveLength(0);
  });

  it.each([['blank name', { name: '  ' }], ['name 121 chars', { name: 'n'.repeat(121) }], ['falls_through string', { falls_through: 'no' }], ['is_active string', { is_active: 'false' }], ['null name', { name: null }]])
  ('validation: %s -> 400', { timeout: T }, async (_n, patch) => {
    const { db, svc } = W();
    validation400(await rejection(upd(db, svc, LP.id as string, 1, patch)));
    expect(db.row('price_lists', LP.id as string)!.version).toBe(1);
  });

  it('S-1: tenant B\'s list / unknown id -> 404 and B\'s row is untouched', { timeout: T }, async () => {
    const { db, svc } = W();
    for (const id of [LB.id, ID(0xdead)]) lims(await rejection(upd(db, svc, id as string, 1, { name: 'hijack' })), 'common.not_found', 404);
    expect(db.row('price_lists', LB.id as string)).toMatchObject({ name: 'Synthetic List 9', version: 1 });
    expect(events(db)).toHaveLength(0);
  });
});

// ====================================================================================================== replacePriceListAssignments (#75)
describe('replacePriceListAssignments (#75) — AC-13.7, AB-3', () => {
  const LR2 = plist(6, A, { owner_kind: 'referrer', code: 'DOCY1' });
  const W = () => setup({
    price_lists: [DEF, LR, LR2, LC, LB],
    price_list_assignments: [passign(1, A, LR.id as string, 'referrer', X.id as string), passign(3, A, LC.id as string, 'centre', C1.id as string)],
  });
  const owners = (db: Db, id: string) => db.rows('price_list_assignments', A).filter((a) => a.price_list_id === id).map((a) => a.doctor_id ?? a.centre_id ?? a.credit_party_id).sort();

  it('replaces the set: adds Y, keeps X, drops nothing -> PriceList with the new assignments; version+1; event `updated` for the LIST id', { timeout: T }, async () => {
    const { db, svc } = W();
    const out = await assign(db, svc, LR.id as string, 1, [X.id, Y.id]);
    expect(out.assignments.map((a: Row) => a.owner_id).sort()).toEqual([X.id, Y.id].sort());
    expect(out).toMatchObject({ id: LR.id, version: 2 });
    expect(owners(db, LR.id as string)).toEqual([X.id, Y.id].sort());
    expect(payloads(db)).toEqual([expect.objectContaining({ entity_type: 'price_list', entity_id: LR.id, change_kind: 'updated', catalog_revision: 418 })]);
  });

  it('removing owners deletes their assignment rows; an empty set clears the list; the list itself stays', { timeout: T }, async () => {
    const { db, svc } = W();
    await assign(db, svc, LR.id as string, 1, [X.id, Y.id]);
    const out = await assign(db, svc, LR.id as string, 2, [Y.id]);
    expect(out.assignments).toEqual([{ owner_id: Y.id }]);
    expect(owners(db, LR.id as string)).toEqual([Y.id]);
    expect((await assign(db, svc, LR.id as string, 3, [])).assignments).toEqual([]);
    expect(owners(db, LR.id as string)).toEqual([]);
    expect(db.row('price_lists', LR.id as string)).toMatchObject({ is_active: true });
  });

  it('centre lists take centre ids, credit-party lists credit-party ids (the list\'s owner_kind decides the column)', { timeout: T }, async () => {
    const { db, svc } = W();
    expect((await assign(db, svc, LC.id as string, 1, [C1.id, C2.id])).assignments.map((a: Row) => a.owner_id).sort()).toEqual([C1.id, C2.id].sort());
    lims(await rejection(assign(db, svc, LC.id as string, 2, [X.id])), 'common.not_found', 404);          // a doctor id is not a centre in this tenant
  });

  it('AC-13.7: an owner that already has ANOTHER list -> 409 catalog.code_duplicate; the replace is atomic (nothing changed, no event)', { timeout: T }, async () => {
    const { db, svc } = W();
    const before = snap(db);
    lims(await rejection(assign(db, svc, LR2.id as string, 1, [Y.id, X.id])), 'catalog.code_duplicate', 409);   // Y is free, X belongs to LR
    expect(snap(db)).toBe(before); expect(events(db)).toHaveLength(0); expect(owners(db, LR2.id as string)).toEqual([]);
  });

  it('moving an owner: remove it from list 1, then add it to list 2 (works; at most one list at any time)', { timeout: T }, async () => {
    const { db, svc } = W();
    await assign(db, svc, LR.id as string, 1, []);
    await assign(db, svc, LR2.id as string, 1, [X.id]);
    expect(owners(db, LR.id as string)).toEqual([]); expect(owners(db, LR2.id as string)).toEqual([X.id]);
  });

  it('re-sending the same set is accepted (idempotent): same assignments afterwards, no duplicate rows', { timeout: T }, async () => {
    const { db, svc } = W();
    const out = await assign(db, svc, LR.id as string, 1, [X.id]);
    expect(out.assignments).toEqual([{ owner_id: X.id }]);
    expect(db.rows('price_list_assignments', A).filter((a) => a.doctor_id === X.id)).toHaveLength(1);
  });

  it.each([['tenant-B doctor', XB.id], ['unknown doctor', ID(0xdead)]])
  ('AB-3 / S-3: %s in owner_ids -> 404 common.not_found (service check), assignments unchanged, no event', { timeout: T }, async (_n, bad) => {
    const { db, svc } = W();
    const before = snap(db);
    const e = await rejection(assign(db, svc, LR.id as string, 1, [Y.id, bad]));
    lims(e, 'common.not_found', 404);
    expect(JSON.stringify([e.message, e.detail, e.errors])).not.toMatch(/DRB1|Dr Seed 9/);
    expect(snap(db)).toBe(before); expect(events(db)).toHaveLength(0);
  });

  it('AB-3 / S-3: tenant-B centre id in a centre list -> 404; and the DB backstop: the composite FK rejects it even if the service check were bypassed (23503)', { timeout: T }, async () => {
    const { db, svc } = W();
    lims(await rejection(assign(db, svc, LC.id as string, 1, [CB.id])), 'common.not_found', 404);
    expect(owners(db, LC.id as string)).toEqual([C1.id]);
    const raw = (col: string, id: string, kind: string, list: string) => sql(db, `INSERT INTO catalog.price_list_assignments (id, tenant_id, price_list_id, owner_kind, ${col}, created_by) VALUES ($1, $2, $3, $4, $5, $6)`, [ID(0x9100 + Math.floor(Math.random() * 999)), A, list, kind, id, USER]);
    expect(await sqlCode(raw('centre_id', CB.id as string, 'centre', LC.id as string))).toBe('23503');
    expect(await sqlCode(raw('doctor_id', XB.id as string, 'referrer', LR.id as string))).toBe('23503');
  });

  it('the default list takes no assignments (non-empty owner_ids -> 400); tenant B\'s list id -> 404', { timeout: T }, async () => {
    const { db, svc } = W();
    validation400(await rejection(assign(db, svc, DEF.id as string, 1, [C1.id])));
    lims(await rejection(assign(db, svc, LB.id as string, 1, [P1.id])), 'common.not_found', 404);
    expect(db.rows('price_list_assignments', A)).toHaveLength(2);
  });

  it.each([['not an array', 'x'], ['non-uuid member', ['nope']], ['duplicate members', [Y.id, Y.id]], ['501 members', Array.from({ length: 501 }, (_, i) => ID(0x6000 + i))]])
  ('validation: owner_ids %s -> 400, nothing written', { timeout: T }, async (_n, owner_ids) => {
    const { db, svc } = W();
    const before = snap(db);
    validation400(await rejection(assign(db, svc, LR.id as string, 1, owner_ids)));
    expect(snap(db)).toBe(before);
  });

  it('body keys other than owner_ids (tenant_id, assignments) -> 400', { timeout: T }, async () => {
    const { db, svc } = W();
    for (const body of [{ owner_ids: [], tenant_id: B }, { assignments: [] }, {}]) validation400(await rejection(db.run((ctx) => svc['replacePriceListAssignments']!(ctx, { id: LR.id, expectedVersion: 1, body }), { at: NOW })));
  });

  it('If-Match: missing -> 428; stale -> 409 common.version_conflict', { timeout: T }, async () => {
    const { db, svc } = W();
    lims(await rejection(assign(db, svc, LR.id as string, undefined, [])), 'common.precondition_required', 428);
    lims(await rejection(assign(db, svc, LR.id as string, 7, [])), 'common.version_conflict', 409);
    expect(owners(db, LR.id as string)).toEqual([X.id]);
  });

  it('concurrent replaces racing for the same free doctor on two lists: exactly one wins', { timeout: T }, async () => {
    const { db, svc } = W();
    const r = await Promise.allSettled([assign(db, svc, LR.id as string, 1, [X.id, Y.id]), assign(db, svc, LR2.id as string, 1, [Y.id])]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    for (const x of r.filter((y) => y.status === 'rejected') as PromiseRejectedResult[]) expect(['catalog.code_duplicate', 'common.version_conflict']).toContain(x.reason.code);
    expect(db.rows('price_list_assignments', A).filter((a) => a.doctor_id === Y.id)).toHaveLength(1);
  });
});

// ====================================================================================================== createPriceListVersionDraft (#76)
describe('createPriceListVersionDraft (#76) — V1, AC-13.4, E2', () => {
  it('copies the latest published version into a new draft v2: version_no = max+1, status draft, items copied with NEW ids, item_count; no event, no revision bump (drafts are invisible)', { timeout: T }, async () => {
    const { db, svc } = withPublished();
    const out = await draftOf(db, svc, LP.id as string);
    expect(out).toMatchObject({ price_list_id: LP.id, version_no: 2, status: 'draft', item_count: 2, version: 1 });
    expect(out).not.toHaveProperty('effective_from'); expect(out).not.toHaveProperty('change_reason');
    expect(itemRows(db, out.id).map((r) => [r.orderable_id, Number(r.unit_price_paisa)]).sort()).toEqual([[O1.id, 90_000], [O2.id, 50_000]].sort());
    expect(itemRows(db, V1.id as string)).toHaveLength(2);
    const ids = new Set(db.rows('price_list_items', A).map((r) => r.id));
    expect(ids.size).toBe(4);
    expect(events(db)).toHaveLength(0); expect(db.revisionOf(A)).toBe(417);
    expect(db.row('price_list_versions', V1.id as string)).toMatchObject({ status: 'published', version: 1 });                 // the source is untouched
  });

  it('E2 / V1: a second draft while one is open -> 409 common.version_conflict; two concurrent creates -> exactly one 201', { timeout: T }, async () => {
    const { db, svc } = withPublished();
    const r = await Promise.allSettled([draftOf(db, svc, LP.id as string), draftOf(db, svc, LP.id as string), draftOf(db, svc, LP.id as string)]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    for (const x of r.filter((y) => y.status === 'rejected') as PromiseRejectedResult[]) lims(x.reason, 'common.version_conflict', 409);
    lims(await rejection(draftOf(db, svc, LP.id as string)), 'common.version_conflict', 409);
    expect(db.rows('price_list_versions', A).filter((v) => v.status === 'draft')).toHaveLength(1);
    expect(db.rows('price_list_items', A)).toHaveLength(4);                                    // only one copy was made
  });

  it('a list created through #72 already owns the empty draft v1 -> a second draft is 409 until v1 is discarded', { timeout: T }, async () => {
    const { db, svc } = setup();
    const l = await create(db, svc, { code: 'NEW1', name: 'x', owner_kind: 'centre', assignments: [] });
    lims(await rejection(draftOf(db, svc, l.id)), 'common.version_conflict', 409);
    await discard(db, svc, l.draft_version_id, 1);
    expect(await draftOf(db, svc, l.id)).toMatchObject({ version_no: 2, status: 'draft', item_count: 0 });
  });

  it('copy_from_version_no copies that version (also a superseded one); default = the latest published', { timeout: T }, async () => {
    const v1 = pver(1, A, LP.id as string, 1, { status: 'superseded', effective_to: iso(new Date('2026-06-01T00:00:00.000Z')) });
    const v2 = pver(2, A, LP.id as string, 2, { status: 'published', effective_from: new Date('2026-06-01T00:00:00.000Z') });
    const mk = () => setup({ price_lists: [LP], price_list_versions: [v1, v2], price_list_items: [
      pitem(1, A, v1.id as string, O1.id as string, 100), pitem(2, A, v2.id as string, O1.id as string, 200), pitem(3, A, v2.id as string, O2.id as string, 300)] });
    const a = mk(); const d1 = await draftOf(a.db, a.svc, LP.id as string, { copy_from_version_no: 1 });
    expect(d1).toMatchObject({ version_no: 3, item_count: 1 }); expect(priceOf(a.db, d1.id, O1.id as string)).toBe(100);
    const b = mk(); const d2 = await draftOf(b.db, b.svc, LP.id as string);
    expect(d2).toMatchObject({ version_no: 3, item_count: 2 }); expect(priceOf(b.db, d2.id, O1.id as string)).toBe(200);
  });

  it('with no published version (all discarded) the draft starts empty at max+1', { timeout: T }, async () => {
    const { db, svc } = setup({ price_lists: [LP], price_list_versions: [pver(1, A, LP.id as string, 1, { status: 'discarded' })] });
    expect(await draftOf(db, svc, LP.id as string)).toMatchObject({ version_no: 2, status: 'draft', item_count: 0 });
  });

  it('unknown / foreign copy_from_version_no, bad body -> 4xx (400 or 404), nothing created', { timeout: T }, async () => {
    const { db, svc } = withPublished();
    for (const body of [{ copy_from_version_no: 99 }, { copy_from_version_no: 0 }, { copy_from_version_no: 'x' }, { copy_from_version_no: 1.5 }, { tenant_id: B }, { status: 'published' }]) {
      const e = await rejection(draftOf(db, svc, LP.id as string, body));
      expect([400, 404], JSON.stringify(body)).toContain(e.statusCode);
    }
    expect(db.rows('price_list_versions', A)).toHaveLength(1);
  });

  it('S-1: tenant B\'s list / unknown list -> 404, zero rows created; a non-uuid id -> 400', { timeout: T }, async () => {
    const { db, svc } = setup({ price_lists: [LP, LB], price_list_versions: [V1] });
    for (const id of [LB.id, ID(0xdead)]) lims(await rejection(draftOf(db, svc, id as string)), 'common.not_found', 404);
    validation400(await rejection(draftOf(db, svc, 'nope')));
    expect(db.rows('price_list_versions')).toHaveLength(1);
  });
});

// ====================================================================================================== items: list / upsert / remove (#77–#79)
describe('price items — listPriceListItems (#77), upsertPriceListItems (#78), removePriceListItems (#79) — AC-13.4, AC-13.8, AB-1, AB-2', () => {
  const D2 = pver(2, A, LP.id as string, 2);                                                        // draft v2 next to published v1
  const W = () => setup({
    price_lists: [DEF, LP, LB], price_list_versions: [V1, D2, pver(9, B, LB.id as string, 1)],
    price_list_items: [pitem(1, A, V1.id as string, O1.id as string, 90_000), pitem(2, A, V1.id as string, O2.id as string, 50_000), pitem(3, A, D2.id as string, O1.id as string, 91_000)],
  });
  const BV = pver(9, B, LB.id as string, 1);

  it('upsert on a draft: created / updated / unchanged per row, prices stored as integer paisa, item_count follows; NO event and NO revision bump (draft edit)', { timeout: T }, async () => {
    const { db, svc } = W();
    const out = await upsert(db, svc, D2.id as string, [[O1.id as string, 91_000], [O2.id as string, 55_000], [O3.id as string, 0]]);
    expect(out.results.map((r: Row) => [r.orderable_id, r.outcome]).sort()).toEqual([[O1.id, 'unchanged'], [O2.id, 'created'], [O3.id, 'created']].sort());
    const again = await upsert(db, svc, D2.id as string, [[O1.id as string, 92_000], [O2.id as string, 55_000]]);
    expect(Object.fromEntries(again.results.map((r: Row) => [r.orderable_id, r.outcome]))).toEqual({ [O1.id as string]: 'updated', [O2.id as string]: 'unchanged' });
    expect(Number(priceOf(db, D2.id as string, O1.id as string))).toBe(92_000);
    expect(Number(priceOf(db, D2.id as string, O3.id as string))).toBe(0);
    expect(itemRows(db, D2.id as string)).toHaveLength(3);
    expect(db.row('price_list_versions', D2.id as string)!.item_count).toBe(3);
    expect(events(db)).toHaveLength(0); expect(db.revisionOf(A)).toBe(417);
    for (const r of [...out.results, ...again.results]) expect(r).not.toHaveProperty('error_code');
  });

  it('AC-13.4: a PUBLISHED version\'s items cannot be upserted or removed -> 409 catalog.version_in_use; superseded and discarded likewise; zero rows change', { timeout: T }, async () => {
    const sup = pver(3, A, LP.id as string, 3, { status: 'superseded', effective_to: iso(FUTURE) });
    const dis = pver(4, A, LP.id as string, 4, { status: 'discarded' });
    const { db, svc } = setup({ price_lists: [LP], price_list_versions: [V1, sup, dis], price_list_items: [pitem(1, A, V1.id as string, O1.id as string, 90_000), pitem(2, A, sup.id as string, O1.id as string, 80_000)] });
    const before = snap(db);
    for (const v of [V1, sup, dis]) {
      lims(await rejection(upsert(db, svc, v.id as string, [[O1.id as string, 1], [O2.id as string, 2]])), 'catalog.version_in_use', 409);
      lims(await rejection(remove(db, svc, v.id as string, [O1.id as string])), 'catalog.version_in_use', 409);
    }
    expect(snap(db)).toBe(before);
  });

  it('AB-2: a batch mixing tenant-A and tenant-B orderable ids -> per-row error common.not_found for the B / unknown ids, the A rows are applied; nothing is created for B', { timeout: T }, async () => {
    const { db, svc } = W();
    const out = await upsert(db, svc, D2.id as string, [[O2.id as string, 1_000], [OB.id as string, 2_000], [ID(0xdead), 3_000]]);
    const by = Object.fromEntries(out.results.map((r: Row) => [r.orderable_id, r]));
    expect(by[O2.id as string]).toMatchObject({ outcome: 'created' });
    expect(by[OB.id as string]).toMatchObject({ outcome: 'error', error_code: 'common.not_found' });
    expect(by[ID(0xdead)]).toMatchObject({ outcome: 'error', error_code: 'common.not_found' });
    expect(Number(priceOf(db, D2.id as string, O2.id as string))).toBe(1_000);
    expect(itemRows(db, D2.id as string).map((r) => r.orderable_id).sort()).toEqual([O1.id, O2.id].sort());
    expect(JSON.stringify(out)).not.toContain('BSECRET');
  });

  it('AB-1 / S-1: upsert, remove and list against tenant B\'s version id -> 404 common.not_found, zero rows changed in B, no leak', { timeout: T }, async () => {
    const { db, svc } = W();
    const before = JSON.stringify(db.rows('price_list_items'));
    lims(await rejection(upsert(db, svc, BV.id as string, [[O1.id as string, 5]])), 'common.not_found', 404);
    lims(await rejection(remove(db, svc, BV.id as string, [O1.id as string])), 'common.not_found', 404);
    lims(await rejection(items(db, svc, BV.id as string)), 'common.not_found', 404);
    lims(await rejection(upsert(db, svc, ID(0xdead), [[O1.id as string, 5]])), 'common.not_found', 404);
    expect(JSON.stringify(db.rows('price_list_items'))).toBe(before);
    expect(db.rows('price_list_items', B)).toHaveLength(0);
  });

  it.each([
    ['float', { amount_paisa: 12.5, currency: 'NPR' }], ['negative', { amount_paisa: -1, currency: 'NPR' }], ['above 999,999,999', { amount_paisa: 1_000_000_000, currency: 'NPR' }],
    ['numeric string', { amount_paisa: '100', currency: 'NPR' }], ['wrong currency', { amount_paisa: 100, currency: 'USD' }], ['bare string', '100'], ['array', [100]], ['null', null], ['NaN', { amount_paisa: Number.NaN, currency: 'NPR' }],
    ['Infinity', { amount_paisa: Number.POSITIVE_INFINITY, currency: 'NPR' }], ['extra key', { amount_paisa: 100, currency: 'NPR', rate: 1 }],
  ])('AC-13.8: unit_price %s is rejected (400, or a per-row error) and NO row with that price exists afterwards', { timeout: T }, async (_n, price) => {
    const { db, svc } = W();
    const r = await upsert(db, svc, D2.id as string, [[O2.id as string, price]]).then((x) => ({ ok: x }), (e) => ({ e }));
    if ('e' in r) validation400(r.e); else expect((r.ok as any).results[0]).toMatchObject({ orderable_id: O2.id, outcome: 'error' });
    expect(itemRows(db, D2.id as string).map((x) => x.orderable_id)).toEqual([O1.id]);
    expect(Number(priceOf(db, D2.id as string, O1.id as string))).toBe(91_000);
  });

  it('AC-13.8 boundaries: 0 and 999,999,999 paisa are accepted and stored exactly (integers, no float round-trip)', { timeout: T }, async () => {
    const { db, svc } = W();
    const out = await upsert(db, svc, D2.id as string, [[O2.id as string, 0], [O3.id as string, 999_999_999]]);
    expect(out.results.map((r: Row) => r.outcome)).toEqual(['created', 'created']);
    expect(Number(priceOf(db, D2.id as string, O3.id as string))).toBe(999_999_999);
    const listed = await items(db, svc, D2.id as string);
    expect(listed.data.find((i: Row) => i.orderable_id === O3.id).unit_price).toEqual({ amount_paisa: 999_999_999, currency: 'NPR' });
    expect(Number.isInteger(listed.data[0].unit_price.amount_paisa)).toBe(true);
  });

  it('batch limits: 0 rows and 201 rows -> 400; exactly 200 rows are accepted (E18)', { timeout: T }, async () => {
    const { db, svc } = W();
    validation400(await rejection(db.run((ctx) => svc['upsertPriceListItems']!(ctx, { versionId: D2.id, body: { items: [] } }), { at: NOW })));
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ orderable_id: ID(0x7000 + i), unit_price: money(1) }));
    validation400(await rejection(db.run((ctx) => svc['upsertPriceListItems']!(ctx, { versionId: D2.id, body: { items: many(201) } }), { at: NOW })));
    const ok = await db.run((ctx) => svc['upsertPriceListItems']!(ctx, { versionId: D2.id, body: { items: many(200) } }), { at: NOW });
    expect(ok.results).toHaveLength(200);                                                        // all unknown orderables -> per-row not_found, but the call itself succeeds
    expect(ok.results.every((r: Row) => r.outcome === 'error' && r.error_code === 'common.not_found')).toBe(true);
    validation400(await rejection(db.run((ctx) => svc['removePriceListItems']!(ctx, { versionId: D2.id, body: { ids: Array.from({ length: 201 }, (_, i) => ID(0x7000 + i)) } }), { at: NOW })));
    validation400(await rejection(db.run((ctx) => svc['removePriceListItems']!(ctx, { versionId: D2.id, body: { ids: [] } }), { at: NOW })));
  });

  it('S-5 / AB-10: unknown fields in the body or in an item (tenant_id, price, status, id) -> 400, nothing written', { timeout: T }, async () => {
    const { db, svc } = W();
    const before = snap(db);
    const call = (body: unknown) => db.run((ctx) => svc['upsertPriceListItems']!(ctx, { versionId: D2.id, body }), { at: NOW });
    validation400(await rejection(call({ items: [{ orderable_id: O2.id, unit_price: money(1), tenant_id: B }] })));
    validation400(await rejection(call({ items: [{ orderable_id: O2.id, unit_price: money(1), id: ID(1) }] })));
    validation400(await rejection(call({ items: [{ orderable_id: O2.id, unit_price: money(1) }], status: 'published' })));
    validation400(await rejection(call({ items: [{ orderable_id: O2.id, price: 5 }] })));
    validation400(await rejection(call({ items: [{ orderable_id: 'not-a-uuid', unit_price: money(1) }] })));
    validation400(await rejection(call({ items: 'x' })));
    expect(snap(db)).toBe(before);
  });

  it('the same orderable twice in ONE request is never 500 and never leaves two rows for it (400, or last-wins with one row)', { timeout: T }, async () => {
    const { db, svc } = W();
    const r = await upsert(db, svc, D2.id as string, [[O2.id as string, 100], [O2.id as string, 200]]).then((x) => ({ x }), (e) => ({ e }));
    if ('e' in r) validation400(r.e);
    expect(itemRows(db, D2.id as string).filter((x) => x.orderable_id === O2.id).length).toBeLessThanOrEqual(1);
    expect(db.rows('price_list_items', A).filter((x) => x.price_list_version_id === V1.id)).toHaveLength(2);
  });

  it('remove: ids are ORDERABLE ids; removed rows are gone, item_count follows, unknown / absent / tenant-B ids do not touch anything else; draft edit => no event', { timeout: T }, async () => {
    const { db, svc } = W();
    await upsert(db, svc, D2.id as string, [[O2.id as string, 5], [O3.id as string, 6]]);
    const out = await remove(db, svc, D2.id as string, [O2.id as string, OB.id as string, ID(0xdead)]);
    expect(out.results.map((r: Row) => r.orderable_id).sort()).toEqual([O2.id, OB.id, ID(0xdead)].sort());
    for (const r of out.results) expect(['created', 'updated', 'unchanged', 'error']).toContain(r.outcome);
    expect(itemRows(db, D2.id as string).map((r) => r.orderable_id).sort()).toEqual([O1.id, O3.id].sort());
    expect(db.row('price_list_versions', D2.id as string)!.item_count).toBe(2);
    expect(itemRows(db, V1.id as string)).toHaveLength(2);                                      // the published version is untouched
    expect(events(db)).toHaveLength(0);
  });

  it('list items: PriceItem {orderable_id, orderable_code, orderable_kind, unit_price{amount_paisa,currency}} sorted by orderable_code (asc default, -orderable_code desc); filter by orderable_kind; paging covers everything once; works for published versions too', { timeout: T }, async () => {
    const { db, svc } = W();
    await upsert(db, svc, D2.id as string, [[O2.id as string, 5], [O3.id as string, 6]]);
    const asc = await items(db, svc, D2.id as string);
    expect(asc.data.map((i: Row) => i.orderable_code)).toEqual(['CBC', 'FBS', 'LFT']);
    expect(asc.data[0]).toEqual({ orderable_id: O1.id, orderable_code: 'CBC', orderable_kind: 'test', unit_price: { amount_paisa: 91_000, currency: 'NPR' } });
    expect((await items(db, svc, D2.id as string, { sort: '-orderable_code' })).data.map((i: Row) => i.orderable_code)).toEqual(['LFT', 'FBS', 'CBC']);
    expect((await items(db, svc, D2.id as string, { orderable_kind: 'panel' })).data.map((i: Row) => i.orderable_code)).toEqual(['LFT']);
    expect((await items(db, svc, V1.id as string)).data.map((i: Row) => i.orderable_code)).toEqual(['CBC', 'FBS']);
    const p1 = await items(db, svc, D2.id as string, { limit: 2 });
    expect(p1.data).toHaveLength(2); expect(p1.page.next_cursor).toBeTruthy();
    const p2 = await items(db, svc, D2.id as string, { limit: 2, cursor: p1.page.next_cursor });
    expect([...p1.data, ...p2.data].map((i: Row) => i.orderable_code)).toEqual(['CBC', 'FBS', 'LFT']);
    for (const q of [{ orderable_kind: 'group' }, { sort: 'unit_price' }, { limit: 0 }, { limit: 201 }, { department_id: 'x' }]) validation400(await rejection(items(db, svc, D2.id as string, q)));
  });
});

// ====================================================================================================== publish (#80) — AC-13.3, AC-13.5, V4/V5, E1, E11, S-15
describe('publishPriceListVersion (#80) — AC-13.3, AC-13.5', () => {
  const V2 = pver(2, A, LP.id as string, 2, { status: 'published', effective_from: new Date('2026-06-01T00:00:00.000Z') });
  const V3 = pver(3, A, LP.id as string, 3, { version: 4 });                                        // draft v3 (row version 4 — If-Match must match it)
  const W = (extra: Record<string, Row[]> = {}) => setup({
    price_lists: [DEF, LP], price_list_versions: [{ ...pver(1, A, LP.id as string, 1, { status: 'superseded', effective_to: new Date('2026-06-01T00:00:00.000Z') }) }, V2, V3],
    price_list_items: [pitem(1, A, V2.id as string, O1.id as string, 90_000), pitem(2, A, V3.id as string, O1.id as string, 95_000), pitem(3, A, V3.id as string, O2.id as string, 50_000)], ...extra,
  });
  const V = (db: Db, id: string) => db.row('price_list_versions', id)!;

  it('AC-13.3: publish v3 with effective_from = T1 (future): v3 published [T1, ∞), v2 superseded with effective_to = T1 (windows touch, no gap/overlap), v1 untouched; items of v2 unchanged', { timeout: T }, async () => {
    const { db, svc } = W();
    const out = await publish(db, svc, V3.id as string, 4, { effective_from: iso(FUTURE), change_reason: REASON });
    expect(out).toMatchObject({ id: V3.id, price_list_id: LP.id, version_no: 3, status: 'published', change_reason: REASON, item_count: 2, version: 5 });
    expect(ms(out.effective_from)).toBe(FUTURE.getTime()); expect(out).not.toHaveProperty('effective_to');
    expect(V(db, V3.id as string)).toMatchObject({ status: 'published', change_reason: REASON, published_by: USER });
    expect(ms(V(db, V3.id as string).effective_from)).toBe(FUTURE.getTime()); expect(V(db, V3.id as string).effective_to).toBeNull();
    expect(ms(V(db, V3.id as string).published_at)).toBe(NOW.getTime());
    expect(V(db, V2.id as string)).toMatchObject({ status: 'superseded', version: 2 });
    expect(ms(V(db, V2.id as string).effective_to)).toBe(FUTURE.getTime());
    expect(ms(V(db, V2.id as string).effective_from)).toBe(new Date('2026-06-01T00:00:00.000Z').getTime());
    expect(V(db, ID(0xb01) /* seeded v1 */)).toMatchObject({ status: 'superseded' });
    expect(itemRows(db, V2.id as string).map((r) => [r.orderable_id, Number(r.unit_price_paisa)])).toEqual([[O1.id, 90_000]]);
    expect(itemRows(db, V3.id as string)).toHaveLength(2);
  });

  it('event: exactly ONE catalog.changed.v1 {entity_type price_list, entity_id = the LIST id (not the version id), change_kind versioned, effective_from = the version\'s}; revision +1; one transaction', { timeout: T }, async () => {
    const { db, svc } = W();
    await publish(db, svc, V3.id as string, 4, { effective_from: iso(FUTURE), change_reason: REASON });
    const ev = events(db);
    expect(ev).toHaveLength(1);
    const p = ev[0]!.envelope.payload as Record<string, any>;
    expect(p).toMatchObject({ catalog_revision: 418, entity_type: 'price_list', entity_id: LP.id, change_kind: 'versioned' });
    expect(ms(p['effective_from'])).toBe(FUTURE.getTime());
    expect(JSON.stringify(p)).not.toMatch(/90000|95000|unit_price|amount_paisa|Synthetic change reason/);                 // payload never carries prices (P0)
    expect(db.revisionOf(A)).toBe(418);
    expect(new Set(db.stmts.filter((s) => s.tenantId === A).map((s) => s.txId)).size).toBe(1);
  });

  it('effective_from defaults to the transaction time; the predecessor ends exactly then', { timeout: T }, async () => {
    const { db, svc } = W();
    const out = await publish(db, svc, V3.id as string, 4, { change_reason: REASON });
    expect(ms(out.effective_from)).toBe(NOW.getTime());
    expect(ms(V(db, V2.id as string).effective_to)).toBe(NOW.getTime());
  });

  it('AC-13.5: change_reason is required — missing, empty, whitespace-only, 501 chars, non-string -> 400 (path /change_reason); the version stays a draft; no event', { timeout: T }, async () => {
    const { db, svc } = W();
    for (const body of [{}, { change_reason: '' }, { change_reason: '   ' }, { change_reason: 'r'.repeat(501) }, { change_reason: 7 }, { change_reason: null }, { effective_from: iso(FUTURE) }]) {
      validation400(await rejection(publish(db, svc, V3.id as string, 4, body)));
    }
    expect(V(db, V3.id as string)).toMatchObject({ status: 'draft', version: 4 }); expect(V(db, V2.id as string).status).toBe('published');
    expect(events(db)).toHaveLength(0); expect(db.revisionOf(A)).toBe(417);
    expect(await publish(db, svc, V3.id as string, 4, { change_reason: 'r'.repeat(500) })).toMatchObject({ status: 'published' });      // 500 is fine
  });

  it('S-5 / AB-10: unknown body fields (status, tenant_id, version_no, published_by) -> 400', { timeout: T }, async () => {
    const { db, svc } = W();
    for (const extra of [{ status: 'published' }, { tenant_id: B }, { version_no: 9 }, { published_by: B }, { unit_price: 1 }]) {
      validation400(await rejection(publish(db, svc, V3.id as string, 4, { change_reason: REASON, ...extra })));
    }
    expect(V(db, V3.id as string).status).toBe('draft');
  });

  it('effective_from validation (S-15 / V4): older than now − 300 s -> 400 /effective_from; within the 300 s tolerance is accepted; not a date -> 400', { timeout: T }, async () => {
    for (const bad of [at(-301), new Date(NOW.getTime() - 40 * DAY)]) {
      const { db, svc } = W();
      validation400(await rejection(publish(db, svc, V3.id as string, 4, { effective_from: iso(bad), change_reason: REASON }, { at: NOW })));
      expect(V(db, V3.id as string).status).toBe('draft'); expect(events(db)).toHaveLength(0);
    }
    for (const bad of ['yesterday', '2026-13-45T00:00:00Z', 12345, '']) {
      const { db, svc } = W();
      validation400(await rejection(publish(db, svc, V3.id as string, 4, { effective_from: bad, change_reason: REASON })));
    }
    const { db, svc } = W();
    expect(await publish(db, svc, V3.id as string, 4, { effective_from: iso(at(-299)), change_reason: REASON })).toMatchObject({ status: 'published' });
  });

  it('E1 / V4: effective_from must be LATER than the latest published/superseded sibling\'s (equal or earlier -> 400 /effective_from) — v2 starts 2026-06-01, which is also in the past of "now" ⇒ use a clock before it', { timeout: T }, async () => {
    const early = new Date('2026-05-31T23:59:00.000Z');
    for (const from of [new Date('2026-06-01T00:00:00.000Z'), new Date('2026-05-31T12:00:00.000Z')]) {
      const { db, svc } = W();
      validation400(await rejection(publish(db, svc, V3.id as string, 4, { effective_from: iso(from), change_reason: REASON }, { at: early })));
      expect(V(db, V3.id as string).status).toBe('draft'); expect(V(db, V2.id as string)).toMatchObject({ status: 'published', version: 1 });
    }
    const { db, svc } = W();
    expect(await publish(db, svc, V3.id as string, 4, { effective_from: '2026-06-01T00:00:01.000Z', change_reason: REASON }, { at: early })).toMatchObject({ status: 'published' });
  });

  it('E11: a scheduled version keeps its window [F1, F2) when a later one is published: publish v3 at F1, then draft v4 at F2 > F1 -> v3 superseded with effective_to = F2; v4 ≤ F1 is refused', { timeout: T }, async () => {
    const { db, svc } = W();
    await publish(db, svc, V3.id as string, 4, { effective_from: iso(FUTURE), change_reason: REASON });
    const v4 = await draftOf(db, svc, LP.id as string);
    expect(v4).toMatchObject({ version_no: 4, item_count: 2 });
    validation400(await rejection(publish(db, svc, v4.id, 1, { effective_from: iso(FUTURE), change_reason: REASON })));
    validation400(await rejection(publish(db, svc, v4.id, 1, { effective_from: iso(new Date(FUTURE.getTime() - DAY)), change_reason: REASON })));
    const F2 = new Date(FUTURE.getTime() + 10 * DAY);
    await publish(db, svc, v4.id, 1, { effective_from: iso(F2), change_reason: 'second' });
    expect(V(db, V3.id as string)).toMatchObject({ status: 'superseded' }); expect(ms(V(db, V3.id as string).effective_to)).toBe(F2.getTime());
    expect(ms(V(db, V3.id as string).effective_from)).toBe(FUTURE.getTime());
    expect(ms(V(db, V2.id as string).effective_to)).toBe(FUTURE.getTime());                       // v2's window was set once and is not rewritten
    const windows = db.rows('price_list_versions', A).filter((v) => ['published', 'superseded'].includes(v.status as string)).sort((a, b) => ms(a.effective_from) - ms(b.effective_from));
    for (let i = 1; i < windows.length; i++) expect(ms(windows[i - 1]!.effective_to)).toBe(ms(windows[i]!.effective_from));       // contiguous, no overlap
    expect(windows.at(-1)!.effective_to).toBeNull();                                                 // exactly one open-ended version
  });

  it('only a DRAFT can be published: published / superseded / discarded -> 409 catalog.version_in_use, nothing changes', { timeout: T }, async () => {
    const v1 = pver(1, A, LP.id as string, 1, { status: 'superseded', effective_to: new Date('2026-06-01T00:00:00.000Z') });
    const { db, svc } = W({ price_list_versions: [v1, V2, V3, pver(7, A, LP.id as string, 7, { status: 'discarded' })] });
    const before = snap(db);
    for (const id of [V2.id, ID(0xb01), ID(0xb07)]) lims(await rejection(publish(db, svc, id as string, 1, { change_reason: REASON })), 'catalog.version_in_use', 409);
    expect(snap(db)).toBe(before); expect(events(db)).toHaveLength(0);
  });

  it('If-Match on the version row: missing -> 428 common.precondition_required; stale -> 409 common.version_conflict; nothing published', { timeout: T }, async () => {
    const { db, svc } = W();
    lims(await rejection(publish(db, svc, V3.id as string, undefined, { change_reason: REASON })), 'common.precondition_required', 428);
    lims(await rejection(publish(db, svc, V3.id as string, 1, { change_reason: REASON })), 'common.version_conflict', 409);
    expect(V(db, V3.id as string)).toMatchObject({ status: 'draft', version: 4 }); expect(events(db)).toHaveLength(0);
  });

  it('two concurrent publishes of the same draft: exactly one wins (the other 409 version_conflict / version_in_use); one event; one superseded predecessor', { timeout: T }, async () => {
    const { db, svc } = W();
    const r = await Promise.allSettled([1, 2].map(() => publish(db, svc, V3.id as string, 4, { change_reason: REASON })));
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(['common.version_conflict', 'catalog.version_in_use']).toContain((r.find((x) => x.status === 'rejected') as PromiseRejectedResult).reason.code);
    expect(events(db)).toHaveLength(1); expect(db.revisionOf(A)).toBe(418);
    expect(db.rows('price_list_versions', A).filter((v) => v.status === 'published')).toHaveLength(1);
  });

  it('after publishing, the version is frozen end-to-end: upsert/remove -> 409 version_in_use (AC-13.4), a new draft copied from it carries the same prices and is editable', { timeout: T }, async () => {
    const { db, svc } = W();
    await publish(db, svc, V3.id as string, 4, { effective_from: iso(FUTURE), change_reason: REASON });
    lims(await rejection(upsert(db, svc, V3.id as string, [[O1.id as string, 1]])), 'catalog.version_in_use', 409);
    lims(await rejection(remove(db, svc, V3.id as string, [O1.id as string])), 'catalog.version_in_use', 409);
    expect(Number(priceOf(db, V3.id as string, O1.id as string))).toBe(95_000);
    const d4 = await draftOf(db, svc, LP.id as string);
    expect(Number(priceOf(db, d4.id, O1.id as string))).toBe(95_000);
    await upsert(db, svc, d4.id, [[O1.id as string, 96_000]]);
    expect(Number(priceOf(db, d4.id, O1.id as string))).toBe(96_000); expect(Number(priceOf(db, V3.id as string, O1.id as string))).toBe(95_000);
  });

  it('S-1: tenant B\'s version id / unknown id -> 404 (nothing published in B); a non-uuid id -> 400', { timeout: T }, async () => {
    const BV = pver(9, B, LB.id as string, 1);
    const { db, svc } = W({ price_lists: [LB], price_list_versions: [BV] });
    lims(await rejection(publish(db, svc, BV.id as string, 1, { change_reason: REASON })), 'common.not_found', 404);
    lims(await rejection(publish(db, svc, ID(0xdead), 1, { change_reason: REASON })), 'common.not_found', 404);
    validation400(await rejection(publish(db, svc, 'nope', 1, { change_reason: REASON })));
    expect(db.row('price_list_versions', BV.id as string)).toMatchObject({ status: 'draft', version: 1 });
  });

  it('publishing the first version of a list (no predecessor) just publishes it; a list with only a discarded history works too', { timeout: T }, async () => {
    const { db, svc } = setup();
    const l = await create(db, svc, { code: 'FRESH1', name: 'x', owner_kind: 'centre', assignments: [] });
    await upsert(db, svc, l.draft_version_id, [[O1.id as string, 10_000]]);
    const out = await publish(db, svc, l.draft_version_id, 1, { change_reason: 'first' });
    expect(out).toMatchObject({ version_no: 1, status: 'published', item_count: 1 });
    expect(payloads(db).at(-1)).toMatchObject({ entity_type: 'price_list', entity_id: l.id, change_kind: 'versioned' });
    expect((await getD(db, svc, l.id)).current_version).toMatchObject({ id: l.draft_version_id, version_no: 1 });
  });
});

// ====================================================================================================== discard (#81)
describe('discardPriceListVersionDraft (#81)', () => {
  const D2 = pver(2, A, LP.id as string, 2, { version: 3 });
  const W = () => setup({ price_lists: [LP, LB], price_list_versions: [V1, D2, pver(9, B, LB.id as string, 1)], price_list_items: [pitem(1, A, V1.id as string, O1.id as string, 1), pitem(2, A, D2.id as string, O1.id as string, 2)] });

  it('draft -> discarded: status only, items stay (history), no event, no revision bump; the list may then get a new draft numbered max+1', { timeout: T }, async () => {
    const { db, svc } = W();
    const out = await discard(db, svc, D2.id as string, 3);
    expect(out).toMatchObject({ id: D2.id, status: 'discarded', version_no: 2, version: 4 });
    expect(db.row('price_list_versions', D2.id as string)).toMatchObject({ status: 'discarded' });
    expect(events(db)).toHaveLength(0); expect(db.revisionOf(A)).toBe(417);
    expect(await draftOf(db, svc, LP.id as string)).toMatchObject({ version_no: 3, status: 'draft' });
  });

  it('only drafts can be discarded: published / superseded / already discarded -> 409 catalog.version_in_use', { timeout: T }, async () => {
    const { db, svc } = W();
    lims(await rejection(discard(db, svc, V1.id as string, 1)), 'catalog.version_in_use', 409);
    await discard(db, svc, D2.id as string, 3);
    lims(await rejection(discard(db, svc, D2.id as string, 4)), 'catalog.version_in_use', 409);
    expect(db.row('price_list_versions', V1.id as string)).toMatchObject({ status: 'published', version: 1 });
  });

  it('If-Match: missing -> 428; stale -> 409 common.version_conflict; tenant B\'s version -> 404 (untouched)', { timeout: T }, async () => {
    const { db, svc } = W();
    lims(await rejection(discard(db, svc, D2.id as string, undefined)), 'common.precondition_required', 428);
    lims(await rejection(discard(db, svc, D2.id as string, 1)), 'common.version_conflict', 409);
    lims(await rejection(discard(db, svc, ID(0xb09), 1)), 'common.not_found', 404);
    expect(db.row('price_list_versions', D2.id as string)).toMatchObject({ status: 'draft', version: 3 });
    expect(db.row('price_list_versions', ID(0xb09))).toMatchObject({ status: 'draft', version: 1 });
  });

  it('a discarded version\'s items are frozen too (trigger): upsert -> 409 version_in_use', { timeout: T }, async () => {
    const { db, svc } = W();
    await discard(db, svc, D2.id as string, 3);
    lims(await rejection(upsert(db, svc, D2.id as string, [[O2.id as string, 5]])), 'catalog.version_in_use', 409);
  });
});

// ====================================================================================================== DB triggers against service-produced state (05-SCHEMA §5)
describe('integration (trigger) — immutability holds even for direct SQL, on state produced by the service', () => {
  it('after publish: UPDATE / INSERT / DELETE on its items and a content UPDATE on the version row all raise P0001 (common.immutable_record); status/effective_to changes of the lifecycle stay possible', { timeout: T }, async () => {
    const { db, svc } = withPublished();
    const d = await draftOf(db, svc, LP.id as string);
    await upsert(db, svc, d.id, [[O3.id as string, 700]]);
    const pub = await publish(db, svc, d.id, 1, { effective_from: iso(FUTURE), change_reason: REASON });
    expect(await sqlCode(sql(db, 'UPDATE catalog.price_list_items SET unit_price_paisa = $3 WHERE tenant_id = $1 AND price_list_version_id = $2', [A, pub.id, 1]))).toBe('P0001');
    expect(await sqlCode(sql(db, 'INSERT INTO catalog.price_list_items (id, tenant_id, price_list_version_id, orderable_id, unit_price_paisa, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $6)', [ID(0x9200), A, pub.id, O2.id, 5, USER]))).toBe('P0001');
    expect(await sqlCode(sql(db, 'DELETE FROM catalog.price_list_items WHERE tenant_id = $1 AND price_list_version_id = $2', [A, pub.id]))).toBe('P0001');
    expect(await sqlCode(sql(db, 'UPDATE catalog.price_list_versions SET change_reason = $3 WHERE tenant_id = $1 AND id = $2', [A, pub.id, 'tampered']))).toBe('P0001');
    expect(await sqlCode(sql(db, 'UPDATE catalog.price_list_versions SET status = $3 WHERE tenant_id = $1 AND id = $2', [A, pub.id, 'draft']))).toBe('P0001');       // published -> draft is forbidden
    expect(await sqlCode(sql(db, 'UPDATE catalog.price_list_items SET unit_price_paisa = $3 WHERE tenant_id = $1 AND price_list_version_id = $2', [A, V1.id, 1]))).toBe('P0001');   // the superseded predecessor too
    expect(itemRows(db, pub.id).map((r) => Number(r.unit_price_paisa)).sort((a, b) => a - b)).toEqual([700, 50_000, 90_000]);
  });

  it('one draft per list is a DB guarantee (partial unique index) and a published row needs effective_from / published_at / change_reason (CHECK)', { timeout: T }, async () => {
    const { db } = withPublished();
    const ins = (id: string, no: number, status: string) => sql(db, 'INSERT INTO catalog.price_list_versions (id, tenant_id, price_list_id, version_no, status, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $6, $6)', [id, A, LP.id, no, status, USER]);
    expect(await sqlCode(ins(ID(0x9301), 2, 'draft'))).toBe('none');
    expect(await sqlCode(ins(ID(0x9302), 3, 'draft'))).toBe('23505');
    expect(await sqlCode(ins(ID(0x9303), 4, 'published'))).toBe('23514');
  });

  it('the service never issues DELETE on price lists or versions (no DELETE grant) — discard keeps the row — and every write carries the caller\'s tenant (S-1)', { timeout: T }, async () => {
    const { db, svc } = withPublished();
    const d = await draftOf(db, svc, LP.id as string);
    await discard(db, svc, d.id, 1);
    await create(db, svc, { code: 'WRITE1', name: 'x', owner_kind: 'centre', assignments: [{ owner_id: C1.id }] });
    expect(writes(db).filter((s) => /^\s*DELETE\s+FROM\s+catalog\.(price_lists|price_list_versions)/i.test(s.text))).toEqual([]);
    for (const s of writes(db)) expect(JSON.stringify(s.values) + s.text, s.text.slice(0, 60)).toMatch(new RegExp(A));
    expect(db.rows('price_list_versions', B)).toHaveLength(0);
  });
});
