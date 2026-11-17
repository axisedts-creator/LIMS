// J-T01 (06-IMPLEMENTATION-PLAN row J-T01; PRD US-FD-03.1/.3/.4/.5, US-FD-04.1; 07-SECURITY counter row "number skipping/reuse -> guard last_no = old+1", A3 gapless).
// done_when: FD registration green against REAL billing (BL-T07 BillingCommandPort, real counter, real billing.* tables, real core events);
// the registration rollback proves the INVOICE counter rolled back: the number real billing allocated inside a failed registration is the number the next one gets.
// The FD-T06 rollback suite could not assert this (its fake counter is not transactional: see registration/rollback.test.ts header). Synthetic data only.
// Counter assertions use tenant B (side 'b'): tenant A's INV counter is moved by other suites' registrations, B's only by this file (one file = sequential).
import { describe, expect, it } from 'vitest';
import { createIdempotency } from '../../../../core/idempotency.js';
import { handlers } from '../../handlers/index.js';
import { CP, ctxFor, draft, eventRows, NET, NOTHING, orderRow, ordersOf, pay, prepare, quoteFp, storedFor, T, knowRecipient, type RegReply } from '../registration/helpers.js';
import { req } from '../patients/helpers.js';
import { BILLING_NOTHING, CENTRE, INVOICE_NO, TENANT_A, TENANT_B, appTx, balanceOf, billingStoredFor, chargesOf, ensureBillingSeed, eventsFor, realCtx, invoiceCounter,
  invoicesOf, ledgerOf, ownerRows, realWorld, registerReal, registerRealFails, seqOf, uid, type RealWorld } from './billingReal.harness.js';

/** Tenant B registration prepared against the real-billing world. */
const prep = (o: Parameters<typeof prepare>[0] = {}, w: RealWorld = realWorld()) => prepare({ side: 'b', w, ...o });
const regB = (body: unknown, w: RealWorld, o: Record<string, unknown> = {}) => registerReal(body, { w, tenant: TENANT_B, ...o });
const failB = (body: unknown, w: RealWorld, o: Record<string, unknown> = {}) => registerRealFails(body, { w, tenant: TENANT_B, ...o });

describe('US-FD-03.1 walk-in cash registration over real billing', () => {
  it('201: order + invoice + payment persisted by billing; number has the tenant-pattern shape and equals the counter value', async () => {
    const before = await invoiceCounter(TENANT_B);
    const p = await prep();
    const r = await regB(p.body, p.w);
    expect(r.status).toBe(201);
    const no: string = r.body.invoice.invoice_no;
    expect(no).toMatch(INVOICE_NO);
    expect(seqOf(no)).toBe(before + 1);
    expect(await invoiceCounter(TENANT_B)).toBe(before + 1);
    const inv = await invoicesOf(r.body.order.id);
    expect(inv).toHaveLength(1);
    expect(inv[0]).toMatchObject({ invoice_no: no, status: 'issued', purpose: 'registration', invoice_seq: before + 1, patient_id: p.patient.id });
    expect(Number(inv[0].net_paisa)).toBe(NET);
    expect(r.body.invoice.id).toBe(inv[0].id);
    expect(await ownerRows('billing.invoice_lines', 'invoice_id = $1', [inv[0].id])).toHaveLength(2);
    const led = await ledgerOf(r.body.order.id);
    expect(led).toHaveLength(1);
    expect(Number(led[0].amount_paisa)).toBe(NET);
    expect(r.body.ledger_entries[0].id).toBe(led[0].id);
    expect(r.body.balance.balance_due.amount_paisa).toBe(0);
    expect(Number((await balanceOf(r.body.order.id))[0].balance_due_paisa)).toBe(0);
    expect((await orderRow(r.body.order.id)).status).toBe('registered');
  }, T);

  it('events exactly once: frontdesk.order.created.v1 x1, billing.invoice.issued.v1 x1, billing.balance.changed.v1 x (1 + payments) with strictly increasing balance_version', async () => {
    const p = await prep({ payments: [pay(30000), pay(NET - 30000)] });
    const r = await regB(p.body, p.w);
    const orderId: string = r.body.order.id, invoiceId: string = r.body.invoice.id;
    expect(await eventRows('frontdesk.order.created.v1', orderId)).toHaveLength(1);
    expect(await eventsFor([invoiceId], 'billing.invoice.issued.v1')).toHaveLength(1);
    const bal = await eventsFor([orderId], 'billing.balance.changed.v1');
    expect(bal).toHaveLength(3);                                                      // invoice_issued + 2 payments
    const seq = bal.map((e) => Number(e.aggregate_seq));
    expect(seq).toEqual([...seq].sort((a, b) => a - b));
    expect(new Set(seq).size).toBe(3);
    expect(r.body.balance.balance_version).toBe(Math.max(...seq));
    expect(r.body.balance.balance_due.amount_paisa).toBe(0);
    expect(r.body.ledger_entries).toHaveLength(2);
  }, T);

  it('part payment: balance due is what billing computed, one balance event per change', async () => {
    const p = await prep({ payments: [pay(10000)] });
    const r = await regB(p.body, p.w);
    expect(r.body.balance.balance_due.amount_paisa).toBe(NET - 10000);
    expect(Number((await balanceOf(r.body.order.id))[0].balance_due_paisa)).toBe(NET - 10000);
    expect(await eventsFor([r.body.order.id], 'billing.balance.changed.v1')).toHaveLength(2);
  }, T);

  it('no payment: invoice issued, balance due = net, ONE balance event', async () => {
    const p = await prep({ payments: [] });
    const r = await regB(p.body, p.w);
    expect(r.body.invoice.invoice_no).toMatch(INVOICE_NO);
    expect(r.body.balance.balance_due.amount_paisa).toBe(NET);
    expect(await ledgerOf(r.body.order.id)).toHaveLength(0);
    expect(await eventsFor([r.body.order.id], 'billing.balance.changed.v1')).toHaveLength(1);
  }, T);

  it('the invoice number of the response is the one billing allocated (no FD-side numbering)', async () => {
    const p = await prep();
    const r = await regB(p.body, p.w);
    expect(p.w.issued).toHaveLength(1);
    expect(p.w.issued[0]).toMatchObject({ invoiceNo: r.body.invoice.invoice_no, invoiceId: r.body.invoice.id, orderId: r.body.order.id });
  }, T);
});

describe('US-FD-03.5 rollback after the invoice number was allocated: the counter is rolled back, the next invoice reuses the number', () => {
  const NO_ORDER_ROWS = NOTHING;

  /** Register once (counter n -> n+1), fail one registration with `inject`, register again: the failed attempt's number must be re-issued. */
  async function failThenSucceed(inject: (p: Awaited<ReturnType<typeof prep>>) => { failEvent?: string }, expectCode: string, prepOpts: Parameters<typeof prepare>[0] = {}) {
    const w = realWorld();
    const first = await prep(prepOpts, w);
    const a = await regB(first.body, w);
    const n = seqOf(a.body.invoice.invoice_no);
    expect(await invoiceCounter(TENANT_B)).toBe(n);

    const w2 = realWorld();
    const second = await prep(prepOpts, w2);
    const failing = inject(second);
    const e = await failB(second.body, w2, failing);
    expect(e.code).toBe(expectCode);
    const burnt = w2.issued[0];                                                       // real billing DID allocate inside the failed tx ...
    expect(burnt, 'injection point must come after issueOrderInvoice').toBeDefined();
    expect(seqOf(burnt!.invoiceNo)).toBe(n + 1);
    expect(await invoiceCounter(TENANT_B)).toBe(n);                                   // ... and the rollback gave the number back
    const orderId = burnt!.orderId;
    expect(await storedFor(orderId)).toEqual(NO_ORDER_ROWS);
    expect(await billingStoredFor(orderId)).toEqual(BILLING_NOTHING);
    expect(await invoicesOf(orderId)).toHaveLength(0);
    expect(w2.spy.published).toHaveLength(0);

    const w3 = realWorld();
    const third = await prep(prepOpts, w3);
    const c = await regB(third.body, w3);
    expect(c.body.invoice.invoice_no).toBe(burnt!.invoiceNo);                         // US-FD-03.5: next invoice receives the same number
    expect(seqOf(c.body.invoice.invoice_no)).toBe(n + 1);
    expect(await invoiceCounter(TENANT_B)).toBe(n + 1);
    return { a, c, burnt: burnt! };
  }

  it('event publish fails (schema failure) after billing wrote invoice + payment + balance + events: nothing survives, same number re-issued', async () => {
    await failThenSucceed(() => ({ failEvent: 'frontdesk.order.created.v1' }), 'common.internal');
  }, T * 2);

  it('second payment refused by real billing (payment_exceeds_due) after the invoice and first payment were written: all rolled back, same number re-issued', async () => {
    // total payments 72601 > net 72600: real billing refuses the second recordPayment (no failure injection: the real rule)
    await failThenSucceed((p) => { p.body.payments = [pay(30000), pay(NET - 30000 + 1)]; return {}; }, 'billing.payment_exceeds_due');
  }, T * 2);

  it('mixed sequence ok, fail, fail, ok, ok: invoice numbers of the successes are consecutive (gapless)', async () => {
    const seqs: number[] = [];
    const ok = async () => { const w = realWorld(); const p = await prep({}, w); seqs.push(seqOf((await regB(p.body, w)).body.invoice.invoice_no)); };
    const bad = async () => { const w = realWorld(); const p = await prep({}, w); expect((await failB(p.body, w, { failEvent: 'frontdesk.order.created.v1' })).code).toBe('common.internal'); };
    await ok(); await bad(); await bad(); await ok(); await ok();
    expect(seqs).toHaveLength(3);
    expect(seqs[1]).toBe(seqs[0]! + 1);
    expect(seqs[2]).toBe(seqs[1]! + 1);
    expect(await invoiceCounter(TENANT_B)).toBe(seqs[2]);
  }, T * 4);

  it('stale quote (409 common.version_conflict) consumes no invoice number (US-FD-03.4)', async () => {
    // tenant A: the fixture's cbcPriceV2 only exists on tenant A's price list (quote/helpers.ts world()). Other suites also move A's counter, so only
    // "this request never allocated" is asserted for A (later.issued), plus the counter staying put when nothing else runs (this verify runs this file alone).
    const quoted = await prepare({ w: realWorld() });
    const later = realWorld({ cbcPriceV2: 55000 });
    knowRecipient(later, TENANT_A, quoted.patient.id, true);
    const before = await invoiceCounter(TENANT_A);
    const e = await registerRealFails(quoted.body, { w: later });
    expect(e.code).toBe('common.version_conflict');
    expect(later.issued).toHaveLength(0);
    expect(await invoiceCounter(TENANT_A)).toBe(before);
    expect(await ordersOf(quoted.patient.id)).toHaveLength(0);
  }, T);

  it('a refused request that never reaches billing (validation) consumes no number', async () => {
    const p = await prep();
    const before = await invoiceCounter(TENANT_B);
    const e = await failB({ ...p.body, payments: [pay(0)] }, p.w);
    expect(e.code).toBe('common.validation_failed');
    expect(p.w.issued).toHaveLength(0);
    expect(await invoiceCounter(TENANT_B)).toBe(before);
  }, T);

  it('new patient + failure after the invoice: the patient row, the order and the invoice are all gone, the counter is back', async () => {
    const w = realWorld();
    const np = { full_name: `Fdt J01 ${uid().slice(-8)}`, sex: 'male', age: { years: 41 }, phone_e164: `+977984${String(Date.now()).slice(-7)}`,
      consents: { processing: true, sms: false, whatsapp: false, email: false, share_with_referrer: false, consent_text_version: 'v1' } };
    const d = draft({ patient: { new_patient: np }, centre_id: CENTRE.b });
    const fp = await quoteFp(w, d, { tenant: TENANT_B, centreIds: [CENTRE.b] });
    const before = await invoiceCounter(TENANT_B);
    const e = await failB({ ...d, quote_fingerprint: fp, payments: [pay(NET)] }, w, { failEvent: 'frontdesk.order.created.v1' });
    expect(e.code).toBe('common.internal');
    expect(w.issued).toHaveLength(1);
    expect(await ownerRows('frontdesk.patients', 'tenant_id = $1 AND full_name = $2', [TENANT_B, np.full_name])).toHaveLength(0);
    expect(await billingStoredFor(w.issued[0]!.orderId)).toEqual(BILLING_NOTHING);
    expect(await invoiceCounter(TENANT_B)).toBe(before);
  }, T);
});

describe('US-FD-03.3 idempotent replay over real billing: one order, ONE invoice number consumed', () => {
  const claims = { sub: '01a1b34e-1000-7eee-9d29-d7ca59a102b5', tenant_id: TENANT_B };
  const db: any = { requestTx: async (_in: unknown, fn: (tx: any) => Promise<unknown>) => appTx(TENANT_B, fn) };
  const idem = createIdempotency({ db });
  const operation = { module: 'frontdesk', operationId: 'createRegistration', context: 'tenant', idempotency: 'required' } as const;

  /** What the pipeline does: begin (stage 6) -> handler in the request tx + finish (stage 10) -> release after a rollback (stage 11). Same as registration/rollback.test.ts + real billing. */
  async function viaPipeline(key: string, body: any, w: RealWorld, o: { failEvent?: string } = {}) {
    await ensureBillingSeed();
    const begun = await idem.begin({ operation, method: 'POST', routeTemplate: '/v1/frontdesk/registrations', body, idempotencyKey: key, claims: claims as never, requestId: uid(), clientIp: '203.0.113.9' });
    if (begun.action === 'replay') return { replay: true as const, status: begun.status, body: begun.body };
    if (begun.action !== 'proceed') throw new Error('unexpected skip');
    try {
      const out = await appTx(TENANT_B, async (tx) => {
        const probe: RegReply['probe'] = { logs: [], accessCalls: [], identity: undefined, requestId: uid(), ctx: undefined };
        const ctx = ctxFor(tx, TENANT_B, w, { ...(o.failEvent ? { failEvent: o.failEvent } : {}), centreId: CENTRE.b }, probe);
        realCtx(ctx, TENANT_B);
        let reply: any;
        try { reply = await (handlers as any).createRegistration(req({ body, headers: { 'idempotency-key': key } }), ctx); }
        catch (e) { w.spy.rollback(tx); w.notif.__rollback(tx); throw e; }
        await idem.finish(tx, begun.handle, { status: reply.status, body: reply.body });
        return reply;
      });
      return { replay: false as const, status: out.status, body: out.body };
    } catch (e) { await idem.release(begun.handle); throw e; }
  }

  it('same key + same body twice: second is the stored 201; one invoice, counter moved by exactly 1', async () => {
    const p = await prep();
    const key = `jt01-${uid().replace(/-/g, '').slice(0, 24)}`;
    const before = await invoiceCounter(TENANT_B);
    const first = await viaPipeline(key, p.body, p.w);
    expect(first).toMatchObject({ replay: false, status: 201 });
    const second = await viaPipeline(key, p.body, p.w);
    expect(second).toMatchObject({ replay: true, status: 201 });
    expect(second.body).toEqual(JSON.parse(JSON.stringify(first.body)));
    expect(await invoiceCounter(TENANT_B)).toBe(before + 1);
    expect(p.w.issued).toHaveLength(1);
    expect(await invoicesOf((first.body as any).order.id)).toHaveLength(1);
    expect(await ledgerOf((first.body as any).order.id)).toHaveLength(1);
  }, T);

  it('failed attempt releases the key and the counter: retry with the SAME key + body registers once and re-issues the burnt number', async () => {
    const p = await prep();
    const key = `jt01-${uid().replace(/-/g, '').slice(0, 24)}`;
    const before = await invoiceCounter(TENANT_B);
    const failed = await viaPipeline(key, p.body, p.w, { failEvent: 'frontdesk.order.created.v1' }).catch((x) => x);
    expect(failed.code).toBe('common.internal');
    expect(await invoiceCounter(TENANT_B)).toBe(before);
    const burnt = p.w.issued[0]!.invoiceNo;
    const ok: any = await viaPipeline(key, p.body, p.w);
    expect(ok).toMatchObject({ replay: false, status: 201 });
    expect(ok.body.invoice.invoice_no).toBe(burnt);
    expect(await invoiceCounter(TENANT_B)).toBe(before + 1);
  }, T);
});

describe('many users at once: concurrent registrations get distinct, contiguous invoice numbers', () => {
  it('4 parallel registrations (distinct patients): all 201, numbers contiguous, counter moved by exactly 4', async () => {
    const preps = await Promise.all([0, 1, 2, 3].map(() => { const w = realWorld(); return prep({}, w).then((p) => ({ p, w })); }));
    const before = await invoiceCounter(TENANT_B);
    const out = await Promise.all(preps.map(({ p, w }) => regB(p.body, w)));
    const seqs = out.map((r) => seqOf(r.body.invoice.invoice_no)).sort((a, b) => a - b);
    expect(out.map((r) => r.status)).toEqual([201, 201, 201, 201]);
    expect(seqs).toEqual([before + 1, before + 2, before + 3, before + 4]);
    expect(await invoiceCounter(TENANT_B)).toBe(before + 4);
  }, T * 2);

  it('parallel mix: 2 succeed, 2 fail after the invoice: successes get contiguous numbers, failures leave no gap', async () => {
    const mk = () => { const w = realWorld(); return prep({}, w).then((p) => ({ p, w })); };
    const [a, b, c, d] = await Promise.all([mk(), mk(), mk(), mk()]);
    const before = await invoiceCounter(TENANT_B);
    const res = await Promise.allSettled([regB(a!.p.body, a!.w), regB(b!.p.body, b!.w), failB(c!.p.body, c!.w, { failEvent: 'frontdesk.order.created.v1' }), failB(d!.p.body, d!.w, { failEvent: 'frontdesk.order.created.v1' })]);
    expect(res.every((r) => r.status === 'fulfilled')).toBe(true);
    const seqs = [res[0], res[1]].map((r) => seqOf((r as PromiseFulfilledResult<RegReply>).value.body.invoice.invoice_no)).sort((x, y) => x - y);
    expect(seqs).toEqual([before + 1, before + 2]);
    expect(await invoiceCounter(TENANT_B)).toBe(before + 2);
  }, T * 2);
});

describe('credit mode over real billing (US-FD-04.1): charges, no invoice, no number consumed', () => {
  it('credit registration: credit_charges per line, no invoice, no ledger, invoice counter untouched', async () => {
    const before = await invoiceCounter(TENANT_A);
    const w = realWorld();
    const p = await prepare({ w, d: { billing_mode: 'credit', credit_party_id: CP.ok } });
    const r = await registerReal(p.body, { w });
    expect(r.status).toBe(201);
    expect(r.body.invoice).toBeUndefined();
    const orderId: string = r.body.order.id;
    expect(await invoicesOf(orderId)).toHaveLength(0);
    expect(await ledgerOf(orderId)).toHaveLength(0);
    const ch = await chargesOf(orderId);
    expect(ch).toHaveLength(2);
    expect(ch.every((c) => c.status === 'uninvoiced')).toBe(true);
    expect(w.issued).toHaveLength(0);
    expect(await invoiceCounter(TENANT_A)).toBe(before);
  }, T);

  it('credit registration that fails after recordCreditCharges leaves no charges and no order', async () => {
    const w = realWorld();
    const p = await prepare({ w, d: { billing_mode: 'credit', credit_party_id: CP.ok } });
    const e = await registerRealFails(p.body, { w, failEvent: 'frontdesk.order.created.v1' });
    expect(e.code).toBe('common.internal');
    expect(w.creditOrders).toHaveLength(1);                                            // billing really wrote charges inside the failed tx ...
    expect(await billingStoredFor(w.creditOrders[0]!)).toEqual(BILLING_NOTHING);       // ... and they are gone
    expect(await ordersOf(p.patient.id)).toHaveLength(0);
  }, T);
});

describe('security: counter integrity, tenancy, authority (07-SECURITY counter row, A3)', () => {
  it('the counter cannot be pushed past +1 or moved back by the app role (guard last_no = old or old + 1)', async () => {
    const p = await prep();
    await regB(p.body, p.w);                                                           // the INV row exists
    const skip = appTx(TENANT_B, (tx) => tx.query("UPDATE billing.fiscal_counters SET last_no = last_no + 2 WHERE tenant_id = $1 AND series = 'INV'", [TENANT_B]));
    await expect(skip).rejects.toBeTruthy();
    const back = appTx(TENANT_B, (tx) => tx.query("UPDATE billing.fiscal_counters SET last_no = last_no - 1 WHERE tenant_id = $1 AND series = 'INV'", [TENANT_B]));
    await expect(back).rejects.toBeTruthy();
  }, T);

  it('a committed invoice is immutable for the app role: no DELETE, number cannot be edited', async () => {
    const p = await prep();
    const r = await regB(p.body, p.w);
    const id = r.body.invoice.id;
    await expect(appTx(TENANT_B, (tx) => tx.query('DELETE FROM billing.invoices WHERE id = $1', [id]))).rejects.toBeTruthy();
    await expect(appTx(TENANT_B, (tx) => tx.query("UPDATE billing.invoices SET invoice_no = 'X' WHERE id = $1", [id]))).rejects.toBeTruthy();
    expect((await invoicesOf(r.body.order.id))[0].invoice_no).toBe(r.body.invoice.invoice_no);
  }, T);

  it('another tenant cannot see the registration\'s billing rows (RLS)', async () => {
    const p = await prep();
    const r = await regB(p.body, p.w);
    const orderId: string = r.body.order.id;
    const asA = await appTx(TENANT_A, async (tx) => ({
      inv: (await tx.query('SELECT id FROM billing.invoices WHERE order_id = $1', [orderId])).rows.length,
      led: (await tx.query('SELECT id FROM billing.ledger_entries WHERE order_id = $1', [orderId])).rows.length,
      bal: (await tx.query('SELECT order_id FROM billing.order_balances WHERE order_id = $1', [orderId])).rows.length,
    }));
    expect(asA).toEqual({ inv: 0, led: 0, bal: 0 });
  }, T);

  it('missing invoice permission stops a cash registration before billing is called: no number consumed', async () => {
    const p = await prep();
    const before = await invoiceCounter(TENANT_B);
    const e = await failB(p.body, p.w, { grants: ['frontdesk.registration.create'] });
    expect(e.code).toBe('auth.forbidden');
    expect(p.w.issued).toHaveLength(0);
    expect(await invoiceCounter(TENANT_B)).toBe(before);
  }, T);
});
