// T-15 (C3) — doctors (referrers) service, operations #60–#66: search, list, create/quick-add, get, update, verify, merge with chain flattening.
// Spec: 06-PLAN row T-15 (done_when: mapper hides contacts without catalog.referrer.manage; auto codes via code_counters; search match/rank rule 02-TRD #60;
//         price-list reassignment at merge is T-17; tests: unit (normalisation), integration, probes, wording grep);
//       01-PRD US-11: AC-11.1 quick-add (auto DR{seq:5}, is_verified=false, source=quick_add), AC-11.2 duplicate hints (201 + possible_duplicate_of, never 409),
//         AC-11.3 merge (X inactive, merged_into_id=Y, historic orders keep X), AC-11.4 contacts only for purpose 'notification' (port = T-29; this task proves the
//         mapper side), AC-11.5 no "commission" (probes/referrers.wording.test.ts);
//       02-TRD §5 rows 60–66, §5.0 (If-Match 428/409, codes trimmed + upper-cased, cursor lists), §5.1 Doctor DTO, §6.2 (IdentityPort.getActor decides contacts),
//         §9.1 events (`doctor`: create -> created, update/verify -> updated, is_active -> false / merge -> deactivated); 03-APP-FLOW F-09 + doctor state table (chains flattened);
//       05-SCHEMA doctors (name_normalised, UNIQUE(tenant, doctor_code), merged_into_id FK/CHECKs), code_counters (next_value = next to hand out; lazily created, P-22);
//       07-SECURITY S-1 (cross-tenant), S-5 (mass assignment), S-11 + AB-15 (contacts), AB-20 (no value echo), REQ-SEC-082 (escaped LIKE).
// Real core `createEvents({producer:'catalog'})` over the SQL fake in helpers/doctorsDb.ts (RLS, row locks, UNIQUE, CHECK, FK, LIKE with ESCAPE, counters).
// The revision bump is T-03's real service — the writer must call it in the SAME transaction.
// Interface expected from the writer (names marked SEAM are not fixed by the spec; see .orchestra/notes/T-15-tests.md):
//   catalog/service/referrers.service.ts  export function createReferrersService(deps: { events, identity }) (SEAM: identity = IdentityPort subset { getActor(ctx) -> ActorProfile })
//     searchDoctors(ctx, { q, include_unverified?, include_inactive?, limit? })          -> { data: DoctorSummary[] }
//     listDoctors(ctx, { is_verified?, is_active?, source?, sort?, cursor?, limit? })      -> { data: DoctorSummary[], page: { limit, next_cursor? } }
//     createDoctor(ctx, body)                                                              -> DoctorCreated (the 201 body)
//     getDoctor(ctx, { id })                                                               -> Doctor (contacts only when getActor().permissions has catalog.referrer.manage)
//     updateDoctor(ctx, { id, expectedVersion, patch })                                    -> Doctor
//     verifyDoctor(ctx, { id, expectedVersion })                                           -> Doctor
//     mergeDoctor(ctx, { id, expectedVersion, body: { into_doctor_id } })                  -> Doctor (the merged one, id = id)
//   DTOs = snake_case Doctor / DoctorSummary / DoctorCreated of contracts/openapi/catalog.yaml (no tenant_id, name_normalised, created_*, updated_*, verified_*).
//   Single-table SQL only (see doctorsDb.ts dialect). Permission checks (x-permission) are the core pipeline's and are not re-tested here.
import { describe, expect, it } from 'vitest';
import { createEvents } from '../../../../core/events/publish.js';
import { isLimsError } from '../../../../core/errors.js';
import { createReferrersService } from '../../service/referrers.service.js';
import { ROOT_A, TENANT_A, TENANT_B, USER, UUIDV7 } from '../helpers/catalogDb.js';
import { MANAGE, READ, actorIdentity, ctr, doc, makeDoctorsDb, normName } from '../helpers/doctorsDb.js';
import { ID, pgError, type Row } from '../helpers/mastersDb.js';

const T = 20_000;
type Svc = Record<string, (ctx: any, input?: any) => Promise<any>>;
const seedState = { state: { [TENANT_A]: { rootId: ROOT_A, revision: 417 } } };
const at = (s: number) => new Date(Date.UTC(2026, 10, 7, 12, 0, s));
const P1 = '+9779800000001';
const P2 = '+9779800000002';
const A = TENANT_A;
const B = TENANT_B;

const setup = (rows: { doctors?: Row[]; code_counters?: Row[] } = {}, perms: readonly string[] = [READ, MANAGE], catalog: any = seedState) => {
  const db = makeDoctorsDb({ rows, catalog });
  const identity = actorIdentity(perms);
  const svc = createReferrersService({ events: createEvents({ producer: 'catalog' } as never), identity } as never) as unknown as Svc;
  return { db, svc, identity };
};
type Db = ReturnType<typeof setup>['db'];
const rejection = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { expect(e, `crash: ${(e as Error)?.message}`).not.toBeInstanceOf(TypeError); return e; } throw new Error('expected rejection, got success'); };
const lims = (e: any, code: string, status: number) => { expect(isLimsError(e, code), `got ${e?.code ?? e?.message}`).toBe(true); expect(e.statusCode).toBe(status); };
const validation400 = (e: any) => { expect(isLimsError(e), `got ${e?.code ?? e?.message}`).toBe(true); expect(e.statusCode).toBe(400); expect(['common.validation_failed', 'common.unknown_field']).toContain(e.code); };
const events = (db: Db, tenant = A) => db.events.filter((e) => e.tenantId === tenant && e.eventType === 'catalog.changed.v1');
const stmtsOf = (db: Db, tenant = A) => db.stmts.filter((s) => s.tenantId === tenant);
const writes = (db: Db) => stmtsOf(db).filter((s) => /^\s*(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+catalog\./i.test(s.text));
const ms = (v: unknown) => new Date(v as string | Date).getTime();

const create = (db: Db, svc: Svc, body: object, o: { tenantId?: string; at?: Date; rollback?: boolean } = {}) => db.run((ctx) => svc['createDoctor']!(ctx, body), o);
const quick = (db: Db, svc: Svc, body: object, o: { tenantId?: string; at?: Date } = {}) => create(db, svc, { quick_add: true, ...body }, o);
const get = (db: Db, svc: Svc, id: string, tenantId = A) => db.run((ctx) => svc['getDoctor']!(ctx, { id }), { tenantId });
const upd = (db: Db, svc: Svc, id: string, version: number | undefined, patch: object, o: { tenantId?: string; at?: Date; rollback?: boolean } = {}) =>
  db.run((ctx) => svc['updateDoctor']!(ctx, { id, expectedVersion: version, patch }), o);
const verify = (db: Db, svc: Svc, id: string, version: number | undefined, o: { tenantId?: string; at?: Date } = {}) =>
  db.run((ctx) => svc['verifyDoctor']!(ctx, { id, expectedVersion: version }), o);
const merge = (db: Db, svc: Svc, id: string, version: number | undefined, into: unknown, o: { tenantId?: string; at?: Date; rollback?: boolean } = {}) =>
  db.run((ctx) => svc['mergeDoctor']!(ctx, { id, expectedVersion: version, body: { into_doctor_id: into } }), o);
const search = (db: Db, svc: Svc, body: object, tenantId = A) => db.run((ctx) => svc['searchDoctors']!(ctx, body), { tenantId });
const list = (db: Db, svc: Svc, q: object = {}, tenantId = A) => db.run((ctx) => svc['listDoctors']!(ctx, q), { tenantId });
const codes = (r: { data: any[] }) => r.data.map((x) => x.doctor_code);
const SUMMARY_KEYS = ['id', 'doctor_code', 'display_name', 'qualification', 'is_verified', 'is_active', 'canonical_doctor_id'];
const CONTACTS = ['phone_e164', 'email'];
const noContacts = (x: object) => { for (const k of CONTACTS) expect(x, k).not.toHaveProperty(k); };

// ====================================================================================================== CREATE / QUICK-ADD
describe('createDoctor (#62) — AC-11.1 quick-add', () => {
  it('AC-11.1: quick-add "Dr Test Referrer 0007" with phone -> first auto code DR00001, is_verified=false, source=quick_add, exact DoctorCreated DTO, owned by the caller\'s tenant', { timeout: T }, async () => {
    const { db, svc } = setup();
    const out = await quick(db, svc, { display_name: 'Dr Test Referrer 0007', phone_e164: P1 });
    expect(out).toEqual({ id: out.id, doctor_code: 'DR00001', display_name: 'Dr Test Referrer 0007', phone_e164: P1, is_verified: false, source: 'quick_add', is_active: true, version: 1, possible_duplicate_of: [] });
    expect(out.id).toMatch(UUIDV7);
    expect(db.row(out.id)).toMatchObject({ tenant_id: A, doctor_code: 'DR00001', name_normalised: 'dr test referrer 0007', is_verified: false, verified_at: null, verified_by: null, source: 'quick_add', merged_into_id: null, version: 1, is_active: true, created_by: USER, updated_by: USER });
    expect(db.counter()).toBe(2);                                                  // next_value = the next code to hand out
  });

  it('back-office create (quick_add absent or false): source back_office, still unverified, still auto code; every optional field round-trips', { timeout: T }, async () => {
    for (const flag of [{}, { quick_add: false }]) {
      const { db, svc } = setup();
      const body = { display_name: 'Dr Full Record', qualification: 'MD General Medicine', registration_council: 'NMC', registration_no: 'SYN-0001', phone_e164: P1, email: 'dr.full@example.test', notes: 'Synthetic note.' };
      const out = await create(db, svc, { ...body, ...flag });
      expect(out).toEqual({ id: out.id, doctor_code: 'DR00001', ...body, is_verified: false, source: 'back_office', is_active: true, version: 1, possible_duplicate_of: [] });
    }
  });

  it('sequential auto codes DR00001, DR00002, DR00003; counter row lazily created with the actor; tenants count independently', { timeout: T }, async () => {
    const { db, svc } = setup({}, [READ, MANAGE], { state: { [A]: { rootId: ROOT_A, revision: 417 }, [B]: { rootId: ROOT_A, revision: 1 } } });
    expect(db.counter()).toBeUndefined();
    const seq: string[] = [];
    for (let i = 1; i <= 3; i++) seq.push((await quick(db, svc, { display_name: `Dr Seq ${i}` })).doctor_code);
    expect(seq).toEqual(['DR00001', 'DR00002', 'DR00003']);
    expect(db.counter()).toBe(4);
    expect(db.rows('code_counters', A)).toHaveLength(1);
    expect(db.rows('code_counters', A)[0]).toMatchObject({ counter_key: 'doctor_code', created_by: USER });
    expect((await quick(db, svc, { display_name: 'Dr Other Lab' }, { tenantId: B })).doctor_code).toBe('DR00001');
    expect(db.counter(B)).toBe(2);
    expect(db.counter()).toBe(4);
  });

  it.each([[41, 'DR00041'], [99999, 'DR99999'], [100000, 'DR100000']])('an existing counter at next_value %i issues %s (pattern DR{seq:5}: zero-padded to 5, longer numbers are not truncated) and advances', { timeout: T }, async (n, expected) => {
    const { db, svc } = setup({ code_counters: [ctr(A, n)] });
    expect((await quick(db, svc, { display_name: 'Dr Counter' })).doctor_code).toBe(expected);
    expect(db.counter()).toBe(n + 1);
  });

  it('race: five concurrent quick-adds -> five distinct consecutive codes (row-locked counter), counter 6, five events, revision +5', { timeout: T }, async () => {
    const { db, svc } = setup();
    const res = await Promise.all([1, 2, 3, 4, 5].map((n) => quick(db, svc, { display_name: `Dr Race ${n}` }, { at: at(n) })));
    expect(res.map((r) => r.doctor_code).sort()).toEqual(['DR00001', 'DR00002', 'DR00003', 'DR00004', 'DR00005']);
    expect(db.counter()).toBe(6);
    expect(db.rows('doctors')).toHaveLength(5);
    expect(events(db)).toHaveLength(5);
    expect(db.revisionOf(A)).toBe(422);
  });

  it('the counter advance is part of the create transaction: a failed create (event insert fails) or a rollback leaves the counter and the next code untouched', { timeout: T }, async () => {
    const seeded = setup({ code_counters: [ctr(A, 7)] });
    seeded.db.fail(/INSERT INTO core\.event_log/i);
    await rejection(quick(seeded.db, seeded.svc, { display_name: 'Dr Fails' }));
    expect(seeded.db.counter()).toBe(7);
    expect(seeded.db.rows('doctors')).toHaveLength(0);
    const fresh = setup();
    await rejection(create(fresh.db, fresh.svc, { display_name: 'Dr Rolled Back' }, { rollback: true }));
    expect([undefined, 1]).toContain(fresh.db.counter());
    expect(fresh.db.rows('doctors')).toHaveLength(0);
    expect((await quick(fresh.db, fresh.svc, { display_name: 'Dr After' })).doctor_code).toBe('DR00001');
    const noText = setup(); noText.db.fail(/INSERT INTO catalog\.doctors\b/i);
    await rejection(quick(noText.db, noText.svc, { display_name: 'Dr Insert Fails' }));
    expect([undefined, 1]).toContain(noText.db.counter());
    expect(events(noText.db)).toHaveLength(0);
  });

  it('event catalog.changed.v1 {entity_type doctor, change_kind created, entity_id = new id} in the same transaction; revision +1; insert before event', { timeout: T }, async () => {
    const { db, svc } = setup();
    const out = await quick(db, svc, { display_name: 'Dr Event' });
    const ev = events(db);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.envelope.payload).toMatchObject({ catalog_revision: 418, entity_type: 'doctor', entity_id: out.id, change_kind: 'created' });
    expect(db.revisionOf(A)).toBe(418);
    const mine = stmtsOf(db);
    const insertAt = mine.findIndex((s) => /^\s*INSERT\s+INTO\s+catalog\.doctors\b/i.test(s.text));
    expect(insertAt).toBeGreaterThanOrEqual(0);
    expect(mine.findIndex((s) => /INSERT INTO core\.event_log/i.test(s.text))).toBeGreaterThan(insertAt);
    expect(new Set(mine.map((s) => s.txId)).size).toBe(1);
  });

  it('first write of a tenant with no catalog_state row works (revision 1)', { timeout: T }, async () => {
    const { db, svc } = setup({}, [READ, MANAGE], {});
    await quick(db, svc, { display_name: 'Dr First' });
    expect(db.revisionOf(A)).toBe(1);
  });

  it.each([[' dr-77 ', 'DR-77'], ['dr_77', 'DR_77'], ['\tDr77\n', 'DR77'], ['x'.repeat(20), 'X'.repeat(20)]])('explicit code %j is trimmed and upper-cased (TRD §5.0) and does not consume the counter', { timeout: T }, async (raw, stored) => {
    const { db, svc } = setup({ code_counters: [ctr(A, 5)] });
    const out = await create(db, svc, { doctor_code: raw, display_name: 'Dr Explicit' });
    expect(out.doctor_code).toBe(stored);
    expect(db.row(out.id)!.doctor_code).toBe(stored);
    expect(db.counter()).toBe(5);
    expect(out.source).toBe('back_office');
  });

  it.each([
    ['same code', 'SEED1'], ['lower-case', 'seed1'], ['padded', ' SEED1 '],
  ])('explicit code taken (%s) -> 409 catalog.code_duplicate — no row, no event, no revision bump, counter untouched', { timeout: T }, async (_n, raw) => {
    const { db, svc } = setup({ doctors: [doc(1, A)], code_counters: [ctr(A, 5)] });
    lims(await rejection(create(db, svc, { doctor_code: raw, display_name: 'Dr Clash' })), 'catalog.code_duplicate', 409);
    expect(db.rows('doctors')).toHaveLength(1);
    expect(events(db)).toHaveLength(0);
    expect(db.revisionOf(A)).toBe(417);
    expect(db.counter()).toBe(5);
  });

  it('an INACTIVE or MERGED doctor still owns its code; another tenant owning the same code does not block (AC-01.3 pattern)', { timeout: T }, async () => {
    const { db, svc } = setup({ doctors: [doc(1, A, { is_active: false }), doc(2, A, { is_active: false, merged_into_id: doc(3, A).id }), doc(3, A), doc(94, B, { doctor_code: 'THEIRS' })] });
    for (const code of ['SEED1', 'SEED2']) lims(await rejection(create(db, svc, { doctor_code: code, display_name: 'Dr Again' })), 'catalog.code_duplicate', 409);
    const out = await create(db, svc, { doctor_code: 'THEIRS', display_name: 'Dr Mine' });
    expect(out.doctor_code).toBe('THEIRS');
    expect(db.row(doc(94, B).id)).toMatchObject({ doctor_code: 'THEIRS', version: 1, display_name: 'Dr Seed 94' });
    expect(events(db, B)).toHaveLength(0);
  });

  it('race: two concurrent creates with the same explicit code -> one wins, the loser gets catalog.code_duplicate (not a raw 23505)', { timeout: T }, async () => {
    const { db, svc } = setup();
    const res = await Promise.allSettled([create(db, svc, { doctor_code: 'RACE', display_name: 'Dr One' }, { at: at(1) }), create(db, svc, { doctor_code: 'RACE', display_name: 'Dr Two' }, { at: at(2) })]);
    expect(res.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    lims((res.find((x) => x.status === 'rejected') as PromiseRejectedResult).reason, 'catalog.code_duplicate', 409);
    expect(db.rows('doctors')).toHaveLength(1);
    expect(events(db)).toHaveLength(1);
  });

  it('the unique index is the guard: a 23505 from doctors__tenant_id_doctor_code__uq (raced past any pre-read) is mapped to 409 catalog.code_duplicate', { timeout: T }, async () => {
    const { db, svc } = setup();
    db.fail(/INSERT INTO catalog\.doctors\b/i, () => pgError('23505', 'duplicate key value violates unique constraint "doctors__tenant_id_doctor_code__uq"', 'doctors__tenant_id_doctor_code__uq'));
    const e = await rejection(create(db, svc, { doctor_code: 'RACE', display_name: 'Dr One' }));
    lims(e, 'catalog.code_duplicate', 409);
    expect(e.code).not.toBe('23505');
    expect(events(db)).toHaveLength(0);
  });

  it('boundaries: 120-char name, 120 qualification, 20 council, 30 registration_no, 500 notes, 254-char e-mail, 8- and 15-digit phones, 20-char code are all accepted', { timeout: T }, async () => {
    const { db, svc } = setup();
    const email = `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(55)}.com`;
    expect(email.length).toBeLessThanOrEqual(254);
    const out = await create(db, svc, { doctor_code: 'C'.repeat(20), display_name: 'n'.repeat(120), qualification: 'q'.repeat(120), registration_council: 'c'.repeat(20), registration_no: 'r'.repeat(30), notes: 'x'.repeat(500), email, phone_e164: '+12345678' });
    expect(out.display_name).toHaveLength(120);
    expect(db.row(out.id)).toMatchObject({ notes: 'x'.repeat(500), email, phone_e164: '+12345678' });
    await create(db, svc, { display_name: 'Dr Long Phone', phone_e164: '+123456789012345' });
  });

  it.each([
    ['display_name missing', { display_name: undefined }], ['display_name empty', { display_name: '' }], ['display_name only spaces', { display_name: '   ' }],
    ['display_name 121 chars', { display_name: 'n'.repeat(121) }], ['display_name number', { display_name: 5 }], ['display_name null', { display_name: null }],
    ['qualification 121', { qualification: 'q'.repeat(121) }], ['registration_council 21', { registration_council: 'c'.repeat(21) }], ['registration_no 31', { registration_no: 'r'.repeat(31) }],
    ['notes 501', { notes: 'x'.repeat(501) }], ['email without @', { email: 'plainaddress' }], ['email without domain', { email: 'a@' }], ['email without local part', { email: '@b.test' }], ['email 255 chars', { email: `${'a'.repeat(250)}@b.cd` }],
    ['phone without +', { phone_e164: '9779800000001' }], ['phone starting +0', { phone_e164: '+0123456789' }], ['phone too short', { phone_e164: '+1234567' }], ['phone too long', { phone_e164: '+1234567890123456' }],
    ['phone with spaces', { phone_e164: '+977 9800000001' }], ['phone with letters', { phone_e164: '+97798000000a1' }], ['phone number type', { phone_e164: 9779800000001 }],
    ['doctor_code with space', { doctor_code: 'DR 1' }], ['doctor_code with dot', { doctor_code: 'DR.1' }], ['doctor_code 21 chars', { doctor_code: 'D'.repeat(21) }],
    ['doctor_code Unicode letter that upper-cases to ASCII (ı)', { doctor_code: 'drı' }], ['doctor_code number', { doctor_code: 12 }],
    ['quick_add string', { quick_add: 'yes' }], ['quick_add number', { quick_add: 1 }], ['quick_add null', { quick_add: null }],
  ])('invalid body: %s -> 400 before any write (the service is also called by import commits, so it validates itself)', { timeout: T }, async (_n, over) => {
    const { db, svc } = setup();
    const body = Object.fromEntries(Object.entries({ display_name: 'Dr Valid', ...over }).filter(([, v]) => v !== undefined));
    validation400(await rejection(create(db, svc, body)));
    expect(writes(db)).toEqual([]);
    expect(events(db)).toHaveLength(0);
  });

  it.each([['tenant_id', { tenant_id: B }], ['id', { id: ID(0xbad) }], ['version', { version: 9 }], ['is_verified', { is_verified: true }], ['source', { source: 'import' }],
    ['merged_into_id', { merged_into_id: doc(1, A).id }], ['is_active', { is_active: false }], ['price_list_id', { price_list_id: ID(0x5) }], ['name_normalised', { name_normalised: 'x' }],
    ['possible_duplicate_of', { possible_duplicate_of: [] }], ['created_by', { created_by: ID(1) }], ['verified_at', { verified_at: '2020-01-01T00:00:00.000Z' }],
    ['__proto__ key', JSON.parse('{"__proto__": {"is_verified": true}}')],
  ])('S-5: mass assignment (%s) -> 400, nothing written', { timeout: T }, async (_n, extra) => {
    const { db, svc } = setup();
    validation400(await rejection(create(db, svc, { display_name: 'Dr Valid', ...extra })));
    expect(writes(db)).toEqual([]);
    expect(db.rows('doctors')).toHaveLength(0);
  });

  it('a non-object body is a 400, not a crash', { timeout: T }, async () => {
    const { db, svc } = setup();
    for (const body of [null, 'Dr Valid', 7, [{ display_name: 'Dr Valid' }]]) validation400(await rejection(create(db, svc, body as never)));
  });

  it('REQ-SEC-088/089 data side: markup / quotes / SQL fragments are stored and returned verbatim and never reach SQL text; all values are bind parameters', { timeout: T }, async () => {
    const nasty = "<img src=x onerror=alert(1)> & \"q\" ' ; DROP TABLE catalog.doctors; --";
    const { db, svc } = setup();
    const out = await create(db, svc, { display_name: nasty, notes: nasty, qualification: 'bound-0xC0FFEE' });
    expect(out.display_name).toBe(nasty);
    expect(db.row(out.id)).toMatchObject({ display_name: nasty, notes: nasty });
    for (const s of db.stmts) { expect(s.text).not.toContain('DROP TABLE'); expect(s.text).not.toContain('bound-0xC0FFEE'); }
    const ins = db.stmts.filter((s) => /^\s*INSERT\s+INTO\s+catalog\.doctors\b/i.test(s.text));
    expect(ins.some((s) => s.values.includes('bound-0xC0FFEE') && s.values.includes(A))).toBe(true);
    expect(db.stmts.filter((s) => /^\s*DELETE\b/i.test(s.text))).toEqual([]);
  });

  it('AB-20: errors never echo submitted values (validation, duplicate code, unknown field)', { timeout: T }, async () => {
    const planted = 'PLANTED-TOKEN-9c2d';
    const { db, svc } = setup({ doctors: [doc(1, A)] });
    const errs = [
      await rejection(create(db, svc, { doctor_code: 'SEED1', display_name: planted })),
      await rejection(create(db, svc, { display_name: planted, phone_e164: `+${planted}` })),
      await rejection(create(db, svc, { display_name: planted, email: planted })),
      await rejection(create(db, svc, { display_name: planted, [planted]: planted })),
      await rejection(create(db, svc, { display_name: 'x'.repeat(121) + planted })),
    ];
    for (const e of errs) expect(JSON.stringify({ m: e.message, d: e.detail, errs: e.errors })).not.toContain(planted);
  });
});

// ====================================================================================================== NORMALISATION (unit)
describe('name normalisation (name_normalised: trim, collapse spaces, NFC, lower-case — 03-APP-FLOW F-09, 05-SCHEMA)', () => {
  it.each([
    ['  Dr   Test  Referrer ', 'dr test referrer'], ['DR TEST', 'dr test'], ['Dr Test', 'dr test'], ['Dr    A    B', 'dr a b'],
    ['Dr Café', 'dr café'], ['Dr Café', 'dr café'], ['Dr Émile', 'dr émile'], ['Dr José Martín', 'dr josé martín'],
  ])('%j is stored as name_normalised %j (display_name is kept for display)', { timeout: T }, async (raw, normalised) => {
    const { db, svc } = setup();
    const out = await create(db, svc, { display_name: raw });
    expect(db.row(out.id)!.name_normalised).toBe(normalised);
    expect(db.row(out.id)!.name_normalised).toBe(normName(raw));
    expect(normName(out.display_name)).toBe(normalised);
  });

  it('a patched display_name re-computes name_normalised (so search and duplicate hints follow the edit)', { timeout: T }, async () => {
    const { db, svc } = setup({ doctors: [doc(1, A, { display_name: 'Dr Old Name' })] });
    await upd(db, svc, doc(1, A).id, 1, { display_name: '  Dr   NEW  Name ' });
    expect(db.row(doc(1, A).id)!.name_normalised).toBe('dr new name');
    expect((await search(db, svc, { q: 'new name' })).data.map((x: Row) => x.id)).toEqual([doc(1, A).id]);
    expect((await search(db, svc, { q: 'old name' })).data).toEqual([]);
  });
});

// ====================================================================================================== DUPLICATE HINTS
describe('createDoctor duplicate hints — AC-11.2 (normalised name + phone equal an existing ACTIVE doctor of the tenant)', () => {
  const EXISTING = doc(1, A, { display_name: 'Dr Test Referrer 0007', phone_e164: P1, qualification: 'MBBS' });
  const twin = { display_name: ' dr  TEST referrer 0007 ', phone_e164: P1 };

  it('AC-11.2: 201 (NOT 409 code_duplicate) with possible_duplicate_of = [the existing doctor as a DoctorSummary]; the new doctor is created anyway with its own code', { timeout: T }, async () => {
    const { db, svc } = setup({ doctors: [EXISTING] });
    const out = await quick(db, svc, twin);
    expect(out.doctor_code).toBe('DR00001');
    expect(out.possible_duplicate_of).toEqual([{ id: EXISTING.id, doctor_code: 'SEED1', display_name: 'Dr Test Referrer 0007', qualification: 'MBBS', is_verified: false, is_active: true, canonical_doctor_id: EXISTING.id }]);
    expect(out.id).not.toBe(EXISTING.id);
    expect(db.rows('doctors', A)).toHaveLength(2);
    expect(events(db)).toHaveLength(1);
    expect(out.possible_duplicate_of.map((x: Row) => x.id)).not.toContain(out.id);
  });

  it('hint entries are DoctorSummary only — no phone, e-mail or any other key', { timeout: T }, async () => {
    const { db, svc } = setup({ doctors: [{ ...EXISTING, email: 'hidden@example.test', notes: 'n', registration_no: 'R1' }] });
    const out = await quick(db, svc, twin);
    expect(out.possible_duplicate_of).toHaveLength(1);
    for (const k of Object.keys(out.possible_duplicate_of[0])) expect(SUMMARY_KEYS).toContain(k);
    noContacts(out.possible_duplicate_of[0]);
  });

  it('NFC and case/space variants of the name still match', { timeout: T }, async () => {
    const e = doc(1, A, { display_name: 'Dr Café Rai', phone_e164: P1 });
    const { db, svc } = setup({ doctors: [e] });
    expect((await quick(db, svc, { display_name: 'DR  Café   RAI', phone_e164: P1 })).possible_duplicate_of.map((x: Row) => x.id)).toEqual([e.id]);
  });

  it('all matching doctors are listed (verified or not), capped at 10 (DoctorCreated.possible_duplicate_of maxItems)', { timeout: T }, async () => {
    const some = [doc(1, A, { display_name: 'Dr Same', phone_e164: P1 }), doc(2, A, { display_name: 'DR SAME', phone_e164: P1, is_verified: true }), doc(3, A, { display_name: 'Dr Same', phone_e164: P1, source: 'quick_add' })];
    const { db, svc } = setup({ doctors: some });
    expect((await quick(db, svc, { display_name: 'dr same', phone_e164: P1 })).possible_duplicate_of.map((x: Row) => x.id).sort()).toEqual(some.map((d) => d.id).sort());
    const many = setup({ doctors: Array.from({ length: 12 }, (_, i) => doc(i + 1, A, { display_name: 'Dr Same', phone_e164: P1 })) });
    const out = await quick(many.db, many.svc, { display_name: 'Dr Same', phone_e164: P1 });
    expect(out.possible_duplicate_of.length).toBeLessThanOrEqual(10);
    expect(out.possible_duplicate_of.length).toBeGreaterThan(0);
  });

  it.each([
    ['different phone', { ...twin, phone_e164: P2 }, {}],
    ['no phone on the new doctor', { display_name: twin.display_name }, {}],
    ['different name', { display_name: 'Dr Test Referrer 0008', phone_e164: P1 }, {}],
    ['name only a prefix of the existing one', { display_name: 'Dr Test', phone_e164: P1 }, {}],
    ['the existing doctor is inactive', twin, { is_active: false }],
    ['the existing doctor is merged away', twin, { is_active: false, merged_into_id: doc(9, A).id }],
  ])('no hint when: %s', { timeout: T }, async (_n, body, over) => {
    const { db, svc } = setup({ doctors: [{ ...EXISTING, ...over }, doc(9, A)] });
    expect((await quick(db, svc, body)).possible_duplicate_of).toEqual([]);
    expect(db.rows('doctors', A)).toHaveLength(3);
  });

  it('S-1: a twin in another tenant is neither hinted nor disclosed', { timeout: T }, async () => {
    const theirs = doc(91, B, { display_name: 'Dr Test Referrer 0007', phone_e164: P1 });
    const { db, svc } = setup({ doctors: [theirs] });
    const out = await quick(db, svc, twin);
    expect(out.possible_duplicate_of).toEqual([]);
    expect(JSON.stringify(out)).not.toContain(theirs.id);
  });

  it('a create without quick_add also carries possible_duplicate_of (the field is required by DoctorCreated): [] when none', { timeout: T }, async () => {
    const { db, svc } = setup();
    expect((await create(db, svc, { display_name: 'Dr Lonely' })).possible_duplicate_of).toEqual([]);
  });
});

// ====================================================================================================== GET + mapper (contacts)
describe('getDoctor (#63) and the contact allow-list — S-11, AB-15, REQ-SEC-081', () => {
  const full = doc(1, A, { phone_e164: P1, email: 'dr.one@example.test', notes: 'Synthetic note.', qualification: 'MD', registration_council: 'NMC', registration_no: 'SYN-1', is_verified: true, version: 3 });

  it('a holder of catalog.referrer.manage gets the full Doctor (contacts included); exact keys, no internal columns', { timeout: T }, async () => {
    const { db, svc } = setup({ doctors: [full] });
    const out = await get(db, svc, full.id);
    expect(out).toEqual({ id: full.id, doctor_code: 'SEED1', display_name: 'Dr Seed 1', qualification: 'MD', registration_council: 'NMC', registration_no: 'SYN-1', phone_e164: P1, email: 'dr.one@example.test', notes: 'Synthetic note.', is_verified: true, source: 'back_office', is_active: true, version: 3 });
    for (const k of ['tenant_id', 'name_normalised', 'created_by', 'updated_by', 'created_at', 'updated_at', 'verified_at', 'verified_by']) expect(out).not.toHaveProperty(k);
  });

  it('AB-15 / S-11: without catalog.referrer.manage (read only) phone_e164 and email are ABSENT (not null, not masked); the rest of the record is returned', { timeout: T }, async () => {
    const { db, svc, identity } = setup({ doctors: [full] }, [READ]);
    const out = await get(db, svc, full.id);
    noContacts(out);
    expect(JSON.stringify(out)).not.toContain(P1);
    expect(JSON.stringify(out)).not.toContain('dr.one@example.test');
    expect(out).toMatchObject({ id: full.id, doctor_code: 'SEED1', display_name: 'Dr Seed 1', is_verified: true, version: 3 });
    expect(identity.calls.some((c) => c.method === 'getActor')).toBe(true);
  });

  it('fail closed: if the actor lookup fails, getDoctor fails (it must not fall back to returning contacts)', { timeout: T }, async () => {
    const { db, identity } = setup({ doctors: [full] });
    (identity as any).getActor = async () => { throw Object.assign(new Error('boom'), { code: 'auth.unauthenticated' }); };
    const svc = createReferrersService({ events: createEvents({ producer: 'catalog' } as never), identity } as never) as unknown as Svc;
    const e = await db.run((ctx) => svc['getDoctor']!(ctx, { id: full.id })).then((r) => ({ leaked: JSON.stringify(r) }), (x) => x);
    expect(e.leaked ?? '').not.toContain(P1);
    expect(e.leaked ?? '').not.toContain('dr.one@example.test');
  });

  it('a merged (inactive) doctor can be read: merged_into_id and is_active=false are in the DTO', { timeout: T }, async () => {
    const y = doc(2, A);
    const { db, svc } = setup({ doctors: [doc(1, A, { is_active: false, merged_into_id: y.id }), y] });
    expect(await get(db, svc, doc(1, A).id)).toMatchObject({ is_active: false, merged_into_id: y.id });
  });

  it('unknown id -> 404; S-1: tenant B\'s id -> 404 (same answer); malformed id -> 400', { timeout: T }, async () => {
    const { db, svc } = setup({ doctors: [doc(91, B, { phone_e164: P2 })] });
    for (const id of [ID(0xdead), doc(91, B).id]) { const e = await rejection(get(db, svc, id)); lims(e, 'common.not_found', 404); expect(JSON.stringify([e.message, e.detail])).not.toContain(P2); }
    validation400(await rejection(get(db, svc, 'not-a-uuid')));
  });

  it('read-only: no INSERT/UPDATE/event/revision change', { timeout: T }, async () => {
    const { db, svc } = setup({ doctors: [full] });
    await get(db, svc, full.id);
    expect(writes(db)).toEqual([]);
    expect(events(db)).toHaveLength(0);
    expect(db.revisionOf(A)).toBe(417);
  });
});

// ====================================================================================================== LIST
describe('listDoctors (#61)', () => {
  const rows = () => [
    doc(1, A, { doctor_code: 'L1', created_at: new Date(Date.UTC(2026, 0, 1)), is_verified: true, source: 'back_office', phone_e164: P1 }),
    doc(2, A, { doctor_code: 'L2', created_at: new Date(Date.UTC(2026, 0, 2)), is_verified: false, source: 'quick_add' }),
    doc(3, A, { doctor_code: 'L3', created_at: new Date(Date.UTC(2026, 0, 3)), is_verified: false, source: 'import' }),
    doc(4, A, { doctor_code: 'L4', created_at: new Date(Date.UTC(2026, 0, 4)), is_verified: true, source: 'quick_add' }),
    doc(5, A, { doctor_code: 'L5', created_at: new Date(Date.UTC(2026, 0, 5)), is_active: false }),
    doc(6, A, { doctor_code: 'L6', created_at: new Date(Date.UTC(2026, 0, 6)), is_active: false, merged_into_id: doc(1, A).id }),
    doc(92, B, { doctor_code: 'BONLY', display_name: 'B Secret Doctor' }),
  ];

  it('default: ACTIVE doctors of the tenant only; DTO exactly DoctorSummary (no contacts, no other keys); canonical_doctor_id = own id when not merged', { timeout: T }, async () => {
    const { db, svc } = setup({ doctors: rows() });
    const out = await list(db, svc);
    expect(codes(out).sort()).toEqual(['L1', 'L2', 'L3', 'L4']);
    expect(out.page.limit).toBe(50);
    const l1 = out.data.find((x: Row) => x.doctor_code === 'L1');
    expect(l1).toEqual({ id: doc(1, A).id, doctor_code: 'L1', display_name: 'Dr Seed 1', is_verified: true, is_active: true, canonical_doctor_id: doc(1, A).id });
    for (const x of out.data) for (const k of Object.keys(x)) expect(SUMMARY_KEYS).toContain(k);
    expect(JSON.stringify(out)).not.toMatch(/BONLY|B Secret/);
  });

  it('a manage holder still gets summaries without contacts', { timeout: T }, async () => {
    const { db, svc } = setup({ doctors: rows() }, [READ, MANAGE]);
    for (const x of (await list(db, svc)).data) noContacts(x);
  });

  it.each([
    [{ is_active: 'all' }, ['L1', 'L2', 'L3', 'L4', 'L5', 'L6']], [{ is_active: 'false' }, ['L5', 'L6']], [{ is_active: 'true' }, ['L1', 'L2', 'L3', 'L4']],
    [{ is_verified: true }, ['L1', 'L4']], [{ is_verified: false }, ['L2', 'L3']], [{ source: 'quick_add' }, ['L2', 'L4']], [{ source: 'import' }, ['L3']], [{ source: 'back_office' }, ['L1']],
    [{ is_verified: false, source: 'quick_add' }, ['L2']], [{ is_active: 'all', is_verified: false }, ['L2', 'L3', 'L5', 'L6']],
  ])('filter %j -> %j', { timeout: T }, async (q, expected) => {
    const { db, svc } = setup({ doctors: rows() });
    expect(codes(await list(db, svc, q)).sort()).toEqual(expected);
  });

  it('merged doctors listed with is_active=all point at the survivor: canonical_doctor_id = merged_into_id', { timeout: T }, async () => {
    const { db, svc } = setup({ doctors: rows() });
    const l6 = (await list(db, svc, { is_active: 'all' })).data.find((x: Row) => x.doctor_code === 'L6');
    expect(l6).toMatchObject({ is_active: false, canonical_doctor_id: doc(1, A).id });
  });

  it.each([['doctor_code', ['L1', 'L2', 'L3', 'L4', 'L5', 'L6']], ['-doctor_code', ['L6', 'L5', 'L4', 'L3', 'L2', 'L1']], ['created_at', ['L1', 'L2', 'L3', 'L4', 'L5', 'L6']], ['-created_at', ['L6', 'L5', 'L4', 'L3', 'L2', 'L1']]])
  ('sort %s is honoured and paging with a cursor (limit 2) visits every row exactly once, in order', { timeout: T }, async (sort, expected) => {
    const { db, svc } = setup({ doctors: rows() });
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 6; i++) {
      const p = await list(db, svc, { sort, is_active: 'all', limit: 2, ...(cursor ? { cursor } : {}) });
      expect(p.page.limit).toBe(2);
      seen.push(...codes(p));
      cursor = p.page.next_cursor;
      if (!cursor) break;
    }
    expect(seen).toEqual(expected);
  });

  it('equal sort values are tie-broken by id (stable paging): five rows with one created_at', { timeout: T }, async () => {
    const same = new Date(Date.UTC(2026, 2, 3));
    const { db, svc } = setup({ doctors: [1, 2, 3, 4, 5].map((n) => doc(n, A, { doctor_code: `S${n}`, created_at: same })) });
    const seen: string[] = []; let cursor: string | undefined;
    for (let i = 0; i < 5; i++) { const p = await list(db, svc, { sort: 'created_at', limit: 2, ...(cursor ? { cursor } : {}) }); seen.push(...codes(p)); cursor = p.page.next_cursor; if (!cursor) break; }
    expect([...seen].sort()).toEqual(['S1', 'S2', 'S3', 'S4', 'S5']);
    expect(new Set(seen).size).toBe(5);
  });

  it.each([[{ is_active: 'maybe' }], [{ source: 'web' }], [{ sort: 'display_name' }], [{ sort: 'doctor_code;DROP' }], [{ limit: 0 }], [{ limit: 201 }], [{ is_verified: 'perhaps' }], [{ bogus: 1 }], [{ cursor: '!!!' }]])
  ('bad query %j -> 400, no data', { timeout: T }, async (q) => {
    const { db, svc } = setup({ doctors: rows() });
    const e = await rejection(list(db, svc, q));
    expect(isLimsError(e)).toBe(true); expect(e.statusCode).toBe(400);
  });

  it('S-1: tenant B sees only its own doctors', { timeout: T }, async () => {
    const { db, svc } = setup({ doctors: rows() });
    expect(codes(await list(db, svc, {}, B))).toEqual(['BONLY']);
  });
});

// ====================================================================================================== SEARCH
describe('searchDoctors (#60) — match: doctor_code prefix (upper-cased q) OR name_normalised contains normalised q; rank exact code, code prefix, name prefix, name contains, then doctor_code', () => {
  const RANK = () => [
    doc(1, A, { doctor_code: 'RAI', display_name: 'Zed Person' }), doc(2, A, { doctor_code: 'RAI2', display_name: 'Yan Person' }), doc(3, A, { doctor_code: 'C300', display_name: 'Rai Kumar' }),
    doc(4, A, { doctor_code: 'C200', display_name: 'Anita Rai' }), doc(5, A, { doctor_code: 'C100', display_name: 'Bina Rai' }), doc(6, A, { doctor_code: 'RAI0', display_name: 'Qwe Person' }),
    doc(7, A, { doctor_code: 'ZZ', display_name: 'Nothing Here' }), doc(8, A, { doctor_code: 'RAIX', display_name: 'Xavier Rai' }),
    doc(93, B, { doctor_code: 'RAIB', display_name: 'Rai Of Tenant B' }),
  ];
  const ORDER = ['RAI', 'RAI0', 'RAI2', 'RAIX', 'C300', 'C100', 'C200'];

  it('rank: exact code, then code prefix (by code), then name prefix, then name contains (by code); non-matches and other tenants excluded', { timeout: T }, async () => {
    const { db, svc } = setup({ doctors: RANK() });
    expect(codes(await search(db, svc, { q: 'rai' }))).toEqual(ORDER);
  });

  it.each([['RAI'], ['Rai'], ['  rai  '], ['\trai\n']])('q %j is trimmed and case-insensitive', { timeout: T }, async (q) => {
    const { db, svc } = setup({ doctors: RANK() });
    expect(codes(await search(db, svc, { q }))).toEqual(ORDER);
  });

  it('DoctorSummary list: exact keys, no contacts (even for a manage holder), canonical_doctor_id; nothing is written', { timeout: T }, async () => {
    const { db, svc } = setup({ doctors: [doc(1, A, { doctor_code: 'K1', display_name: 'Kay One', qualification: 'MD', phone_e164: P1, email: 'k@example.test' })] }, [READ, MANAGE]);
    const out = await search(db, svc, { q: 'kay' });
    expect(out).toEqual({ data: [{ id: doc(1, A).id, doctor_code: 'K1', display_name: 'Kay One', qualification: 'MD', is_verified: false, is_active: true, canonical_doctor_id: doc(1, A).id }] });
    expect(writes(db)).toEqual([]);
    expect(events(db)).toHaveLength(0);
    expect(db.revisionOf(A)).toBe(417);
  });

  it('code match is a PREFIX of the upper-cased q (lower-case q matches a code); a code CONTAINING q does not match; the name is matched by CONTAINS', { timeout: T }, async () => {
    const only = setup({ doctors: [doc(1, A, { doctor_code: 'DR00012', display_name: 'Mmm Nnn' })] });
    expect(codes(await search(only.db, only.svc, { q: 'dr000' }))).toEqual(['DR00012']);
    expect(codes(await search(only.db, only.svc, { q: 'DR00012' }))).toEqual(['DR00012']);
    for (const q of ['00012', 'r00012', '12']) expect(codes(await search(only.db, only.svc, { q })), q).toEqual([]);   // contained in the code, not a prefix of it
    const { db, svc } = setup({ doctors: [doc(1, A, { doctor_code: 'DR00012', display_name: 'Mmm Nnn' }), doc(2, A, { doctor_code: 'XX', display_name: 'Pre Dr00012 Post' })] });
    expect(codes(await search(db, svc, { q: 'dr00012' }))).toEqual(['DR00012', 'XX']);                    // code (exact) first, then name contains
    expect(codes(await search(db, svc, { q: 'e dr0' }))).toEqual(['XX']);
  });

  it('q is normalised like the stored name: runs of spaces collapse, NFC composes', { timeout: T }, async () => {
    const { db, svc } = setup({ doctors: [doc(1, A, { doctor_code: 'N1', display_name: 'Asha  Rai' }), doc(2, A, { doctor_code: 'N2', display_name: 'Café Doc' })] });
    expect(codes(await search(db, svc, { q: '  ASHA    rai ' }))).toEqual(['N1']);
    expect(codes(await search(db, svc, { q: 'café d' }))).toEqual(['N2']);
  });

  it('filters: include_unverified (default true), include_inactive (default false); merged doctors point at the survivor', { timeout: T }, async () => {
    const f = () => [
      doc(1, A, { doctor_code: 'F1', display_name: 'Filt Unverified' }), doc(2, A, { doctor_code: 'F2', display_name: 'Filt Verified', is_verified: true }),
      doc(3, A, { doctor_code: 'F3', display_name: 'Filt Inactive', is_active: false }), doc(4, A, { doctor_code: 'F4', display_name: 'Filt Merged', is_active: false, merged_into_id: doc(2, A).id }),
      doc(5, A, { doctor_code: 'F5', display_name: 'Filt Old Verified', is_active: false, is_verified: true }),
    ];
    const { db, svc } = setup({ doctors: f() });
    expect(codes(await search(db, svc, { q: 'filt' }))).toEqual(['F1', 'F2']);
    expect(codes(await search(db, svc, { q: 'filt', include_unverified: true }))).toEqual(['F1', 'F2']);
    expect(codes(await search(db, svc, { q: 'filt', include_unverified: false }))).toEqual(['F2']);
    const all = await search(db, svc, { q: 'filt', include_inactive: true });
    expect(codes(all)).toEqual(['F1', 'F2', 'F3', 'F4', 'F5']);
    expect(all.data.find((x: Row) => x.doctor_code === 'F4')).toMatchObject({ is_active: false, canonical_doctor_id: doc(2, A).id });
    expect(all.data.find((x: Row) => x.doctor_code === 'F5')).toMatchObject({ is_active: false, canonical_doctor_id: doc(5, A).id });
    expect(codes(await search(db, svc, { q: 'filt', include_inactive: true, include_unverified: false }))).toEqual(['F2', 'F5']);
  });

  it('limit: default is at most 50 (and at least 1); limit n returns the n best-ranked; 1 and 50 are accepted', { timeout: T }, async () => {
    const many = Array.from({ length: 60 }, (_, i) => doc(i + 1, A, { doctor_code: `LIM${String(i + 1).padStart(2, '0')}`, display_name: `Lim Doc ${i + 1}` }));
    const { db, svc } = setup({ doctors: many });
    const def = await search(db, svc, { q: 'lim' });
    expect(def.data.length).toBeGreaterThan(0);
    expect(def.data.length).toBeLessThanOrEqual(50);
    expect(codes(await search(db, svc, { q: 'lim', limit: 3 }))).toEqual(['LIM01', 'LIM02', 'LIM03']);
    expect(await search(db, svc, { q: 'lim', limit: 1 })).toMatchObject({ data: [{ doctor_code: 'LIM01' }] });
    expect((await search(db, svc, { q: 'lim', limit: 50 })).data).toHaveLength(50);
  });

  // REQ-SEC-082: the user's text is data, never a LIKE pattern. The fake evaluates LIKE for real, so an unescaped wildcard WOULD over-match here.
  const ESC = () => [
    doc(11, A, { doctor_code: 'AB1', display_name: 'Pure 100% Gold' }), doc(12, A, { doctor_code: 'AB2', display_name: 'Pure 100x Gold' }),
    doc(13, A, { doctor_code: 'AB3', display_name: 'Under_score Man' }), doc(14, A, { doctor_code: 'AB4', display_name: 'Underxscore Man' }),
    doc(15, A, { doctor_code: 'AB5', display_name: 'Back\\slash Man' }), doc(16, A, { doctor_code: 'DX1', display_name: 'Plain One' }), doc(17, A, { doctor_code: 'DX2', display_name: 'Plain Two' }),
  ];
  it.each([
    ['%', ['AB1']], ['_', ['AB3']], ['\\', ['AB5']], ['D%', []], ['100%', ['AB1']], ['r_s', ['AB3']], ['er_s', ['AB3']], ['%%', []], ['\\%', []], ['d_1', []],
  ])('REQ-SEC-082: q %j is matched literally (wildcards %% _ and the escape character carry no meaning) -> %j', { timeout: T }, async (q, expected) => {
    const { db, svc } = setup({ doctors: ESC() });
    expect(codes(await search(db, svc, { q })).sort()).toEqual(expected);
  });

  it('q is always a bind parameter: quotes / SQL fragments return nothing and never reach SQL text; the table survives', { timeout: T }, async () => {
    const { db, svc } = setup({ doctors: ESC() });
    for (const q of ["'; DROP TABLE catalog.doctors; --", "x' OR '1'='1", '") OR 1=1 --']) {
      expect((await search(db, svc, { q })).data).toEqual([]);
      for (const s of db.stmts) { expect(s.text).not.toContain('DROP TABLE'); expect(s.text).not.toContain("'1'='1"); expect(s.text).not.toContain('OR 1=1'); }
    }
    expect(db.rows('doctors', A)).toHaveLength(7);
  });

  it.each([
    ['q missing', undefined], ['q empty', { q: '' }], ['q 65 chars', { q: 'a'.repeat(65) }], ['q number', { q: 5 }], ['q null', { q: null }], ['body not an object', 'rai'],
    ['unknown field', { q: 'rai', tenant_id: B }], ['limit 0', { q: 'rai', limit: 0 }], ['limit 51', { q: 'rai', limit: 51 }], ['limit string', { q: 'rai', limit: 'ten' }],
    ['include_unverified string', { q: 'rai', include_unverified: 'yes' }], ['include_inactive number', { q: 'rai', include_inactive: 1 }],
  ])('invalid request: %s -> 400', { timeout: T }, async (_n, body) => {
    const { db, svc } = setup({ doctors: RANK() });
    validation400(await rejection(search(db, svc, body as never)));
  });

  it('q of exactly 64 characters is accepted', { timeout: T }, async () => {
    const { db, svc } = setup({ doctors: RANK() });
    expect((await search(db, svc, { q: 'a'.repeat(64) })).data).toEqual([]);
  });

  it('S-1: tenant B\'s doctors never appear (RAIB / "Rai Of Tenant B"), and tenant B searching sees only its own', { timeout: T }, async () => {
    const { db, svc } = setup({ doctors: RANK() });
    expect(JSON.stringify(await search(db, svc, { q: 'rai' }))).not.toMatch(/RAIB|Tenant B/);
    expect(codes(await search(db, svc, { q: 'rai' }, B))).toEqual(['RAIB']);
  });
});

// ====================================================================================================== UPDATE
describe('updateDoctor (#64)', () => {
  const ID1 = doc(1, A).id;
  const base = () => doc(1, A, { phone_e164: P1, email: 'old@example.test', qualification: 'MD', notes: 'old note', registration_no: 'R-1', registration_council: 'NMC', version: 1 });

  it('patch -> 200 Doctor with version+1; only the patched fields change; event `updated` (entity doctor) + revision +1 in the same transaction', { timeout: T }, async () => {
    const { db, svc } = setup({ doctors: [base()] });
    const out = await upd(db, svc, ID1, 1, { display_name: 'Dr Renamed', phone_e164: P2, email: 'new@example.test', qualification: 'MS', notes: 'new note', registration_no: 'R-2', registration_council: 'KMC' }, { at: at(3) });
    expect(out).toEqual({ id: ID1, doctor_code: 'SEED1', display_name: 'Dr Renamed', qualification: 'MS', registration_council: 'KMC', registration_no: 'R-2', phone_e164: P2, email: 'new@example.test', notes: 'new note', is_verified: false, source: 'back_office', is_active: true, version: 2 });
    expect(db.row(ID1)).toMatchObject({ version: 2, updated_by: USER, doctor_code: 'SEED1', source: 'back_office', is_verified: false });
    expect(ms(db.row(ID1)!.updated_at)).toBe(+at(3));
    const ev = events(db);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.envelope.payload).toMatchObject({ catalog_revision: 418, entity_type: 'doctor', entity_id: ID1, change_kind: 'updated' });
    expect(new Set(stmtsOf(db).map((s) => s.txId)).size).toBe(1);
  });

  it('unset[] clears optional fields (stored NULL, key absent from the DTO); other fields untouched', { timeout: T }, async () => {
    const { db, svc } = setup({ doctors: [base()] });
    const out = await upd(db, svc, ID1, 1, { unset: ['phone_e164', 'email', 'notes', 'qualification'] });
    for (const k of ['phone_e164', 'email', 'notes', 'qualification']) { expect(out, k).not.toHaveProperty(k); expect(db.row(ID1)![k], k).toBeNull(); }
    expect(out).toMatchObject({ registration_no: 'R-1', registration_council: 'NMC', version: 2 });
    expect((await upd(db, svc, ID1, 2, { unset: ['registration_council', 'registration_no'] })).version).toBe(3);
  });

  it.each([
    ['unset names a field also set', { phone_e164: P2, unset: ['phone_e164'] }], ['unset display_name (required)', { unset: ['display_name'] }], ['unset doctor_code', { unset: ['doctor_code'] }],
    ['unset is_active', { unset: ['is_active'] }], ['unset not an array', { unset: 'phone_e164' }], ['unset 7 entries', { unset: ['qualification', 'registration_council', 'registration_no', 'phone_e164', 'email', 'notes', 'notes'] }],
    ['display_name empty', { display_name: '' }], ['display_name only spaces', { display_name: '  ' }], ['display_name 121', { display_name: 'n'.repeat(121) }], ['phone invalid', { phone_e164: '12345' }],
    ['email invalid', { email: 'nope' }], ['notes 501', { notes: 'x'.repeat(501) }], ['is_active string', { is_active: 'false' }],
  ])('invalid patch: %s -> 400, nothing written', { timeout: T }, async (_n, patch) => {
    const { db, svc } = setup({ doctors: [base()] });
    validation400(await rejection(upd(db, svc, ID1, 1, patch)));
    expect(writes(db)).toEqual([]);
    expect(db.row(ID1)!.version).toBe(1);
  });

  it.each([['doctor_code', { doctor_code: 'NEWCODE' }], ['tenant_id', { tenant_id: B }], ['version', { version: 9 }], ['id', { id: ID(0xbad) }], ['is_verified', { is_verified: true }], ['source', { source: 'import' }],
    ['merged_into_id', { merged_into_id: doc(2, A).id }], ['name_normalised', { name_normalised: 'x' }], ['price_list_id', { price_list_id: ID(5) }], ['quick_add', { quick_add: true }], ['verified_by', { verified_by: USER }],
  ])('S-5: mass assignment (%s) -> 400, nothing written', { timeout: T }, async (_n, patch) => {
    const { db, svc } = setup({ doctors: [base(), doc(2, A)] });
    validation400(await rejection(upd(db, svc, ID1, 1, patch)));
    expect(writes(db)).toEqual([]);
    expect(db.row(ID1)).toMatchObject({ version: 1, doctor_code: 'SEED1', is_verified: false, merged_into_id: null });
    expect(events(db)).toHaveLength(0);
  });

  it('is_active:false -> 200 and event change_kind `deactivated`; reactivating a non-merged doctor -> `updated`', { timeout: T }, async () => {
    const { db, svc } = setup({ doctors: [base()] });
    expect(await upd(db, svc, ID1, 1, { is_active: false })).toMatchObject({ is_active: false, version: 2 });
    expect(events(db).at(-1)!.envelope.payload).toMatchObject({ entity_type: 'doctor', entity_id: ID1, change_kind: 'deactivated' });
    expect(await upd(db, svc, ID1, 2, { is_active: true })).toMatchObject({ is_active: true, version: 3 });
    expect(events(db).at(-1)!.envelope.payload).toMatchObject({ change_kind: 'updated' });
    expect(db.revisionOf(A)).toBe(419);
  });

  it('a MERGED doctor cannot be reactivated [CONV]: a clean LimsError (4xx), not a raw check violation, and nothing changes', { timeout: T }, async () => {
    const y = doc(2, A);
    const { db, svc } = setup({ doctors: [doc(1, A, { is_active: false, merged_into_id: y.id }), y] });
    const e = await rejection(upd(db, svc, doc(1, A).id, 1, { is_active: true }));
    expect(isLimsError(e), `got ${e?.code ?? e?.message}`).toBe(true);
    expect([400, 409, 422]).toContain(e.statusCode);
    expect(e.code).not.toBe('23514');
    expect(db.row(doc(1, A).id)).toMatchObject({ is_active: false, merged_into_id: y.id, version: 1 });
    expect(events(db)).toHaveLength(0);
  });

  it('If-Match: missing -> 428 common.precondition_required; stale -> 409 common.version_conflict; malformed -> 400; none of them writes', { timeout: T }, async () => {
    const { db, svc } = setup({ doctors: [{ ...base(), version: 3 }] });
    lims(await rejection(upd(db, svc, ID1, undefined, { notes: 'x' })), 'common.precondition_required', 428);
    lims(await rejection(upd(db, svc, ID1, 2, { notes: 'x' })), 'common.version_conflict', 409);
    for (const v of [0, -1, 1.5, 2 ** 31, '3' as never, null as never]) { const e = await rejection(upd(db, svc, ID1, v, { notes: 'x' })); expect(isLimsError(e)).toBe(true); expect(e.statusCode).toBe(400); }
    expect(db.row(ID1)!.version).toBe(3);
    expect(writes(db)).toEqual([]);
    expect(events(db)).toHaveLength(0);
  });

  it('race: two concurrent updates with the same If-Match -> exactly one wins (version 2), the other gets 409 common.version_conflict', { timeout: T }, async () => {
    const { db, svc } = setup({ doctors: [base()] });
    const res = await Promise.allSettled([upd(db, svc, ID1, 1, { notes: 'one' }, { at: at(1) }), upd(db, svc, ID1, 1, { notes: 'two' }, { at: at(2) })]);
    expect(res.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    lims((res.find((x) => x.status === 'rejected') as PromiseRejectedResult).reason, 'common.version_conflict', 409);
    expect(db.row(ID1)!.version).toBe(2);
    expect(events(db)).toHaveLength(1);
  });

  it('unknown id -> 404; S-1: tenant B\'s id -> 404 and the B row is untouched; malformed id -> 400', { timeout: T }, async () => {
    const { db, svc } = setup({ doctors: [base(), doc(91, B, { phone_e164: P2 })] });
    for (const id of [ID(0xdead), doc(91, B).id]) lims(await rejection(upd(db, svc, id, 1, { notes: 'x' })), 'common.not_found', 404);
    validation400(await rejection(upd(db, svc, 'nope', 1, { notes: 'x' })));
    expect(db.row(doc(91, B).id)).toMatchObject({ version: 1, notes: null });
    expect(events(db)).toHaveLength(0);
  });

  it('rollback / a failing event insert discards the update, the version and the revision together', { timeout: T }, async () => {
    const a = setup({ doctors: [base()] });
    await rejection(upd(a.db, a.svc, ID1, 1, { notes: 'x' }, { rollback: true }));
    expect(a.db.row(ID1)).toMatchObject({ version: 1, notes: 'old note' }); expect(a.db.revisionOf(A)).toBe(417);
    const b = setup({ doctors: [base()] });
    b.db.fail(/INSERT INTO core\.event_log/i);
    await rejection(upd(b.db, b.svc, ID1, 1, { notes: 'x' }));
    expect(b.db.row(ID1)).toMatchObject({ version: 1, notes: 'old note' }); expect(b.db.revisionOf(A)).toBe(417);
  });

  it('the UPDATE is optimistic and tenant-scoped explicitly in SQL (version predicate, tenant_id predicate), all values bound', { timeout: T }, async () => {
    const { db, svc } = setup({ doctors: [base()] });
    await upd(db, svc, ID1, 1, { notes: 'bound-note-0xC0FFEE' });
    const u = db.stmts.filter((s) => /^\s*UPDATE\s+catalog\.doctors\b/i.test(s.text));
    expect(u.length).toBeGreaterThanOrEqual(1);
    for (const s of u) { expect(s.text).not.toContain('bound-note-0xC0FFEE'); expect(s.text.split(/\bWHERE\b/i)[1] ?? '').toMatch(/\btenant_id\s*=\s*\$\d+/i); }
    expect(u.some((s) => /\bversion\s*=\s*\$\d+/i.test(s.text.split(/\bWHERE\b/i)[1] ?? '') && s.values.includes(ID1) && s.values.includes(A))).toBe(true);
  });
});

// ====================================================================================================== VERIFY
describe('verifyDoctor (#65)', () => {
  const ID1 = doc(1, A).id;

  it('unverified -> verified: is_verified=true, verified_at = transaction clock, verified_by = actor, version+1; event `updated` + revision +1', { timeout: T }, async () => {
    const { db, svc } = setup({ doctors: [doc(1, A, { source: 'quick_add', phone_e164: P1 })] });
    const out = await verify(db, svc, ID1, 1, { at: at(9) });
    expect(out).toMatchObject({ id: ID1, is_verified: true, version: 2, source: 'quick_add', is_active: true, phone_e164: P1 });
    expect(db.row(ID1)).toMatchObject({ is_verified: true, verified_by: USER, version: 2 });
    expect(ms(db.row(ID1)!.verified_at)).toBe(+at(9));
    const ev = events(db);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.envelope.payload).toMatchObject({ catalog_revision: 418, entity_type: 'doctor', entity_id: ID1, change_kind: 'updated' });
    expect(new Set(stmtsOf(db).map((s) => s.txId)).size).toBe(1);
  });

  it('verify keeps everything else: code, name, source quick_add stay as they were', { timeout: T }, async () => {
    const { db, svc } = setup({ doctors: [doc(1, A, { source: 'quick_add' })] });
    await verify(db, svc, ID1, 1);
    expect(db.row(ID1)).toMatchObject({ doctor_code: 'SEED1', display_name: 'Dr Seed 1', name_normalised: 'dr seed 1', source: 'quick_add', merged_into_id: null });
  });

  it('a merged doctor cannot be verified -> 409 catalog.version_in_use, unchanged', { timeout: T }, async () => {
    const y = doc(2, A);
    const { db, svc } = setup({ doctors: [doc(1, A, { is_active: false, merged_into_id: y.id }), y] });
    lims(await rejection(verify(db, svc, ID1, 1)), 'catalog.version_in_use', 409);
    expect(db.row(ID1)).toMatchObject({ is_verified: false, version: 1 });
    expect(events(db)).toHaveLength(0);
    expect(db.revisionOf(A)).toBe(417);
  });

  it('If-Match: missing -> 428; stale -> 409 common.version_conflict; malformed -> 400', { timeout: T }, async () => {
    const { db, svc } = setup({ doctors: [doc(1, A, { version: 2 })] });
    lims(await rejection(verify(db, svc, ID1, undefined)), 'common.precondition_required', 428);
    lims(await rejection(verify(db, svc, ID1, 1)), 'common.version_conflict', 409);
    for (const v of [0, -3, 1.5, 2 ** 31]) expect((await rejection(verify(db, svc, ID1, v))).statusCode).toBe(400);
    expect(db.row(ID1)).toMatchObject({ is_verified: false, version: 2 });
  });

  it('unknown id -> 404; S-1: tenant B\'s id -> 404 and untouched; malformed id -> 400', { timeout: T }, async () => {
    const { db, svc } = setup({ doctors: [doc(91, B)] });
    for (const id of [ID(0xdead), doc(91, B).id]) lims(await rejection(verify(db, svc, id, 1)), 'common.not_found', 404);
    validation400(await rejection(verify(db, svc, 'nope', 1)));
    expect(db.row(doc(91, B).id)).toMatchObject({ is_verified: false, version: 1 });
  });

  it('rollback / failing event insert leaves it unverified', { timeout: T }, async () => {
    const { db, svc } = setup({ doctors: [doc(1, A)] });
    db.fail(/INSERT INTO core\.event_log/i);
    await rejection(verify(db, svc, ID1, 1));
    expect(db.row(ID1)).toMatchObject({ is_verified: false, verified_at: null, version: 1 });
  });
});

// ====================================================================================================== MERGE
describe('mergeDoctor (#66) — AC-11.3', () => {
  const X = doc(1, A, { phone_e164: P1 });
  const Y = doc(2, A);
  const W = doc(3, A);

  it('AC-11.3: merge X into Y -> X inactive with merged_into_id = Y, version+1, DTO returned for X; Y stays active/unmerged; event `deactivated` for X (one event, revision +1, same tx)', { timeout: T }, async () => {
    const { db, svc } = setup({ doctors: [X, Y] });
    const out = await merge(db, svc, X.id, 1, Y.id);
    expect(out).toMatchObject({ id: X.id, doctor_code: 'SEED1', is_active: false, merged_into_id: Y.id, version: 2 });
    expect(db.row(X.id)).toMatchObject({ is_active: false, merged_into_id: Y.id, version: 2, updated_by: USER });
    expect(db.row(Y.id)).toMatchObject({ is_active: true, merged_into_id: null });
    const ev = events(db);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.envelope.payload).toMatchObject({ catalog_revision: 418, entity_type: 'doctor', entity_id: X.id, change_kind: 'deactivated' });
    expect(db.revisionOf(A)).toBe(418);
    expect(new Set(stmtsOf(db).map((s) => s.txId)).size).toBe(1);
    expect(db.rows('doctors', A)).toHaveLength(2);                                  // nothing deleted; historic references to X stay valid (C3 never rewrites other modules)
  });

  it('afterwards: getDoctor(X) shows the merge; lists/search expose canonical_doctor_id = Y; the default list and search hide X', { timeout: T }, async () => {
    const { db, svc } = setup({ doctors: [X, Y] });
    await merge(db, svc, X.id, 1, Y.id);
    expect(await get(db, svc, X.id)).toMatchObject({ is_active: false, merged_into_id: Y.id });
    expect(codes(await list(db, svc))).toEqual(['SEED2']);
    expect(codes(await search(db, svc, { q: 'seed' }))).toEqual(['SEED2']);
    const all = (await list(db, svc, { is_active: 'all' })).data;
    expect(all.find((x: Row) => x.id === X.id)).toMatchObject({ canonical_doctor_id: Y.id, is_active: false });
    expect(all.find((x: Row) => x.id === Y.id)).toMatchObject({ canonical_doctor_id: Y.id });
    expect((await search(db, svc, { q: 'seed', include_inactive: true })).data.find((x: Row) => x.id === X.id)).toMatchObject({ canonical_doctor_id: Y.id });
  });

  it('chain flattening (05-SCHEMA §5.5): doctors already merged into X are re-pointed to Y in the same transaction; unrelated merges are untouched; merged_into_id is always ONE hop', { timeout: T }, async () => {
    const a = doc(4, A, { is_active: false, merged_into_id: X.id }); const b = doc(5, A, { is_active: false, merged_into_id: X.id }); const c = doc(6, A, { is_active: false, merged_into_id: W.id });
    const { db, svc } = setup({ doctors: [X, Y, W, a, b, c] });
    await merge(db, svc, X.id, 1, Y.id);
    for (const d of [X, a, b]) expect(db.row(d.id), d.doctor_code).toMatchObject({ merged_into_id: Y.id, is_active: false });
    expect(db.row(c.id)!.merged_into_id).toBe(W.id);
    expect(events(db)).toHaveLength(1);
    await merge(db, svc, Y.id, db.row(Y.id)!.version, W.id);                      // Y is itself merged later: everything that pointed at Y now points at W
    for (const d of [X, Y, a, b, c]) expect(db.row(d.id), d.doctor_code).toMatchObject({ merged_into_id: W.id, is_active: false });
    expect(db.row(W.id)).toMatchObject({ is_active: true, merged_into_id: null });
    const active = new Set(db.rows('doctors', A).filter((r) => r.is_active).map((r) => r.id));
    for (const r of db.rows('doctors', A).filter((r) => r.merged_into_id)) expect(active.has(r.merged_into_id), `${r.doctor_code} points at an active doctor`).toBe(true);
  });

  it('merging does not touch the survivor\'s data, and does not copy contacts or verification onto it', { timeout: T }, async () => {
    const { db, svc } = setup({ doctors: [X, { ...Y, is_verified: true, version: 4 }] });
    await merge(db, svc, X.id, 1, Y.id);
    expect(db.row(Y.id)).toMatchObject({ is_verified: true, phone_e164: null, display_name: 'Dr Seed 2', doctor_code: 'SEED2', is_active: true });
  });

  it.each([
    ['into itself', (s: any) => s.x, 'validation'],
    ['into an inactive doctor', (s: any) => s.off, 'validation'],
    ['into a doctor that is itself merged', (s: any) => s.mergedAway, 'validation'],
  ])('target rule (≠ self, active, not itself merged): %s -> 400 common.validation_failed, nothing changes', { timeout: T }, async (_n, pick) => {
    const off = doc(7, A, { is_active: false }); const mergedAway = doc(8, A, { is_active: false, merged_into_id: Y.id });
    const { db, svc } = setup({ doctors: [X, Y, off, mergedAway] });
    lims(await rejection(merge(db, svc, X.id, 1, pick({ x: X, off, mergedAway }).id)), 'common.validation_failed', 400);
    expect(db.row(X.id)).toMatchObject({ is_active: true, merged_into_id: null, version: 1 });
    expect(events(db)).toHaveLength(0);
    expect(db.revisionOf(A)).toBe(417);
  });

  it('unknown target and tenant B\'s target are rejected IDENTICALLY (no existence oracle), as 400/404, nothing changes; B row untouched', { timeout: T }, async () => {
    const theirs = doc(91, B);
    const { db, svc } = setup({ doctors: [X, Y, theirs] });
    const e1 = await rejection(merge(db, svc, X.id, 1, ID(0xdead)));
    const e2 = await rejection(merge(db, svc, X.id, 1, theirs.id));
    expect(isLimsError(e1) && isLimsError(e2)).toBe(true);
    expect([400, 404]).toContain(e1.statusCode);
    expect([e2.statusCode, e2.code]).toEqual([e1.statusCode, e1.code]);
    expect(db.row(X.id)).toMatchObject({ is_active: true, version: 1 });
    expect(db.row(theirs.id)).toMatchObject({ is_active: true, merged_into_id: null, version: 1 });
    expect(events(db)).toHaveLength(0);
  });

  it('a source that is already merged (or unknown / tenant B\'s) cannot be merged again: 4xx, nothing changes', { timeout: T }, async () => {
    const gone = doc(4, A, { is_active: false, merged_into_id: W.id });
    const { db, svc } = setup({ doctors: [X, Y, W, gone, doc(91, B)] });
    const e = await rejection(merge(db, svc, gone.id, 1, Y.id));
    expect(isLimsError(e)).toBe(true); expect([400, 409, 422]).toContain(e.statusCode);
    expect(db.row(gone.id)).toMatchObject({ merged_into_id: W.id, version: 1 });
    for (const id of [ID(0xdead), doc(91, B).id]) lims(await rejection(merge(db, svc, id, 1, Y.id)), 'common.not_found', 404);
    expect(events(db)).toHaveLength(0);
  });

  it.each([['missing', undefined], ['not a uuid', 'nope'], ['number', 5], ['null', null], ['empty', '']])('into_doctor_id %s -> 400', { timeout: T }, async (_n, into) => {
    const { db, svc } = setup({ doctors: [X, Y] });
    validation400(await rejection(merge(db, svc, X.id, 1, into)));
    expect(writes(db)).toEqual([]);
  });

  it('body validation: unknown / mass-assigned fields and a non-object body -> 400', { timeout: T }, async () => {
    const { db, svc } = setup({ doctors: [X, Y] });
    for (const body of [{ into_doctor_id: Y.id, is_active: true }, { into_doctor_id: Y.id, tenant_id: B }, { into_doctor_id: Y.id, merged_into_id: W.id }, null, 'x', [Y.id]]) {
      validation400(await rejection(db.run((ctx) => svc['mergeDoctor']!(ctx, { id: X.id, expectedVersion: 1, body }))));
    }
    expect(writes(db)).toEqual([]);
  });

  it('If-Match on the source: missing -> 428; stale -> 409 common.version_conflict; malformed -> 400', { timeout: T }, async () => {
    const { db, svc } = setup({ doctors: [{ ...X, version: 3 }, Y] });
    lims(await rejection(merge(db, svc, X.id, undefined, Y.id)), 'common.precondition_required', 428);
    lims(await rejection(merge(db, svc, X.id, 2, Y.id)), 'common.version_conflict', 409);
    for (const v of [0, -1, 1.5, 2 ** 31]) expect((await rejection(merge(db, svc, X.id, v, Y.id))).statusCode).toBe(400);
    expect(db.row(X.id)).toMatchObject({ is_active: true, version: 3 });
    expect(events(db)).toHaveLength(0);
  });

  it('atomic: a rollback or a failing event insert leaves X active AND every re-pointed doctor where it was', { timeout: T }, async () => {
    const a = doc(4, A, { is_active: false, merged_into_id: X.id });
    const r = setup({ doctors: [X, Y, a] });
    await rejection(merge(r.db, r.svc, X.id, 1, Y.id, { rollback: true }));
    expect(r.db.row(X.id)).toMatchObject({ is_active: true, merged_into_id: null }); expect(r.db.row(a.id)!.merged_into_id).toBe(X.id); expect(r.db.revisionOf(A)).toBe(417);
    const f = setup({ doctors: [X, Y, a] });
    f.db.fail(/INSERT INTO core\.event_log/i);
    await rejection(merge(f.db, f.svc, X.id, 1, Y.id));
    expect(f.db.row(X.id)).toMatchObject({ is_active: true, merged_into_id: null }); expect(f.db.row(a.id)!.merged_into_id).toBe(X.id);
  });

  it('race: X into Y and Y into X at the same time -> exactly one succeeds; no cycle, no chain: one active survivor, the other merged into it', { timeout: T }, async () => {
    const { db, svc } = setup({ doctors: [X, Y] });
    const res = await Promise.allSettled([merge(db, svc, X.id, 1, Y.id, { at: at(1) }), merge(db, svc, Y.id, 1, X.id, { at: at(2) })]);
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = (res.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason;
    expect(isLimsError(rejected)).toBe(true);
    const rows = db.rows('doctors', A);
    const active = rows.filter((r) => r.is_active);
    expect(active).toHaveLength(1);
    expect(rows.find((r) => !r.is_active)!.merged_into_id).toBe(active[0]!.id);
    expect(active[0]!.merged_into_id).toBeNull();
    expect(events(db)).toHaveLength(1);
  });

  it('race: two concurrent merges of X into different targets -> exactly one wins (If-Match / state check), X ends merged once', { timeout: T }, async () => {
    const { db, svc } = setup({ doctors: [X, Y, W] });
    const res = await Promise.allSettled([merge(db, svc, X.id, 1, Y.id, { at: at(1) }), merge(db, svc, X.id, 1, W.id, { at: at(2) })]);
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(db.row(X.id)!.version).toBe(2);
    expect([Y.id, W.id]).toContain(db.row(X.id)!.merged_into_id);
    expect(events(db)).toHaveLength(1);
  });

});

// ====================================================================================================== PROBES (cross-tenant, SQL discipline, wording of payloads)
describe('probes — S-1 tenant scoping in SQL, AC-11.5 payloads', () => {
  it('every statement on catalog.doctors / code_counters that reads or updates rows carries an explicit tenant_id predicate (defence in depth beside RLS)', { timeout: T }, async () => {
    const y = doc(2, A); const a = doc(4, A, { is_active: false, merged_into_id: doc(1, A).id });
    const { db, svc } = setup({ doctors: [doc(1, A, { phone_e164: P1 }), y, a, doc(91, B)] });
    await quick(db, svc, { display_name: 'Dr Probe', phone_e164: P1 });
    await get(db, svc, doc(1, A).id); await list(db, svc, { is_active: 'all', sort: '-created_at', limit: 1 }); await search(db, svc, { q: 'seed' });
    await upd(db, svc, doc(1, A).id, 1, { notes: 'n' }); await verify(db, svc, y.id, 1); await merge(db, svc, doc(1, A).id, 2, y.id);
    const probed = stmtsOf(db).filter((s) => /^\s*(SELECT|UPDATE)\b[\s\S]*\bcatalog\.(doctors|code_counters)\b/i.test(s.text));
    expect(probed.length).toBeGreaterThan(6);
    for (const s of probed) { expect(s.text.split(/\bWHERE\b/i)[1] ?? '', s.text).toMatch(/\btenant_id\s*=\s*\$\d+/i); expect(s.values).toContain(A); }
    expect(stmtsOf(db).filter((s) => /^\s*DELETE\b/i.test(s.text))).toEqual([]);
  });

  it('AC-11.5: no response, event payload or error carries the word "commission" (any case) for any operation', { timeout: T }, async () => {
    const { db, svc } = setup({ doctors: [doc(1, A, { phone_e164: P1 }), doc(2, A)] });
    const seen: unknown[] = [];
    seen.push(await quick(db, svc, { display_name: 'Dr Wording', phone_e164: P2 }), await get(db, svc, doc(1, A).id), await list(db, svc, { is_active: 'all' }), await search(db, svc, { q: 'dr' }),
      await upd(db, svc, doc(1, A).id, 1, { notes: 'n' }), await verify(db, svc, doc(2, A).id, 1), await merge(db, svc, doc(1, A).id, 2, doc(2, A).id));
    seen.push(...db.events.map((e) => e.envelope));
    for (const e of [await rejection(create(db, svc, { display_name: '' })), await rejection(get(db, svc, ID(0xdead)))]) seen.push({ code: e.code, message: e.message, detail: e.detail, errors: e.errors });
    expect(JSON.stringify(seen)).not.toMatch(/commission/i);
  });
});
