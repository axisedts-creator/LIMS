// BL-T13 B19 credit accounts, B20 charges list, B22 credit-party payment, B23 statement (02-TRD §5 B19/B20/B22/B23, §5 cash sessions bullet; PRD US-BL-10.3, US-BL-11.3,
// US-FD-04.4 (read side); 05-SCHEMA credit_accounts__lock__ck, ledger_entries__subject__ck, v_pub_credit_party_statement; 07-SECURITY A11 tenant ids in credit party ids, REQ-SEC-056).
// Fails now: ../credit.service.js does not exist. ASSUMED API: see t13.helpers.ts header.
// Decisions beyond spec text (writer: dispute if wrong): a LOCKED party can still PAY (paying is how finance clears the lock cause) and paying never unlocks (job "never auto-unlock");
//   B23 without from/to = the last 24 months ending with the current tenant-tz month; B20 limit max 200.
import { describe, expect, it } from 'vitest';
import { createBillingEvents } from '../../events/publish.js';
import { createCreditService } from '../credit.service.js';
import { account, BASE, BRANCH2, CH, errCode, IDS, makeT13World, MEMBERSHIP, PARTY, PARTY2, TENANT_A, TENANT_B, USER, V7, type T13World } from './t13.helpers.js';

const svcOf = (w: T13World) => createCreditService({ repo: w.repo as never, counter: w.counter as never, events: createBillingEvents(w.events) as never });
const run = <T = any>(w: T13World, fn: (svc: ReturnType<typeof svcOf>) => Promise<unknown>) => w.tx(() => fn(svcOf(w))) as Promise<T>;
const hasPath = (e: any, re: RegExp) => (e.errors ?? []).some((x: any) => re.test(String(x.path)));
const billed = async (n = 3) => { // n charges of NPR 1,000.00 billed -> periodic invoice of n * 100000
  const w = makeT13World(); w.addCharges(1, n);
  const r = await run(w, (s) => s.issuePeriodicInvoice(w.ctx(), { creditPartyId: PARTY, periodMonth: '2026-10', branchId: BRANCH2 } as never));
  return { w, inv: r as any };
};

describe('B19 credit accounts: read', () => {
  it('getAccount returns the account with outstanding = uninvoiced charges + unpaid periodic bills; unknown party and a party of another tenant are common.not_found', async () => {
    const w = makeT13World({ accounts: [account({ credit_limit_paisa: '500000' }), account({ tenant_id: TENANT_B, credit_party_id: V7('000000b000b2') })] }); w.addCharges(1, 2);
    const a = await run(w, (s) => s.getAccount(w.ctx(), { creditPartyId: PARTY } as never));
    expect(a).toMatchObject({ credit_party_id: PARTY, party_display_name: 'Synthetic Corp', credit_limit_paisa: '500000', credit_days: 30, is_locked: false, version: 1, outstandingPaisa: 200000 });
    expect((await errCode(run(w, (s) => s.getAccount(w.ctx(), { creditPartyId: V7('000000b0ffff') } as never)))).code).toBe('common.not_found');
    expect((await errCode(run(w, (s) => s.getAccount(w.ctx(), { creditPartyId: V7('000000b000b2') } as never)))).code).toBe('common.not_found');
  });
  it('listAccounts is tenant-scoped, ordered by party id, and paged: limit 1 gives a continuation, the next page starts after it', async () => {
    const w = makeT13World({ accounts: [account(), account({ credit_party_id: PARTY2 }), account({ tenant_id: TENANT_B, credit_party_id: V7('000000b000b2') })] });
    const p1 = await run(w, (s) => s.listAccounts(w.ctx(), { limit: 1 } as never));
    expect(p1.data.map((x: any) => x.credit_party_id)).toEqual([PARTY]);
    const p2 = await run(w, (s) => s.listAccounts(w.ctx(), { limit: 1, afterPartyId: PARTY } as never));
    expect(p2.data.map((x: any) => x.credit_party_id)).toEqual([PARTY2]);
    const all = await run(w, (s) => s.listAccounts(w.ctx(), {} as never));
    expect(all.data.map((x: any) => x.credit_party_id)).toEqual([PARTY, PARTY2]);
    expect((await errCode(run(w, (s) => s.listAccounts(w.ctx(), { limit: 201 } as never)))).code).toBe('common.validation_failed');
  });
});

describe('B19 updateAccount (privileged billing.credit_party.manage; If-Match)', () => {
  const upd = (w: T13World, over: Record<string, unknown> = {}, ctx: never = w.ctx()) =>
    run(w, (s) => s.updateAccount(ctx, { creditPartyId: PARTY, expectedVersion: 1, creditLimitPaisa: 750000, creditDays: 45, isLocked: false, ...over } as never));
  it('sets limit and credit_days, bumps version, writes ONE credit_account_changed activity row (ids and codes only)', async () => {
    const w = makeT13World();
    const a = await upd(w);
    expect(a).toMatchObject({ credit_party_id: PARTY, credit_limit_paisa: '750000', credit_days: 45, is_locked: false, lock_reason_code: null, version: 2 });
    expect(w.activity()).toHaveLength(1);
    expect(w.activity()[0]).toMatchObject({ tenant_id: TENANT_A, action: 'credit_account_changed', actor_id: USER, actor_membership_id: MEMBERSHIP });
    expect(JSON.stringify(w.activity()[0]!.details ?? {})).not.toMatch(/Synthetic Corp|987654321|Synthetic Road/);
  });
  it('lock needs a reason (credit_account lock CK): is_locked true without lock_reason_code -> 400 on lock_reason_code, nothing written; with a reason it locks and records who/when', async () => {
    const w = makeT13World();
    const e = await errCode(upd(w, { isLocked: true }));
    expect(e.code).toBe('common.validation_failed');
    expect(hasPath(e, /lock_?reason_?code/i)).toBe(true);
    expect(w.wrote()).toEqual([]);
    const a = await upd(w, { isLocked: true, lockReasonCode: 'manual' });
    expect(a).toMatchObject({ is_locked: true, lock_reason_code: 'manual', locked_by: USER, version: 2 });
    expect(a.locked_at).toBeTruthy();
  });
  it('unlock clears reason / locked_at / locked_by; a reason sent with is_locked false is a validation error (no half state)', async () => {
    const w = makeT13World({ accounts: [account({ is_locked: true, lock_reason_code: 'credit_days_exceeded', locked_at: BASE, locked_by: USER })] });
    const e = await errCode(upd(w, { isLocked: false, lockReasonCode: 'manual' }));
    expect(e.code).toBe('common.validation_failed');
    const a = await upd(w, { isLocked: false });
    expect(a).toMatchObject({ is_locked: false, lock_reason_code: null, locked_at: null, locked_by: null, version: 2 });
  });
  it('stale If-Match version -> 409 common.version_conflict and no write / activity; a missing version -> validation error', async () => {
    const w = makeT13World({ accounts: [account({ version: 3 })] });
    expect((await errCode(upd(w, { expectedVersion: 1 }))).code).toBe('common.version_conflict');
    expect(w.activity()).toHaveLength(0);
    expect(w.accounts()[0].version).toBe(3);
    expect((await errCode(upd(w, { expectedVersion: undefined }))).code).toBe('common.validation_failed');
  });
  it('bad numbers: negative / fractional / non-numeric limit, credit_days -1 / 1.5 / "x" -> 400 common.validation_failed with the field; unknown party / other tenant -> 404', async () => {
    const w = makeT13World();
    for (const [over, re] of [[{ creditLimitPaisa: -1 }, /limit/i], [{ creditLimitPaisa: 1.5 }, /limit/i], [{ creditLimitPaisa: 'x' }, /limit/i], [{ creditDays: -1 }, /days/i], [{ creditDays: 1.5 }, /days/i], [{ creditDays: 'x' }, /days/i]] as const) {
      const e = await errCode(upd(w, over as never));
      expect(e.code, JSON.stringify(over)).toBe('common.validation_failed');
      expect(hasPath(e, re), JSON.stringify(over)).toBe(true);
    }
    expect(w.wrote()).toEqual([]);
    expect((await errCode(upd(w, { creditPartyId: V7('000000b0ffff') }))).code).toBe('common.not_found');
    expect((await errCode(upd(w, {}, w.ctx({ tenantId: TENANT_B })))).code).toBe('common.not_found');
    expect(w.accounts()[0].version).toBe(1);
  });
  it('lowering the limit below current exposure is allowed (it blocks NEW charges, it does not void existing ones); the update never touches party snapshot columns', async () => {
    const w = makeT13World(); w.addCharges(1, 3);
    const a = await upd(w, { creditLimitPaisa: 100 });
    expect(a).toMatchObject({ credit_limit_paisa: '100', party_code: 'SYN-CORP', party_display_name: 'Synthetic Corp', party_pan: '987654321' });
    expect(w.charges().every((c: any) => c.status === 'uninvoiced')).toBe(true);
  });
});

describe('B20 listCharges', () => {
  const seeded = () => { const w = makeT13World(); w.addCharges(1, 3); w.addCharge(10, { period_month: '2026-09-01' }); w.addCharge(11, { status: 'voided', voided_at: BASE }); w.addCharge(12, { credit_party_id: PARTY2 });
    w.addCharge(13, { tenant_id: TENANT_B }); return w; };
  it('filters by status and period_month, only this tenant and party; period is the A.D. month YYYY-MM mapped to the first day', async () => {
    const w = seeded();
    const all = await run(w, (s) => s.listCharges(w.ctx(), { creditPartyId: PARTY } as never));
    expect(all.data.map((c: any) => c.id).sort()).toEqual([CH(1), CH(2), CH(3), CH(10), CH(11)].sort());
    const oct = await run(w, (s) => s.listCharges(w.ctx(), { creditPartyId: PARTY, periodMonth: '2026-10' } as never));
    expect(oct.data.map((c: any) => c.id).sort()).toEqual([CH(1), CH(2), CH(3), CH(11)].sort());
    expect(w.repoCalls.filter((c) => c.name === 'listCreditChargesByParty').pop()!.args).toMatchObject({ tenantId: TENANT_A, creditPartyId: PARTY, periodMonth: '2026-10-01' });
    const voided = await run(w, (s) => s.listCharges(w.ctx(), { creditPartyId: PARTY, status: 'voided' } as never));
    expect(voided.data.map((c: any) => c.id)).toEqual([CH(11)]);
  });
  it('cursor paging: limit 2 then afterId continues without overlap; limit above 200 and a bad period_month / status are 400', async () => {
    const w = seeded();
    const p1 = await run(w, (s) => s.listCharges(w.ctx(), { creditPartyId: PARTY, limit: 2 } as never));
    expect(p1.data).toHaveLength(2);
    const p2 = await run(w, (s) => s.listCharges(w.ctx(), { creditPartyId: PARTY, limit: 2, afterId: p1.data[1].id } as never));
    expect(p2.data[0].id > p1.data[1].id).toBe(true);
    for (const over of [{ limit: 201 }, { limit: 0 }, { periodMonth: '2026-13' }, { periodMonth: '202610' }, { status: 'x'.repeat(33) }]) {
      expect((await errCode(run(w, (s) => s.listCharges(w.ctx(), { creditPartyId: PARTY, ...over } as never)))).code, JSON.stringify(over)).toBe('common.validation_failed');
    }
  });
  it('a party of another tenant / unknown party is common.not_found (not an empty list)', async () => {
    const w = seeded();
    expect((await errCode(run(w, (s) => s.listCharges(w.ctx({ tenantId: TENANT_B }), { creditPartyId: PARTY } as never)))).code).toBe('common.not_found');
    expect((await errCode(run(w, (s) => s.listCharges(w.ctx(), { creditPartyId: V7('000000b0ffff') } as never)))).code).toBe('common.not_found');
  });
});

describe('US-BL-10.3 B22 payment from the credit party against a periodic invoice', () => {
  const pay = (w: T13World, inv: { invoiceId: string }, over: Record<string, unknown> = {}, ctx: never = w.ctx()) =>
    run(w, (s) => s.recordPartyPayment(ctx, { creditPartyId: PARTY, invoiceId: inv.invoiceId, methodCode: 'cash', amountReceivedPaisa: 100000, idempotencyKey: 'bl13-pay-1', ...over } as never));
  it('creates ONE ledger row against that invoice: credit_party_id, no order, no centre, no cash session, payment/manual, collector = actor membership, branch = invoice branch', async () => {
    const { w, inv } = await billed();
    const r = await pay(w, inv);
    expect(r).toMatchObject({ duplicate: false });
    expect(w.ledger()).toHaveLength(1);
    expect(w.ledger()[0]).toMatchObject({ id: r.ledgerEntryId, tenant_id: TENANT_A, invoice_id: inv.invoiceId, credit_party_id: PARTY, order_id: null, centre_id: null, cash_session_id: null,
      entry_kind: 'payment', capture_kind: 'manual', method_code: 'cash', amount_paisa: 100000, branch_id: BRANCH2, collected_by_membership_id: MEMBERSHIP, idempotency_key: 'bl13-pay-1' });
    expect(w.names()).not.toContain('findOpenCashSession');   // US-BL-11.3: never a shift-close payment
    expect(w.names()).not.toContain('insertCashSession');
    expect(w.events_of('billing.balance.changed.v1')).toHaveLength(0); // no order to recompute
  });
  it('part payments add up; paying the exact remainder is allowed, one paisa more -> 422 billing.payment_exceeds_due and no row', async () => {
    const { w, inv } = await billed(); // due 300000
    await pay(w, inv, { amountReceivedPaisa: 100000, idempotencyKey: 'k1' });
    await pay(w, inv, { amountReceivedPaisa: 150000, idempotencyKey: 'k2' });
    const e = await errCode(pay(w, inv, { amountReceivedPaisa: 50001, idempotencyKey: 'k3' }));
    expect(e.code).toBe('billing.payment_exceeds_due');
    expect(w.ledger()).toHaveLength(2);
    await pay(w, inv, { amountReceivedPaisa: 50000, idempotencyKey: 'k4' });
    expect(w.ledger().reduce((t: number, x: any) => t + x.amount_paisa, 0)).toBe(300000);
    expect((await errCode(pay(w, inv, { amountReceivedPaisa: 1, idempotencyKey: 'k5' }))).code).toBe('billing.payment_exceeds_due');
  });
  it('same Idempotency-Key + same body replays (duplicate:true, one row); same key with another amount -> common.idempotency_key_reused', async () => {
    const { w, inv } = await billed();
    const a = await pay(w, inv);
    const b = await pay(w, inv);
    expect(b).toMatchObject({ duplicate: true, ledgerEntryId: a.ledgerEntryId });
    expect(w.ledger()).toHaveLength(1);
    expect((await errCode(pay(w, inv, { amountReceivedPaisa: 200000 }))).code).toBe('common.idempotency_key_reused');
    expect(w.ledger()).toHaveLength(1);
  });
  it('an invoice that is not a periodic bill of THIS party (other party, order invoice, unknown id, other tenant) is common.not_found and nothing is written', async () => {
    const { w, inv } = await billed();
    w.s.invoices.push({ id: V7('000000a000f1'), tenant_id: TENANT_A, order_id: IDS.order, credit_party_id: null, is_periodic_credit_bill: false, net_paisa: 50000, purpose: 'registration', status: 'issued', credited_total_paisa: 0 });
    w.accounts().push(account({ credit_party_id: PARTY2 }));
    const before = w.ledger().length;
    for (const [label, over, ctx] of [['other party', { creditPartyId: PARTY2 }, w.ctx()], ['order invoice', { invoiceId: V7('000000a000f1') }, w.ctx()], ['unknown', { invoiceId: V7('000000a000ee') }, w.ctx()],
      ['other tenant', {}, w.ctx({ tenantId: TENANT_B })]] as const) {
      expect((await errCode(pay(w, inv, over as never, ctx as never))).code, label).toBe('common.not_found');
    }
    expect(w.ledger()).toHaveLength(before);
  });
  it('bad amount (0, -1, 1.5, "100"), unknown or inactive method, missing reference for a reference-method, a 16-digit reference -> 400 common.validation_failed, nothing written (REQ-SEC-056)', async () => {
    const { w, inv } = await billed();
    const cases: Array<[Record<string, unknown>, RegExp]> = [[{ amountReceivedPaisa: 0 }, /amount/i], [{ amountReceivedPaisa: -1 }, /amount/i], [{ amountReceivedPaisa: 1.5 }, /amount/i], [{ amountReceivedPaisa: '100' }, /amount/i],
      [{ methodCode: 'nope' }, /method/i], [{ methodCode: 'old_cheque' }, /method/i], [{ methodCode: 'card' }, /reference/i], [{ methodCode: 'card', reference: '4111111111111111' }, /reference/i]];
    for (const [over, re] of cases) {
      const e = await errCode(pay(w, inv, over));
      expect(e.code, JSON.stringify(over)).toBe('common.validation_failed');
      expect(hasPath(e, re), JSON.stringify(over)).toBe(true);
    }
    expect(w.ledger()).toHaveLength(0);
  });
  it('a LOCKED party can still pay, and paying the whole bill does not unlock the account (never auto-unlock)', async () => {
    const { w, inv } = await billed();
    Object.assign(w.accounts()[0], { is_locked: true, lock_reason_code: 'credit_days_exceeded' });
    await pay(w, inv, { amountReceivedPaisa: 300000 });
    expect(w.ledger()).toHaveLength(1);
    expect(w.accounts()[0]).toMatchObject({ is_locked: true, lock_reason_code: 'credit_days_exceeded' });
  });
  it('payment lowers the party outstanding by exactly the amount (limit math after a payment)', async () => {
    const { w, inv } = await billed();
    const before = (await run(w, (s) => s.getAccount(w.ctx(), { creditPartyId: PARTY } as never))).outstandingPaisa;
    await pay(w, inv, { amountReceivedPaisa: 120000 });
    const after = (await run(w, (s) => s.getAccount(w.ctx(), { creditPartyId: PARTY } as never))).outstandingPaisa;
    expect([before, after]).toEqual([300000, 180000]);
  });
});

describe('US-BL-10.3 B23 statement', () => {
  const row = (month: string, fy: string, invoiced: number, paid: number, credited: number, closing: number, over: Record<string, unknown> = {}) =>
    ({ tenant_id: TENANT_A, credit_party_id: PARTY, period_month: `${month}-01`, fiscal_year_bs: fy, invoiced_paisa: String(invoiced), paid_paisa: String(paid), credited_paisa: String(credited), closing_balance_paisa: String(closing), ...over });
  const stmt = (w: T13World, over: Record<string, unknown> = {}, ctx: never = w.ctx()) => run(w, (s) => s.statement(ctx, { creditPartyId: PARTY, ...over } as never));
  const seeded = () => { const w = makeT13World(); (w.s as any).statementRows.push(row('2026-09', '2083/84', 500000, 0, 0, 500000), row('2026-10', '2083/84', 1200000, 700000, 50000, 950000), row('2026-11', '2083/84', 0, 300000, 0, 650000),
    row('2026-10', '2083/84', 99, 99, 99, 99, { credit_party_id: PARTY2 }), row('2026-10', '2083/84', 99, 99, 99, 99, { tenant_id: TENANT_B })); return w; };
  it('invoiced, paid, credited and closing balance per month as Money, for the requested inclusive range only', async () => {
    const w = seeded();
    const s = await stmt(w, { fromMonth: '2026-09', toMonth: '2026-10' });
    expect(s.rows).toEqual([
      { periodMonth: '2026-09', fiscalYearBs: '2083/84', invoiced: { amountPaisa: 500000, currency: 'NPR' }, paid: { amountPaisa: 0, currency: 'NPR' }, credited: { amountPaisa: 0, currency: 'NPR' }, closingBalance: { amountPaisa: 500000, currency: 'NPR' } },
      { periodMonth: '2026-10', fiscalYearBs: '2083/84', invoiced: { amountPaisa: 1200000, currency: 'NPR' }, paid: { amountPaisa: 700000, currency: 'NPR' }, credited: { amountPaisa: 50000, currency: 'NPR' }, closingBalance: { amountPaisa: 950000, currency: 'NPR' } },
    ]);
    expect(w.repoCalls.filter((c) => c.name === 'readCreditPartyStatement').pop()!.args).toEqual({ tenantId: TENANT_A, creditPartyId: PARTY, fromMonth: '2026-09-01', toMonth: '2026-10-01' });
  });
  it('a month straddling Shrawan 1 shows one row per fiscal year (intended, 05-SCHEMA)', async () => {
    const w = makeT13World();
    (w.s as any).statementRows.push(row('2026-07', '2082/83', 100, 0, 0, 100), row('2026-07', '2083/84', 200, 0, 0, 300));
    expect((await stmt(w, { fromMonth: '2026-07', toMonth: '2026-07' })).rows.map((r: any) => r.fiscalYearBs)).toEqual(['2082/83', '2083/84']);
  });
  it('range limit: exactly 24 months is fine; 25 months -> 422 billing.export_too_large and the view is not read; from after to / bad format -> 400', async () => {
    const w = seeded();
    await stmt(w, { fromMonth: '2024-11', toMonth: '2026-10' });
    const reads = w.repoCalls.filter((c) => c.name === 'readCreditPartyStatement').length;
    expect((await errCode(stmt(w, { fromMonth: '2024-10', toMonth: '2026-10' }))).code).toBe('billing.export_too_large');
    expect(w.repoCalls.filter((c) => c.name === 'readCreditPartyStatement').length).toBe(reads);
    for (const over of [{ fromMonth: '2026-10', toMonth: '2026-09' }, { fromMonth: '2026-13', toMonth: '2026-13' }, { fromMonth: '202610' }, { toMonth: '2026-1' }]) {
      expect((await errCode(stmt(w, over))).code, JSON.stringify(over)).toBe('common.validation_failed');
    }
  });
  it('without from/to: the last 24 months ending with the current month (tenant timezone), never more', async () => {
    const w = seeded();
    await stmt(w);
    const a = w.repoCalls.filter((c) => c.name === 'readCreditPartyStatement').pop()!.args;
    expect(a.toMonth).toBe('2026-11-01');                       // BASE = 2026-11-08 NPT
    const [fy, fm] = a.fromMonth.split('-').map(Number), months = (2026 - fy) * 12 + (11 - fm) + 1;
    expect(months).toBeLessThanOrEqual(24);
  });
  it('a party of another tenant / unknown party is common.not_found and the view is not read', async () => {
    const w = seeded();
    expect((await errCode(stmt(w, {}, w.ctx({ tenantId: TENANT_B })))).code).toBe('common.not_found');
    expect((await errCode(stmt(w, { creditPartyId: V7('000000b0ffff') }))).code).toBe('common.not_found');
    expect(w.repoCalls.some((c) => c.name === 'readCreditPartyStatement')).toBe(false);
  });
});
