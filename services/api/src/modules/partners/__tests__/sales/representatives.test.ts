// T0B-SALES-1: create / update / deactivate / list sales representatives (done_when (2): no self manager, no manager loop, manager same tenant + active,
// deactivation with active clients refused, dates ordered; domain layer first, DB triggers are only the backstop). Real PG17, RLS on. Synthetic data only.
// Fails now: the operations are pending (no handler).
import { beforeEach, describe, expect, it } from 'vitest';
import { ADMIN_A, ADMIN_B, T, TENANT_A, TENANT_B, TODAY_NPT, auditRows, chain, dbRow, fire, idem, ifm, mkAssignment, mkCreditParty, mkDesignation, mkRep, noWrites, notFound, ok, rejected, req, uid, wipe } from './helpers.js';

let D: any; let DB: any;
beforeEach(async () => { await wipe(TENANT_A, TENANT_B); D = await mkDesignation(TENANT_A, 2); DB = await mkDesignation(TENANT_B, 2); }, T);
const create = (body: object, who = ADMIN_A) => fire('createSalesRepresentative', req({ headers: idem(), body }), who);
const update = (id: string, v: number | undefined, body: object, who = ADMIN_A) => fire('updateSalesRepresentative', req({ params: { representative_id: id }, headers: v === undefined ? {} : ifm(v), body }), who);
const deactivate = (id: string, v: number | undefined, who = ADMIN_A) => fire('deactivateSalesRepresentative', req({ params: { representative_id: id }, headers: v === undefined ? {} : ifm(v) }), who);
const PHONE = '+9779801234567'; const EMAIL = 'synthetic.rep.7731@example.test';

describe('createSalesRepresentative', () => {
  it('201: contract shape (designation_level joined in), version 1, no tenant_id / audit columns; INSERT audit event; phone + email never in the audit values nor in logs', { timeout: T }, async () => {
    const mgr = await mkRep(TENANT_A, D.id);
    const o = await create({ name: 'Synthetic Rep', phone: PHONE, email: EMAIL, designation_id: D.id, manager_id: mgr.id, joining_date: '2026-04-14' });
    const b = ok(o, 201);
    expect(b).toMatchObject({ name: 'Synthetic Rep', phone: PHONE, email: EMAIL, designation_id: D.id, designation_level: 2, manager_id: mgr.id, joining_date: '2026-04-14', is_active: true, version: 1 });
    expect(Object.keys(b).every((k) => ['id', 'name', 'phone', 'email', 'user_id', 'designation_id', 'designation_level', 'manager_id', 'joining_date', 'is_active', 'version', 'created_at', 'updated_at'].includes(k))).toBe(true);
    expect(await dbRow('partners.sales_representative', b.id)).toMatchObject({ tenant_id: TENANT_A, manager_id: mgr.id });
    const a = await auditRows('partners.sales_representative', b.id);
    expect(a.map((r) => r.action)).toEqual(['INSERT']);
    expect(JSON.stringify(a)).not.toContain(PHONE); expect(JSON.stringify(a)).not.toContain(EMAIL);
    expect(o.probe.logs.join('\n')).not.toContain(PHONE); expect(o.probe.logs.join('\n')).not.toContain(EMAIL);
  });
  it('no manager = top of the tree: manager_id key is absent, not null', { timeout: T }, async () => {
    expect('manager_id' in ok(await create({ name: 'Synthetic Top', designation_id: D.id }), 201)).toBe(false);
  });
  it('designation: unknown, other tenant, inactive -> /designation_id, no write, the request values are not echoed', { timeout: T }, async () => {
    const dead = await mkDesignation(TENANT_A, 7, { is_active: false });
    for (const id of [uid(), DB.id, dead.id]) { const o = await create({ name: 'Synthetic', phone: PHONE, designation_id: id }); rejected(o, 'common.validation_failed', '/designation_id', PHONE); noWrites(o); }
  });
  it('manager: unknown, other tenant, inactive -> /manager_id, no write', { timeout: T }, async () => {
    const foreign = await mkRep(TENANT_B, DB.id); const dead = await mkRep(TENANT_A, D.id, { is_active: false });
    for (const id of [uid(), foreign.id, dead.id]) { const o = await create({ name: 'Synthetic', designation_id: D.id, manager_id: id }); rejected(o, 'common.validation_failed', '/manager_id'); noWrites(o); }
  });
  it.each([[''], ['   '], ['x'.repeat(201)]])('name %j -> /name', { timeout: T }, async (name) => { const o = await create({ name, designation_id: D.id }); rejected(o, 'common.validation_failed', '/name'); noWrites(o); });
  it.each([['2026-02-30'], ['2026-13-01'], ['14/04/2026'], ['']])('joining_date %j -> /joining_date', { timeout: T }, async (d) => { const o = await create({ name: 'Synthetic', designation_id: D.id, joining_date: d }); rejected(o, 'common.validation_failed', '/joining_date'); noWrites(o); });
  it.each([['12345'], ['+0123456789'], ['+977 980 123 4567']])('phone %j -> /phone and the value is not echoed', { timeout: T }, async (phone) => { const o = await create({ name: 'Synthetic', designation_id: D.id, phone }); rejected(o, 'common.validation_failed', '/phone', phone); noWrites(o); });
});

describe('updateSalesRepresentative', () => {
  it('rename + move: 200, version 2; UPDATE audit names manager_id and not phone / email', { timeout: T }, async () => {
    const [a, b] = await chain(TENANT_A, D.id, 2); const x = await mkRep(TENANT_A, D.id, { phone: PHONE, email: EMAIL });
    const out = ok(await update(b!.id, 1, { name: 'Synthetic moved', manager_id: x.id }));
    expect(out).toMatchObject({ id: b!.id, name: 'Synthetic moved', manager_id: x.id, version: 2 }); expect(a).toBeTruthy();
    const ev = (await auditRows('partners.sales_representative', b!.id)).filter((r) => r.action === 'UPDATE');
    expect(ev).toHaveLength(1); expect(ev[0].changed_columns).toEqual(expect.arrayContaining(['manager_id', 'name']));
    const c = ok(await update(x.id, 1, { phone: '+9779800000001' }));
    expect(JSON.stringify(await auditRows('partners.sales_representative', x.id))).not.toContain('+9779800000001'); expect(c.version).toBe(2);
  });
  it('moving a representative moves its whole team (the reports keep their manager_id)', { timeout: T }, async () => {
    const [top, mid, low] = await chain(TENANT_A, D.id, 3); const other = await mkRep(TENANT_A, D.id);
    ok(await update(mid!.id, 1, { manager_id: other.id }));
    expect((await dbRow('partners.sales_representative', low!.id)).manager_id).toBe(mid!.id); expect(top).toBeTruthy();
  });
  it('unset clears optional fields (manager_id, phone) and the key is gone from the answer', { timeout: T }, async () => {
    const [, b] = await chain(TENANT_A, D.id, 2); await fire('updateSalesRepresentative', req({ params: { representative_id: b!.id }, headers: ifm(1), body: { phone: PHONE } }), ADMIN_A);
    const out = ok(await update(b!.id, 2, { unset: ['manager_id', 'phone'] }));
    expect('manager_id' in out).toBe(false); expect('phone' in out).toBe(false);
  });
  it('NO SELF MANAGER: refused (/manager_id) in the domain layer, before any write', { timeout: T }, async () => {
    const r = await mkRep(TENANT_A, D.id); const o = await update(r.id, 1, { manager_id: r.id });
    rejected(o, 'common.validation_failed', '/manager_id'); noWrites(o);
  });
  it('NO MANAGER LOOP: a under b under c, moving a under c or b is refused (/manager_id) before any write; the chain is unchanged', { timeout: T }, async () => {
    const [a, b, c] = await chain(TENANT_A, D.id, 3);
    for (const m of [c!.id, b!.id]) { const o = await update(a!.id, 1, { manager_id: m }); rejected(o, 'common.validation_failed', '/manager_id'); noWrites(o); }
    expect((await dbRow('partners.sales_representative', a!.id)).manager_id).toBeNull(); expect((await dbRow('partners.sales_representative', a!.id)).version).toBe(1);
  });
  it('manager must be same tenant and active: foreign / inactive / unknown -> /manager_id', { timeout: T }, async () => {
    const r = await mkRep(TENANT_A, D.id); const foreign = await mkRep(TENANT_B, DB.id); const dead = await mkRep(TENANT_A, D.id, { is_active: false });
    for (const id of [foreign.id, dead.id, uid()]) { const o = await update(r.id, 1, { manager_id: id }); rejected(o, 'common.validation_failed', '/manager_id'); noWrites(o); }
  });
  it('designation must be an active designation of the tenant (/designation_id)', { timeout: T }, async () => {
    const r = await mkRep(TENANT_A, D.id); const dead = await mkDesignation(TENANT_A, 6, { is_active: false });
    for (const id of [DB.id, dead.id]) { const o = await update(r.id, 1, { designation_id: id }); rejected(o, 'common.validation_failed', '/designation_id'); noWrites(o); }
    expect(ok(await update(r.id, 1, { designation_id: (await mkDesignation(TENANT_A, 4)).id })).designation_level).toBe(4);
  });
  it('If-Match missing -> 428, stale -> 409; other tenant / unknown id -> not_found', { timeout: T }, async () => {
    const r = await mkRep(TENANT_A, D.id);
    rejected(await update(r.id, undefined, { name: 'X' }), 'common.precondition_required');
    ok(await update(r.id, 1, { name: 'Synthetic v2' })); rejected(await update(r.id, 1, { name: 'Synthetic stale' }), 'common.version_conflict');
    notFound(await update(r.id, 2, { name: 'Synthetic hijack' }, ADMIN_B)); notFound(await update(uid(), 1, { name: 'X' }));
  });
});

describe('deactivateSalesRepresentative', () => {
  it('200: is_active false, version +1, UPDATE audit names is_active; nothing is deleted; direct reports keep manager_id', { timeout: T }, async () => {
    const [top, low] = await chain(TENANT_A, D.id, 2);
    const b = ok(await deactivate(top!.id, 1));
    expect(b).toMatchObject({ id: top!.id, is_active: false, version: 2 });
    expect((await auditRows('partners.sales_representative', top!.id)).some((r) => r.action === 'UPDATE' && r.changed_columns.includes('is_active'))).toBe(true);
    expect((await dbRow('partners.sales_representative', low!.id)).manager_id).toBe(top!.id);
  });
  it('REFUSED while the representative has active clients (open ended or ending today / later): validation error, nothing changes', { timeout: T }, async () => {
    for (const to of [null, TODAY_NPT, '2027-01-01']) {
      const r = await mkRep(TENANT_A, D.id); const p = await mkCreditParty(TENANT_A); await mkAssignment(TENANT_A, { party: p.id, rep: r.id, from: '2026-01-01', to });
      const o = await deactivate(r.id, 1); rejected(o, 'common.validation_failed', '*'); noWrites(o);
      expect(await dbRow('partners.sales_representative', r.id)).toMatchObject({ is_active: true, version: 1 });
    }
  });
  it('allowed when every assignment already ended before today (tenant time zone), and after the clients were unassigned in an earlier request', { timeout: T }, async () => {
    const r = await mkRep(TENANT_A, D.id); const p = await mkCreditParty(TENANT_A); await mkAssignment(TENANT_A, { party: p.id, rep: r.id, from: '2026-01-01', to: '2026-11-17' });
    expect(ok(await deactivate(r.id, 1)).is_active).toBe(false);
    const r2 = await mkRep(TENANT_A, D.id); const a2 = await mkAssignment(TENANT_A, { party: p.id, rep: r2.id, from: '2026-01-01' });
    rejected(await deactivate(r2.id, 1), 'common.validation_failed', '*');
    ok(await fire('unassignPartyFromRepresentative', req({ params: { assignment_id: a2.id }, headers: ifm(1), body: { effective_to: '2026-11-17' } }), ADMIN_A));
    expect(ok(await deactivate(r2.id, 1)).is_active).toBe(false);
  });
  it('a deactivated representative is not a manager candidate any more and gets no new assignment', { timeout: T }, async () => {
    const r = await mkRep(TENANT_A, D.id); ok(await deactivate(r.id, 1)); const p = await mkCreditParty(TENANT_A);
    rejected(await create({ name: 'Synthetic', designation_id: D.id, manager_id: r.id }), 'common.validation_failed', '/manager_id');
    rejected(await fire('assignPartyToRepresentative', req({ headers: idem(), body: { party_kind: 'credit_party', party_id: p.id, representative_id: r.id, effective_from: '2026-11-18' } }), ADMIN_A), 'common.validation_failed', '/representative_id');
  });
  it('If-Match missing -> 428, stale -> 409; other tenant / unknown -> not_found', { timeout: T }, async () => {
    const r = await mkRep(TENANT_A, D.id);
    rejected(await deactivate(r.id, undefined), 'common.precondition_required'); rejected(await deactivate(r.id, 5), 'common.version_conflict');
    notFound(await deactivate(r.id, 1, ADMIN_B)); notFound(await deactivate(uid(), 1));
    expect((await dbRow('partners.sales_representative', r.id)).is_active).toBe(true);
  });
});

describe('listSalesRepresentatives', () => {
  it('own tenant only; filters q (prefix, case-insensitive) / designation_id / manager_id (direct reports) / is_active; paged without gaps or repeats', { timeout: T }, async () => {
    const d3 = await mkDesignation(TENANT_A, 3);
    const boss = await mkRep(TENANT_A, D.id, { name: 'Anita Boss' });
    for (let i = 0; i < 5; i++) await mkRep(TENANT_A, d3.id, { name: `Report ${i}`, manager_id: boss.id });
    await mkRep(TENANT_A, d3.id, { name: 'Retired Rep', is_active: false }); await mkRep(TENANT_B, DB.id, { name: 'Other tenant rep' });
    const L = (query: object, who = ADMIN_A) => fire('listSalesRepresentatives', req({ query }), who);
    expect(ok(await L({})).data).toHaveLength(7);
    expect(ok(await L({ q: 'ANITA' })).data.map((x: any) => x.id)).toEqual([boss.id]);
    expect(ok(await L({ designation_id: D.id })).data.map((x: any) => x.id)).toEqual([boss.id]);
    expect(ok(await L({ manager_id: boss.id })).data).toHaveLength(5);
    expect(ok(await L({ is_active: false })).data.map((x: any) => x.name)).toEqual(['Retired Rep']);
    const seen: string[] = []; let cursor: string | undefined;
    for (let i = 0; i < 6; i++) { const p = ok(await L({ limit: 3, ...(cursor ? { cursor } : {}) })); seen.push(...p.data.map((x: any) => x.id)); cursor = p.page.next_cursor; if (!cursor) break; }
    expect(seen).toHaveLength(7); expect(new Set(seen).size).toBe(7);
    expect(ok(await L({}, ADMIN_B)).data.map((x: any) => x.name)).toEqual(['Other tenant rep']);
  });
});
