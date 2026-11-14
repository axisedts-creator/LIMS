// T-18 (C3) — surcharge rules #83–#85, tax types #86–#88, tax rules #89–#91 (the quote engine that CONSUMES them is T-19; domain rules are unit-tested in domain/__tests__/surcharge|tax.test.ts).
// Spec: 06-PLAN row T-18 (done_when: overlap rejection after the catalog_state lock; tenant-default successor ends its predecessor; open-rule unique index + mutable-columns triggers; panel department
//         rule; tax type without rate unusable; VAT row read-only; tax-type rates effective-dated — rate change = new version, never in place — 08 R18);
//       01-PRD AC-14.5 (overlap -> 400 common.validation_failed path /effective_from), AC-15.1 (default exempt + orderable taxable), AC-15.2 (tax type without a rate -> 400 path /other_tax_code),
//         AC-15.5 (successor tenant default ends the open one in the same transaction; dept / orderable overlap -> 400 /effective_from; a panel/package uses its own department_id, else none);
//       02-TRD §5.0 (If-Match 428/409), §5.1 SurchargeRule / TaxType / TaxRule, §5.2 rows 83–91, §7.5, §7.6 (overlap check AFTER the catalog_state lock; window half-open), §9.1 (events:
//         surcharge_rule created; tax type / tax rule -> entity_type `tax_rule`, created|updated|deactivated, a new rate version carries its effective_from);
//       05-SCHEMA surcharge_rules / cs_tax_types / tax_rules (+ __mutable_columns, __open__p_uq, tg_tax_rule_other_type — the TRIGGERS and INDEXES themselves are proven against real Postgres by
//         db/tests/catalog/T0B-10.C3_behaviour.test.sql; the fake in helpers/taxDb.ts models them so a service that writes a frozen column fails here too);
//       07-SECURITY S-1/S-5/AB-1/AB-3/AB-10 (tenant-B ids, closed bodies), S-6 (binds only), A2 (rows effective-dated, never edited after creation except effective_to / is_active).
// Real core `createEvents({producer:'catalog'})` over the SQL fake in helpers/taxDb.ts. The revision bump is T-03's real service — the writer must call it in the SAME transaction.
// Interface expected from the writer — SEAMS (catalog/service/pricing.service.ts: createPricingService(deps) returns these IN ADDITION to the T-17 methods):
//   listSurchargeRules(ctx, { scope?, active_at? })                                  -> { data: SurchargeRule[] }
//   createSurchargeRule(ctx, body)                                                   -> SurchargeRule
//   endSurchargeRule(ctx, { id, expectedVersion, body?: { effective_to? } })        -> SurchargeRule        (effective_to defaults to the transaction clock)
//   listTaxTypes(ctx, { active_at?, all_versions? })                                 -> { data: TaxType[] }  (global VAT row (scope 'global') + the tenant versions effective at active_at, default now)
//   createTaxType(ctx, body: { code, display, rate_bp?, effective_from? })           -> TaxType
//   updateTaxType(ctx, { id, expectedVersion, patch: { display?, rate_bp?, effective_from?, is_active? } }) -> TaxType (the version now current or scheduled)
//   listTaxRules(ctx, { scope?, active_at? })                                        -> { data: TaxRule[] }
//   createTaxRule(ctx, body)                                                         -> TaxRule
//   endTaxRule(ctx, { id, expectedVersion, body?: { effective_to? } })              -> TaxRule
//   DTOs = snake_case SurchargeRule / TaxType / TaxRule of contracts/openapi/catalog.yaml: absent optionals are OMITTED (never null); money = { amount_paisa, currency:'NPR' }; timestamps ISO UTC.
//   Single-table SQL only (taxDb.ts dialect). x-permission / aal2 / Idempotency-Key are the core pipeline's and are not re-tested here.
// Assumptions beyond the spec (so a failure here may be a spec gap, see .orchestra/notes/C3.T-18-tests.md): foreign/unknown department / orderable / price-list ids -> 400 OR 404 (never created);
//   the end-of-rule event kind is `updated` OR `deactivated`; creating tax type 'VAT' -> 400 OR 409; PATCH of the global VAT row -> any 4xx.
import { describe, expect, it } from 'vitest';
import { isLimsError } from '../../../../core/errors.js';
import { createEvents } from '../../../../core/events/publish.js';
import { createPricingService } from '../../service/pricing.service.js';
import { ROOT_A, TENANT_A, TENANT_B } from '../helpers/catalogDb.js';
import { type Row } from '../helpers/mastersDb.js';
import { MANAGE, READ, actorIdentity, dept, makeTaxDb, orderable, plist, srule, trule, ttype } from '../helpers/taxDb.js';

const T = 20_000;
type Svc = Record<string, (ctx: any, input?: any) => Promise<any>>;
const A = TENANT_A;
const B = TENANT_B;
const seedState = { state: { [A]: { rootId: ROOT_A, revision: 417 } } };
const NOW = new Date(Date.UTC(2026, 10, 7, 12, 0, 0));
const DAY = 86_400_000;
const iso = (d: Date) => d.toISOString();
const plus = (days: number) => new Date(NOW.getTime() + days * DAY);
const T0 = new Date('2026-01-01T00:00:00.000Z');                      // effective_from of every seeded rule / type version
const T1 = new Date('2026-06-01T00:00:00.000Z');

// ---- synthetic world -------------------------------------------------------------------------------------------------------------------------
const D1 = dept(1, A); const D2 = dept(2, A); const DB = dept(9, B);
const O1 = orderable(1, A, { code: 'CBC', kind: 'test', department_id: D1.id }); const O2 = orderable(2, A, { code: 'FBS', kind: 'test', department_id: D2.id });
const O3 = orderable(3, A, { code: 'LFT', kind: 'panel', department_id: null }); const OB = orderable(9, B, { code: 'BSECRET', kind: 'test' });
const LP = plist(1, A); const LB = plist(9, B);
const REFS = { departments: [D1, D2, DB], orderables: [O1, O2, O3, OB], price_lists: [LP, LB] };

const setup = (rows: Record<string, Row[]> = {}, o: { noVat?: boolean } = {}) => {
  const merged: Record<string, Row[]> = { ...REFS };
  for (const [k, v] of Object.entries(rows)) merged[k] = [...(merged[k] ?? []), ...v];
  const db = makeTaxDb({ rows: merged as never, catalog: seedState, ...o });
  const identity = actorIdentity([READ, MANAGE]);
  const svc = createPricingService({ events: createEvents({ producer: 'catalog' } as never), identity } as never) as unknown as Svc;
  return { db, svc };
};
type Db = ReturnType<typeof setup>['db'];
const rejection = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { expect(e, `crash: ${(e as Error)?.message}`).not.toBeInstanceOf(TypeError); return e; } throw new Error('expected rejection, got success'); };
const lims = (e: any, code: string, status: number) => { expect(isLimsError(e, code), `got ${e?.code ?? e?.message}`).toBe(true); expect(e.statusCode).toBe(status); };
const validation400 = (e: any, path?: string) => {
  expect(isLimsError(e), `got ${e?.code ?? e?.message}`).toBe(true); expect(e.statusCode).toBe(400); expect(['common.validation_failed', 'common.unknown_field']).toContain(e.code);
  if (path) { expect(e.code).toBe('common.validation_failed'); expect((e.errors ?? []).map((x: any) => x.path)).toContain(path); }
};
const client4xx = (e: any) => { expect(isLimsError(e), `got ${e?.code ?? e?.message}`).toBe(true); expect(e.statusCode).toBeGreaterThanOrEqual(400); expect(e.statusCode).toBeLessThan(500); };
const events = (db: Db, tenant = A) => db.events.filter((e) => e.tenantId === tenant && e.eventType === 'catalog.changed.v1');
const payloads = (db: Db, tenant = A) => events(db, tenant).map((e) => e.envelope.payload as Record<string, any>);
const ms = (v: unknown) => new Date(v as string | Date).getTime();
const snap = (db: Db) => JSON.stringify(['surcharge_rules', 'tax_rules', 'cs_tax_types', 'g_tax_types'].map((t) => db.rows(t as never)));
const dbWrites = (db: Db) => db.stmts.filter((s) => s.tenantId === A && /^\s*(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+catalog\./i.test(s.text));
const untouched = (db: Db, before: string) => { expect(snap(db)).toBe(before); expect(events(db)).toHaveLength(0); expect(db.revisionOf(A)).toBe(417); };

const run = <R>(db: Db, f: (ctx: any) => Promise<R>, o: { tenantId?: string; at?: Date } = {}) => db.run(f, { at: NOW, ...o });
const sList = (db: Db, svc: Svc, q: object = {}, tenantId = A) => run(db, (c) => svc['listSurchargeRules']!(c, q), { tenantId });
const sNew = (db: Db, svc: Svc, body: object, o: { tenantId?: string; at?: Date } = {}) => run(db, (c) => svc['createSurchargeRule']!(c, body), o);
const sEnd = (db: Db, svc: Svc, id: string, version: number | undefined, body?: object, o: { tenantId?: string } = {}) => run(db, (c) => svc['endSurchargeRule']!(c, { id, expectedVersion: version, body }), o);
const yList = (db: Db, svc: Svc, q: object = {}, tenantId = A) => run(db, (c) => svc['listTaxTypes']!(c, q), { tenantId });
const yNew = (db: Db, svc: Svc, body: object, o: { tenantId?: string } = {}) => run(db, (c) => svc['createTaxType']!(c, body), o);
const yUpd = (db: Db, svc: Svc, id: string, version: number | undefined, patch: object, o: { tenantId?: string } = {}) => run(db, (c) => svc['updateTaxType']!(c, { id, expectedVersion: version, patch }), o);
const rList = (db: Db, svc: Svc, q: object = {}, tenantId = A) => run(db, (c) => svc['listTaxRules']!(c, q), { tenantId });
const rNew = (db: Db, svc: Svc, body: object, o: { tenantId?: string } = {}) => run(db, (c) => svc['createTaxRule']!(c, body), o);
const rEnd = (db: Db, svc: Svc, id: string, version: number | undefined, body?: object, o: { tenantId?: string } = {}) => run(db, (c) => svc['endTaxRule']!(c, { id, expectedVersion: version, body }), o);
const money = (n: number) => ({ amount_paisa: n, currency: 'NPR' });
const sql = (db: Db, text: string, values: unknown[] = []) => run(db, (c) => c.tx.query(text, values));
const sqlCode = async (p: Promise<unknown>) => { try { await p; } catch (e: any) { return e.code as string; } return 'none'; };

// ============================================================================================================================================
describe('createSurchargeRule #84 — happy paths (AC-14.1 data, §5.1 SurchargeRule DTO, §9.1 event)', () => {
  it('flat all-tests rule: 201 DTO with amount {amount_paisa, currency}, no percent_bp, absent optionals omitted, version 1; row stored with tenant + actor', { timeout: T }, async () => {
    const { db, svc } = setup();
    const out = await sNew(db, svc, { scope: 'all', amount_kind: 'flat', amount: money(25_000), effective_from: iso(plus(1)) });
    expect(out).toEqual({ id: expect.any(String), scope: 'all', amount_kind: 'flat', amount: money(25_000), effective_from: iso(plus(1)), version: 1 });
    expect(Object.keys(out)).not.toContain('percent_bp');
    const rows = db.rows('surcharge_rules', A);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: out.id, scope: 'all', amount_kind: 'flat', amount_paisa: 25_000, percent_bp: null, department_id: null, orderable_id: null, price_list_id: null, effective_to: null, is_active: true, version: 1 });
  });
  it('AC-14.1 data: department rule HAEM percent 5000 bp -> percent_bp stored, no amount in the DTO', { timeout: T }, async () => {
    const { db, svc } = setup();
    const out = await sNew(db, svc, { scope: 'department', department_id: D1.id, amount_kind: 'percent', percent_bp: 5_000, effective_from: iso(NOW) });
    expect(out).toMatchObject({ scope: 'department', department_id: D1.id, amount_kind: 'percent', percent_bp: 5_000, effective_from: iso(NOW), version: 1 });
    expect(Object.keys(out)).not.toContain('amount');
    expect(db.rows('surcharge_rules', A)[0]).toMatchObject({ amount_paisa: null, percent_bp: 5_000, department_id: D1.id });
  });
  it('orderable rule scoped to a price list, with a bounded window', { timeout: T }, async () => {
    const { db, svc } = setup();
    const out = await sNew(db, svc, { scope: 'orderable', orderable_id: O1.id, price_list_id: LP.id, amount_kind: 'flat', amount: money(1), effective_from: iso(NOW), effective_to: iso(plus(30)) });
    expect(out).toMatchObject({ scope: 'orderable', orderable_id: O1.id, price_list_id: LP.id, effective_to: iso(plus(30)) });
    expect(db.rows('surcharge_rules', A)[0]).toMatchObject({ orderable_id: O1.id, price_list_id: LP.id });
  });
  it('boundary values: amount 1 and 999,999,999 paisa; percent_bp 1 and 100000', { timeout: T }, async () => {
    const { db, svc } = setup();
    for (const [i, b] of [{ amount_kind: 'flat', amount: money(1) }, { amount_kind: 'flat', amount: money(999_999_999) }, { amount_kind: 'percent', percent_bp: 1 }, { amount_kind: 'percent', percent_bp: 100_000 }].entries()) {
      const out = await sNew(db, svc, { scope: 'orderable', orderable_id: [O1, O2, O3, O1][i]!.id, ...b, effective_from: iso(i === 3 ? plus(400) : NOW), effective_to: i === 3 ? undefined : iso(plus(10)) });
      expect(out.id).toEqual(expect.any(String));
    }
    expect(db.rows('surcharge_rules', A)).toHaveLength(4);
  });
  it('publishes exactly ONE catalog.changed.v1 {entity_type surcharge_rule, entity_id = the rule id, created, effective_from = the rule\'s}; revision +1; same transaction', { timeout: T }, async () => {
    const { db, svc } = setup();
    const out = await sNew(db, svc, { scope: 'all', amount_kind: 'flat', amount: money(500), effective_from: iso(plus(2)) });
    expect(payloads(db)).toEqual([expect.objectContaining({ catalog_revision: 418, entity_type: 'surcharge_rule', entity_id: out.id, change_kind: 'created' })]);
    expect(ms(payloads(db)[0]!['effective_from'])).toBe(plus(2).getTime());
    expect(db.revisionOf(A)).toBe(418);
  });
  it('a failing event insert rolls the rule back (one transaction): no row, revision unchanged', { timeout: T }, async () => {
    const { db, svc } = setup();
    db.fail(/INSERT\s+INTO\s+core\.event_log/i);
    await rejection(sNew(db, svc, { scope: 'all', amount_kind: 'flat', amount: money(500), effective_from: iso(NOW) }));
    expect(db.rows('surcharge_rules', A)).toHaveLength(0); expect(db.revisionOf(A)).toBe(417);
  });
  it('node-pg returns bigint columns as strings: a seeded amount_paisa "25000" is served as the NUMBER 25000', { timeout: T }, async () => {
    const { db, svc } = setup({ surcharge_rules: [srule(1, A, { amount_paisa: '25000' })] });
    const out = await sList(db, svc);
    expect(out.data[0].amount).toEqual({ amount_paisa: 25_000, currency: 'NPR' });
  });
});

describe('createSurchargeRule — validation (S-5 closed bodies, AB-10, AB-3, 05-SCHEMA checks): nothing is written', () => {
  const base = { scope: 'all', amount_kind: 'flat', amount: money(100), effective_from: iso(NOW) };
  const BAD: Array<[string, object]> = [
    ['unknown field', { ...base, tenant_id: A }],
    ['server-owned field `version`', { ...base, version: 5 }],
    ['server-owned field `is_active`', { ...base, is_active: false }],
    ['missing scope', { amount_kind: 'flat', amount: money(100), effective_from: iso(NOW) }],
    ['missing amount_kind', { scope: 'all', amount: money(100), effective_from: iso(NOW) }],
    ['missing effective_from', { scope: 'all', amount_kind: 'flat', amount: money(100) }],
    ['scope not in enum', { ...base, scope: 'tenant' }],
    ['amount_kind not in enum', { ...base, amount_kind: 'tiered' }],
    ['scope all + department_id', { ...base, department_id: D1.id }],
    ['scope all + orderable_id', { ...base, orderable_id: O1.id }],
    ['scope department without department_id', { ...base, scope: 'department' }],
    ['scope department + orderable_id', { ...base, scope: 'department', department_id: D1.id, orderable_id: O1.id }],
    ['scope orderable without orderable_id', { ...base, scope: 'orderable' }],
    ['scope orderable + department_id', { ...base, scope: 'orderable', orderable_id: O1.id, department_id: D1.id }],
    ['department_id not a uuid', { ...base, scope: 'department', department_id: 'HAEM' }],
    ['flat without amount', { scope: 'all', amount_kind: 'flat', effective_from: iso(NOW) }],
    ['flat + percent_bp', { ...base, percent_bp: 5_000 }],
    ['percent without percent_bp', { scope: 'all', amount_kind: 'percent', effective_from: iso(NOW) }],
    ['percent + amount', { scope: 'all', amount_kind: 'percent', percent_bp: 5_000, amount: money(100), effective_from: iso(NOW) }],
    ['amount 0', { ...base, amount: money(0) }],
    ['amount 1,000,000,000', { ...base, amount: money(1_000_000_000) }],
    ['amount fractional', { ...base, amount: money(10.5) }],
    ['amount negative', { ...base, amount: money(-1) }],
    ['amount as string', { ...base, amount: money('100' as never) }],
    ['currency USD', { ...base, amount: { amount_paisa: 100, currency: 'USD' } }],
    ['amount with an extra key', { ...base, amount: { ...money(100), extra: 1 } }],
    ['amount as a bare number', { ...base, amount: 100 }],
    ['percent_bp 0', { scope: 'all', amount_kind: 'percent', percent_bp: 0, effective_from: iso(NOW) }],
    ['percent_bp 100001', { scope: 'all', amount_kind: 'percent', percent_bp: 100_001, effective_from: iso(NOW) }],
    ['percent_bp fractional', { scope: 'all', amount_kind: 'percent', percent_bp: 50.5, effective_from: iso(NOW) }],
    ['percent_bp as string', { scope: 'all', amount_kind: 'percent', percent_bp: '5000', effective_from: iso(NOW) }],
    ['effective_from not a string', { ...base, effective_from: 1_700_000_000 }],
    ['effective_from without a zone', { ...base, effective_from: '2026-11-07T12:00:00' }],
    ['effective_from garbage', { ...base, effective_from: 'tomorrow' }],
    ['effective_to before effective_from', { ...base, effective_to: iso(plus(-1)) }],
    ['effective_to garbage', { ...base, effective_to: 'never' }],
    ['body is an array', [base] as never],
    ['body is null', null as never],
  ];
  it.each(BAD)('%s -> 400, no row, no event, revision unchanged', { timeout: T }, async (_n, body) => {
    const { db, svc } = setup(); const before = snap(db);
    validation400(await rejection(sNew(db, svc, body)));
    untouched(db, before);
  });
  it('a tenant-B department / orderable / price list id, and an unknown id, are never accepted (AB-3): 400 or 404, no row', { timeout: T }, async () => {
    const unknown = '0190c300-0000-7000-8000-00000000ffff';
    for (const body of [
      { ...base, scope: 'department', department_id: DB.id }, { ...base, scope: 'department', department_id: unknown },
      { ...base, scope: 'orderable', orderable_id: OB.id }, { ...base, scope: 'orderable', orderable_id: unknown },
      { ...base, price_list_id: LB.id }, { ...base, price_list_id: unknown },
    ]) {
      const { db, svc } = setup(); const before = snap(db);
      client4xx(await rejection(sNew(db, svc, body)));
      untouched(db, before);
    }
  });
});

describe('createSurchargeRule — overlap rejection AFTER the catalog_state lock (AC-14.5, §7.5)', () => {
  const body = (o: object = {}) => ({ scope: 'department', department_id: D1.id, amount_kind: 'flat', amount: money(100), effective_from: iso(plus(1)), ...o });
  const EXISTING = srule(1, A, { scope: 'department', department_id: D1.id, effective_from: T0 });          // open-ended since T0

  it('AC-14.5: a second rule with an overlapping window for the same (scope, key, price list) -> 400 common.validation_failed path /effective_from; nothing written', { timeout: T }, async () => {
    const { db, svc } = setup({ surcharge_rules: [EXISTING] }); const before = snap(db);
    validation400(await rejection(sNew(db, svc, body())), '/effective_from');
    untouched(db, before);
  });
  it('a bounded existing window: a new window inside / straddling it overlaps; one starting at its end does not (half-open)', { timeout: T }, async () => {
    const existing = srule(1, A, { scope: 'department', department_id: D1.id, effective_from: plus(10), effective_to: plus(20) });
    for (const [from, to] of [[plus(12), plus(15)], [plus(5), plus(12)], [plus(15), plus(40)], [plus(5), plus(40)], [plus(19), undefined], [plus(10), plus(20)]] as const) {
      const { db, svc } = setup({ surcharge_rules: [existing] });
      validation400(await rejection(sNew(db, svc, body({ effective_from: iso(from), effective_to: to ? iso(to) : undefined }))), '/effective_from');
    }
    for (const [from, to] of [[plus(20), plus(30)], [plus(20), undefined], [plus(1), plus(10)]] as const) {
      const { db, svc } = setup({ surcharge_rules: [existing] });
      const out = await sNew(db, svc, body({ effective_from: iso(from), effective_to: to ? iso(to) : undefined }));
      expect(out.id).toEqual(expect.any(String));
    }
  });
  it('an open-ended NEW rule overlaps any existing rule that is open or ends after its start', { timeout: T }, async () => {
    const existing = srule(1, A, { scope: 'department', department_id: D1.id, effective_from: plus(10), effective_to: plus(20) });
    const { db, svc } = setup({ surcharge_rules: [existing] });
    validation400(await rejection(sNew(db, svc, body({ effective_from: iso(plus(5)) }))), '/effective_from');
  });
  it('different key / different scope / different price list do NOT conflict', { timeout: T }, async () => {
    const { db, svc } = setup({ surcharge_rules: [EXISTING] });
    await sNew(db, svc, body({ department_id: D2.id }));                                         // other department
    await sNew(db, svc, body({ scope: 'orderable', department_id: undefined, orderable_id: O1.id }));  // other scope, same instant
    await sNew(db, svc, body({ scope: 'all', department_id: undefined }));
    await sNew(db, svc, body({ price_list_id: LP.id }));                                        // list-scoped vs the unscoped existing
    expect(db.rows('surcharge_rules', A)).toHaveLength(5);
    validation400(await rejection(sNew(db, svc, body({ price_list_id: LP.id, effective_from: iso(plus(3)) }))), '/effective_from');   // same list twice
  });
  it('an INACTIVE existing rule does not block ("active surcharge rule", AC-14.5)', { timeout: T }, async () => {
    const { db, svc } = setup({ surcharge_rules: [{ ...EXISTING, is_active: false }] });
    expect((await sNew(db, svc, body())).id).toEqual(expect.any(String));
  });
  it('a tenant-B rule for the same key does not block tenant A (RLS)', { timeout: T }, async () => {
    const { db, svc } = setup({ surcharge_rules: [srule(9, B, { scope: 'department', department_id: DB.id })] });
    expect((await sNew(db, svc, body())).id).toEqual(expect.any(String));
  });
  it('the overlap check runs only AFTER the catalog_state row is locked (§3, §7.5)', { timeout: T }, async () => {
    const { db, svc } = setup({ surcharge_rules: [EXISTING] });
    await rejection(sNew(db, svc, body()));
    const idx = (re: RegExp) => db.stmts.findIndex((x) => re.test(x.text));
    const lock = Math.min(...[/FROM\s+catalog\.catalog_state[\s\S]*FOR UPDATE/i, /UPDATE\s+catalog\.catalog_state/i].map(idx).filter((i) => i >= 0));
    const overlap = idx(/FROM\s+catalog\.surcharge_rules/i);
    expect(lock).toBeGreaterThanOrEqual(0); expect(overlap).toBeGreaterThanOrEqual(0);
    expect(lock).toBeLessThan(overlap);
  });
  it('two concurrent creates with overlapping windows: exactly one is stored, the other gets 400 /effective_from', { timeout: T }, async () => {
    const { db, svc } = setup();
    const results = await Promise.allSettled([1, 2, 3, 4].map((n) => sNew(db, svc, body({ effective_from: iso(plus(n)), amount: money(100 * n) }))));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results) if (r.status === 'rejected') validation400(r.reason, '/effective_from');
    expect(db.rows('surcharge_rules', A)).toHaveLength(1);
    expect(events(db)).toHaveLength(1); expect(db.revisionOf(A)).toBe(418);
  });
});

describe('endSurchargeRule #85', () => {
  const R1 = srule(1, A, { scope: 'department', department_id: D1.id, effective_from: T0 });
  it('sets effective_to (default = the transaction clock), version +1, nothing else changes; response is the SurchargeRule', { timeout: T }, async () => {
    const { db, svc } = setup({ surcharge_rules: [R1] });
    const out = await sEnd(db, svc, R1.id as string, 1);
    expect(out).toMatchObject({ id: R1.id, scope: 'department', effective_to: iso(NOW), version: 2 });
    const row = db.row('surcharge_rules', R1.id as string)!;
    expect(ms(row.effective_to)).toBe(NOW.getTime()); expect(row).toMatchObject({ version: 2, scope: 'department', amount_paisa: 10_000, percent_bp: null, department_id: D1.id });
    expect(ms(row.effective_from)).toBe(T0.getTime());
  });
  it('explicit effective_to (future) is honoured; event kind updated|deactivated with entity_type surcharge_rule + revision +1', { timeout: T }, async () => {
    const { db, svc } = setup({ surcharge_rules: [R1] });
    const out = await sEnd(db, svc, R1.id as string, 1, { effective_to: iso(plus(5)) });
    expect(out.effective_to).toBe(iso(plus(5)));
    expect(payloads(db)).toEqual([expect.objectContaining({ entity_type: 'surcharge_rule', entity_id: R1.id, catalog_revision: 418 })]);
    expect(['updated', 'deactivated']).toContain(payloads(db)[0]!['change_kind']);
  });
  it('after ending, a new rule may start at the end instant (adjacent windows) — the rule history is kept, not rewritten', { timeout: T }, async () => {
    const { db, svc } = setup({ surcharge_rules: [R1] });
    await sEnd(db, svc, R1.id as string, 1, { effective_to: iso(plus(2)) });
    const next = await sNew(db, svc, { scope: 'department', department_id: D1.id, amount_kind: 'flat', amount: money(777), effective_from: iso(plus(2)) });
    expect(next.id).not.toBe(R1.id); expect(db.rows('surcharge_rules', A)).toHaveLength(2);
  });
  it('effective_to before the rule\'s effective_from -> 400; garbage -> 400; unknown body key -> 400; nothing changes', { timeout: T }, async () => {
    for (const body of [{ effective_to: iso(new Date('2025-12-31T00:00:00Z')) }, { effective_to: 'soon' }, { effective_to: 5 }, { effective_to: iso(NOW), is_active: false }]) {
      const { db, svc } = setup({ surcharge_rules: [R1] }); const before = snap(db);
      validation400(await rejection(sEnd(db, svc, R1.id as string, 1, body)));
      untouched(db, before);
    }
  });
  it('If-Match: missing -> 428 common.precondition_required, stale -> 409 common.version_conflict; unknown / tenant-B id -> 404 with zero rows changed (AB-1)', { timeout: T }, async () => {
    const other = srule(9, B, { scope: 'all' });
    const { db, svc } = setup({ surcharge_rules: [R1, other] }); const before = snap(db);
    lims(await rejection(sEnd(db, svc, R1.id as string, undefined)), 'common.precondition_required', 428);
    lims(await rejection(sEnd(db, svc, R1.id as string, 7)), 'common.version_conflict', 409);
    lims(await rejection(sEnd(db, svc, other.id as string, 1)), 'common.not_found', 404);
    lims(await rejection(sEnd(db, svc, '0190c300-0000-7000-8000-00000000ffff', 1)), 'common.not_found', 404);
    untouched(db, before);
  });
  it('ending an already-ended rule is refused (4xx) and does not move effective_to', { timeout: T }, async () => {
    const { db, svc } = setup({ surcharge_rules: [R1] });
    await sEnd(db, svc, R1.id as string, 1, { effective_to: iso(plus(1)) });
    client4xx(await rejection(sEnd(db, svc, R1.id as string, 2, { effective_to: iso(plus(9)) })));
    expect(ms(db.row('surcharge_rules', R1.id as string)!.effective_to)).toBe(plus(1).getTime());
  });
});

describe('listSurchargeRules #83', () => {
  const RA = srule(1, A, { scope: 'all' });
  const RD = srule(2, A, { scope: 'department', department_id: D1.id, effective_from: T0, effective_to: T1 });
  const RO = srule(3, A, { scope: 'orderable', orderable_id: O1.id, amount_kind: 'percent', amount_paisa: null, percent_bp: 5_000, effective_from: plus(30) });
  it('tenant-scoped; DTO shape; no active_at -> at least every rule effective now', { timeout: T }, async () => {
    const { db, svc } = setup({ surcharge_rules: [RA, RD, RO, srule(9, B, { scope: 'all' })] });
    const out = await sList(db, svc);
    const ids = out.data.map((r: Row) => r.id);
    expect(ids).toContain(RA.id); expect(out.data.every((r: Row) => r.id !== (srule(9, B).id))).toBe(true);
    expect(out.data.find((r: Row) => r.id === RA.id)).toEqual({ id: RA.id, scope: 'all', amount_kind: 'flat', amount: money(10_000), effective_from: iso(T0), version: 1 });
  });
  it('scope filter', { timeout: T }, async () => {
    const { db, svc } = setup({ surcharge_rules: [RA, RD, RO] });
    const out = await sList(db, svc, { scope: 'department' });
    expect(out.data.map((r: Row) => r.id)).toEqual([RD.id]);
  });
  it('active_at: only rules effective at that instant (half-open)', { timeout: T }, async () => {
    const { db, svc } = setup({ surcharge_rules: [RA, RD, RO] });
    const ids = async (at: Date) => (await sList(db, svc, { active_at: iso(at) })).data.map((r: Row) => r.id).sort();
    expect(await ids(new Date('2026-03-01T00:00:00Z'))).toEqual([RA.id, RD.id].sort());
    expect(await ids(T1)).toEqual([RA.id]);                                    // RD ended exactly at T1
    expect(await ids(plus(31))).toEqual([RA.id, RO.id].sort());
  });
  it('bad query values -> 400', { timeout: T }, async () => {
    const { db, svc } = setup();
    validation400(await rejection(sList(db, svc, { scope: 'bogus' })));
    validation400(await rejection(sList(db, svc, { active_at: 'yesterday' })));
  });
  it('reads write nothing and publish nothing', { timeout: T }, async () => {
    const { db, svc } = setup({ surcharge_rules: [RA] }); const before = snap(db);
    await sList(db, svc);
    expect(dbWrites(db)).toHaveLength(0); untouched(db, before);
  });
});

// ============================================================================================================================================
describe('listTaxTypes #86 — global VAT row + tenant versions, effective-dated (08 R18)', () => {
  const HST1 = ttype(1, A, 'HST', { rate_bp: 500, effective_from: T0, effective_to: T1 });
  const HST2 = ttype(2, A, 'HST', { rate_bp: 750, effective_from: T1 });
  const EDU = ttype(3, A, 'EDU', { rate_bp: null });
  const SCHED = ttype(4, A, 'FUT', { rate_bp: 100, effective_from: plus(30) });
  const world = () => setup({ cs_tax_types: [HST1, HST2, EDU, SCHED, ttype(9, B, 'BTAX', { rate_bp: 1 })] });
  const codes = (out: any) => out.data.map((r: Row) => r.code).sort();

  it('default active_at = now: the VAT global row (scope global, 1300 bp) + the version of each tenant code effective now; not other tenants\', not scheduled ones, not ended ones', { timeout: T }, async () => {
    const { db, svc } = world();
    const out = await yList(db, svc);
    expect(codes(out)).toEqual(['EDU', 'HST', 'VAT']);
    const vat = out.data.find((r: Row) => r.code === 'VAT');
    expect(vat).toMatchObject({ scope: 'global', rate_bp: 1300, is_active: true });
    expect(out.data.find((r: Row) => r.code === 'HST')).toMatchObject({ id: HST2.id, scope: 'tenant', rate_bp: 750, effective_from: iso(T1), is_active: true, version: 1 });
  });
  it('a type without a rate is listed WITHOUT rate_bp (not 0, not null) — "Not configured" (B7)', { timeout: T }, async () => {
    const { db, svc } = world();
    const edu = (await yList(db, svc)).data.find((r: Row) => r.code === 'EDU');
    expect(edu).toBeDefined(); expect(Object.keys(edu)).not.toContain('rate_bp');
  });
  it('active_at in the past shows the rate that was effective then (rate history)', { timeout: T }, async () => {
    const { db, svc } = world();
    const out = await yList(db, svc, { active_at: iso(new Date('2026-03-01T00:00:00Z')) });
    expect(out.data.find((r: Row) => r.code === 'HST')).toMatchObject({ id: HST1.id, rate_bp: 500, effective_to: iso(T1) });
    const atSwitch = await yList(db, svc, { active_at: iso(T1) });
    expect(atSwitch.data.find((r: Row) => r.code === 'HST')).toMatchObject({ id: HST2.id, rate_bp: 750 });
  });
  it('active_at in the future shows the scheduled version', { timeout: T }, async () => {
    const { db, svc } = world();
    expect(codes(await yList(db, svc, { active_at: iso(plus(31)) }))).toEqual(['EDU', 'FUT', 'HST', 'VAT']);
  });
  it('all_versions=true lists the whole rate history of every tenant code', { timeout: T }, async () => {
    const { db, svc } = world();
    const out = await yList(db, svc, { all_versions: true });
    expect(out.data.filter((r: Row) => r.code === 'HST').map((r: Row) => r.rate_bp).sort()).toEqual([500, 750]);
    expect(out.data.some((r: Row) => r.code === 'BTAX')).toBe(false);
  });
  it('even a tenant with no types sees the VAT row', { timeout: T }, async () => {
    const { db, svc } = setup();
    expect(codes(await yList(db, svc))).toEqual(['VAT']);
  });
  it('bad query values -> 400', { timeout: T }, async () => {
    const { db, svc } = setup();
    validation400(await rejection(yList(db, svc, { active_at: 'x' })));
    validation400(await rejection(yList(db, svc, { all_versions: 'maybe' })));
  });
});

describe('createTaxType #87', () => {
  it('201: code trimmed + upper-cased, scope tenant, active, version 1, effective_from defaults to now; event entity_type tax_rule / created / row id', { timeout: T }, async () => {
    const { db, svc } = setup();
    const out = await yNew(db, svc, { code: ' hst ', display: 'Synthetic HST', rate_bp: 750 });
    expect(out).toEqual({ id: expect.any(String), code: 'HST', display: 'Synthetic HST', rate_bp: 750, effective_from: iso(NOW), scope: 'tenant', is_active: true, version: 1 });
    expect(db.rows('cs_tax_types', A)).toHaveLength(1);
    expect(payloads(db)).toEqual([expect.objectContaining({ catalog_revision: 418, entity_type: 'tax_rule', entity_id: out.id, change_kind: 'created' })]);
  });
  it('AC-15.2 / B7: rate_bp is optional — a type may be created WITHOUT a rate (stored NULL, DTO omits rate_bp)', { timeout: T }, async () => {
    const { db, svc } = setup();
    const out = await yNew(db, svc, { code: 'HST', display: 'Synthetic HST' });
    expect(Object.keys(out)).not.toContain('rate_bp');
    expect(db.rows('cs_tax_types', A)[0]!.rate_bp).toBeNull();
  });
  it('rate 0 is a real rate: stored as 0 and returned as 0', { timeout: T }, async () => {
    const { db, svc } = setup();
    const out = await yNew(db, svc, { code: 'ZERO', display: 'Synthetic zero', rate_bp: 0 });
    expect(out.rate_bp).toBe(0); expect(db.rows('cs_tax_types', A)[0]!.rate_bp).toBe(0);
  });
  it('explicit effective_from is stored', { timeout: T }, async () => {
    const { db, svc } = setup();
    expect((await yNew(db, svc, { code: 'HST', display: 'x', rate_bp: 1, effective_from: iso(plus(7)) })).effective_from).toBe(iso(plus(7)));
  });
  it('409 catalog.code_duplicate for a code that already has a version (case/space-insensitive); the existing rows are untouched', { timeout: T }, async () => {
    const { db, svc } = setup({ cs_tax_types: [ttype(1, A, 'HST')] }); const before = snap(db);
    lims(await rejection(yNew(db, svc, { code: 'hst', display: 'again', rate_bp: 1 })), 'catalog.code_duplicate', 409);
    lims(await rejection(yNew(db, svc, { code: ' HST ', display: 'again' })), 'catalog.code_duplicate', 409);
    untouched(db, before);
  });
  it('the same code in another tenant is fine (RLS)', { timeout: T }, async () => {
    const { db, svc } = setup({ cs_tax_types: [ttype(9, B, 'HST')] });
    expect((await yNew(db, svc, { code: 'HST', display: 'mine', rate_bp: 1 })).code).toBe('HST');
  });
  it('VAT is the global system type: creating a tenant type "VAT"/"vat" is refused (400 or 409) and writes nothing', { timeout: T }, async () => {
    for (const code of ['VAT', 'vat', ' Vat ']) {
      const { db, svc } = setup(); const before = snap(db);
      const e = await rejection(yNew(db, svc, { code, display: 'fake VAT', rate_bp: 0 }));
      expect([400, 409]).toContain(e.statusCode); untouched(db, before);
    }
  });
  const BAD: Array<[string, object]> = [
    ['missing code', { display: 'x' }], ['missing display', { code: 'HST' }], ['unknown field', { code: 'HST', display: 'x', tenant_id: A }],
    ['server-owned `scope`', { code: 'HST', display: 'x', scope: 'global' }], ['server-owned `is_active`', { code: 'HST', display: 'x', is_active: false }],
    ['empty code', { code: '', display: 'x' }], ['blank code', { code: '   ', display: 'x' }], ['code with a space inside', { code: 'H S', display: 'x' }],
    ['code with punctuation', { code: 'HST!', display: 'x' }], ['code 17 chars', { code: 'A'.repeat(17), display: 'x' }], ['code with non-ASCII', { code: 'HSŤ', display: 'x' }],
    ['code is a number', { code: 5, display: 'x' }], ['empty display', { code: 'HST', display: '' }], ['display 61 chars', { code: 'HST', display: 'x'.repeat(61) }],
    ['rate_bp -1', { code: 'HST', display: 'x', rate_bp: -1 }], ['rate_bp 10001', { code: 'HST', display: 'x', rate_bp: 10_001 }], ['rate_bp fractional', { code: 'HST', display: 'x', rate_bp: 1.5 }],
    ['rate_bp as string', { code: 'HST', display: 'x', rate_bp: '5' }], ['rate_bp null', { code: 'HST', display: 'x', rate_bp: null }], ['effective_from garbage', { code: 'HST', display: 'x', effective_from: 'now' }],
    ['body not an object', 'HST' as never],
  ];
  it.each(BAD)('%s -> 400, nothing written', { timeout: T }, async (_n, body) => {
    const { db, svc } = setup(); const before = snap(db);
    validation400(await rejection(yNew(db, svc, body)));
    untouched(db, before);
  });
  it('boundary: code of exactly 16 chars and display of exactly 60 chars are accepted', { timeout: T }, async () => {
    const { db, svc } = setup();
    expect((await yNew(db, svc, { code: 'A_1'.repeat(5) + 'B', display: 'x'.repeat(60), rate_bp: 10_000 })).rate_bp).toBe(10_000);
  });
});

describe('updateTaxType #88 — a stored rate is never edited in place; a rate change is a NEW version row (08 R18)', () => {
  const HST = ttype(1, A, 'HST', { rate_bp: 500, effective_from: T0 });
  const upd = (rows: Row[] = [HST]) => setup({ cs_tax_types: rows });

  it('display only: in-place update of that row (version +1), rate and effective_from untouched, still ONE row for the code', { timeout: T }, async () => {
    const { db, svc } = upd();
    const out = await yUpd(db, svc, HST.id as string, 1, { display: 'Renamed HST' });
    expect(out).toMatchObject({ id: HST.id, display: 'Renamed HST', rate_bp: 500, version: 2, scope: 'tenant' });
    expect(db.rows('cs_tax_types', A)).toHaveLength(1);
    expect(db.row('cs_tax_types', HST.id as string)).toMatchObject({ display: 'Renamed HST', rate_bp: 500, version: 2 });
  });
  it('is_active=false deactivates that version (event kind deactivated, entity_type tax_rule)', { timeout: T }, async () => {
    const { db, svc } = upd();
    const out = await yUpd(db, svc, HST.id as string, 1, { is_active: false });
    expect(out.is_active).toBe(false);
    expect(payloads(db)).toEqual([expect.objectContaining({ entity_type: 'tax_rule', entity_id: HST.id, change_kind: 'deactivated', catalog_revision: 418 })]);
  });
  it('rate change with effective_from in the future: NEW row (scheduled), predecessor ends at that instant, predecessor\'s rate is NOT edited; response is the new version', { timeout: T }, async () => {
    const { db, svc } = upd();
    const out = await yUpd(db, svc, HST.id as string, 1, { rate_bp: 900, effective_from: iso(plus(7)) });
    expect(out).toMatchObject({ code: 'HST', rate_bp: 900, effective_from: iso(plus(7)), scope: 'tenant', is_active: true, version: 1 });
    expect(out.id).not.toBe(HST.id);
    const rows = db.rows('cs_tax_types', A).sort((a, b) => ms(a.effective_from) - ms(b.effective_from));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: HST.id, rate_bp: 500 }); expect(ms(rows[0]!.effective_to)).toBe(plus(7).getTime()); expect(ms(rows[0]!.effective_from)).toBe(T0.getTime());
    expect(rows[1]).toMatchObject({ id: out.id, rate_bp: 900, effective_to: null });
    expect(rows.filter((r) => r.effective_to == null)).toHaveLength(1);
  });
  it('the version effective now keeps its rate until the scheduled one starts (list at now vs at the switch)', { timeout: T }, async () => {
    const { db, svc } = upd();
    await yUpd(db, svc, HST.id as string, 1, { rate_bp: 900, effective_from: iso(plus(7)) });
    expect((await yList(db, svc)).data.find((r: Row) => r.code === 'HST')).toMatchObject({ rate_bp: 500 });
    expect((await yList(db, svc, { active_at: iso(plus(7)) })).data.find((r: Row) => r.code === 'HST')).toMatchObject({ rate_bp: 900 });
  });
  it('rate change effective now: new row current from now, predecessor ends exactly now (no gap, no overlap)', { timeout: T }, async () => {
    const { db, svc } = upd();
    const out = await yUpd(db, svc, HST.id as string, 1, { rate_bp: 0, effective_from: iso(NOW) });
    expect(out).toMatchObject({ rate_bp: 0, effective_from: iso(NOW) });
    expect(ms(db.row('cs_tax_types', HST.id as string)!.effective_to)).toBe(NOW.getTime());
  });
  it('publishes ONE tax_rule event for a new rate version with effective_from = the version\'s; revision +1; same transaction', { timeout: T }, async () => {
    const { db, svc } = upd();
    const out = await yUpd(db, svc, HST.id as string, 1, { rate_bp: 900, effective_from: iso(plus(7)) });
    expect(payloads(db)).toEqual([expect.objectContaining({ entity_type: 'tax_rule', entity_id: out.id, catalog_revision: 418 })]);
    expect(ms(payloads(db)[0]!['effective_from'])).toBe(plus(7).getTime());
    expect(['created', 'updated']).toContain(payloads(db)[0]!['change_kind']);
  });
  it('a failing event insert leaves the predecessor un-ended and no new row (one transaction)', { timeout: T }, async () => {
    const { db, svc } = upd(); const before = snap(db);
    db.fail(/INSERT\s+INTO\s+core\.event_log/i);
    await rejection(yUpd(db, svc, HST.id as string, 1, { rate_bp: 900, effective_from: iso(plus(7)) }));
    expect(snap(db)).toBe(before); expect(db.revisionOf(A)).toBe(417);
  });
  it('rate change WITHOUT effective_from -> 400 path /effective_from; nothing written', { timeout: T }, async () => {
    const { db, svc } = upd(); const before = snap(db);
    validation400(await rejection(yUpd(db, svc, HST.id as string, 1, { rate_bp: 900 })), '/effective_from');
    untouched(db, before);
  });
  it('rate change back-dated (a day before now) -> 400 path /effective_from; nothing written', { timeout: T }, async () => {
    const { db, svc } = upd(); const before = snap(db);
    validation400(await rejection(yUpd(db, svc, HST.id as string, 1, { rate_bp: 900, effective_from: iso(plus(-1)) })), '/effective_from');
    untouched(db, before);
  });
  it('rate change whose effective_from is not after the current version\'s start -> 400 /effective_from (would make an empty or inverted window)', { timeout: T }, async () => {
    const future = ttype(1, A, 'HST', { rate_bp: 500, effective_from: plus(10) });
    const { db, svc } = upd([future]); const before = snap(db);
    validation400(await rejection(yUpd(db, svc, future.id as string, 1, { rate_bp: 900, effective_from: iso(plus(5)) })), '/effective_from');
    expect(snap(db)).toBe(before);
  });
  it('a rate that equals the current rate is still a (new) version when effective_from is given; but an effective_from with NO rate change creates nothing and edits nothing it must not', { timeout: T }, async () => {
    const { db, svc } = upd();
    const before = db.row('cs_tax_types', HST.id as string)!;
    await yUpd(db, svc, HST.id as string, 1, { effective_from: iso(plus(3)) }).catch((e) => client4xx(e));
    const after = db.row('cs_tax_types', HST.id as string)!;
    expect(ms(after.effective_from)).toBe(ms(before.effective_from)); expect(after.rate_bp).toBe(500);
  });
  const BAD: Array<[string, object]> = [
    ['empty patch', {}], ['unknown field', { rate_bp: 1, effective_from: iso(plus(1)), tenant_id: A }], ['code (immutable)', { code: 'NEW' }], ['scope', { scope: 'global' }],
    ['rate_bp null (a rate cannot be cleared)', { rate_bp: null, effective_from: iso(plus(1)) }], ['rate_bp 10001', { rate_bp: 10_001, effective_from: iso(plus(1)) }],
    ['rate_bp -1', { rate_bp: -1, effective_from: iso(plus(1)) }], ['rate_bp fractional', { rate_bp: 5.5, effective_from: iso(plus(1)) }], ['display empty', { display: '' }],
    ['display 61 chars', { display: 'x'.repeat(61) }], ['is_active string', { is_active: 'false' }], ['effective_from garbage', { rate_bp: 5, effective_from: 'later' }],
  ];
  it.each(BAD)('%s -> 400, nothing written', { timeout: T }, async (_n, patch) => {
    const { db, svc } = upd(); const before = snap(db);
    validation400(await rejection(yUpd(db, svc, HST.id as string, 1, patch)));
    untouched(db, before);
  });
  it('If-Match: missing -> 428, stale -> 409 (and no new version row is created by the stale attempt); unknown / tenant-B id -> 404, zero rows changed', { timeout: T }, async () => {
    const other = ttype(9, B, 'BTAX');
    const { db, svc } = upd([HST, other]); const before = snap(db);
    lims(await rejection(yUpd(db, svc, HST.id as string, undefined, { display: 'x' })), 'common.precondition_required', 428);
    lims(await rejection(yUpd(db, svc, HST.id as string, 5, { rate_bp: 1, effective_from: iso(plus(1)) })), 'common.version_conflict', 409);
    lims(await rejection(yUpd(db, svc, other.id as string, 1, { display: 'x' })), 'common.not_found', 404);
    lims(await rejection(yUpd(db, svc, '0190c300-0000-7000-8000-00000000ffff', 1, { display: 'x' })), 'common.not_found', 404);
    untouched(db, before);
  });
  it('two concurrent rate changes with the same If-Match: exactly one wins, the other gets 409; the code ends with ONE open version', { timeout: T }, async () => {
    const { db, svc } = upd();
    const res = await Promise.allSettled([900, 800].map((r, i) => yUpd(db, svc, HST.id as string, 1, { rate_bp: r, effective_from: iso(plus(5 + i)) })));
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of res) if (r.status === 'rejected') lims(r.reason, 'common.version_conflict', 409);
    const rows = db.rows('cs_tax_types', A);
    expect(rows).toHaveLength(2); expect(rows.filter((r) => r.effective_to == null)).toHaveLength(1);
  });
  it('VAT is read-only: PATCH of the global VAT row id is refused with a 4xx and the g_tax_types row is unchanged', { timeout: T }, async () => {
    const { db, svc } = upd(); const before = snap(db);
    const vatId = db.rows('g_tax_types')[0]!.id as string;
    for (const patch of [{ display: 'x' }, { rate_bp: 0, effective_from: iso(plus(1)) }, { is_active: false }]) client4xx(await rejection(yUpd(db, svc, vatId, 1, patch)));
    expect(snap(db)).toBe(before); expect(db.rows('g_tax_types')[0]).toMatchObject({ code: 'VAT', rate_bp: 1300, is_active: true });
  });
  it('a service bug that wrote cs_tax_types.rate_bp / effective_from in place would trip the trigger — direct SQL proves the fake enforces it (05-SCHEMA §10 test 8)', { timeout: T }, async () => {
    const { db } = upd();
    expect(await sqlCode(sql(db, 'UPDATE catalog.cs_tax_types SET rate_bp = $1 WHERE tenant_id = $2 AND id = $3', [999, A, HST.id]))).toBe('P0001');
    expect(await sqlCode(sql(db, 'UPDATE catalog.cs_tax_types SET effective_from = $1 WHERE tenant_id = $2 AND id = $3', [iso(NOW), A, HST.id]))).toBe('P0001');
    expect(await sqlCode(sql(db, 'UPDATE catalog.cs_tax_types SET display = $1 WHERE tenant_id = $2 AND id = $3', ['ok', A, HST.id]))).toBe('none');
  });
  it('the service only ever UPDATEs the mutable columns of cs_tax_types (display, sort_order, is_active, effective_to, bookkeeping) — S-1/A2', { timeout: T }, async () => {
    const { db, svc } = upd();
    await yUpd(db, svc, HST.id as string, 1, { display: 'a' });
    await yUpd(db, svc, HST.id as string, 2, { rate_bp: 800, effective_from: iso(plus(2)) });
    const ok = new Set(['display', 'sort_order', 'is_active', 'effective_to', 'updated_at', 'updated_by', 'version']);
    for (const st of dbWrites(db).filter((s) => /^\s*UPDATE\s+catalog\.cs_tax_types/i.test(s.text))) {
      const set = /\bSET\b([\s\S]*?)\bWHERE\b/i.exec(st.text)![1]!.split(',').map((x) => x.split('=')[0]!.trim());
      for (const c of set) expect(ok.has(c), `UPDATE sets frozen column ${c}`).toBe(true);
    }
  });
});

// ============================================================================================================================================
describe('createTaxRule #90 — happy paths (AC-15.1, AC-15.5 panel rule)', () => {
  const body = (o: object = {}) => ({ scope: 'tenant_default', vat_treatment: 'exempt', effective_from: iso(NOW), ...o });
  it('tenant default: 201 DTO (no department / orderable keys), version 1, row stored, event tax_rule/created (entity_id = the rule id, effective_from = the rule\'s)', { timeout: T }, async () => {
    const { db, svc } = setup();
    const out = await rNew(db, svc, body());
    expect(out).toEqual({ id: expect.any(String), scope: 'tenant_default', vat_treatment: 'exempt', effective_from: iso(NOW), version: 1 });
    expect(db.rows('tax_rules', A)[0]).toMatchObject({ id: out.id, scope: 'tenant_default', vat_treatment: 'exempt', department_id: null, orderable_id: null, other_tax_code: null, hs_code: null, effective_to: null, is_active: true });
    expect(payloads(db)).toEqual([expect.objectContaining({ catalog_revision: 418, entity_type: 'tax_rule', entity_id: out.id, change_kind: 'created' })]);
    expect(ms(payloads(db)[0]!['effective_from'])).toBe(NOW.getTime());
  });
  it('AC-15.1: tenant default `exempt` + an orderable rule `taxable` for a kit-sale orderable can coexist (both stored, both listed)', { timeout: T }, async () => {
    const { db, svc } = setup();
    await rNew(db, svc, body());
    const ord = await rNew(db, svc, body({ scope: 'orderable', orderable_id: O1.id, vat_treatment: 'taxable' }));
    expect(ord).toMatchObject({ scope: 'orderable', orderable_id: O1.id, vat_treatment: 'taxable' });
    expect((await rList(db, svc)).data.map((r: Row) => r.scope).sort()).toEqual(['orderable', 'tenant_default']);
  });
  it('department rule, hs_code and other_tax_code (a type WITH a rate) are stored and returned', { timeout: T }, async () => {
    const { db, svc } = setup({ cs_tax_types: [ttype(1, A, 'HST', { rate_bp: 500 })] });
    const out = await rNew(db, svc, body({ scope: 'department', department_id: D1.id, vat_treatment: 'taxable', other_tax_code: 'HST', hs_code: '9018' }));
    expect(out).toMatchObject({ scope: 'department', department_id: D1.id, other_tax_code: 'HST', hs_code: '9018' });
    expect(db.rows('tax_rules', A)[0]).toMatchObject({ other_tax_code: 'HST', hs_code: '9018' });
  });
  it('AC-15.5 panel/package: an orderable rule may target a PANEL orderable that has no department; a department rule needs a real department id', { timeout: T }, async () => {
    const { db, svc } = setup();
    expect((await rNew(db, svc, body({ scope: 'orderable', orderable_id: O3.id, vat_treatment: 'taxable' }))).orderable_id).toBe(O3.id);
    const e = await rejection(rNew(db, svc, body({ scope: 'department', department_id: null })));
    validation400(e);
  });
  it('boundary hs_code lengths 4 and 8 digits are accepted', { timeout: T }, async () => {
    const { db, svc } = setup();
    expect((await rNew(db, svc, body({ scope: 'orderable', orderable_id: O1.id, hs_code: '1234' }))).hs_code).toBe('1234');
    expect((await rNew(db, svc, body({ scope: 'orderable', orderable_id: O2.id, hs_code: '12345678' }))).hs_code).toBe('12345678');
  });
  it('a failing event insert rolls the rule back: no row, revision unchanged', { timeout: T }, async () => {
    const { db, svc } = setup();
    db.fail(/INSERT\s+INTO\s+core\.event_log/i);
    await rejection(rNew(db, svc, body()));
    expect(db.rows('tax_rules', A)).toHaveLength(0); expect(db.revisionOf(A)).toBe(417);
  });
});

describe('createTaxRule — AC-15.2: a tax type without a rate is unusable (path /other_tax_code)', () => {
  const body = (code: unknown) => ({ scope: 'tenant_default', vat_treatment: 'taxable', other_tax_code: code, effective_from: iso(NOW) });
  it('type exists but rate_bp is NULL (rate not entered, B7) -> 400 common.validation_failed path /other_tax_code; no row', { timeout: T }, async () => {
    const { db, svc } = setup({ cs_tax_types: [ttype(1, A, 'HST', { rate_bp: null })] }); const before = snap(db);
    validation400(await rejection(rNew(db, svc, body('HST'))), '/other_tax_code');
    untouched(db, before);
  });
  it('unknown code -> 400 /other_tax_code', { timeout: T }, async () => {
    const { db, svc } = setup(); const before = snap(db);
    validation400(await rejection(rNew(db, svc, body('NOPE'))), '/other_tax_code'); untouched(db, before);
  });
  it('"VAT" is not an "other" tax type -> 400 /other_tax_code', { timeout: T }, async () => {
    const { db, svc } = setup(); const before = snap(db);
    validation400(await rejection(rNew(db, svc, body('VAT'))), '/other_tax_code'); untouched(db, before);
  });
  it('a type of ANOTHER tenant is not usable -> 400 /other_tax_code', { timeout: T }, async () => {
    const { db, svc } = setup({ cs_tax_types: [ttype(9, B, 'BTAX', { rate_bp: 100 })] });
    validation400(await rejection(rNew(db, svc, body('BTAX'))), '/other_tax_code');
  });
  it('an inactive type is not usable -> 400 /other_tax_code', { timeout: T }, async () => {
    const { db, svc } = setup({ cs_tax_types: [ttype(1, A, 'HST', { rate_bp: 100, is_active: false })] });
    validation400(await rejection(rNew(db, svc, body('HST'))), '/other_tax_code');
  });
  it('the SAME type once its rate is configured (rate change = new version, rate 0 counts) is usable', { timeout: T }, async () => {
    const { db, svc } = setup({ cs_tax_types: [ttype(1, A, 'HST', { rate_bp: 0 })] });
    expect((await rNew(db, svc, body('HST'))).other_tax_code).toBe('HST');
  });
  it('lower-case / malformed other_tax_code -> 400 (resource pattern ^[A-Z0-9_]{1,16}$)', { timeout: T }, async () => {
    for (const code of ['hst', 'H S', 'A'.repeat(17), '', 5]) {
      const { db, svc } = setup({ cs_tax_types: [ttype(1, A, 'HST', { rate_bp: 100 })] }); const before = snap(db);
      validation400(await rejection(rNew(db, svc, body(code)))); untouched(db, before);
    }
  });
});

describe('createTaxRule — validation (S-5, AB-3): nothing is written', () => {
  const base = { scope: 'tenant_default', vat_treatment: 'exempt', effective_from: iso(NOW) };
  const BAD: Array<[string, object]> = [
    ['unknown field', { ...base, tenant_id: A }], ['server-owned `version`', { ...base, version: 2 }], ['missing scope', { vat_treatment: 'exempt', effective_from: iso(NOW) }],
    ['missing vat_treatment', { scope: 'tenant_default', effective_from: iso(NOW) }], ['missing effective_from', { scope: 'tenant_default', vat_treatment: 'exempt' }],
    ['scope not in enum', { ...base, scope: 'all' }], ['vat_treatment not in enum (zero_rated)', { ...base, vat_treatment: 'zero_rated' }],
    ['tenant_default + department_id', { ...base, department_id: D1.id }], ['tenant_default + orderable_id', { ...base, orderable_id: O1.id }],
    ['department without department_id', { ...base, scope: 'department' }], ['department + orderable_id', { ...base, scope: 'department', department_id: D1.id, orderable_id: O1.id }],
    ['orderable without orderable_id', { ...base, scope: 'orderable' }], ['orderable + department_id', { ...base, scope: 'orderable', orderable_id: O1.id, department_id: D1.id }],
    ['hs_code 3 digits', { ...base, hs_code: '123' }], ['hs_code 9 digits', { ...base, hs_code: '123456789' }], ['hs_code letters', { ...base, hs_code: 'ABCD' }], ['hs_code with a dot', { ...base, hs_code: '9018.1' }],
    ['effective_from garbage', { ...base, effective_from: '2026' }], ['effective_to before effective_from', { ...base, effective_to: iso(plus(-1)) }], ['body is an array', [base] as never],
  ];
  it.each(BAD)('%s -> 400', { timeout: T }, async (_n, body) => {
    const { db, svc } = setup(); const before = snap(db);
    validation400(await rejection(rNew(db, svc, body)));
    untouched(db, before);
  });
  it('tenant-B / unknown department or orderable ids are never accepted (AB-3): 400 or 404, no row', { timeout: T }, async () => {
    const unknown = '0190c300-0000-7000-8000-00000000ffff';
    for (const b of [{ ...base, scope: 'department', department_id: DB.id }, { ...base, scope: 'department', department_id: unknown }, { ...base, scope: 'orderable', orderable_id: OB.id }, { ...base, scope: 'orderable', orderable_id: unknown }]) {
      const { db, svc } = setup(); const before = snap(db);
      client4xx(await rejection(rNew(db, svc, b))); untouched(db, before);
    }
  });
});

describe('createTaxRule — AC-15.5 successor ends its predecessor; overlap rejection after the catalog_state lock (§7.6)', () => {
  const DEF0 = trule(1, A, { scope: 'tenant_default', vat_treatment: 'exempt', effective_from: T0 });          // open default since T0
  const body = (o: object = {}) => ({ scope: 'tenant_default', vat_treatment: 'taxable', effective_from: iso(plus(5)), ...o });

  it('a new tenant default with effective_from T1 > T0 ends the open default AT T1 in the same transaction; exactly one open default afterwards', { timeout: T }, async () => {
    const { db, svc } = setup({ tax_rules: [DEF0] });
    const out = await rNew(db, svc, body());
    expect(out).toMatchObject({ scope: 'tenant_default', vat_treatment: 'taxable', effective_from: iso(plus(5)) });
    const old = db.row('tax_rules', DEF0.id as string)!;
    expect(ms(old.effective_to)).toBe(plus(5).getTime());
    expect(old).toMatchObject({ vat_treatment: 'exempt', version: 2 }); expect(ms(old.effective_from)).toBe(T0.getTime());     // history kept, only effective_to / bookkeeping moved
    const rows = db.rows('tax_rules', A);
    expect(rows).toHaveLength(2); expect(rows.filter((r) => r.effective_to == null)).toHaveLength(1);
    expect(rows.find((r) => r.effective_to == null)!.id).toBe(out.id);
  });
  it('the predecessor is ended and the successor inserted in ONE transaction with ONE event and ONE revision bump (a failing event insert undoes both)', { timeout: T }, async () => {
    const ok = setup({ tax_rules: [DEF0] });
    await rNew(ok.db, ok.svc, body());
    expect(events(ok.db)).toHaveLength(1); expect(ok.db.revisionOf(A)).toBe(418);
    const { db, svc } = setup({ tax_rules: [DEF0] }); const before = snap(db);
    db.fail(/INSERT\s+INTO\s+core\.event_log/i);
    await rejection(rNew(db, svc, body()));
    expect(snap(db)).toBe(before); expect(db.revisionOf(A)).toBe(417);
  });
  it('the switch is seamless: at T1 the new default applies, one ms earlier the old one (windows meet, no gap, no overlap)', { timeout: T }, async () => {
    const { db, svc } = setup({ tax_rules: [DEF0] });
    await rNew(db, svc, body());
    const at = async (d: Date) => (await rList(db, svc, { scope: 'tenant_default', active_at: iso(d) })).data.map((r: Row) => r.vat_treatment);
    expect(await at(new Date(plus(5).getTime() - 1))).toEqual(['exempt']);
    expect(await at(plus(5))).toEqual(['taxable']);
  });
  it('a successor with effective_from EQUAL to or BEFORE the open default\'s -> 400 path /effective_from; nothing changes', { timeout: T }, async () => {
    for (const from of [T0, new Date('2025-06-01T00:00:00Z')]) {
      const { db, svc } = setup({ tax_rules: [DEF0] }); const before = snap(db);
      validation400(await rejection(rNew(db, svc, body({ effective_from: iso(from) }))), '/effective_from');
      untouched(db, before);
    }
  });
  it('a chain of successors keeps a contiguous history (T0 -> T1 -> T2), always one open rule', { timeout: T }, async () => {
    const { db, svc } = setup({ tax_rules: [DEF0] });
    await rNew(db, svc, body({ effective_from: iso(plus(5)) }));
    await rNew(db, svc, body({ effective_from: iso(plus(9)), vat_treatment: 'exempt' }));
    const rows = db.rows('tax_rules', A).sort((a, b) => ms(a.effective_from) - ms(b.effective_from));
    expect(rows).toHaveLength(3);
    expect(ms(rows[0]!.effective_to)).toBe(ms(rows[1]!.effective_from)); expect(ms(rows[1]!.effective_to)).toBe(ms(rows[2]!.effective_from)); expect(rows[2]!.effective_to).toBeNull();
  });
  it('the first tenant default (none open) just inserts; a tenant-B default does not count as a predecessor (RLS)', { timeout: T }, async () => {
    const { db, svc } = setup({ tax_rules: [trule(9, B, { scope: 'tenant_default' })] });
    await rNew(db, svc, body());
    expect(db.rows('tax_rules', B)[0]!.effective_to).toBeNull(); expect(db.rows('tax_rules', A)).toHaveLength(1);
  });
  it('department rule overlapping an existing rule of the same department -> 400 /effective_from (NO auto-end for department / orderable rules); the predecessor is untouched', { timeout: T }, async () => {
    const existing = trule(2, A, { scope: 'department', department_id: D1.id, vat_treatment: 'taxable' });
    const { db, svc } = setup({ tax_rules: [existing] }); const before = snap(db);
    validation400(await rejection(rNew(db, svc, body({ scope: 'department', department_id: D1.id, effective_from: iso(plus(5)) }))), '/effective_from');
    untouched(db, before);
  });
  it('orderable rule overlapping an existing one -> 400 /effective_from, also when the new one starts EARLIER and is open-ended', { timeout: T }, async () => {
    const existing = trule(3, A, { scope: 'orderable', orderable_id: O1.id, effective_from: plus(10) });
    const { db, svc } = setup({ tax_rules: [existing] });
    validation400(await rejection(rNew(db, svc, body({ scope: 'orderable', orderable_id: O1.id, effective_from: iso(plus(1)) }))), '/effective_from');
  });
  it('bounded existing window: inside / straddling overlap; a rule starting at its end (adjacent) is accepted', { timeout: T }, async () => {
    const existing = trule(3, A, { scope: 'orderable', orderable_id: O1.id, effective_from: plus(10), effective_to: plus(20) });
    for (const [from, to] of [[plus(12), plus(15)], [plus(5), plus(12)], [plus(15), plus(30)], [plus(19), undefined]] as const) {
      const { db, svc } = setup({ tax_rules: [existing] });
      validation400(await rejection(rNew(db, svc, body({ scope: 'orderable', orderable_id: O1.id, effective_from: iso(from), effective_to: to ? iso(to) : undefined }))), '/effective_from');
    }
    const { db, svc } = setup({ tax_rules: [existing] });
    expect((await rNew(db, svc, body({ scope: 'orderable', orderable_id: O1.id, effective_from: iso(plus(20)) }))).id).toEqual(expect.any(String));
  });
  it('different department / orderable keys, and department vs orderable vs default, do not conflict', { timeout: T }, async () => {
    const { db, svc } = setup({ tax_rules: [DEF0, trule(2, A, { scope: 'department', department_id: D1.id })] });
    await rNew(db, svc, body({ scope: 'department', department_id: D2.id, effective_from: iso(NOW) }));
    await rNew(db, svc, body({ scope: 'orderable', orderable_id: O1.id, effective_from: iso(NOW) }));
    expect(db.rows('tax_rules', A)).toHaveLength(4);
  });
  it('an INACTIVE existing rule does not block a new rule of the same key', { timeout: T }, async () => {
    const { db, svc } = setup({ tax_rules: [trule(2, A, { scope: 'orderable', orderable_id: O1.id, is_active: false, effective_to: null })] });
    expect((await rNew(db, svc, body({ scope: 'orderable', orderable_id: O1.id, effective_from: iso(NOW) }))).id).toEqual(expect.any(String));
  });
  it('the overlap check runs only AFTER the catalog_state row is locked (§3, §7.6)', { timeout: T }, async () => {
    const existing = trule(2, A, { scope: 'department', department_id: D1.id });
    const { db, svc } = setup({ tax_rules: [existing] });
    await rejection(rNew(db, svc, body({ scope: 'department', department_id: D1.id })));
    const idx = (re: RegExp) => db.stmts.findIndex((x) => re.test(x.text));
    const lock = Math.min(...[/FROM\s+catalog\.catalog_state[\s\S]*FOR UPDATE/i, /UPDATE\s+catalog\.catalog_state/i].map(idx).filter((i) => i >= 0));
    const overlap = idx(/FROM\s+catalog\.tax_rules/i);
    expect(lock).toBeGreaterThanOrEqual(0); expect(overlap).toBeGreaterThanOrEqual(0); expect(lock).toBeLessThan(overlap);
  });
  it('two concurrent creates of the same department rule: exactly one is stored, the other gets 400 /effective_from (the lock serialises the check)', { timeout: T }, async () => {
    const { db, svc } = setup();
    const res = await Promise.allSettled([1, 2, 3].map((n) => rNew(db, svc, body({ scope: 'department', department_id: D1.id, effective_from: iso(plus(n)) }))));
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of res) if (r.status === 'rejected') validation400(r.reason, '/effective_from');
    expect(db.rows('tax_rules', A)).toHaveLength(1); expect(events(db)).toHaveLength(1);
  });
  it('concurrent tenant-default successors never leave two open defaults or overlapping windows (open-rule unique index backstop)', { timeout: T }, async () => {
    const { db, svc } = setup({ tax_rules: [DEF0] });
    const res = await Promise.allSettled([2, 3, 4].map((n) => rNew(db, svc, body({ effective_from: iso(plus(n)) }))));
    expect(res.filter((r) => r.status === 'fulfilled').length).toBeGreaterThanOrEqual(1);
    for (const r of res) if (r.status === 'rejected') validation400(r.reason, '/effective_from');
    const rows = db.rows('tax_rules', A).sort((a, b) => ms(a.effective_from) - ms(b.effective_from));
    expect(rows.filter((r) => r.effective_to == null)).toHaveLength(1);
    for (let i = 1; i < rows.length; i++) expect(ms(rows[i - 1]!.effective_to)).toBeLessThanOrEqual(ms(rows[i]!.effective_from));
  });
  it('mutable-columns trigger: direct SQL changing vat_treatment / other_tax_code / hs_code / effective_from of a stored rule -> P0001; effective_to succeeds (05-SCHEMA §10 test 11)', { timeout: T }, async () => {
    const { db } = setup({ tax_rules: [DEF0] });
    for (const set of ["vat_treatment = 'taxable'", "hs_code = '1234'", `effective_from = '${iso(NOW)}'`]) expect(await sqlCode(sql(db, `UPDATE catalog.tax_rules SET ${set} WHERE tenant_id = $1 AND id = $2`, [A, DEF0.id])), set).toBe('P0001');
    expect(await sqlCode(sql(db, `UPDATE catalog.tax_rules SET effective_to = '${iso(plus(1))}' WHERE tenant_id = $1 AND id = $2`, [A, DEF0.id]))).toBe('none');
  });
  it('open-rule unique index: direct SQL inserting a second open default -> 23505 (backstop for the overlap rule)', { timeout: T }, async () => {
    const { db } = setup({ tax_rules: [DEF0] });
    const code = await sqlCode(sql(db, "INSERT INTO catalog.tax_rules (id, tenant_id, scope, vat_treatment, effective_from, created_by, updated_by) VALUES ($1, $2, 'tenant_default', 'taxable', $3, $4, $4)", [db.newId(), A, iso(plus(1)), '0190c300-0000-7000-8000-0000000000ff']));
    expect(code).toBe('23505');
  });
  it('the service only ever UPDATEs the mutable columns of tax_rules / surcharge_rules (effective_to, is_active, bookkeeping)', { timeout: T }, async () => {
    const { db, svc } = setup({ tax_rules: [DEF0], surcharge_rules: [srule(1, A)] });
    await rNew(db, svc, body());
    await sEnd(db, svc, srule(1, A).id as string, 1);
    const ok = new Set(['effective_to', 'is_active', 'updated_at', 'updated_by', 'version']);
    for (const st of dbWrites(db).filter((s) => /^\s*UPDATE\s+catalog\.(tax_rules|surcharge_rules)/i.test(s.text))) {
      const set = /\bSET\b([\s\S]*?)\bWHERE\b/i.exec(st.text)![1]!.split(',').map((x) => x.split('=')[0]!.trim());
      for (const c of set) expect(ok.has(c), `UPDATE sets frozen column ${c}`).toBe(true);
    }
  });
});

describe('endTaxRule #91', () => {
  const ORD = trule(2, A, { scope: 'orderable', orderable_id: O1.id, vat_treatment: 'taxable' });
  const DEPT = trule(3, A, { scope: 'department', department_id: D1.id, vat_treatment: 'taxable' });
  const DEF = trule(1, A, { scope: 'tenant_default' });
  it('ends an orderable rule at the transaction clock by default; only effective_to + bookkeeping move', { timeout: T }, async () => {
    const { db, svc } = setup({ tax_rules: [ORD] });
    const out = await rEnd(db, svc, ORD.id as string, 1);
    expect(out).toMatchObject({ id: ORD.id, scope: 'orderable', vat_treatment: 'taxable', effective_to: iso(NOW), version: 2 });
    expect(db.row('tax_rules', ORD.id as string)).toMatchObject({ vat_treatment: 'taxable', orderable_id: O1.id, version: 2 }); expect(ms(db.row('tax_rules', ORD.id as string)!.effective_from)).toBe(T0.getTime());
  });
  it('explicit future effective_to for a department rule; event entity_type tax_rule, kind updated|deactivated, revision +1', { timeout: T }, async () => {
    const { db, svc } = setup({ tax_rules: [DEPT] });
    expect((await rEnd(db, svc, DEPT.id as string, 1, { effective_to: iso(plus(5)) })).effective_to).toBe(iso(plus(5)));
    expect(payloads(db)).toEqual([expect.objectContaining({ entity_type: 'tax_rule', entity_id: DEPT.id, catalog_revision: 418 })]);
    expect(['updated', 'deactivated']).toContain(payloads(db)[0]!['change_kind']);
  });
  it('the tenant default can only be ended by creating its successor: ending it -> 400, row unchanged', { timeout: T }, async () => {
    const { db, svc } = setup({ tax_rules: [DEF] }); const before = snap(db);
    validation400(await rejection(rEnd(db, svc, DEF.id as string, 1)));
    validation400(await rejection(rEnd(db, svc, DEF.id as string, 1, { effective_to: iso(plus(3)) })));
    untouched(db, before);
  });
  it('effective_to before the rule\'s effective_from / garbage / unknown key -> 400; nothing changes', { timeout: T }, async () => {
    for (const body of [{ effective_to: iso(new Date('2025-12-31T00:00:00Z')) }, { effective_to: 'soon' }, { effective_to: iso(NOW), vat_treatment: 'exempt' }]) {
      const { db, svc } = setup({ tax_rules: [ORD] }); const before = snap(db);
      validation400(await rejection(rEnd(db, svc, ORD.id as string, 1, body))); untouched(db, before);
    }
  });
  it('If-Match: missing -> 428, stale -> 409; unknown / tenant-B id -> 404, zero rows changed (AB-1)', { timeout: T }, async () => {
    const other = trule(9, B, { scope: 'orderable', orderable_id: OB.id });
    const { db, svc } = setup({ tax_rules: [ORD, other] }); const before = snap(db);
    lims(await rejection(rEnd(db, svc, ORD.id as string, undefined)), 'common.precondition_required', 428);
    lims(await rejection(rEnd(db, svc, ORD.id as string, 4)), 'common.version_conflict', 409);
    lims(await rejection(rEnd(db, svc, other.id as string, 1)), 'common.not_found', 404);
    lims(await rejection(rEnd(db, svc, '0190c300-0000-7000-8000-00000000ffff', 1)), 'common.not_found', 404);
    untouched(db, before);
  });
  it('ending an already-ended rule is refused (4xx), effective_to stays; a new rule for the same key may then start at the end instant', { timeout: T }, async () => {
    const { db, svc } = setup({ tax_rules: [ORD] });
    await rEnd(db, svc, ORD.id as string, 1, { effective_to: iso(plus(2)) });
    client4xx(await rejection(rEnd(db, svc, ORD.id as string, 2, { effective_to: iso(plus(9)) })));
    expect(ms(db.row('tax_rules', ORD.id as string)!.effective_to)).toBe(plus(2).getTime());
    expect((await rNew(db, svc, { scope: 'orderable', orderable_id: O1.id, vat_treatment: 'exempt', effective_from: iso(plus(2)) })).id).toEqual(expect.any(String));
  });
});

describe('listTaxRules #89', () => {
  const DEF = trule(1, A, { scope: 'tenant_default', effective_from: T0, effective_to: T1 });
  const DEF2 = trule(2, A, { scope: 'tenant_default', vat_treatment: 'taxable', effective_from: T1 });
  const ORD = trule(3, A, { scope: 'orderable', orderable_id: O1.id, vat_treatment: 'taxable', hs_code: '9018', effective_from: T0 });
  it('tenant-scoped; DTO shape (absent optionals omitted); no active_at -> at least every rule effective now', { timeout: T }, async () => {
    const { db, svc } = setup({ tax_rules: [DEF, DEF2, ORD, trule(9, B)] });
    const out = await rList(db, svc);
    const ids = out.data.map((r: Row) => r.id);
    expect(ids).toEqual(expect.arrayContaining([DEF2.id, ORD.id])); expect(ids).not.toContain(trule(9, B).id);
    expect(out.data.find((r: Row) => r.id === ORD.id)).toEqual({ id: ORD.id, scope: 'orderable', orderable_id: O1.id, vat_treatment: 'taxable', hs_code: '9018', effective_from: iso(T0), version: 1 });
  });
  it('scope filter and active_at (half-open) work together', { timeout: T }, async () => {
    const { db, svc } = setup({ tax_rules: [DEF, DEF2, ORD] });
    expect((await rList(db, svc, { scope: 'orderable' })).data.map((r: Row) => r.id)).toEqual([ORD.id]);
    expect((await rList(db, svc, { scope: 'tenant_default', active_at: iso(new Date('2026-03-01T00:00:00Z')) })).data.map((r: Row) => r.id)).toEqual([DEF.id]);
    expect((await rList(db, svc, { scope: 'tenant_default', active_at: iso(T1) })).data.map((r: Row) => r.id)).toEqual([DEF2.id]);
  });
  it('AC-15.3: a tenant with no rules gets an empty list — no default is invented', { timeout: T }, async () => {
    const { db, svc } = setup();
    expect((await rList(db, svc)).data).toEqual([]);
  });
  it('bad query values -> 400; reads write nothing and publish nothing', { timeout: T }, async () => {
    const { db, svc } = setup({ tax_rules: [DEF2] }); const before = snap(db);
    validation400(await rejection(rList(db, svc, { scope: 'all' }))); validation400(await rejection(rList(db, svc, { active_at: 'x' })));
    await rList(db, svc);
    expect(dbWrites(db)).toHaveLength(0); untouched(db, before);
  });
});

describe('adversarial: SQL injection / identifiers (07-SECURITY S-6)', () => {
  it('ids, codes and tenant ids reach Postgres as bind values, never interpolated into statement text', { timeout: T }, async () => {
    const hst = ttype(1, A, 'HST', { rate_bp: 500 });
    const { db, svc } = setup({ cs_tax_types: [hst] });
    await yUpd(db, svc, hst.id as string, 1, { display: "x'; DROP TABLE catalog.tax_rules; --" });
    await rNew(db, svc, { scope: 'department', department_id: D1.id, vat_treatment: 'taxable', other_tax_code: 'HST', effective_from: iso(NOW) });
    await sNew(db, svc, { scope: 'orderable', orderable_id: O1.id, price_list_id: LP.id, amount_kind: 'flat', amount: money(5), effective_from: iso(NOW) });
    for (const st of db.stmts) for (const secret of [A, hst.id, D1.id, O1.id, LP.id, 'DROP TABLE', 'HST']) expect(st.text, `${secret} in: ${st.text.slice(0, 80)}`).not.toContain(secret as string);
  });
  it('a SQL-injection-shaped code is just an invalid code (400), never executed', { timeout: T }, async () => {
    const { db, svc } = setup(); const before = snap(db);
    validation400(await rejection(yNew(db, svc, { code: "X'; DELETE FROM catalog.cs_tax_types;--", display: 'x' })));
    untouched(db, before);
  });
  it('no operation DELETEs a rule or a tax type (rules are ended, never deleted)', { timeout: T }, async () => {
    const { db, svc } = setup({ tax_rules: [trule(1, A, { scope: 'orderable', orderable_id: O1.id })], surcharge_rules: [srule(1, A)] });
    await rEnd(db, svc, trule(1, A).id as string, 1); await sEnd(db, svc, srule(1, A).id as string, 1);
    expect(db.stmts.filter((s) => /^\s*DELETE/i.test(s.text))).toHaveLength(0);
  });
});
