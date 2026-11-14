// C16.T-EP1 — EngagementPort implementation (06-PLAN T-EP1; 02-TRD §6.1; IC §4.17; 08 R25 / A17 P-20). ACs: US-EN-13.3, US-EN-17.5.
// Part 1: the shared contract (packages/fakes/contract-tests/EngagementPort.contract.ts) run in FULL (no phase1Stub) against the real impl:
//   (1) other tenant -> not_found / undefined; (2) device/patient actor -> auth.forbidden; (3) expired membership -> undefined; plus the own-tenant happy path.
// Part 2: AC cases, authorisation (who may call), tenant binding (REQ-SEC-024), minimal exposure (P2 fields), read-only, no PHI in logs.
// SEAMS the impl must honour: ctx.tx.query (single-table statements on engagement.addresses / patient_memberships / membership_plans, see EngagementPort.world.ts),
// ctx.ports.IdentityPort.assertRole(ctx, { permission }) for staff ('user') actors, ctx.now() as the default `at`.
// Fails now: the T-01 impl returns not_found / undefined for every input and never checks the actor.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runEngagementPortContract } from '../../../../../../packages/fakes/contract-tests/EngagementPort.contract';
import { ID, membership } from './membership.world.js';
import { ADDR1, ADDR2, ADDR_B, ADDR_NO_GEO, ALL_GRANTS, PAT_HOME, PERM, TA, contractHarness, makeEpWorld } from './EngagementPort.world.js';
import { engagementPort } from '../ports/EngagementPort.impl.js';

const impl: any = engagementPort;
const PAT_M = ID(0x11), PAT_NONE = ID(0x12);
const PLAN_GOLD = ID(0x21);
const MEM = (n: number) => ID(0x300 + n);
const addrIn = (id = ADDR1) => ({ homeAddressId: id, purpose: 'home_visit' as const });
const code = async (p: Promise<unknown>): Promise<string | undefined> => (await p.then(() => undefined, (e: any) => e))?.code;
const mem = (o: Record<string, unknown>) => membership(o);
const withMem = (rows: Array<Record<string, unknown>>, now?: string, grants?: readonly string[]) =>
  makeEpWorld({ now, grants, seed: ({ tables }) => { tables['patient_memberships']!.push(...rows.map((r, i) => mem({ id: MEM(i), card_token: `0123456789ABCDEFGHJKMNPQR${'ABCDEFGHJK'[i]}`, card_no: `MB2600000${i + 1}`, ...r }))); } });

runEngagementPortContract(contractHarness(impl)); // FULL contract: no phase1Stub

describe('C16-T-EP1: getActiveMembership (US-EN-17.5)', () => {
  const active = { patient_id: PAT_M, plan_id: PLAN_GOLD, status: 'active', valid_from: '2026-10-01', valid_to: '2027-10-01' };

  it('returns exactly { membershipId, planCode, planName, priceListId, validTo } for the active membership; validTo is an IsoUtc instant', async () => {
    const w = withMem([active]);
    const r = await impl.getActiveMembership(w.ctx('A'), { patientId: PAT_M });
    expect(r).toEqual({ membershipId: MEM(0), planCode: 'GOLD', planName: 'Gold plan (synthetic)', priceListId: ID(0x701), validTo: '2027-10-01T00:00:00.000Z' });
    expect(Object.keys(r).sort()).toEqual(['membershipId', 'planCode', 'planName', 'priceListId', 'validTo']); // never card_no / card_token / patient_id / plan_id
  });

  it('no membership at all for the patient -> undefined', async () => {
    await expect(impl.getActiveMembership(withMem([active]).ctx('A'), { patientId: PAT_NONE })).resolves.toBeUndefined();
  });

  it('`at` defaults to ctx.now(); valid_from <= at < valid_to (from inclusive, to exclusive)', async () => {
    const w = (iso: string) => withMem([active], iso);
    await expect(impl.getActiveMembership(w('2026-09-30T12:00:00.000Z').ctx('A'), { patientId: PAT_M })).resolves.toBeUndefined(); // before valid_from
    await expect(impl.getActiveMembership(w('2026-10-01T00:00:00.000Z').ctx('A'), { patientId: PAT_M })).resolves.toMatchObject({ membershipId: MEM(0) }); // = valid_from
    await expect(impl.getActiveMembership(w('2027-09-30T23:59:59.000Z').ctx('A'), { patientId: PAT_M })).resolves.toMatchObject({ membershipId: MEM(0) });
    await expect(impl.getActiveMembership(w('2027-10-01T00:00:00.000Z').ctx('A'), { patientId: PAT_M })).resolves.toBeUndefined(); // = valid_to is out
  });

  it('explicit `at` overrides ctx.now()', async () => {
    const w = withMem([active]); // now = 2026-11-05, inside
    await expect(impl.getActiveMembership(w.ctx('A'), { patientId: PAT_M, at: '2028-01-01T00:00:00.000Z' })).resolves.toBeUndefined();
    await expect(impl.getActiveMembership(w.ctx('A'), { patientId: PAT_M, at: '2026-12-01T00:00:00.000Z' })).resolves.toMatchObject({ membershipId: MEM(0) });
    await expect(impl.getActiveMembership(w.ctx('A'), { patientId: PAT_M, at: '2026-09-01T00:00:00.000Z' })).resolves.toBeUndefined();
  });

  it('cancelled and expired status never count, even when the dates cover `at`', async () => {
    for (const status of ['cancelled', 'expired']) {
      const extra = status === 'cancelled' ? { cancelled_at: '2026-10-15T00:00:00.000Z', cancel_reason_code: 'other' } : {};
      await expect(impl.getActiveMembership(withMem([{ ...active, status, ...extra }]).ctx('A'), { patientId: PAT_M }), status).resolves.toBeUndefined();
    }
  });

  it('with an old expired card and a current active card, returns the active one', async () => {
    const w = withMem([{ ...active, status: 'expired', valid_from: '2025-01-01', valid_to: '2026-01-01' }, active]);
    await expect(impl.getActiveMembership(w.ctx('A'), { patientId: PAT_M })).resolves.toMatchObject({ membershipId: MEM(1) });
  });

  it("only the asked patient's membership is returned", async () => {
    const w = withMem([active, { ...active, patient_id: PAT_NONE }]);
    await expect(impl.getActiveMembership(w.ctx('A'), { patientId: PAT_NONE })).resolves.toMatchObject({ membershipId: MEM(1) });
  });

  it('tenant B asking for tenant A patient -> undefined (RLS) and still undefined when the tx would let A rows through (impl binds tenant_id itself)', async () => {
    const w = withMem([active]);
    await expect(impl.getActiveMembership(w.ctx('B'), { patientId: PAT_M })).resolves.toBeUndefined();
    await expect(impl.getActiveMembership(w.ctx('B', {}, { bypassRls: true }), { patientId: PAT_M })).resolves.toBeUndefined();
  });

  it('actors: device / patient -> auth.forbidden before any engagement table is read', async () => {
    for (const key of ['A:device', 'A:patient']) {
      const w = withMem([active]);
      expect(await code(impl.getActiveMembership(w.ctx(key), { patientId: PAT_M })), key).toBe('auth.forbidden');
      expect(w.stmts.filter((s) => /engagement\./i.test(s.text)), key).toEqual([]);
    }
  });

  it(`staff ('user') actor needs ${PERM.REG}: without it -> auth.forbidden; with it -> the membership`, async () => {
    const without = withMem([active], undefined, [PERM.VISIT_READ, PERM.VISIT_ASSIGN]);
    expect(await code(impl.getActiveMembership(without.ctx('A'), { patientId: PAT_M }))).toBe('auth.forbidden');
    expect(without.identity.asserted.map((a) => a.permission)).toContain(PERM.REG);
    const ok = withMem([active], undefined, [PERM.REG]);
    await expect(impl.getActiveMembership(ok.ctx('A'), { patientId: PAT_M })).resolves.toMatchObject({ membershipId: MEM(0) });
  });
});

describe('C16-T-EP1: getHomeAddress (US-EN-13.3)', () => {
  const w0 = () => makeEpWorld();

  it('system actor gets the address of D by id: addressText, landmark, latitude, longitude (DecimalString); needs no permission grant', async () => {
    const w = makeEpWorld({ grants: [] });
    await expect(impl.getHomeAddress(w.ctx('A:system'), addrIn())).resolves.toEqual({
      addressText: 'Test Street 9, Test Ward 9', landmark: 'Next to the synthetic pharmacy', latitude: '27.717200', longitude: '85.324000',
    });
  });

  it('returns only the asked address, and only the four contract fields (no patient_id, phone, municipality, ward, district, label, account_id)', async () => {
    const w = w0();
    const r = await impl.getHomeAddress(w.ctx('A:system'), addrIn(ADDR2));
    expect(r).toMatchObject({ addressText: 'Test Lane 2, Test Ward 2', landmark: 'Opposite the synthetic school' });
    expect(Object.keys(r).every((k) => ['addressText', 'landmark', 'latitude', 'longitude'].includes(k))).toBe(true);
    expect(JSON.stringify(r)).not.toMatch(/97798000000099|Test Municipality|Test District|PAT|patient_id|account_id/);
  });

  it('optional fields are omitted (not null) when the row has none', async () => {
    const r = await impl.getHomeAddress(w0().ctx('A:system'), addrIn(ADDR_NO_GEO));
    expect(Object.keys(r)).toEqual(['addressText']);
  });

  it('unknown address id -> common.not_found', async () => {
    expect(await code(impl.getHomeAddress(w0().ctx('A:system'), addrIn(ID(0xdead))))).toBe('common.not_found');
  });

  it("other tenant's address -> common.not_found, both with RLS and when the tx would let tenant A rows through", async () => {
    const w = w0();
    expect(await code(impl.getHomeAddress(w.ctx('B:system'), addrIn(ADDR1)))).toBe('common.not_found'); // A's row, B's session
    expect(await code(impl.getHomeAddress(w.ctx('B:system', {}, { bypassRls: true }), addrIn(ADDR1)))).toBe('common.not_found');
    expect(await code(impl.getHomeAddress(w.ctx('A:system'), addrIn(ADDR_B)))).toBe('common.not_found'); // B's row, A's session
  });

  it('actors: device / patient -> auth.forbidden before any engagement table is read (even for their own tenant address)', async () => {
    for (const key of ['A:device', 'A:patient']) {
      const w = w0();
      expect(await code(impl.getHomeAddress(w.ctx(key), addrIn())), key).toBe('auth.forbidden');
      expect(w.stmts.filter((s) => /engagement\./i.test(s.text)), key).toEqual([]);
    }
  });

  it(`staff ('user') actor needs ${PERM.VISIT_ASSIGN} or ${PERM.VISIT_READ}; any other permission -> auth.forbidden`, async () => {
    for (const g of [PERM.VISIT_ASSIGN, PERM.VISIT_READ]) {
      await expect(impl.getHomeAddress(makeEpWorld({ grants: [g] }).ctx('A'), addrIn()), g).resolves.toMatchObject({ addressText: 'Test Street 9, Test Ward 9' });
    }
    const none = makeEpWorld({ grants: [PERM.REG, 'engagement.membership.read'] });
    expect(await code(impl.getHomeAddress(none.ctx('A'), addrIn()))).toBe('auth.forbidden');
    expect(none.stmts.filter((s) => /engagement\./i.test(s.text))).toEqual([]);
  });

  it("purpose other than 'home_visit' -> common.validation_failed (purpose limitation for P2 data), nothing read", async () => {
    const w = w0();
    expect(await code(impl.getHomeAddress(w.ctx('A:system'), { homeAddressId: ADDR1, purpose: 'marketing' }))).toBe('common.validation_failed');
    expect(w.stmts.filter((s) => /engagement\./i.test(s.text))).toEqual([]);
  });

  it('the caller writes access_log (IC §4.17): the port itself writes no audit entry and no row', async () => {
    const w = w0();
    await impl.getHomeAddress(w.ctx('A:system'), addrIn());
    expect(w.audit.access).toEqual([]);
    expect(w.writes()).toEqual([]);
  });

  it('never logs the address (REQ-SEC-024 / 07 §2 denylist)', async () => {
    const w = w0();
    await impl.getHomeAddress(w.ctx('A:system'), addrIn());
    await impl.getHomeAddress(w.ctx('B:system'), addrIn()).catch(() => undefined);
    expect(JSON.stringify(w.logged)).not.toMatch(/Test Street|pharmacy|27\.7172|85\.324/);
  });
});

describe('C16-T-EP1: shared guarantees', () => {
  it('every engagement statement is read-only, binds tenant_id and the ctx tenant, and uses no catalog/v_pub_* relation (08 R25 / A17 P-21)', async () => {
    const w = withMem([{ patient_id: PAT_M, plan_id: PLAN_GOLD, status: 'active', valid_from: '2026-10-01', valid_to: '2027-10-01' }]);
    await impl.getActiveMembership(w.ctx('A'), { patientId: PAT_M });
    await impl.getHomeAddress(w.ctx('A:system'), addrIn());
    const eng = w.stmts.filter((s) => /engagement\./i.test(s.text));
    expect(eng.length).toBeGreaterThanOrEqual(3); // membership, plan, address
    for (const s of eng) {
      expect(s.text, s.text).toMatch(/^\s*select\b/i);
      expect(s.text, s.text).toMatch(/\btenant_id\s*=\s*\$\d/i);
      expect(s.values, s.text).toContain(TA);
      expect(s.text, s.text).not.toMatch(/v_pub_|catalog\.|\bjoin\b/i);
    }
    expect(w.writes()).toEqual([]);
  });

  it('source: no v_pub_ view, no logger or console call, and the port does not leak the T-01 stub shape', () => {
    const src = readFileSync(new URL('../ports/EngagementPort.impl.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/v_pub_/);
    expect(src).not.toMatch(/console\.|\.log\.(info|warn|error|debug)\(/);
    expect(src).not.toMatch(/async getActiveMembership\(\)\s*:\s*Promise<undefined>/); // T-01 stub-equivalent body replaced (P-20)
  });

  it('the registered manifest port is this implementation: same methods, no fake controls', async () => {
    const { manifest } = await import('../index.js');
    const reg: any = (manifest.ports as any).EngagementPort;
    expect(reg.getHomeAddress).toBe(impl.getHomeAddress);
    expect(reg.getActiveMembership).toBe(impl.getActiveMembership);
    for (const c of ['failNext', 'latency', 'calls', 'reset', 'seed', 'fixtures', '__seed', '__rollback']) expect(reg[c], c).toBeUndefined();
  });

  it('every permission grant combination still leaves device/patient out (deny by actor type, not by permission)', async () => {
    for (const key of ['A:device', 'A:patient']) {
      const w = makeEpWorld({ grants: ALL_GRANTS });
      expect(await code(impl.getHomeAddress(w.ctx(key), addrIn())), key).toBe('auth.forbidden');
      expect(await code(impl.getActiveMembership(w.ctx(key), { patientId: PAT_HOME })), key).toBe('auth.forbidden');
    }
  });
});
