// T-16 (C3) — credit parties / affiliations service, operations #67–#70: list, create (auto party_code), get, update.
// Spec: 06-PLAN row T-16 (done_when: auto party_code; mapper hides pan/contacts/address without catalog.price_list.manage; tests: integration, probes);
//       01-PRD US-12: AC-12.1 (blank party_code -> auto CP{seq:5}, appears in the list), AC-12.2 (allows_credit=false affiliation: stored and returned as allows_credit=false;
//         the priceFor / port side is T-17 / T-29), AC-12.3 (no credit limit / days / balance in C3), AC-12.4 (front_desk: pan, contact_phone_e164, contact_email, billing_address
//         absent — REQ-SEC-081);
//       02-TRD §5 rows 67–70, §5.0 (If-Match 428/409 on PATCH, codes trimmed + upper-cased, cursor lists limit 50/200, is_active default true), §5.1 CreditParty DTO,
//         §6.2 (IdentityPort.getActor decides the allow-list), §9.1 events (`credit_party`: create -> created, update -> updated, is_active -> false -> deactivated);
//       05-SCHEMA credit_parties (constraints), code_counters (counter_key party_code; next_value = next to hand out; lazily created);
//       07-SECURITY S-1 (cross-tenant), S-5 (mass assignment), S-11 + AB-22 (allow-list on #67 AND #69), AB-20 (no value echo), REQ-SEC-081/082/088/089.
// Real core `createEvents({producer:'catalog'})` over the SQL fake in helpers/creditPartiesDb.ts (RLS, row locks, UNIQUE, CHECK, LIKE with ESCAPE, counters).
// The revision bump is T-03's real service — the writer must call it in the SAME transaction.
// Interface expected from the writer (names marked SEAM are not fixed by the spec; see .orchestra/notes/T-16-tests.md):
//   catalog/service/creditParties.service.ts  export function createCreditPartiesService(deps: { events, identity }) (SEAM: identity = IdentityPort subset { getActor(ctx) -> ActorProfile })
//     listCreditParties(ctx, { kind?, allows_credit?, is_active?, q?, cursor?, limit? })  -> { data: CreditParty[], page: { limit, next_cursor? } }
//     createCreditParty(ctx, body)                                                          -> CreditParty (the 201 body)
//     getCreditParty(ctx, { id })                                                           -> CreditParty
//     updateCreditParty(ctx, { id, expectedVersion, patch })                                -> CreditParty
//   DTO = snake_case CreditParty of contracts/openapi/catalog.yaml: id, party_code, name, kind, allows_credit, [pan, contact_phone_e164, contact_email, billing_address],
//   is_active, version. price_list_id (optional in the schema) belongs to price-list assignments (T-17): this task does not read price-list tables, so it is absent.
//   Single-table SQL only (see creditPartiesDb.ts dialect). Permission checks (x-permission) are the core pipeline's and are not re-tested here.
import { describe, expect, it } from 'vitest';
import { createEvents } from '../../../../core/events/publish.js';
import { isLimsError } from '../../../../core/errors.js';
import { createCreditPartiesService } from '../../service/creditParties.service.js';
import { ROOT_A, TENANT_A, TENANT_B, USER, UUIDV7 } from '../helpers/catalogDb.js';
import { MANAGE, READ, actorIdentity, cp, ctr, makeCreditPartiesDb } from '../helpers/creditPartiesDb.js';
import { ID, pgError, type Row } from '../helpers/mastersDb.js';

const T = 20_000;
type Svc = Record<string, (ctx: any, input?: any) => Promise<any>>;
const seedState = { state: { [TENANT_A]: { rootId: ROOT_A, revision: 417 } } };
const at = (s: number) => new Date(Date.UTC(2026, 10, 7, 12, 0, s));
const P1 = '+9779800000001';
const P2 = '+9779800000002';
const A = TENANT_A;
const B = TENANT_B;

const setup = (rows: { credit_parties?: Row[]; code_counters?: Row[] } = {}, perms: readonly string[] = [READ, MANAGE], catalog: any = seedState) => {
  const db = makeCreditPartiesDb({ rows, catalog });
  const identity = actorIdentity(perms);
  const svc = createCreditPartiesService({ events: createEvents({ producer: 'catalog' } as never), identity } as never) as unknown as Svc;
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

const create = (db: Db, svc: Svc, body: object, o: { tenantId?: string; at?: Date; rollback?: boolean } = {}) => db.run((ctx) => svc['createCreditParty']!(ctx, body), o);
const get = (db: Db, svc: Svc, id: string, tenantId = A) => db.run((ctx) => svc['getCreditParty']!(ctx, { id }), { tenantId });
const upd = (db: Db, svc: Svc, id: string, version: number | undefined, patch: object, o: { tenantId?: string; at?: Date; rollback?: boolean } = {}) =>
  db.run((ctx) => svc['updateCreditParty']!(ctx, { id, expectedVersion: version, patch }), o);
const list = (db: Db, svc: Svc, q: object = {}, tenantId = A) => db.run((ctx) => svc['listCreditParties']!(ctx, q), { tenantId });
const codes = (r: { data: any[] }) => r.data.map((x) => x.party_code);
const SENSITIVE = ['pan', 'contact_phone_e164', 'contact_email', 'billing_address'];
const noSensitive = (x: object) => { for (const k of SENSITIVE) expect(x, k).not.toHaveProperty(k); };
const DTO_KEYS = ['id', 'party_code', 'name', 'kind', 'allows_credit', ...SENSITIVE, 'is_active', 'version'];
const FULL = { pan: '123456789', contact_phone_e164: P1, contact_email: 'billing@example.test', billing_address: 'Synthetic Street 1, Synthetic City' };

// ====================================================================================================== CREATE
describe('createCreditParty (#68) — AC-12.1 auto party_code', () => {
  it('AC-12.1: hospital "Synthetic General Hospital", allows_credit true, blank party_code -> first auto code CP00001, exact CreditParty DTO, owned by the caller\'s tenant, appears in the list', { timeout: T }, async () => {
    const { db, svc } = setup();
    const out = await create(db, svc, { name: 'Synthetic General Hospital', kind: 'hospital', allows_credit: true });
    expect(out).toEqual({ id: out.id, party_code: 'CP00001', name: 'Synthetic General Hospital', kind: 'hospital', allows_credit: true, is_active: true, version: 1 });
    expect(out.id).toMatch(UUIDV7);
    expect(db.row(out.id)).toMatchObject({ tenant_id: A, party_code: 'CP00001', allows_credit: true, version: 1, is_active: true, pan: null, created_by: USER, updated_by: USER });
    expect(db.counter()).toBe(2);                                                  // next_value = the next code to hand out
    const page = await list(db, svc);
    expect(page.data).toEqual([out]);
  });

  it.each([[undefined], [''], ['   '], ['\t\n']])('a blank party_code (%j) is the same as an absent one: auto code, counter consumed once', { timeout: T }, async (blank) => {
    const { db, svc } = setup();
    const body: Row = { name: 'Synthetic Clinic', kind: 'clinic' };
    if (blank !== undefined) body.party_code = blank;
    expect((await create(db, svc, body)).party_code).toBe('CP00001');
    expect(db.counter()).toBe(2);
  });

  it('allows_credit defaults to true when omitted; every optional field round-trips for a manage holder; all six kinds are accepted', { timeout: T }, async () => {
    const { db, svc } = setup();
    const out = await create(db, svc, { name: 'Synthetic Company', kind: 'company', ...FULL });
    expect(out).toEqual({ id: out.id, party_code: 'CP00001', name: 'Synthetic Company', kind: 'company', allows_credit: true, ...FULL, is_active: true, version: 1 });
    expect(db.row(out.id)).toMatchObject({ allows_credit: true, ...FULL });
    for (const kind of ['hospital', 'company', 'clinic', 'partner_lab', 'insurer', 'other']) expect((await create(db, svc, { name: `K ${kind}`, kind })).kind).toBe(kind);
  });

  it('AC-12.2 (storage side): an affiliation with allows_credit=false is stored and returned as false (C4 refuses credit mode on it); it is a normal, active, listed party', { timeout: T }, async () => {
    const { db, svc } = setup();
    const out = await create(db, svc, { name: 'Synthetic Affiliate Clinic', kind: 'clinic', allows_credit: false });
    expect(out.allows_credit).toBe(false);
    expect(db.row(out.id)).toMatchObject({ allows_credit: false, is_active: true });
    expect(await get(db, svc, out.id)).toMatchObject({ allows_credit: false, is_active: true });
    expect(codes(await list(db, svc))).toEqual([out.party_code]);
  });

  it('sequential auto codes CP00001, CP00002, CP00003; counter row lazily created with the actor under key party_code; tenants count independently; the doctor_code counter is separate', { timeout: T }, async () => {
    const { db, svc } = setup({ code_counters: [ctr(A, 9, 'doctor_code')] }, [READ, MANAGE], { state: { [A]: { rootId: ROOT_A, revision: 417 }, [B]: { rootId: ROOT_A, revision: 1 } } });
    expect(db.counter()).toBeUndefined();
    const seq: string[] = [];
    for (let i = 1; i <= 3; i++) seq.push((await create(db, svc, { name: `Seq ${i}`, kind: 'other' })).party_code);
    expect(seq).toEqual(['CP00001', 'CP00002', 'CP00003']);
    expect(db.counter()).toBe(4);
    expect(db.rows('code_counters', A).find((r) => r.counter_key === 'party_code')).toMatchObject({ created_by: USER });
    expect(db.counter(A, 'doctor_code')).toBe(9);                                  // untouched
    expect((await create(db, svc, { name: 'Other Lab', kind: 'other' }, { tenantId: B })).party_code).toBe('CP00001');
    expect(db.counter(B)).toBe(2);
    expect(db.counter()).toBe(4);
  });

  it.each([[41, 'CP00041'], [99999, 'CP99999'], [100000, 'CP100000']])('an existing counter at next_value %i issues %s (pattern CP{seq:5}: zero-padded to 5, longer numbers are not truncated) and advances', { timeout: T }, async (n, expected) => {
    const { db, svc } = setup({ code_counters: [ctr(A, n)] });
    expect((await create(db, svc, { name: 'Counter', kind: 'other' })).party_code).toBe(expected);
    expect(db.counter()).toBe(n + 1);
  });

  it('race: five concurrent auto-code creates -> five distinct consecutive codes (row-locked counter), counter 6, five events, revision +5', { timeout: T }, async () => {
    const { db, svc } = setup();
    const res = await Promise.all([1, 2, 3, 4, 5].map((n) => create(db, svc, { name: `Race ${n}`, kind: 'other' }, { at: at(n) })));
    expect(res.map((r) => r.party_code).sort()).toEqual(['CP00001', 'CP00002', 'CP00003', 'CP00004', 'CP00005']);
    expect(db.counter()).toBe(6);
    expect(db.rows('credit_parties')).toHaveLength(5);
    expect(events(db)).toHaveLength(5);
    expect(db.revisionOf(A)).toBe(422);
  });

  it('the counter advance is part of the create transaction: a failed create (event insert fails / insert fails) or a rollback leaves the counter and the next code untouched', { timeout: T }, async () => {
    const seeded = setup({ code_counters: [ctr(A, 7)] });
    seeded.db.fail(/INSERT INTO core\.event_log/i);
    await rejection(create(seeded.db, seeded.svc, { name: 'Fails', kind: 'other' }));
    expect(seeded.db.counter()).toBe(7);
    expect(seeded.db.rows('credit_parties')).toHaveLength(0);
    const fresh = setup();
    await rejection(create(fresh.db, fresh.svc, { name: 'Rolled Back', kind: 'other' }, { rollback: true }));
    expect([undefined, 1]).toContain(fresh.db.counter());
    expect(fresh.db.rows('credit_parties')).toHaveLength(0);
    expect((await create(fresh.db, fresh.svc, { name: 'After', kind: 'other' })).party_code).toBe('CP00001');
    const noRow = setup(); noRow.db.fail(/INSERT INTO catalog\.credit_parties\b/i);
    await rejection(create(noRow.db, noRow.svc, { name: 'Insert Fails', kind: 'other' }));
    expect([undefined, 1]).toContain(noRow.db.counter());
    expect(events(noRow.db)).toHaveLength(0);
  });

  it('event catalog.changed.v1 {entity_type credit_party, change_kind created, entity_id = new id} in the same transaction; revision +1; insert before event', { timeout: T }, async () => {
    const { db, svc } = setup();
    const out = await create(db, svc, { name: 'Event Party', kind: 'insurer' });
    const ev = events(db);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.envelope.payload).toMatchObject({ catalog_revision: 418, entity_type: 'credit_party', entity_id: out.id, change_kind: 'created' });
    expect(db.revisionOf(A)).toBe(418);
    const mine = stmtsOf(db);
    const insertAt = mine.findIndex((s) => /^\s*INSERT\s+INTO\s+catalog\.credit_parties\b/i.test(s.text));
    expect(insertAt).toBeGreaterThanOrEqual(0);
    expect(mine.findIndex((s) => /INSERT INTO core\.event_log/i.test(s.text))).toBeGreaterThan(insertAt);
    expect(new Set(mine.map((s) => s.txId)).size).toBe(1);
  });

  it('first write of a tenant with no catalog_state row works (revision 1)', { timeout: T }, async () => {
    const { db, svc } = setup({}, [READ, MANAGE], {});
    await create(db, svc, { name: 'First', kind: 'other' });
    expect(db.revisionOf(A)).toBe(1);
  });

  it.each([[' cp-77 ', 'CP-77'], ['cp_77', 'CP_77'], ['\tCp77\n', 'CP77'], ['x'.repeat(20), 'X'.repeat(20)]])('explicit code %j is trimmed and upper-cased (TRD §5.0) and does not consume the counter', { timeout: T }, async (raw, stored) => {
    const { db, svc } = setup({ code_counters: [ctr(A, 5)] });
    const out = await create(db, svc, { party_code: raw, name: 'Explicit', kind: 'other' });
    expect(out.party_code).toBe(stored);
    expect(db.row(out.id)!.party_code).toBe(stored);
    expect(db.counter()).toBe(5);
  });

  it.each([['same code', 'CPSEED1'], ['lower-case', 'cpseed1'], ['padded', ' CPSEED1 ']])('explicit code taken (%s) -> 409 catalog.code_duplicate — no row, no event, no revision bump, counter untouched', { timeout: T }, async (_n, raw) => {
    const { db, svc } = setup({ credit_parties: [cp(1, A)], code_counters: [ctr(A, 5)] });
    lims(await rejection(create(db, svc, { party_code: raw, name: 'Clash', kind: 'other' })), 'catalog.code_duplicate', 409);
    expect(db.rows('credit_parties')).toHaveLength(1);
    expect(events(db)).toHaveLength(0);
    expect(db.revisionOf(A)).toBe(417);
    expect(db.counter()).toBe(5);
  });

  it('an INACTIVE party still owns its code; another tenant owning the same code does not block (AC-01.3 pattern)', { timeout: T }, async () => {
    const { db, svc } = setup({ credit_parties: [cp(1, A, { is_active: false }), cp(94, B, { party_code: 'THEIRS' })] });
    lims(await rejection(create(db, svc, { party_code: 'CPSEED1', name: 'Again', kind: 'other' })), 'catalog.code_duplicate', 409);
    expect((await create(db, svc, { party_code: 'THEIRS', name: 'Mine', kind: 'other' })).party_code).toBe('THEIRS');
    expect(db.row(cp(94, B).id)).toMatchObject({ party_code: 'THEIRS', version: 1, name: 'Synthetic Party 94' });
    expect(events(db, B)).toHaveLength(0);
  });

  it('race: two concurrent creates with the same explicit code -> one wins, the loser gets catalog.code_duplicate (not a raw 23505)', { timeout: T }, async () => {
    const { db, svc } = setup();
    const res = await Promise.allSettled([create(db, svc, { party_code: 'RACE', name: 'One', kind: 'other' }, { at: at(1) }), create(db, svc, { party_code: 'RACE', name: 'Two', kind: 'other' }, { at: at(2) })]);
    expect(res.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    lims((res.find((x) => x.status === 'rejected') as PromiseRejectedResult).reason, 'catalog.code_duplicate', 409);
    expect(db.rows('credit_parties')).toHaveLength(1);
    expect(events(db)).toHaveLength(1);
  });

  it('the unique index is the guard: a 23505 from credit_parties__tenant_id_party_code__uq (raced past any pre-read) is mapped to 409 catalog.code_duplicate', { timeout: T }, async () => {
    const { db, svc } = setup();
    db.fail(/INSERT INTO catalog\.credit_parties\b/i, () => pgError('23505', 'duplicate key value violates unique constraint "credit_parties__tenant_id_party_code__uq"', 'credit_parties__tenant_id_party_code__uq'));
    const e = await rejection(create(db, svc, { party_code: 'RACE', name: 'One', kind: 'other' }));
    lims(e, 'catalog.code_duplicate', 409);
    expect(e.code).not.toBe('23505');
    expect(events(db)).toHaveLength(0);
  });

  it('boundaries: 160-char name, 20-char pan, 254-char e-mail, 500-char address, 8- and 15-digit phones, 20-char code are all accepted', { timeout: T }, async () => {
    const { db, svc } = setup();
    const email = `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(55)}.com`;
    expect(email.length).toBeLessThanOrEqual(254);
    const out = await create(db, svc, { party_code: 'C'.repeat(20), name: 'n'.repeat(160), kind: 'other', pan: 'p'.repeat(20), billing_address: 'x'.repeat(500), contact_email: email, contact_phone_e164: '+12345678' });
    expect(out.name).toHaveLength(160);
    expect(db.row(out.id)).toMatchObject({ pan: 'p'.repeat(20), billing_address: 'x'.repeat(500), contact_email: email, contact_phone_e164: '+12345678' });
    await create(db, svc, { name: 'Long Phone', kind: 'other', contact_phone_e164: '+123456789012345' });
  });

  it.each([
    ['name missing', { name: undefined }], ['name empty', { name: '' }], ['name only spaces', { name: '   ' }], ['name 161 chars', { name: 'n'.repeat(161) }], ['name number', { name: 5 }], ['name null', { name: null }],
    ['kind missing', { kind: undefined }], ['kind unknown', { kind: 'bank' }], ['kind wrong case', { kind: 'Hospital' }], ['kind number', { kind: 1 }], ['kind null', { kind: null }],
    ['allows_credit string', { allows_credit: 'true' }], ['allows_credit number', { allows_credit: 1 }], ['allows_credit null', { allows_credit: null }],
    ['pan 21 chars', { pan: 'p'.repeat(21) }], ['pan number', { pan: 123456789 }],
    ['email without @', { contact_email: 'plainaddress' }], ['email without domain', { contact_email: 'a@' }], ['email without local part', { contact_email: '@b.test' }], ['email 255 chars', { contact_email: `${'a'.repeat(250)}@b.cd` }],
    ['phone without +', { contact_phone_e164: '9779800000001' }], ['phone starting +0', { contact_phone_e164: '+0123456789' }], ['phone too short', { contact_phone_e164: '+1234567' }], ['phone too long', { contact_phone_e164: '+1234567890123456' }],
    ['phone with spaces', { contact_phone_e164: '+977 9800000001' }], ['phone with letters', { contact_phone_e164: '+97798000000a1' }], ['phone number type', { contact_phone_e164: 9779800000001 }],
    ['billing_address 501', { billing_address: 'x'.repeat(501) }],
    ['party_code with space', { party_code: 'CP 1' }], ['party_code with dot', { party_code: 'CP.1' }], ['party_code 21 chars', { party_code: 'C'.repeat(21) }],
    ['party_code Unicode letter that upper-cases to ASCII (ı)', { party_code: 'cpı' }], ['party_code number', { party_code: 12 }],
  ])('invalid body: %s -> 400 before any write (the service is also called by import commits, so it validates itself)', { timeout: T }, async (_n, over) => {
    const { db, svc } = setup();
    const body = Object.fromEntries(Object.entries({ name: 'Valid Party', kind: 'hospital', ...over }).filter(([, v]) => v !== undefined));
    validation400(await rejection(create(db, svc, body)));
    expect(writes(db)).toEqual([]);
    expect(events(db)).toHaveLength(0);
  });

  it.each([['tenant_id', { tenant_id: B }], ['id', { id: ID(0xbad) }], ['version', { version: 9 }], ['is_active', { is_active: false }], ['price_list_id', { price_list_id: ID(0x5) }],
    ['created_by', { created_by: ID(1) }], ['updated_by', { updated_by: ID(1) }], ['unset', { unset: ['pan'] }],
    ['AC-12.3 credit_limit', { credit_limit: 100000 }], ['AC-12.3 credit_days', { credit_days: 30 }], ['AC-12.3 balance', { balance: 0 }], ['AC-12.3 outstanding_balance', { outstanding_balance: 0 }],
    ['__proto__ key', JSON.parse('{"__proto__": {"allows_credit": true}}')],
  ])('S-5 / AC-12.3: mass assignment (%s) -> 400, nothing written (C3 stores no credit limit, days or balance; C4 owns them)', { timeout: T }, async (_n, extra) => {
    const { db, svc } = setup();
    validation400(await rejection(create(db, svc, { name: 'Valid', kind: 'hospital', ...extra })));
    expect(writes(db)).toEqual([]);
    expect(db.rows('credit_parties')).toHaveLength(0);
  });

  it('a non-object body is a 400, not a crash', { timeout: T }, async () => {
    const { db, svc } = setup();
    for (const body of [null, 'Valid', 7, [{ name: 'Valid', kind: 'other' }]]) validation400(await rejection(create(db, svc, body as never)));
  });

  it('REQ-SEC-088/089 data side: markup / quotes / SQL fragments are stored and returned verbatim and never reach SQL text; all values are bind parameters', { timeout: T }, async () => {
    const nasty = "<img src=x onerror=alert(1)> & \"q\" ' ; DROP TABLE catalog.credit_parties; --";
    const { db, svc } = setup();
    const out = await create(db, svc, { name: nasty, kind: 'other', billing_address: nasty, pan: 'bound-0xC0FFEE' });
    expect(out.name).toBe(nasty);
    expect(db.row(out.id)).toMatchObject({ name: nasty, billing_address: nasty });
    for (const s of db.stmts) { expect(s.text).not.toContain('DROP TABLE'); expect(s.text).not.toContain('bound-0xC0FFEE'); }
    const ins = db.stmts.filter((s) => /^\s*INSERT\s+INTO\s+catalog\.credit_parties\b/i.test(s.text));
    expect(ins.some((s) => s.values.includes('bound-0xC0FFEE') && s.values.includes(A))).toBe(true);
    expect(db.stmts.filter((s) => /^\s*DELETE\b/i.test(s.text))).toEqual([]);
  });

  it('AB-20: errors never echo submitted values (validation, duplicate code, unknown field)', { timeout: T }, async () => {
    const planted = 'PLANTED-TOKEN-9c2d';
    const { db, svc } = setup({ credit_parties: [cp(1, A)] });
    const errs = [
      await rejection(create(db, svc, { party_code: 'CPSEED1', name: planted, kind: 'other' })),
      await rejection(create(db, svc, { name: planted, kind: planted })),
      await rejection(create(db, svc, { name: planted, kind: 'other', contact_phone_e164: `+${planted}` })),
      await rejection(create(db, svc, { name: planted, kind: 'other', contact_email: planted })),
      await rejection(create(db, svc, { name: planted, kind: 'other', [planted]: planted })),
      await rejection(create(db, svc, { name: 'x'.repeat(161) + planted, kind: 'other' })),
    ];
    for (const e of errs) expect(JSON.stringify({ m: e.message, d: e.detail, errs: e.errors })).not.toContain(planted);
  });
});

// ====================================================================================================== GET + ALLOW-LIST
describe('getCreditParty (#69) and the sensitive-field allow-list — AC-12.4, S-11, AB-22, REQ-SEC-081', () => {
  const full = cp(1, A, { allows_credit: false, ...FULL, version: 3 });

  it('a holder of catalog.price_list.manage gets the full CreditParty (pan, phone, e-mail, address included); exact keys, no internal columns', { timeout: T }, async () => {
    const { db, svc } = setup({ credit_parties: [full] });
    const out = await get(db, svc, full.id);
    expect(out).toEqual({ id: full.id, party_code: 'CPSEED1', name: 'Synthetic Party 1', kind: 'hospital', allows_credit: false, ...FULL, is_active: true, version: 3 });
    for (const k of ['tenant_id', 'created_by', 'updated_by', 'created_at', 'updated_at', 'price_list_id']) expect(out).not.toHaveProperty(k);
  });

  it('AC-12.4: a front_desk-style actor (catalog.price_list.read, NOT manage) reads the party -> pan, contact_phone_e164, contact_email, billing_address are ABSENT (not null, not masked); the rest of the record is returned', { timeout: T }, async () => {
    const { db, svc, identity } = setup({ credit_parties: [full] }, [READ]);
    const out = await get(db, svc, full.id);
    noSensitive(out);
    const dump = JSON.stringify(out);
    for (const v of Object.values(FULL)) expect(dump).not.toContain(v);
    expect(out).toEqual({ id: full.id, party_code: 'CPSEED1', name: 'Synthetic Party 1', kind: 'hospital', allows_credit: false, is_active: true, version: 3 });
    expect(identity.calls.some((c) => c.method === 'getActor')).toBe(true);
  });

  it('the allow-list is keyed on catalog.price_list.manage only: read + referrer/test permissions (any other manage) still do not unlock the fields', { timeout: T }, async () => {
    const { db, svc } = setup({ credit_parties: [full] }, [READ, 'catalog.referrer.manage', 'catalog.test.manage', 'catalog.referrer.read', 'catalog.test.read']);
    noSensitive(await get(db, svc, full.id));
  });

  it('an actor with an empty permission set also gets no sensitive field', { timeout: T }, async () => {
    const { db, svc } = setup({ credit_parties: [full] }, []);
    const out = await get(db, svc, full.id).then((r) => r, (e) => ({ rejected: e?.code }));
    noSensitive(out);
  });

  it('a party without optional fields: a manage holder gets no null-valued keys (absent, not null)', { timeout: T }, async () => {
    const { db, svc } = setup({ credit_parties: [cp(2, A)] });
    const out = await get(db, svc, cp(2, A).id);
    expect(Object.keys(out).sort()).toEqual(['allows_credit', 'id', 'is_active', 'kind', 'name', 'party_code', 'version']);
  });

  it('fail closed: if the actor lookup fails, getCreditParty fails (it must not fall back to returning pan / contacts / address)', { timeout: T }, async () => {
    const { db, identity } = setup({ credit_parties: [full] });
    (identity as any).getActor = async () => { throw Object.assign(new Error('boom'), { code: 'auth.unauthenticated' }); };
    const svc = createCreditPartiesService({ events: createEvents({ producer: 'catalog' } as never), identity } as never) as unknown as Svc;
    const e = await db.run((ctx) => svc['getCreditParty']!(ctx, { id: full.id })).then((r) => ({ leaked: JSON.stringify(r) }), (x) => x);
    for (const v of Object.values(FULL)) expect(e.leaked ?? '').not.toContain(v);
  });

  it('an inactive party can be read (is_active=false in the DTO)', { timeout: T }, async () => {
    const { db, svc } = setup({ credit_parties: [cp(1, A, { is_active: false })] });
    expect(await get(db, svc, cp(1, A).id)).toMatchObject({ is_active: false });
  });

  it('unknown id -> 404; S-1: tenant B\'s id -> 404 (same answer, no B value in the error); malformed id -> 400', { timeout: T }, async () => {
    const { db, svc } = setup({ credit_parties: [cp(91, B, { contact_phone_e164: P2, pan: 'BPAN-1' })] });
    for (const id of [ID(0xdead), cp(91, B).id]) { const e = await rejection(get(db, svc, id)); lims(e, 'common.not_found', 404); expect(JSON.stringify([e.message, e.detail])).not.toMatch(/9779800000002|BPAN-1/); }
    validation400(await rejection(get(db, svc, 'not-a-uuid')));
  });

  it('read-only: no INSERT/UPDATE/event/revision change', { timeout: T }, async () => {
    const { db, svc } = setup({ credit_parties: [full] });
    await get(db, svc, full.id);
    expect(writes(db)).toEqual([]);
    expect(events(db)).toHaveLength(0);
    expect(db.revisionOf(A)).toBe(417);
  });
});

// ====================================================================================================== LIST
describe('listCreditParties (#67)', () => {
  const rows = () => [
    cp(1, A, { party_code: 'CP00001', kind: 'hospital', allows_credit: true, created_at: new Date(Date.UTC(2026, 0, 1)), ...FULL }),
    cp(2, A, { party_code: 'CP00002', kind: 'company', allows_credit: false, created_at: new Date(Date.UTC(2026, 0, 2)), contact_phone_e164: P2 }),
    cp(3, A, { party_code: 'CP00003', kind: 'hospital', allows_credit: false, created_at: new Date(Date.UTC(2026, 0, 3)) }),
    cp(4, A, { party_code: 'LAB1', kind: 'partner_lab', allows_credit: true, created_at: new Date(Date.UTC(2026, 0, 4)) }),
    cp(5, A, { party_code: 'CP00005', kind: 'clinic', is_active: false, created_at: new Date(Date.UTC(2026, 0, 5)) }),
    cp(6, A, { party_code: 'OLD1', kind: 'hospital', allows_credit: false, is_active: false, created_at: new Date(Date.UTC(2026, 0, 6)) }),
    cp(92, B, { party_code: 'BONLY', name: 'B Secret Party', ...FULL }),
  ];

  it('default: ACTIVE parties of the tenant only; each item is exactly a CreditParty (manage holder sees sensitive fields); page.limit 50', { timeout: T }, async () => {
    const { db, svc } = setup({ credit_parties: rows() });
    const out = await list(db, svc);
    expect(codes(out).sort()).toEqual(['CP00001', 'CP00002', 'CP00003', 'LAB1']);
    expect(out.page.limit).toBe(50);
    expect(out.data.find((x: Row) => x.party_code === 'CP00001')).toEqual({ id: cp(1, A).id, party_code: 'CP00001', name: 'Synthetic Party 1', kind: 'hospital', allows_credit: true, ...FULL, is_active: true, version: 1 });
    for (const x of out.data) for (const k of Object.keys(x)) expect(DTO_KEYS).toContain(k);
    expect(JSON.stringify(out)).not.toMatch(/BONLY|B Secret/);
  });

  it('AB-22 / AC-12.4: the LIST also applies the allow-list — without catalog.price_list.manage no item carries pan / phone / e-mail / address (they are in the data, so absence is the mapper\'s doing)', { timeout: T }, async () => {
    const { db, svc } = setup({ credit_parties: rows() }, [READ]);
    const out = await list(db, svc, { is_active: 'all' });
    expect(out.data.length).toBe(6);
    for (const x of out.data) noSensitive(x);
    expect(JSON.stringify(out)).not.toMatch(/123456789|9779800000001|9779800000002|billing@example\.test|Synthetic Street/);
    expect(out.data.find((x: Row) => x.party_code === 'CP00002')).toEqual({ id: cp(2, A).id, party_code: 'CP00002', name: 'Synthetic Party 2', kind: 'company', allows_credit: false, is_active: true, version: 1 });
  });

  it.each([
    [{ is_active: 'all' }, ['CP00001', 'CP00002', 'CP00003', 'CP00005', 'LAB1', 'OLD1']], [{ is_active: 'false' }, ['CP00005', 'OLD1']], [{ is_active: 'true' }, ['CP00001', 'CP00002', 'CP00003', 'LAB1']],
    [{ kind: 'hospital' }, ['CP00001', 'CP00003']], [{ kind: 'hospital', is_active: 'all' }, ['CP00001', 'CP00003', 'OLD1']], [{ kind: 'partner_lab' }, ['LAB1']], [{ kind: 'insurer' }, []],
    [{ allows_credit: true }, ['CP00001', 'LAB1']], [{ allows_credit: false }, ['CP00002', 'CP00003']], [{ allows_credit: false, is_active: 'all' }, ['CP00002', 'CP00003', 'OLD1']],
    [{ kind: 'hospital', allows_credit: false }, ['CP00003']],
  ])('filter %j -> %j', { timeout: T }, async (q, expected) => {
    const { db, svc } = setup({ credit_parties: rows() });
    expect(codes(await list(db, svc, q)).sort()).toEqual(expected);
  });

  it.each([['CP', ['CP00001', 'CP00002', 'CP00003']], ['cp', ['CP00001', 'CP00002', 'CP00003']], ['  cp0000 ', ['CP00001', 'CP00002', 'CP00003']], ['LAB1', ['LAB1']], ['P0000', []], ['AB', []], ['CP00003', ['CP00003']]])
  ('q %j is a code PREFIX (trimmed, case-insensitive; a code merely containing q does not match; names are not searched)', { timeout: T }, async (q, expected) => {
    const { db, svc } = setup({ credit_parties: rows() });
    expect(codes(await list(db, svc, { q })).sort()).toEqual(expected);
  });

  it('q is not matched against names ("Synthetic" matches nothing) and combines with the other filters', { timeout: T }, async () => {
    const { db, svc } = setup({ credit_parties: rows() });
    expect(codes(await list(db, svc, { q: 'Synthetic' }))).toEqual([]);
    expect(codes(await list(db, svc, { q: 'cp', allows_credit: false })).sort()).toEqual(['CP00002', 'CP00003']);
    expect(codes(await list(db, svc, { q: 'cp', is_active: 'all', kind: 'clinic' }))).toEqual(['CP00005']);
  });

  it('REQ-SEC-082: % and _ in q are literals, not wildcards (escaped LIKE); a lone wildcard / backslash returns nothing and does not crash; q is a bind parameter', { timeout: T }, async () => {
    const { db, svc } = setup({ credit_parties: [...rows(), cp(7, A, { party_code: 'A_B' }), cp(8, A, { party_code: 'AXB' }), cp(9, A, { party_code: 'A%B' })] });
    expect(codes(await list(db, svc, { q: 'A_' })).sort()).toEqual(['A_B']);
    expect(codes(await list(db, svc, { q: 'A%' })).sort()).toEqual(['A%B']);
    for (const q of ['%', '_', '\\', '%%', "';DROP TABLE x;--"]) expect(codes(await list(db, svc, { q })), q).toEqual([]);
    for (const s of db.stmts) { expect(s.text).not.toContain('DROP TABLE'); }
  });

  it('q of exactly 20 characters is accepted; 21 -> 400', { timeout: T }, async () => {
    const { db, svc } = setup({ credit_parties: rows() });
    expect(codes(await list(db, svc, { q: 'C'.repeat(20) }))).toEqual([]);
    validation400(await rejection(list(db, svc, { q: 'C'.repeat(21) })));
  });

  it('cursor paging with limit 2 visits every row exactly once (is_active=all), page.limit echoes the limit, the last page has no next_cursor', { timeout: T }, async () => {
    const { db, svc } = setup({ credit_parties: rows() });
    const seen: string[] = []; let cursor: string | undefined; let pages = 0;
    for (let i = 0; i < 6; i++) {
      const p = await list(db, svc, { is_active: 'all', limit: 2, ...(cursor ? { cursor } : {}) });
      expect(p.page.limit).toBe(2);
      seen.push(...codes(p)); pages++;
      cursor = p.page.next_cursor;
      if (!cursor) break;
    }
    expect([...seen].sort()).toEqual(['CP00001', 'CP00002', 'CP00003', 'CP00005', 'LAB1', 'OLD1']);
    expect(new Set(seen).size).toBe(6);
    expect(pages).toBe(3);
    expect(cursor).toBeUndefined();
  });

  it('equal created_at values are tie-broken (stable paging): five rows with one created_at are each visited once', { timeout: T }, async () => {
    const same = new Date(Date.UTC(2026, 2, 3));
    const { db, svc } = setup({ credit_parties: [1, 2, 3, 4, 5].map((n) => cp(n, A, { party_code: `S${n}`, created_at: same })) });
    const seen: string[] = []; let cursor: string | undefined;
    for (let i = 0; i < 5; i++) { const p = await list(db, svc, { limit: 2, ...(cursor ? { cursor } : {}) }); seen.push(...codes(p)); cursor = p.page.next_cursor; if (!cursor) break; }
    expect([...seen].sort()).toEqual(['S1', 'S2', 'S3', 'S4', 'S5']);
    expect(new Set(seen).size).toBe(5);
  });

  it('limit 200 is accepted', { timeout: T }, async () => {
    const { db, svc } = setup({ credit_parties: rows() });
    expect((await list(db, svc, { limit: 200 })).page.limit).toBe(200);
  });

  it.each([[{ is_active: 'maybe' }], [{ kind: 'bank' }], [{ kind: 'Hospital' }], [{ allows_credit: 'perhaps' }], [{ allows_credit: 1 }], [{ sort: 'name' }], [{ limit: 0 }], [{ limit: 201 }], [{ limit: 1.5 }], [{ bogus: 1 }], [{ cursor: '!!!' }], [{ q: 5 }]])
  ('bad query %j -> 400, no data', { timeout: T }, async (q) => {
    const { db, svc } = setup({ credit_parties: rows() });
    const e = await rejection(list(db, svc, q));
    expect(isLimsError(e)).toBe(true); expect(e.statusCode).toBe(400);
  });

  it('S-1: tenant B sees only its own parties', { timeout: T }, async () => {
    const { db, svc } = setup({ credit_parties: rows() });
    expect(codes(await list(db, svc, {}, B))).toEqual(['BONLY']);
  });

  it('read-only: no INSERT/UPDATE/event/revision change', { timeout: T }, async () => {
    const { db, svc } = setup({ credit_parties: rows() });
    await list(db, svc, { is_active: 'all', q: 'cp' });
    expect(writes(db)).toEqual([]);
    expect(events(db)).toHaveLength(0);
    expect(db.revisionOf(A)).toBe(417);
  });
});

// ====================================================================================================== UPDATE
describe('updateCreditParty (#70)', () => {
  const ID1 = cp(1, A).id;
  const base = () => cp(1, A, { allows_credit: true, ...FULL, version: 1 });

  it('patch -> 200 CreditParty with version+1; only the patched fields change (party_code never); event `updated` (entity credit_party) + revision +1 in the same transaction', { timeout: T }, async () => {
    const { db, svc } = setup({ credit_parties: [base()] });
    const out = await upd(db, svc, ID1, 1, { name: 'Renamed Hospital', kind: 'insurer', allows_credit: false, pan: '987654321', contact_phone_e164: P2, contact_email: 'new@example.test', billing_address: 'New Street 2' }, { at: at(3) });
    expect(out).toEqual({ id: ID1, party_code: 'CPSEED1', name: 'Renamed Hospital', kind: 'insurer', allows_credit: false, pan: '987654321', contact_phone_e164: P2, contact_email: 'new@example.test', billing_address: 'New Street 2', is_active: true, version: 2 });
    expect(db.row(ID1)).toMatchObject({ version: 2, updated_by: USER, party_code: 'CPSEED1' });
    expect(ms(db.row(ID1)!.updated_at)).toBe(+at(3));
    const ev = events(db);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.envelope.payload).toMatchObject({ catalog_revision: 418, entity_type: 'credit_party', entity_id: ID1, change_kind: 'updated' });
    expect(new Set(stmtsOf(db).map((s) => s.txId)).size).toBe(1);
  });

  it('AC-12.2 (storage side): flipping allows_credit true -> false (and back) is a plain update', { timeout: T }, async () => {
    const { db, svc } = setup({ credit_parties: [base()] });
    expect(await upd(db, svc, ID1, 1, { allows_credit: false })).toMatchObject({ allows_credit: false, version: 2 });
    expect(await upd(db, svc, ID1, 2, { allows_credit: true })).toMatchObject({ allows_credit: true, version: 3 });
    expect(events(db).map((e) => e.envelope.payload.change_kind)).toEqual(['updated', 'updated']);
  });

  it('unset[] clears optional fields (stored NULL, key absent from the DTO); other fields untouched', { timeout: T }, async () => {
    const { db, svc } = setup({ credit_parties: [base()] });
    const out = await upd(db, svc, ID1, 1, { unset: ['pan', 'contact_phone_e164'] });
    for (const k of ['pan', 'contact_phone_e164']) { expect(out, k).not.toHaveProperty(k); expect(db.row(ID1)![k], k).toBeNull(); }
    expect(out).toMatchObject({ contact_email: FULL.contact_email, billing_address: FULL.billing_address, version: 2 });
    const all = await upd(db, svc, ID1, 2, { unset: ['contact_email', 'billing_address'] });
    noSensitive(all);
    expect(all.version).toBe(3);
  });

  it('the response of an update follows the allow-list too (a read-only caller that somehow reaches the service gets no sensitive fields back)', { timeout: T }, async () => {
    const { db, svc } = setup({ credit_parties: [base()] }, [READ]);
    noSensitive(await upd(db, svc, ID1, 1, { name: 'Read Only Actor' }));
  });

  it.each([
    ['unset names a field also set', { pan: '1', unset: ['pan'] }], ['unset name (required)', { unset: ['name'] }], ['unset kind', { unset: ['kind'] }], ['unset party_code', { unset: ['party_code'] }],
    ['unset allows_credit', { unset: ['allows_credit'] }], ['unset is_active', { unset: ['is_active'] }], ['unset not an array', { unset: 'pan' }],
    ['unset 5 entries', { unset: ['pan', 'contact_phone_e164', 'contact_email', 'billing_address', 'pan'] }],
    ['name empty', { name: '' }], ['name only spaces', { name: '  ' }], ['name 161', { name: 'n'.repeat(161) }], ['kind unknown', { kind: 'bank' }], ['phone invalid', { contact_phone_e164: '12345' }],
    ['email invalid', { contact_email: 'nope' }], ['pan 21', { pan: 'p'.repeat(21) }], ['billing_address 501', { billing_address: 'x'.repeat(501) }],
    ['allows_credit string', { allows_credit: 'false' }], ['is_active string', { is_active: 'false' }],
  ])('invalid patch: %s -> 400, nothing written', { timeout: T }, async (_n, patch) => {
    const { db, svc } = setup({ credit_parties: [base()] });
    validation400(await rejection(upd(db, svc, ID1, 1, patch)));
    expect(writes(db)).toEqual([]);
    expect(db.row(ID1)!.version).toBe(1);
  });

  it.each([['party_code', { party_code: 'NEWCODE' }], ['tenant_id', { tenant_id: B }], ['version', { version: 9 }], ['id', { id: ID(0xbad) }], ['price_list_id', { price_list_id: ID(5) }],
    ['updated_by', { updated_by: ID(1) }], ['AC-12.3 credit_limit', { credit_limit: 1 }], ['AC-12.3 credit_days', { credit_days: 30 }], ['AC-12.3 balance', { balance: 5 }],
  ])('S-5 / AC-12.3: mass assignment (%s) -> 400, nothing written', { timeout: T }, async (_n, patch) => {
    const { db, svc } = setup({ credit_parties: [base(), cp(2, A)] });
    validation400(await rejection(upd(db, svc, ID1, 1, patch)));
    expect(writes(db)).toEqual([]);
    expect(db.row(ID1)).toMatchObject({ version: 1, party_code: 'CPSEED1' });
    expect(events(db)).toHaveLength(0);
  });

  it('is_active:false -> 200 and event change_kind `deactivated`; reactivating -> `updated`; an inactive party keeps its code', { timeout: T }, async () => {
    const { db, svc } = setup({ credit_parties: [base()] });
    expect(await upd(db, svc, ID1, 1, { is_active: false })).toMatchObject({ is_active: false, version: 2, party_code: 'CPSEED1' });
    expect(events(db).at(-1)!.envelope.payload).toMatchObject({ entity_type: 'credit_party', entity_id: ID1, change_kind: 'deactivated' });
    expect(await upd(db, svc, ID1, 2, { is_active: true })).toMatchObject({ is_active: true, version: 3 });
    expect(events(db).at(-1)!.envelope.payload).toMatchObject({ change_kind: 'updated' });
    expect(db.revisionOf(A)).toBe(419);
  });

  it('an empty patch is a 400 or a no-op that does not bump version / revision / events — never a silent version bump with no change', { timeout: T }, async () => {
    const { db, svc } = setup({ credit_parties: [base()] });
    const r = await upd(db, svc, ID1, 1, {}).then((x) => ({ ok: x }), (e) => ({ err: e }));
    if ('err' in r) validation400(r.err);
    else expect(r.ok.version).toBe(1);
    expect(db.row(ID1)!.version).toBe(1);
    expect(events(db)).toHaveLength(0);
    expect(db.revisionOf(A)).toBe(417);
  });

  it('If-Match: missing -> 428 common.precondition_required; stale -> 409 common.version_conflict; malformed -> 400; none of them writes', { timeout: T }, async () => {
    const { db, svc } = setup({ credit_parties: [{ ...base(), version: 3 }] });
    lims(await rejection(upd(db, svc, ID1, undefined, { name: 'x' })), 'common.precondition_required', 428);
    lims(await rejection(upd(db, svc, ID1, 2, { name: 'x' })), 'common.version_conflict', 409);
    for (const v of [0, -1, 1.5, 2 ** 31, '3' as never, null as never]) { const e = await rejection(upd(db, svc, ID1, v, { name: 'x' })); expect(isLimsError(e)).toBe(true); expect(e.statusCode).toBe(400); }
    expect(db.row(ID1)!.version).toBe(3);
    expect(writes(db)).toEqual([]);
    expect(events(db)).toHaveLength(0);
  });

  it('race: two concurrent updates with the same If-Match -> exactly one wins (version 2), the other gets 409 common.version_conflict', { timeout: T }, async () => {
    const { db, svc } = setup({ credit_parties: [base()] });
    const res = await Promise.allSettled([upd(db, svc, ID1, 1, { name: 'one' }, { at: at(1) }), upd(db, svc, ID1, 1, { name: 'two' }, { at: at(2) })]);
    expect(res.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    lims((res.find((x) => x.status === 'rejected') as PromiseRejectedResult).reason, 'common.version_conflict', 409);
    expect(db.row(ID1)!.version).toBe(2);
    expect(events(db)).toHaveLength(1);
  });

  it('unknown id -> 404; S-1: tenant B\'s id -> 404 and the B row is untouched; malformed id -> 400', { timeout: T }, async () => {
    const { db, svc } = setup({ credit_parties: [base(), cp(91, B, { contact_phone_e164: P2 })] });
    for (const id of [ID(0xdead), cp(91, B).id]) lims(await rejection(upd(db, svc, id, 1, { name: 'x' })), 'common.not_found', 404);
    validation400(await rejection(upd(db, svc, 'nope', 1, { name: 'x' })));
    expect(db.row(cp(91, B).id)).toMatchObject({ version: 1, name: 'Synthetic Party 91' });
    expect(events(db)).toHaveLength(0);
  });

  it('rollback / a failing event insert discards the update, the version and the revision together', { timeout: T }, async () => {
    const a = setup({ credit_parties: [base()] });
    await rejection(upd(a.db, a.svc, ID1, 1, { name: 'x' }, { rollback: true }));
    expect(a.db.row(ID1)).toMatchObject({ version: 1, name: 'Synthetic Party 1' }); expect(a.db.revisionOf(A)).toBe(417);
    const b = setup({ credit_parties: [base()] });
    b.db.fail(/INSERT INTO core\.event_log/i);
    await rejection(upd(b.db, b.svc, ID1, 1, { name: 'x' }));
    expect(b.db.row(ID1)).toMatchObject({ version: 1, name: 'Synthetic Party 1' }); expect(b.db.revisionOf(A)).toBe(417);
  });

  it('the UPDATE is optimistic and tenant-scoped explicitly in SQL (version predicate, tenant_id predicate), all values bound', { timeout: T }, async () => {
    const { db, svc } = setup({ credit_parties: [base()] });
    await upd(db, svc, ID1, 1, { billing_address: 'bound-addr-0xC0FFEE' });
    const u = db.stmts.filter((s) => /^\s*UPDATE\s+catalog\.credit_parties\b/i.test(s.text));
    expect(u.length).toBeGreaterThanOrEqual(1);
    for (const s of u) { expect(s.text).not.toContain('bound-addr-0xC0FFEE'); expect(s.text.split(/\bWHERE\b/i)[1] ?? '').toMatch(/\btenant_id\s*=\s*\$\d+/i); }
    expect(u.some((s) => /\bversion\s*=\s*\$\d+/i.test(s.text.split(/\bWHERE\b/i)[1] ?? '') && s.values.includes(ID1) && s.values.includes(A))).toBe(true);
  });
});

// ====================================================================================================== PROBES
describe('probes — S-1 tenant scoping in SQL, AC-12.3 shape, AB-22 across all four operations', () => {
  it('every statement on catalog.credit_parties / code_counters that reads or updates rows carries an explicit tenant_id predicate (defence in depth beside RLS)', { timeout: T }, async () => {
    const { db, svc } = setup({ credit_parties: [cp(1, A, FULL), cp(2, A), cp(91, B)] });
    await create(db, svc, { name: 'Probe', kind: 'other' });
    await get(db, svc, cp(1, A).id); await list(db, svc, { is_active: 'all', q: 'cp', limit: 1 });
    await upd(db, svc, cp(1, A).id, 1, { name: 'n' });
    const probed = stmtsOf(db).filter((s) => /^\s*(SELECT|UPDATE)\b[\s\S]*\bcatalog\.(credit_parties|code_counters)\b/i.test(s.text));
    expect(probed.length).toBeGreaterThanOrEqual(4);
    for (const s of probed) { expect(s.text.split(/\bWHERE\b/i)[1] ?? '', s.text).toMatch(/\btenant_id\s*=\s*\$\d+/i); expect(s.values).toContain(A); }
    expect(stmtsOf(db).filter((s) => /^\s*DELETE\b/i.test(s.text))).toEqual([]);
  });

  it('AC-12.3: no response (any operation) and no stored row carries credit_limit / credit_days / balance; no statement touches such a column', { timeout: T }, async () => {
    const { db, svc } = setup({ credit_parties: [cp(1, A, FULL)] });
    const seen: unknown[] = [];
    seen.push(await create(db, svc, { name: 'Shape', kind: 'hospital', allows_credit: false }), await get(db, svc, cp(1, A).id), await list(db, svc, { is_active: 'all' }), await upd(db, svc, cp(1, A).id, 1, { name: 'n' }));
    expect(JSON.stringify(seen)).not.toMatch(/credit_limit|credit_days|balance|outstanding/i);
    for (const r of db.rows('credit_parties')) expect(Object.keys(r).join(',')).not.toMatch(/credit_limit|credit_days|balance/);
    for (const s of db.stmts) expect(s.text).not.toMatch(/credit_limit|credit_days|balance/i);
  });

  it('AB-22: the same read-only actor gets NO sensitive field from any of the three read/write paths (list, get, update), whatever the row holds', { timeout: T }, async () => {
    const { db, svc } = setup({ credit_parties: [cp(1, A, FULL), cp(2, A, FULL)] }, [READ]);
    const seen = [await list(db, svc, { is_active: 'all' }), await get(db, svc, cp(1, A).id), await upd(db, svc, cp(2, A).id, 1, { allows_credit: false })];
    const dump = JSON.stringify(seen);
    for (const v of Object.values(FULL)) expect(dump).not.toContain(v);
    for (const k of SENSITIVE) expect(dump).not.toContain(`"${k}"`);
  });

  it('the sensitive values never appear in an event payload or in an error', { timeout: T }, async () => {
    const { db, svc } = setup({ credit_parties: [cp(1, A, FULL)] });
    await upd(db, svc, cp(1, A).id, 1, { pan: '555555555', contact_email: 'leak@example.test', billing_address: 'Leak Street 9', contact_phone_e164: P2 });
    await create(db, svc, { name: 'Ev', kind: 'other', pan: '777777777', contact_email: 'leak2@example.test' });
    const errs = [await rejection(create(db, svc, { name: 'Ev', kind: 'other', party_code: 'CPSEED1', pan: '888888888', contact_email: 'leak3@example.test' }))];
    const dump = JSON.stringify([db.events.map((e) => e.envelope), errs.map((e) => ({ m: e.message, d: e.detail, errs: e.errors }))]);
    expect(dump).not.toMatch(/555555555|777777777|888888888|leak|Leak Street|9779800000002/);
  });
});
