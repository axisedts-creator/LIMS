// BL-T08 recordPayment (B8 / BillingCommandPort.recordPayment): ledger payments, cash-session linkage, RC receipt numbers, REQ-SEC-056.
// Spec: 02-TRD §5 B8, §6.3 recordPayment + contract cases (7)(8), §6.5, §12 lock order; 03-APP-FLOW §2.9, §5 row "Home-collection payment"; PRD US-FD-08.1–.3, US-BL-11.3;
//       05-SCHEMA billing.ledger_entries; 07-SECURITY REQ-SEC-050/051/056; 08 A19 D-128. done_when: "Overpay refused (manual), recorded (home); RC numbering from TenantSettings;
//       one open session; B22/home payments have no session".
// Fails now: ../ledger.service.js does not exist.
// ASSUMED API (writer: object via a dispute if wrong):
//   ledger.service.ts : createLedgerService(deps:{ repo, counter, events: createBillingEvents(...) }) -> { recordPayment(ctx, input) }
//     input/return = BillingCommandPort.recordPayment (contracts/ports/BillingCommandPort.ts) PLUS one extra field on the result: `entry` = the LedgerEntryDto (snake_case, contracts/openapi billing.yaml) so the B8 handler needs no re-read.
//     ctx = { tenantId, actor:{type,id,membershipId}, tx, now, requestId, ports:{IdentityPort.getTenantSettings} } exactly as invoice.service (tenant/actor from ctx only, never from input).
//     Validation errors: LimsError('common.validation_failed', undefined, [{path:'/reference',...}]) with camelCase service paths, like invoice.service.
//   Repo seams: see t08.helpers.ts header. readOrderTotals additionally returns branch_id (the order's invoice branch) - needed for ledger_entries.branch_id NOT NULL.
//   Order of work (03-APP-FLOW §2.9 / TRD §12): replay check -> validate -> lock order_balances -> (RC counter) -> insert ledger -> balance recompute + event -> activity.
import { describe, expect, it } from 'vitest';
import { createBillingEvents } from '../../events/publish.js';
import { createLedgerService } from '../ledger.service.js';
import { BASE, errCode, IDS, INVOICE, makeLedgerWorld, MEMBERSHIP, money, npr, OTHER_MEMBER, OTHER_TENANT, TENANT_A, USER, V7, type LedgerOpts, type LedgerWorld } from './t08.helpers.js';

let n = 0;
const svcOf = (w: LedgerWorld) => createLedgerService({ repo: w.repo as never, counter: w.counter as never, events: createBillingEvents(w.events) as never });
const input = (over: Record<string, unknown> = {}) => ({ orderId: IDS.order, methodCode: 'cash', amount: npr(100000), captureKind: 'manual', idempotencyKey: `t08-key-${++n}`, issueReceiptNo: true, ...over });
const setup = async (opts: LedgerOpts = {}) => { const w = makeLedgerWorld(opts); await w.seedBalance(); return { w, svc: svcOf(w), ctx: w.ctx() }; };
const pay = (w: LedgerWorld, svc: ReturnType<typeof svcOf>, ctx: never, over: Record<string, unknown> = {}) => w.tx(() => svc.recordPayment(ctx, input(over) as never) as Promise<any>);
const WRITES = ['insertLedgerEntry', 'insertCashSession', 'insertActivity', 'upsertOrderBalance'];
const writeCalls = (w: LedgerWorld, from = 0) => w.names().slice(from).filter((x) => WRITES.includes(x));
const noSideEffects = (w: LedgerWorld, repoMark: number, counterMark: number, eventMark: number) => {
  expect(writeCalls(w, repoMark), 'no repo write may happen before validation passes').toEqual([]);
  expect(w.counterCalls.length).toBe(counterMark);
  expect(w.balanceEvents().length).toBe(eventMark);
};

describe('US-FD-08.1 / .2 part payment then settlement', () => {
  it('1: invoice 2,250.00, cash 1,000.00 -> due 1,250.00, balance.changed v2 payment_recorded {release_eligible:false, due_outstanding}, no duplicate, no excess', async () => {
    const { w, svc, ctx } = await setup();
    const r = await pay(w, svc, ctx, { amount: npr(100000) });
    expect(r).toMatchObject({ duplicate: false, exceedsDue: false });
    expect(typeof r.ledgerEntryId).toBe('string');
    expect(r.balance).toMatchObject({ orderId: IDS.order, invoiced: npr(225000), paid: npr(100000), credited: npr(0), balanceDue: npr(125000), balanceVersion: 2 });
    expect(typeof r.balance.asOf).toBe('string');
    const ev = w.balanceEvents(); expect(ev).toHaveLength(2);
    expect(ev[1].payload).toEqual({ order_id: IDS.order, balance_version: 2, invoiced: money(225000), paid: money(100000), credited: money(0), balance_due: money(125000),
      cause: 'payment_recorded', release_eligible: false, release_basis: 'due_outstanding' });
    expect(ev[1].idempotency_key).toBe(`${IDS.order}:balance:2`);
  });
  it('2: later card 1,250.00 (reference) -> RC receipt, balance 0, event paid_in_full + release_eligible true', async () => {
    const { w, svc, ctx } = await setup();
    await pay(w, svc, ctx, { amount: npr(100000), issueReceiptNo: false });
    const r = await pay(w, svc, ctx, { methodCode: 'card', amount: npr(125000), reference: 'POS-AB12' });
    expect(r.receiptNo).toBe('RC-083/84-000001');
    expect(r.balance).toMatchObject({ paid: npr(225000), balanceDue: npr(0), balanceVersion: 3 });
    expect(w.balanceEvents()[2].payload).toMatchObject({ cause: 'payment_recorded', release_eligible: true, release_basis: 'paid_in_full', balance_version: 3 });
    expect(w.ledger()).toHaveLength(2);
    expect(w.ledger()[1]).toMatchObject({ method_code: 'card', amount_paisa: 125000, receipt_no: 'RC-083/84-000001', receipt_seq: 1, reference_text: 'POS-AB12' });
  });
  it('3: due 1,250.00 + manual 1,300.00 -> billing.payment_exceeds_due (422), nothing recorded, no receipt number consumed, no event', async () => {
    const { w, svc, ctx } = await setup();
    await pay(w, svc, ctx, { amount: npr(100000) });
    const repoMark = w.repoCalls.length, ev = w.balanceEvents().length, cc = w.counterCalls.length;
    const e = await errCode(pay(w, svc, ctx, { amount: npr(130000) }));
    expect(e.code).toBe('billing.payment_exceeds_due');
    expect(w.ledger()).toHaveLength(1);
    expect(writeCalls(w, repoMark).filter((x) => x !== 'lockOrderBalance')).toEqual([]);
    expect(w.counterCalls.length).toBe(cc); expect(w.balanceEvents().length).toBe(ev);
  });
  it('boundary: exactly the due is accepted; due + 1 paisa is refused; replay of a settling payment is not an overpay', async () => {
    const { w, svc, ctx } = await setup();
    expect((await errCode(pay(w, svc, ctx, { amount: npr(225001) }))).code).toBe('billing.payment_exceeds_due');
    const k = 'settle-1';
    const r1 = await pay(w, svc, ctx, { amount: npr(225000), idempotencyKey: k });
    expect(r1.balance.balanceDue).toEqual(npr(0));
    const r2 = await pay(w, svc, ctx, { amount: npr(225000), idempotencyKey: k });
    expect(r2).toMatchObject({ duplicate: true, ledgerEntryId: r1.ledgerEntryId });
    expect((await errCode(pay(w, svc, ctx, { amount: npr(1) }))).code).toBe('billing.payment_exceeds_due'); // already settled: any new manual payment exceeds
  });
  it('the paid-so-far is read from the ledger inside the transaction (a payment recorded elsewhere reduces the room)', async () => {
    const { w, svc, ctx } = await setup();
    w.addLedger({ amount_paisa: 200000, method_code: 'cash', invoice_id: INVOICE });
    expect((await errCode(pay(w, svc, ctx, { amount: npr(30000) }))).code).toBe('billing.payment_exceeds_due');
    expect((await pay(w, svc, ctx, { amount: npr(25000) })).balance.balanceDue).toEqual(npr(0));
  });
});

describe('overpay: refused for manual, recorded for home_collection (TRD §6.3 contract case 7; 08 A19 D-128)', () => {
  it('home_collection above due -> recorded in full, exceedsDue true, balance_due negative, no session, no throw', async () => {
    const { w, svc, ctx } = await setup();
    await pay(w, svc, ctx, { amount: npr(100000) });
    const r = await pay(w, svc, ctx, { captureKind: 'home_collection', amount: npr(130000), collectedByMembershipId: OTHER_MEMBER, issueReceiptNo: false });
    expect(r).toMatchObject({ duplicate: false, exceedsDue: true });
    expect(r.balance).toMatchObject({ paid: npr(230000), balanceDue: npr(-5000) });
    expect(w.ledger().at(-1)).toMatchObject({ capture_kind: 'home_collection', amount_paisa: 130000, cash_session_id: null, collected_by_membership_id: OTHER_MEMBER });
    expect(w.balanceEvents().at(-1)!.payload).toMatchObject({ cause: 'payment_recorded', balance_due: money(-5000), release_eligible: true });
  });
  it('home_collection within due -> exceedsDue false', async () => {
    const { w, svc, ctx } = await setup();
    expect((await pay(w, svc, ctx, { captureKind: 'home_collection', amount: npr(225000), collectedByMembershipId: OTHER_MEMBER, issueReceiptNo: false })).exceedsDue).toBe(false);
  });
  it('home_collection with a method that is inactive for the tenant is still recorded (never rejected, D-128); manual with the same method is refused', async () => {
    const { w, svc, ctx } = await setup();
    const r = await pay(w, svc, ctx, { captureKind: 'home_collection', methodCode: 'old_cheque', amount: npr(50000), collectedByMembershipId: OTHER_MEMBER, issueReceiptNo: false });
    expect(r.duplicate).toBe(false); expect(w.ledger().at(-1)).toMatchObject({ method_code: 'old_cheque' });
    const mark = w.repoCalls.length;
    expect((await errCode(pay(w, svc, ctx, { methodCode: 'old_cheque' }))).code).toBe('common.validation_failed');
    expect(writeCalls(w, mark).filter((x) => x !== 'lockOrderBalance')).toEqual([]);
  });
  it('manual with a method code that does not exist -> common.validation_failed on /methodCode', async () => {
    const { w, svc, ctx } = await setup();
    const e = await errCode(pay(w, svc, ctx, { methodCode: 'bitcoin' }));
    expect(e.code).toBe('common.validation_failed'); expect(e.errors?.map((x: any) => x.path)).toContain('/methodCode');
  });
  it('a gateway captureKind is not accepted here (gateway money enters through recordGatewayPayment)', async () => {
    const { w, svc, ctx } = await setup();
    expect((await errCode(pay(w, svc, ctx, { captureKind: 'gateway' }))).code).toBe('common.validation_failed');
    expect(w.ledger()).toHaveLength(0);
  });
});

describe('order / billing-mode preconditions', () => {
  it('manual payment on an order without invoice -> 409 billing.order_not_invoiced, nothing written', async () => {
    const { w, svc, ctx } = await setup({ invoiceNet: null });
    const e = await errCode(pay(w, svc, ctx));
    expect(e.code).toBe('billing.order_not_invoiced');
    expect(w.ledger()).toHaveLength(0); expect(w.sessions()).toHaveLength(0);
  });
  it('credit-mode order -> common.validation_failed ("Credit orders are paid by the credit party"), nothing written', async () => {
    const { w, svc, ctx } = await setup({ billingMode: 'credit' });
    const mark = w.repoCalls.length;
    expect((await errCode(pay(w, svc, ctx))).code).toBe('common.validation_failed');
    expect(writeCalls(w, mark).filter((x) => x !== 'lockOrderBalance')).toEqual([]);
  });
  it('invoiceId of the same order is stored on the ledger row; an invoice of another order or an unknown invoice is refused and nothing is written (id-swap, REQ-SEC-044)', async () => {
    const { w, svc, ctx } = await setup();
    w.s.invoices.push({ id: V7('000000a00002'), tenant_id: TENANT_A, order_id: IDS.order2, net_paisa: 50000, purpose: 'registration', status: 'issued' });
    expect((await pay(w, svc, ctx, { invoiceId: INVOICE })).duplicate).toBe(false);
    expect(w.ledger()[0]).toMatchObject({ invoice_id: INVOICE, order_id: IDS.order });
    for (const invoiceId of [V7('000000a00002'), V7('000000a00077')]) {
      const e = await errCode(pay(w, svc, ctx, { invoiceId }));
      expect(['common.validation_failed', 'common.not_found'], invoiceId).toContain(e.code);
    }
    expect(w.ledger()).toHaveLength(1);
  });
  it('ledger row carries branch/centre of the order\'s invoice, fiscal year of now (2083/84) and the tenant-timezone business date', async () => {
    const { w, svc, ctx } = await setup();
    await pay(w, svc, ctx);
    expect(w.ledger()[0]).toMatchObject({ tenant_id: TENANT_A, branch_id: IDS.branch, centre_id: IDS.centre, entry_kind: 'payment', capture_kind: 'manual', fiscal_year_bs: '2083/84', business_date: '2026-11-08', created_by: USER });
  });
  it('00:45 NPT on 9 Nov (19:00Z on the 8th) -> business_date is the TENANT date 2026-11-09, not the UTC date', async () => {
    const w = makeLedgerWorld(); await w.seedBalance();
    await pay(w, svcOf(w), w.ctx({ now: () => '2026-11-08T19:00:00.000Z' }), {});
    expect(w.ledger()[0].business_date).toBe('2026-11-09');
  });
});

describe('RC receipt numbering (TenantSettings.numbering.receiptNoPattern; series RC; PRD US-FD-08.2)', () => {
  it('RC series per fiscal year: sequential numbers from the tenant pattern; counter asked for {tenantId, series RC, fiscalYearBs 2083/84, actor}', async () => {
    const { w, svc, ctx } = await setup();
    const a = await pay(w, svc, ctx, { amount: npr(10000) }); const b = await pay(w, svc, ctx, { amount: npr(10000) });
    expect([a.receiptNo, b.receiptNo]).toEqual(['RC-083/84-000001', 'RC-083/84-000002']);
    expect(w.ledger().map((x) => x.receipt_seq)).toEqual([1, 2]);
    expect(w.counterCalls[0]).toMatchObject({ tenantId: TENANT_A, series: 'RC', fiscalYearBs: '2083/84', actorId: USER });
    expect(w.idCalls.some((c: any) => c.keys.includes('numbering'))).toBe(true);
  });
  it('a custom tenant pattern is used verbatim (no local copy): R/{fy}/{seq:4} -> R/083/84/0001', async () => {
    const { w, svc, ctx } = await setup({ tenantSettings: { numbering: { invoiceNoPattern: '{fy}-{seq:6}', receiptNoPattern: 'R/{fy}/{seq:4}' } } });
    expect((await pay(w, svc, ctx)).receiptNo).toBe('R/083/84/0001');
  });
  it('a new fiscal year restarts the numbering: now in FY 2084/85 -> counter FY 2084/85 and short FY in the number', async () => {
    const w = makeLedgerWorld(); await w.seedBalance();
    const r = await pay(w, svcOf(w), w.ctx({ now: () => '2027-08-20T06:00:00.000Z' }), {});
    expect(w.counterCalls[0]).toMatchObject({ series: 'RC', fiscalYearBs: '2084/85' });
    expect(r.receiptNo).toBe('RC-084/85-000001'); expect(w.ledger()[0].fiscal_year_bs).toBe('2084/85');
  });
  it('issueReceiptNo:false (payment in the registration transaction - the invoice is the receipt) -> no allocation, receiptNo undefined, receipt_no NULL', async () => {
    const { w, svc, ctx } = await setup();
    const r = await pay(w, svc, ctx, { issueReceiptNo: false });
    expect(r.receiptNo).toBeUndefined(); expect(w.counterCalls).toHaveLength(0);
    expect(w.ledger()[0]).toMatchObject({ receipt_no: null, receipt_seq: null });
  });
  it('billing settings receipt_no_enabled = false -> no allocation, receiptNo undefined (even with issueReceiptNo true)', async () => {
    const { w, svc, ctx } = await setup({ billingSettings: { receipt_no_enabled: false } });
    const r = await pay(w, svc, ctx);
    expect(r.receiptNo).toBeUndefined(); expect(w.counterCalls).toHaveLength(0); expect(w.ledger()[0].receipt_no).toBeNull();
  });
  it('a pattern without {seq:N} or no pattern at all fails closed with billing.numbering_pattern_invalid, before the counter is touched and before any write', async () => {
    for (const numbering of [{ invoiceNoPattern: '{fy}-{seq:6}', receiptNoPattern: 'RC-{fy}' }, { invoiceNoPattern: '{fy}-{seq:6}' }]) {
      const { w, svc, ctx } = await setup({ tenantSettings: { numbering } });
      const mark = w.repoCalls.length, ev = w.balanceEvents().length;
      expect((await errCode(pay(w, svc, ctx))).code).toBe('billing.numbering_pattern_invalid');
      noSideEffects(w, mark, 0, ev);
    }
  });
  it('counter_busy (incl. fiscal_year_rollover) propagates and rolls everything back: no ledger row, no session, no event', async () => {
    const { w, svc, ctx } = await setup();
    const { LimsError } = await import('../../../../core/errors.js');
    w.counterFail = () => new LimsError('billing.counter_busy', 'fiscal_year_rollover');
    const ev = w.balanceEvents().length;
    const e = await errCode(pay(w, svc, ctx));
    expect(e.code).toBe('billing.counter_busy');
    expect(w.ledger()).toHaveLength(0); expect(w.sessions()).toHaveLength(0); expect(w.balanceEvents().length).toBe(ev);
  });
  it('gapless: a failure AFTER allocation rolls the counter back, so the next payment gets the same number', async () => {
    const { w, svc, ctx } = await setup();
    const real = w.repo.insertLedgerEntry as any;
    (w.repo as any).insertLedgerEntry = async () => { throw new Error('disk full'); };
    await expect(pay(w, svc, ctx)).rejects.toThrow('disk full');
    (w.repo as any).insertLedgerEntry = real;
    expect((await pay(w, svc, ctx)).receiptNo).toBe('RC-083/84-000001');
  });
  it('lock order (TRD §12): order_balances locked BEFORE the RC counter; the ledger row is inserted after the allocation', async () => {
    const { w, svc, ctx } = await setup();
    const mark = w.repoCalls.length;
    await pay(w, svc, ctx);
    const names = w.names().slice(mark);
    const lock = names.indexOf('lockOrderBalance'), insert = names.indexOf('insertLedgerEntry');
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(w.counterCalls[0].atRepoCall - mark).toBeGreaterThan(lock);
    expect(insert).toBeGreaterThanOrEqual(w.counterCalls[0].atRepoCall - mark);
    expect(names.indexOf('upsertOrderBalance')).toBeGreaterThan(insert);
  });
  it('the order_balances lock is taken for every payment (also without a receipt) and is keyed by the caller tenant', async () => {
    const { w, svc, ctx } = await setup();
    await pay(w, svc, ctx, { issueReceiptNo: false });
    const lock = w.repoCalls.find((c) => c.name === 'lockOrderBalance')!;
    expect(lock.args).toMatchObject({ tenantId: TENANT_A, orderId: IDS.order });
  });
});

describe('one open cash session per (membership, centre); B22 / home payments have none (TRD §6.5; PRD US-BL-11.2–.3)', () => {
  it('first manual payment opens exactly one session for the actor at the order\'s centre; the second reuses it; the row links to it', async () => {
    const { w, svc, ctx } = await setup();
    await pay(w, svc, ctx, { amount: npr(10000) }); await pay(w, svc, ctx, { amount: npr(10000), methodCode: 'card', reference: 'POS-1' });
    expect(w.sessions()).toHaveLength(1);
    expect(w.sessions()[0]).toMatchObject({ tenant_id: TENANT_A, membership_id: MEMBERSHIP, centre_id: IDS.centre, branch_id: IDS.branch, status: 'open', opened_at: BASE, created_by: USER });
    expect(w.ledger().map((x) => x.cash_session_id)).toEqual([w.sessions()[0].id, w.sessions()[0].id]);
  });
  it('a different cashier gets their own session; an already-open session of someone else is never used', async () => {
    const { w, svc, ctx } = await setup();
    await pay(w, svc, ctx, { amount: npr(10000) });
    const other = w.ctx({ actor: { type: 'user', id: V7('000000030002'), membershipId: OTHER_MEMBER } });
    await pay(w, svc, other, { amount: npr(10000) });
    expect(w.sessions()).toHaveLength(2);
    expect(w.ledger()[1]).toMatchObject({ collected_by_membership_id: OTHER_MEMBER, cash_session_id: w.sessions().find((s) => s.membership_id === OTHER_MEMBER).id });
    expect(w.ledger()[0].cash_session_id).not.toBe(w.ledger()[1].cash_session_id);
  });
  it('a closed session is not reused: the next payment opens a new one (US-BL-11.2)', async () => {
    const { w, svc, ctx } = await setup();
    await pay(w, svc, ctx, { amount: npr(10000) });
    Object.assign(w.sessions()[0], { status: 'closed', closed_at: BASE, counted: [], expected: [], variance_paisa: 0, version: 2 });
    await pay(w, svc, ctx, { amount: npr(10000) });
    expect(w.sessions()).toHaveLength(2);
    expect(w.ledger()[1].cash_session_id).toBe(w.sessions()[1].id); expect(w.sessions()[1].status).toBe('open');
  });
  it('home_collection never opens or joins a session, even when the collector has one open', async () => {
    const { w, svc, ctx } = await setup();
    await pay(w, svc, ctx, { amount: npr(10000) });
    const before = w.sessions().length, mark = w.repoCalls.length;
    await pay(w, svc, ctx, { captureKind: 'home_collection', amount: npr(10000), collectedByMembershipId: MEMBERSHIP, issueReceiptNo: false });
    expect(w.sessions()).toHaveLength(before); expect(w.ledger().at(-1)!.cash_session_id).toBeNull();
    expect(w.names().slice(mark)).not.toContain('insertCashSession');
  });
  it('only a home_collection first payment creates no session at all', async () => {
    const { w, svc, ctx } = await setup();
    await pay(w, svc, ctx, { captureKind: 'home_collection', amount: npr(10000), collectedByMembershipId: OTHER_MEMBER, issueReceiptNo: false });
    expect(w.sessions()).toHaveLength(0);
  });
  it('home_collection without any collector (system actor, no membership, no collectedByMembershipId) is refused: nothing is written', async () => {
    const { w, svc } = await setup();
    const ctx = w.ctx({ actor: { type: 'system', id: USER } });
    const mark = w.repoCalls.length;
    const e = await errCode(pay(w, svc, ctx, { captureKind: 'home_collection', issueReceiptNo: false }));
    expect(e.code).toBe('common.validation_failed'); expect(writeCalls(w, mark).filter((x) => x !== 'lockOrderBalance')).toEqual([]);
  });
  it('a manual payment by an actor without a membership cannot be attributed to a cash session: refused, nothing written', async () => {
    const { w, svc } = await setup();
    const ctx = w.ctx({ actor: { type: 'system', id: USER } });
    expect((await errCode(pay(w, svc, ctx))).code).toBe('common.validation_failed');
    expect(w.ledger()).toHaveLength(0); expect(w.sessions()).toHaveLength(0);
  });
  it('manual payment: a body-supplied collectedByMembershipId cannot attribute money to someone else (ignored or refused, never stored)', async () => {
    const { w, svc, ctx } = await setup();
    try { await pay(w, svc, ctx, { collectedByMembershipId: OTHER_MEMBER }); expect(w.ledger()[0].collected_by_membership_id).toBe(MEMBERSHIP); }
    catch (e) { expect((e as any).code).toBe('common.validation_failed'); expect(w.ledger()).toHaveLength(0); }
  });
});

describe('idempotency (REQ-SEC-050/051; contract case 8)', () => {
  it('same idempotencyKey twice -> second is duplicate:true with the same ledgerEntryId/receiptNo; one row, one receipt number, one session, one payment event, one activity row', async () => {
    const { w, svc, ctx } = await setup();
    const a = await pay(w, svc, ctx, { idempotencyKey: 'dup-1' });
    const evs = w.balanceEvents().length, acts = w.s.activity.length, cc = w.counterCalls.length;
    const b = await pay(w, svc, ctx, { idempotencyKey: 'dup-1' });
    expect(b).toMatchObject({ duplicate: true, ledgerEntryId: a.ledgerEntryId, receiptNo: a.receiptNo });
    expect(b.balance).toMatchObject({ paid: npr(100000), balanceDue: npr(125000) });
    expect(w.ledger()).toHaveLength(1); expect(w.sessions()).toHaveLength(1);
    expect(w.balanceEvents().length).toBe(evs); expect(w.s.activity.length).toBe(acts); expect(w.counterCalls.length).toBe(cc);
  });
  it('the replay lookup is scoped by tenant: another tenant sending the same key never receives (or collides with) the first tenant\'s entry', async () => {
    const { w, svc, ctx } = await setup();
    const a = await pay(w, svc, ctx, { idempotencyKey: 'shared-key' });
    const other = w.ctx({ tenantId: OTHER_TENANT });
    const e = await errCode(pay(w, svc, other as never, { idempotencyKey: 'shared-key' }));
    expect(['common.not_found', 'billing.order_not_invoiced']).toContain(e.code);
    expect(JSON.stringify(e)).not.toContain(a.ledgerEntryId);
    expect(w.repoCalls.filter((c) => c.name === 'findLedgerByIdempotencyKey').at(-1)!.args.tenantId).toBe(OTHER_TENANT);
  });
  it('home_collection replays by key too (client_mutation_id): second call is duplicate, not a second payment', async () => {
    const { w, svc, ctx } = await setup();
    const o = { captureKind: 'home_collection', collectedByMembershipId: OTHER_MEMBER, issueReceiptNo: false, idempotencyKey: 'mut-1' };
    const a = await pay(w, svc, ctx, o); const b = await pay(w, svc, ctx, o);
    expect(b).toMatchObject({ duplicate: true, ledgerEntryId: a.ledgerEntryId }); expect(w.ledger()).toHaveLength(1);
  });
  it('the idempotency key is stored on the ledger row', async () => {
    const { w, svc, ctx } = await setup();
    await pay(w, svc, ctx, { idempotencyKey: `${IDS.order}:reg:0`, issueReceiptNo: false });
    expect(w.ledger()[0].idempotency_key).toBe(`${IDS.order}:reg:0`);
  });
});

describe('REQ-SEC-056: ledger reference refuses 13-19 digit runs (no card numbers); method requires_reference', () => {
  const REFUSED = ['4111111111111111', '1234567890123', '1234567890123456789', '12345678901234567890', 'card 4111111111111111 exp', 'x4111111111111111y', 'TXN-9999999999999-OK'];
  for (const reference of REFUSED) {
    it(`manual: "${reference}" -> common.validation_failed on /reference, the digits are not echoed, nothing written`, async () => {
      const { w, svc, ctx } = await setup();
      const mark = w.repoCalls.length, ev = w.balanceEvents().length;
      const e = await errCode(pay(w, svc, ctx, { methodCode: 'card', reference }));
      expect(e.code).toBe('common.validation_failed');
      expect(e.errors?.map((x: any) => x.path)).toContain('/reference');
      expect(JSON.stringify(e)).not.toMatch(/[0-9]{10}/);
      noSideEffects(w, mark, 0, ev);
    });
  }
  it('home_collection applies the same rule (the DB CHECK would otherwise dead-letter the consumer)', async () => {
    const { w, svc, ctx } = await setup();
    const e = await errCode(pay(w, svc, ctx, { captureKind: 'home_collection', collectedByMembershipId: OTHER_MEMBER, methodCode: 'card', reference: '4111111111111111', issueReceiptNo: false }));
    expect(e.code).toBe('common.validation_failed'); expect(w.ledger()).toHaveLength(0);
  });
  it('allowed: 12-digit run, digits split by letters, short ids; the reference is stored trimmed', async () => {
    for (const reference of ['123456789012', 'TXN 123456 789012', 'POS-AB12', '  SLIP-77  ']) {
      const { w, svc, ctx } = await setup();
      await pay(w, svc, ctx, { methodCode: 'card', reference, amount: npr(1000) });
      expect(w.ledger()[0].reference_text, reference).toBe(reference.trim());
    }
  });
  it('requires_reference method without a reference (missing, empty, blank) -> common.validation_failed on /reference; a cash payment needs none', async () => {
    for (const reference of [undefined, '', '   ']) {
      const { w, svc, ctx } = await setup();
      const e = await errCode(pay(w, svc, ctx, { methodCode: 'card', ...(reference === undefined ? {} : { reference }) }));
      expect(e.code, String(reference)).toBe('common.validation_failed'); expect(e.errors?.map((x: any) => x.path)).toContain('/reference');
      expect(w.ledger()).toHaveLength(0);
    }
    const { w, svc, ctx } = await setup();
    await pay(w, svc, ctx, { methodCode: 'cash' }); expect(w.ledger()[0].reference_text).toBeNull();
  });
  it('reference longer than 100 characters -> common.validation_failed', async () => {
    const { w, svc, ctx } = await setup();
    expect((await errCode(pay(w, svc, ctx, { methodCode: 'card', reference: 'A'.repeat(101) }))).code).toBe('common.validation_failed');
    await pay(w, svc, ctx, { methodCode: 'card', reference: 'A'.repeat(100), amount: npr(1000) }); expect(w.ledger()).toHaveLength(1);
  });
});

describe('input validation: refused before any write (fail closed)', () => {
  const BAD: Array<[string, Record<string, unknown>]> = [
    ['orderId not a uuid', { orderId: 'order-1' }], ['orderId missing', { orderId: undefined }],
    ['amount 0', { amount: npr(0) }], ['amount negative', { amount: npr(-100) }], ['amount fractional', { amount: npr(10.5) }],
    ['amount NaN', { amount: npr(NaN) }], ['amount string', { amount: { amountPaisa: '100000', currency: 'NPR' } }], ['amount above 2^53-1', { amount: npr(2 ** 53) }],
    ['amount currency USD', { amount: { amountPaisa: 100, currency: 'USD' } }], ['amount missing', { amount: undefined }],
    ['methodCode empty', { methodCode: '' }], ['methodCode number', { methodCode: 7 }], ['captureKind unknown', { captureKind: 'cheque' }],
    ['idempotencyKey missing', { idempotencyKey: undefined }], ['idempotencyKey empty', { idempotencyKey: '' }], ['idempotencyKey number', { idempotencyKey: 12 }],
    ['reference not a string', { reference: 1234 }], ['invoiceId not a uuid', { invoiceId: 'inv' }], ['collectedByMembershipId not a uuid', { captureKind: 'home_collection', collectedByMembershipId: 'm' }],
    ['capturedAt not an instant', { capturedAt: 'yesterday' }],
  ];
  for (const [name, over] of BAD) {
    it(`${name} -> common.validation_failed, no repo write, no counter, no event`, async () => {
      const { w, svc, ctx } = await setup();
      const mark = w.repoCalls.length, ev = w.balanceEvents().length;
      const raw = { ...input(), ...over } as Record<string, unknown>;
      for (const k of Object.keys(raw)) if (raw[k] === undefined) delete raw[k];
      const e = await errCode(w.tx(() => svc.recordPayment(ctx, raw as never) as Promise<unknown>));
      expect(e.code).toBe('common.validation_failed');
      noSideEffects(w, mark, 0, ev);
    });
  }
  it('input that is not an object -> common.validation_failed', async () => {
    const { w, svc, ctx } = await setup();
    for (const bad of [null, undefined, 'x', 42, []]) expect((await errCode(w.tx(() => svc.recordPayment(ctx, bad as never) as Promise<unknown>))).code).toBe('common.validation_failed');
  });
  it('ctx without tenantId / actor / tx -> auth.unauthenticated (REQ-SEC-099), no repo call', async () => {
    const { w, svc } = await setup();
    const mark = w.repoCalls.length;
    for (const bad of [{}, { tenantId: TENANT_A }, { tenantId: TENANT_A, actor: { type: 'user', id: USER } }]) {
      expect((await errCode(svc.recordPayment(bad as never, input() as never) as Promise<unknown>)).code).toBe('auth.unauthenticated');
    }
    expect(w.repoCalls.length).toBe(mark);
  });
});

describe('tenancy and attribution come from ctx only; every repo call is tenant-scoped', () => {
  it('extra fields in the input (tenantId, userId, createdBy, branchId, centreId) never reach the ledger row', async () => {
    const { w, svc, ctx } = await setup();
    await pay(w, svc, ctx, { tenantId: OTHER_TENANT, userId: OTHER_MEMBER, createdBy: OTHER_MEMBER, branchId: V7('0000000b0099'), centreId: V7('0000000c0099') });
    expect(w.ledger()[0]).toMatchObject({ tenant_id: TENANT_A, created_by: USER, branch_id: IDS.branch, centre_id: IDS.centre });
    for (const c of w.repoCalls) expect(c.args.tenantId ?? c.args.tenant_id, c.name).toBe(TENANT_A);
  });
  it('another tenant\'s order is not payable: no ledger row, no lookup of that tenant\'s data (order_not_invoiced / not_found)', async () => {
    const { w, svc } = await setup();
    const e = await errCode(pay(w, svc, w.ctx({ tenantId: OTHER_TENANT }) as never, {}));
    expect(['common.not_found', 'billing.order_not_invoiced']).toContain(e.code);
    expect(w.ledger()).toHaveLength(0);
  });
});

describe('result, event and audit shape', () => {
  it('result.entry is a LedgerEntryDto: exact keys, Money as integers, B.S. business date, no internal columns', async () => {
    const { w, svc, ctx } = await setup();
    const r = await pay(w, svc, ctx, { methodCode: 'card', reference: 'POS-AB12', amount: npr(100000) });
    const allowed = new Set(['id', 'entry_kind', 'capture_kind', 'order_id', 'invoice_id', 'credit_party_id', 'method_code', 'amount', 'reference_masked', 'receipt_no', 'reverses_entry_id', 'collected_by', 'cash_session_id', 'created_at', 'business_date_bs']);
    expect(Object.keys(r.entry).filter((k) => !allowed.has(k))).toEqual([]);
    expect(r.entry).toMatchObject({ id: r.ledgerEntryId, entry_kind: 'payment', capture_kind: 'manual', order_id: IDS.order, method_code: 'card', amount: money(100000), receipt_no: r.receiptNo,
      cash_session_id: w.sessions()[0].id, business_date_bs: '2083-07-22' });
    expect(r.entry.collected_by?.membership_id).toBe(MEMBERSHIP);
    expect(r.entry.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
    for (const k of ['tenant_id', 'created_by', 'idempotency_key', 'fiscal_year_bs']) expect(Object.keys(r.entry)).not.toContain(k);
  });
  it('exactly one balance.changed per payment, none other; the event payload carries no method, reference or collector (no PHI)', async () => {
    const { w, svc, ctx } = await setup();
    const before = w.db.events.length;
    await pay(w, svc, ctx, { methodCode: 'card', reference: 'POS-AB12' });
    expect(w.db.events.length - before).toBe(1);
    expect(JSON.stringify(w.balanceEvents().at(-1))).not.toMatch(/POS-AB12|card|collected/);
  });
  it('activity payment_recorded: one row, tenant/actor from ctx, document = the ledger entry (+ receipt no), centre set; the reference text is not copied into details', async () => {
    const { w, svc, ctx } = await setup();
    const r = await pay(w, svc, ctx, { methodCode: 'card', reference: 'POS-AB12' });
    const rows = w.s.activity.filter((a: any) => a.action === 'payment_recorded');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tenant_id: TENANT_A, centre_id: IDS.centre, document_id: r.ledgerEntryId, document_no: r.receiptNo, actor_id: USER, actor_membership_id: MEMBERSHIP, actor_type: 'user', request_id: expect.any(String) });
    expect(JSON.stringify(rows[0].details)).not.toContain('POS-AB12');
  });
  it('atomicity: when the balance event cannot be published, ledger row, session, receipt number and activity all roll back', async () => {
    const { w, svc, ctx } = await setup();
    const acts = w.s.activity.length;
    w.db.fail(/INSERT\s+INTO\s+core\.event_log/i, () => new Error('event store down'));
    await expect(pay(w, svc, ctx)).rejects.toThrow('event store down');
    expect(w.ledger()).toHaveLength(0); expect(w.sessions()).toHaveLength(0); expect(w.s.activity.length).toBe(acts); expect(w.s.counterNo).toBe(0);
  });
});
