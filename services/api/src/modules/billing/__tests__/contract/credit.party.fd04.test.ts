// BL-T13 done_when "account upsert on first charge; allowsCredit/inactive -> locked" (PRD US-FD-04.1/.2/.4; 02-TRD §6.3 recordCreditCharges/assertCreditAllowed; contract case 14).
// The shared contract suite covers allowsCredit = false and isLocked; THIS file adds what it does not: inactive party (C3 isActive = false), the snapshot values of the first-charge upsert,
// and that a later charge never resets lock / limit / terms. Runs on the real ports/BillingCommandPort.impl.ts (BL-T07), which BL-T13 may move into service/credit.service.ts:
// the behaviour must not change, so these PASS now and guard the refactor.
import { describe, expect, it } from 'vitest';
import { makeCtxFor } from '../../../../../../../packages/fakes/src/harness';
import { makeContractWorld } from './harness.js';

const id = (n: number) => `01900000-0000-7000-8000-0000000c5${n.toString(16).padStart(3, '0')}`;
const P_INACTIVE = id(1), P_NEW = id(2), P_TERMS = id(3), ORDER = id(0x10), BRANCH = id(0x42), CENTRE = id(0x43), PL = id(0x41);
const npr = (amountPaisa: number) => ({ amountPaisa, currency: 'NPR' as const });
const LINES = [{ lineRef: 'CBC', orderableId: id(0x100), orderableKind: 'test' as const, code: 'CBC', name: 'Synthetic CBC', priority: 'routine' as const, unitPrice: npr(50000),
  tax: { vat: 'taxable' as const, vatRateBp: 1300 }, priceListId: PL, priceListVersion: 1, priceSource: 'tenant_default' as const }];
const fail = async (p: Promise<unknown>): Promise<any> => p.then(() => { throw new Error('expected rejection'); }, (e) => e);

async function boot(parties: object[], accounts: object[] = []) {
  const world: any = makeContractWorld();
  const mod: any = await import('../../ports/BillingCommandPort.impl.js');
  const port = mod.createBillingCommandPort(world.deps);
  const A = makeCtxFor()('A');
  world.st.orders.push({ id: ORDER, tenantId: A.tenantId });
  for (const p of parties) world.st.parties.push({ tenantId: A.tenantId, allowsCredit: true, isActive: true, isLocked: false, creditLimitPaisa: null, outstandingPaisa: 0, ...p });
  for (const a of accounts) world.st.accounts.push({ tenant_id: A.tenantId, ...a });
  const ctx = world.enrich(A);
  const q = await port.computeQuote(ctx, { lines: LINES, discounts: [] });
  const charge = (party: string) => port.recordCreditCharges(world.enrich(A), { orderId: ORDER, creditPartyId: party, branchId: BRANCH, centreId: CENTRE, patientDisplayName: 'Synthetic Patient', lines: LINES, discounts: [], expectedFingerprint: q.fingerprint });
  return { world, port, ctx, A, q, charge };
}

describe('US-FD-04.2: C3 reports the party inactive -> 409 billing.credit_party_locked, nothing stored', () => {
  it('recordCreditCharges and assertCreditAllowed both refuse an inactive party (isActive = false), even with allowsCredit = true and no locked account', async () => {
    const { world, port, ctx, charge } = await boot([{ id: P_INACTIVE, isActive: false }]);
    expect((await fail(charge(P_INACTIVE))).code).toBe('billing.credit_party_locked');
    expect((await fail(port.assertCreditAllowed(ctx, { creditPartyId: P_INACTIVE, additional: npr(1) }))).code).toBe('billing.credit_party_locked');
    expect(world.st.charges).toHaveLength(0);
  });
});

describe('US-FD-04.4: first credit order of a party creates its credit_accounts row from CatalogPort.getCreditParty({purpose:"billing"}) in the same transaction', () => {
  it('first charge: account upserted with the C3 snapshot (code, name, PAN, address), unlocked, no limit; charges follow in the same call', async () => {
    const { world, charge } = await boot([{ id: P_NEW }]);
    expect(world.st.accounts).toHaveLength(0);
    const r = await charge(P_NEW);
    expect(r.chargeIds).toHaveLength(1);
    const up = world.repoCalls.filter((c: any) => c.name === 'upsertCreditAccount');
    expect(up).toHaveLength(1);
    expect(up[0].args).toMatchObject({ creditPartyId: P_NEW, partyCode: 'SYN-PARTY', partyName: 'Synthetic Credit Party', pan: '123456789', address: 'Synthetic Street 1' });
    expect(world.st.accounts).toHaveLength(1);
    expect(world.st.accounts[0]).toMatchObject({ credit_party_id: P_NEW, is_locked: false, credit_limit_paisa: null });
    expect(world.st.charges).toHaveLength(1);
  });
  it('a later charge of the same party never creates a second account row (no limit set)', async () => {
    const { world, charge } = await boot([{ id: P_NEW }]);
    await charge(P_NEW);
    await charge(P_NEW);
    expect(world.st.accounts).toHaveLength(1);
    expect(world.st.charges).toHaveLength(2);
  });
  it('a charge on an existing account never resets its limit / lock state (the snapshot refresh touches party columns only)', async () => {
    // one charge only: the T07 harness exposure fake cannot sum charge rows once a limit is set
    const { world, charge } = await boot([{ id: P_TERMS }], [{ credit_party_id: P_TERMS, is_locked: false, credit_limit_paisa: '5000000' }]);
    await charge(P_TERMS);
    expect(world.st.accounts).toHaveLength(1);
    expect(world.st.accounts[0]).toMatchObject({ is_locked: false, credit_limit_paisa: '5000000' });
    expect(world.st.charges).toHaveLength(1);
  });
  it('a locked account still refuses with billing.credit_party_locked after the snapshot refresh; nothing is charged', async () => {
    const { world, charge } = await boot([{ id: P_TERMS }], [{ credit_party_id: P_TERMS, is_locked: true, credit_limit_paisa: null }]);
    expect((await fail(charge(P_TERMS))).code).toBe('billing.credit_party_locked');
    expect(world.st.charges).toHaveLength(0);
  });
});

describe('US-FD-04.3 (port side): a non-UUID credit party is common.validation_failed on /creditPartyId, before any lookup', () => {
  it('recordCreditCharges and assertCreditAllowed', async () => {
    const { world, port, ctx, q, A } = await boot([]);
    const e = await fail(port.recordCreditCharges(world.enrich(A), { orderId: ORDER, creditPartyId: 'x', branchId: BRANCH, centreId: CENTRE, patientDisplayName: 'Synthetic Patient', lines: LINES, discounts: [], expectedFingerprint: q.fingerprint }));
    expect(e.code).toBe('common.validation_failed');
    expect(e.errors?.some((x: any) => /creditPartyId/.test(x.path))).toBe(true);
    expect((await fail(port.assertCreditAllowed(ctx, { creditPartyId: 'x', additional: npr(1) }))).code).toBe('common.validation_failed');
  });
});
