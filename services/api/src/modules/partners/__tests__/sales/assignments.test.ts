// T0B-SALES-1: assignPartyToRepresentative / unassignPartyFromRepresentative / listRepresentativeClients (done_when (2) dates ordered, (3) one paged SQL query with outstanding + last bill date).
// Real PG17, RLS on. Fails now: operations pending. Synthetic data only.
// ASSUMPTIONS to confirm in review (T0B-SALES-1-tests.md): outstanding_paisa of a credit party = sum of its non-cancelled invoices net_paisa minus its ledger payments (this file seeds invoices only);
// last_bill_date = date of the latest issued invoice in Asia/Kathmandu; party_name = credit_parties.name / partners.name / doctors.display_name.
import { beforeEach, describe, expect, it } from 'vitest';
import { ADMIN_A, ADMIN_B, T, TENANT_A, TENANT_B, TODAY_NPT, auditRows, dbRow, dbRows, fire, idem, ifm, mkAssignment, mkCreditParty, mkDesignation, mkDoctor, mkInvoice, mkPartner, mkRep, noWrites, notFound, ok, rejected, req, uid, wipe } from './helpers.js';

let D: any; let R: any;
beforeEach(async () => { await wipe(TENANT_A, TENANT_B); D = await mkDesignation(TENANT_A, 3); R = await mkRep(TENANT_A, D.id, { name: 'Synthetic Seller' }); }, T);
const assign = (body: object, who = ADMIN_A) => fire('assignPartyToRepresentative', req({ headers: idem(), body }), who);
const unassign = (id: string, v: number | undefined, body?: object, who = ADMIN_A) => fire('unassignPartyFromRepresentative', req({ params: { assignment_id: id }, headers: v === undefined ? {} : ifm(v), body }), who);
const clients = (query: object = {}, id = R.id, who = ADMIN_A) => fire('listRepresentativeClients', req({ params: { representative_id: id }, query }), who);
const B = (party_id: string, o: object = {}) => ({ party_kind: 'credit_party', party_id, representative_id: R.id, effective_from: '2026-11-18', ...o });

describe('assignPartyToRepresentative', () => {
  it('201 for each party kind of the split model that has a master here; shape = contract; INSERT audit event', { timeout: T }, async () => {
    const cp = await mkCreditParty(TENANT_A); const pa = await mkPartner(TENANT_A); const dr = await mkDoctor(TENANT_A);
    for (const [party_kind, party_id] of [['credit_party', cp.id], ['partner', pa.id], ['doctor', dr.id]] as const) {
      const b = ok(await assign(B(party_id, { party_kind })), 201);
      expect(b).toMatchObject({ party_kind, party_id, representative_id: R.id, effective_from: '2026-11-18', version: 1 }); expect('effective_to' in b).toBe(false);
      expect((await auditRows('partners.party_sales_assignment', b.id)).map((r) => r.action)).toEqual(['INSERT']);
    }
  });
  it('party must exist in the tenant (/party_id): unknown, another tenant, unknown referrer; no write', { timeout: T }, async () => {
    const foreign = await mkCreditParty(TENANT_B);
    for (const [party_kind, party_id] of [['credit_party', uid()], ['credit_party', foreign.id], ['partner', uid()], ['doctor', uid()], ['referrer', uid()]] as const) {
      const o = await assign(B(party_id, { party_kind })); rejected(o, 'common.validation_failed', '/party_id'); noWrites(o);
    }
  });
  it('representative must exist in the tenant and be active (/representative_id)', { timeout: T }, async () => {
    const p = await mkCreditParty(TENANT_A); const foreign = await mkRep(TENANT_B, (await mkDesignation(TENANT_B, 3)).id); const dead = await mkRep(TENANT_A, D.id, { is_active: false });
    for (const id of [uid(), foreign.id, dead.id]) { const o = await assign(B(p.id, { representative_id: id })); rejected(o, 'common.validation_failed', '/representative_id'); noWrites(o); }
  });
  it('DATES ORDERED: effective_to before effective_from -> /effective_to; the same day is fine (inclusive); impossible calendar dates -> /effective_from', { timeout: T }, async () => {
    const p = await mkCreditParty(TENANT_A);
    const o = await assign(B(p.id, { effective_from: '2026-12-10', effective_to: '2026-12-09' })); rejected(o, 'common.validation_failed', '/effective_to'); noWrites(o);
    ok(await assign(B(p.id, { effective_from: '2026-12-10', effective_to: '2026-12-10' })), 201);
    for (const d of ['2026-02-30', '2026-13-01', 'tomorrow']) { const x = await assign(B((await mkCreditParty(TENANT_A)).id, { effective_from: d })); rejected(x, 'common.validation_failed', '/effective_from'); noWrites(x); }
  });
  it('OVERLAP of the same party and representative is refused (inclusive end, open end = no end); a window that starts the day after is fine', { timeout: T }, async () => {
    const p = await mkCreditParty(TENANT_A);
    ok(await assign(B(p.id, { effective_from: '2026-01-01', effective_to: '2026-01-31' })), 201);
    for (const w of [{ effective_from: '2026-01-31' }, { effective_from: '2025-12-01', effective_to: '2026-01-01' }, { effective_from: '2026-01-10', effective_to: '2026-01-12' }]) rejected(await assign(B(p.id, w)), 'common.validation_failed', '*');
    ok(await assign(B(p.id, { effective_from: '2026-02-01' })), 201);
    for (const w of [{ effective_from: '2030-01-01' }, { effective_from: '2026-02-01', effective_to: '2026-02-02' }]) rejected(await assign(B(p.id, w)), 'common.validation_failed', '*');
    expect(await dbRows('partners.party_sales_assignment', 'party_id = $1', [p.id])).toHaveLength(2);
  });
  it('tenant B cannot assign tenant A parties or representatives (validation, nothing written)', { timeout: T }, async () => {
    const p = await mkCreditParty(TENANT_A); const o = await assign(B(p.id), ADMIN_B); rejected(o, 'common.validation_failed', '/party_id');
    expect(await dbRows('partners.party_sales_assignment', 'tenant_id = $1', [TENANT_B])).toEqual([]);
  });
});

describe('unassignPartyFromRepresentative', () => {
  it('default effective_to = today in the TENANT time zone (ctx.now 2026-11-17T20:30Z -> 2026-11-18); row kept; version 2; UPDATE audit names effective_to', { timeout: T }, async () => {
    const p = await mkCreditParty(TENANT_A); const a = await mkAssignment(TENANT_A, { party: p.id, rep: R.id, from: '2026-01-01' });
    const b = ok(await unassign(a.id, 1));
    expect(b).toMatchObject({ id: a.id, effective_to: TODAY_NPT, version: 2 });
    expect(await dbRow('partners.party_sales_assignment', a.id)).toBeTruthy();
    expect((await auditRows('partners.party_sales_assignment', a.id)).some((r) => r.action === 'UPDATE' && r.changed_columns.includes('effective_to'))).toBe(true);
  });
  it('explicit effective_to; before effective_from -> /effective_to, no write; a future start cannot be ended "today"', { timeout: T }, async () => {
    const p = await mkCreditParty(TENANT_A); const a = await mkAssignment(TENANT_A, { party: p.id, rep: R.id, from: '2026-03-01' });
    const o = await unassign(a.id, 1, { effective_to: '2026-02-28' }); rejected(o, 'common.validation_failed', '/effective_to'); noWrites(o);
    expect(ok(await unassign(a.id, 1, { effective_to: '2026-12-31' })).effective_to).toBe('2026-12-31');
    const f = await mkAssignment(TENANT_A, { party: (await mkCreditParty(TENANT_A)).id, rep: R.id, from: '2027-06-01' });
    rejected(await unassign(f.id, 1), 'common.validation_failed', '/effective_to');
  });
  it('If-Match missing -> 428, stale -> 409; unknown / other tenant -> not_found', { timeout: T }, async () => {
    const a = await mkAssignment(TENANT_A, { party: (await mkCreditParty(TENANT_A)).id, rep: R.id });
    rejected(await unassign(a.id, undefined), 'common.precondition_required'); rejected(await unassign(a.id, 9), 'common.version_conflict');
    notFound(await unassign(a.id, 1, undefined, ADMIN_B)); notFound(await unassign(uid(), 1));
    expect((await dbRow('partners.party_sales_assignment', a.id)).effective_to).toBeNull();
  });
});

describe('listRepresentativeClients', () => {
  it('as_of window (inclusive both ends, open end), party_kind filter, shape = contract; other representatives\' clients are not listed', { timeout: T }, async () => {
    const [past, now, future, open, dr] = [await mkCreditParty(TENANT_A), await mkCreditParty(TENANT_A), await mkCreditParty(TENANT_A), await mkCreditParty(TENANT_A), await mkDoctor(TENANT_A)];
    await mkAssignment(TENANT_A, { party: past.id, rep: R.id, from: '2026-01-01', to: '2026-11-17' });
    await mkAssignment(TENANT_A, { party: now.id, rep: R.id, from: '2026-11-18', to: '2026-11-18' });
    await mkAssignment(TENANT_A, { party: future.id, rep: R.id, from: '2026-11-19' });
    await mkAssignment(TENANT_A, { party: open.id, rep: R.id, from: '2026-01-01' });
    await mkAssignment(TENANT_A, { kind: 'doctor', party: dr.id, rep: R.id, from: '2026-01-01' });
    await mkAssignment(TENANT_A, { party: (await mkCreditParty(TENANT_A)).id, rep: (await mkRep(TENANT_A, D.id)).id });
    const names = (b: any) => b.data.map((x: any) => x.party_id).sort();
    expect(names(ok(await clients({ as_of: '2026-11-18' })))).toEqual([now.id, open.id, dr.id].sort());
    expect(names(ok(await clients({ as_of: '2026-11-17' })))).toEqual([past.id, open.id, dr.id].sort());
    expect(names(ok(await clients({ as_of: '2026-11-19' })))).toEqual([future.id, open.id, dr.id].sort());
    expect(names(ok(await clients({ as_of: '2026-11-18', party_kind: 'doctor' })))).toEqual([dr.id]);
    const row = ok(await clients({ as_of: '2026-11-18', party_kind: 'doctor' })).data[0];
    expect(row).toMatchObject({ party_kind: 'doctor', party_name: dr.display_name, outstanding_paisa: 0, effective_from: '2026-01-01' }); expect('last_bill_date' in row).toBe(false);
    expect(Object.keys(row).every((k) => ['assignment_id', 'party_kind', 'party_id', 'party_name', 'outstanding_paisa', 'last_bill_date', 'effective_from', 'effective_to'].includes(k))).toBe(true);
  });
  it('default as_of = today in the tenant time zone (2026-11-18, not the UTC date 2026-11-17)', { timeout: T }, async () => {
    const p = await mkCreditParty(TENANT_A); await mkAssignment(TENANT_A, { party: p.id, rep: R.id, from: '2026-11-18' });
    expect(ok(await clients()).data.map((x: any) => x.party_id)).toEqual([p.id]);
  });
  it('outstanding_paisa (integer paisa) and last_bill_date come in the SAME query', { timeout: T }, async () => {
    const p = await mkCreditParty(TENANT_A); await mkAssignment(TENANT_A, { party: p.id, rep: R.id, from: '2026-01-01' });
    await mkInvoice(TENANT_A, p.id, 100000, '2026-10-30T10:00:00Z'); await mkInvoice(TENANT_A, p.id, 25050, '2026-11-10T18:30:00Z');
    const row = ok(await clients()).data[0];
    expect(row.outstanding_paisa).toBe(125050); expect(Number.isInteger(row.outstanding_paisa)).toBe(true); expect(row.last_bill_date).toBe('2026-11-11');   // 18:30Z = 00:15 NPT next day
  });
  it('NO PER ROW LOOPS: statements issued are the same for 3 and 40 clients (<= 3), one paged SQL query', { timeout: T }, async () => {
    for (let i = 0; i < 3; i++) await mkAssignment(TENANT_A, { party: (await mkCreditParty(TENANT_A)).id, rep: R.id });
    const small = await clients(); ok(small);
    for (let i = 0; i < 37; i++) await mkAssignment(TENANT_A, { party: (await mkCreditParty(TENANT_A)).id, rep: R.id });
    const big = await clients({ limit: 200 }); expect(ok(big).data).toHaveLength(40);
    expect(big.probe.sql.length).toBe(small.probe.sql.length); expect(big.probe.sql.length).toBeLessThanOrEqual(3);
  });
  it('paged: limit 10 over 25 clients = 3 pages, stable order, no gap or repeat; bad cursor -> invalid_cursor', { timeout: T }, async () => {
    for (let i = 0; i < 25; i++) await mkAssignment(TENANT_A, { party: (await mkCreditParty(TENANT_A)).id, rep: R.id });
    const seen: string[] = []; let cursor: string | undefined; let pages = 0;
    do { const p = ok(await clients({ limit: 10, ...(cursor ? { cursor } : {}) })); seen.push(...p.data.map((x: any) => x.assignment_id)); cursor = p.page.next_cursor; pages++; } while (cursor && pages < 6);
    expect(pages).toBe(3); expect(seen).toHaveLength(25); expect(new Set(seen).size).toBe(25);
    rejected(await clients({ cursor: 'garbage' }), 'common.invalid_cursor');
  });
  it('unknown / other tenant representative -> not_found; tenant B never sees tenant A clients', { timeout: T }, async () => {
    await mkAssignment(TENANT_A, { party: (await mkCreditParty(TENANT_A)).id, rep: R.id });
    notFound(await clients({}, uid())); notFound(await clients({}, R.id, ADMIN_B));
  });
});
