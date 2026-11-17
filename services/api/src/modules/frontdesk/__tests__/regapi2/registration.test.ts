// T0B-REGAPI-2 done_when (1) (2) (7) (8): quoteRegistration + createRegistration accept and return every field added by T0C-REGPARITY-2, validated; coupon and reward-point
// operations (apply, remove, redeem) with a ledger entry per change, never below zero, usage limit race safe, reversed when the order is cancelled; money in paisa integers,
// totals and balance computed on the server. Handlers run over a REAL PG17 under RLS with the real fakes (../registration/helpers.ts); the order is cancelled through cancelOrder.
// PINNED PICKS (the contract and the brief have no text for them; each is the lead's wording turned into a number):
//  - clock: ctx.now() is the request time. collection_at may be at most 5 minutes after it (NOW + 4 min ok, NOW + 6 min 400 /collection_at); the past is fine.
//  - coupon: exactly the rows of frontdesk.coupons of the tenant; valid = is_active, valid_from <= today <= valid_to (NULL = open), used_count < usage_limit. EVERY failure (unknown,
//    other tenant, inactive, expired, not yet valid, exhausted) is the same answer: 400 common.validation_failed at /coupon_code (no probing of codes). Quote only reads; register does
//    UPDATE used_count = used_count + 1 once per order, in the save transaction, so a rolled back save never burns a use. percent coupon = floor(percent x net after discounts, before the
//    visiting charge); amount coupon = amount; capped at that net (the net never goes below zero). Order stores coupon_code + coupon_amount_paisa (server derived).
//  - visiting_charge_paisa is a flat extra charge: totals.net = net + charge, the invoice is for that total; claim > net is 400 /insurance_claim_amount_paisa.
//  - redeem_reward_points: <= balance (earned - redeemed) else 400 /redeem_reward_points; writes ONE ledger row kind 'redeemed' (points = redeemed, order_id = the order); the order shows
//    reward_points_redeemed; parallel redemptions of one patient can never take the balance below zero (row lock). Earning rules are not pinned here.
//  - cancel (cancelOrder): used_count - 1 once, the redeemed points come back as ONE 'earned' ledger row on the cancelled order (balance restored), the insurance claim of the cancelled
//    order reads 0. A second cancel attempt reverses nothing again.
//  - ICD: RegistrationItem.icd_code must be an ACTIVE code of the tenant's ICD master, at quote and at register (400 /items/<i>/icd_code).
//  - sensitive: clinical_history, patient_history, card_holder_name never reach ctx.log, the access log, error messages or audit.audit_log; card_holder_name / payment_remark reach the billing port.
import { createFakeLabPort } from '../../../../../../../packages/fakes/src/LabPort.fake';
import { describe, expect, it } from 'vitest';
import { cancel, cancelFails } from '../orderchange/helpers.js';
import { NOW, schemaErrors, seedOrder } from '../patients/helpers.js';
import { O, draft, quote } from '../quote/helpers.js';
import { NET, itemRows, orderRow, ordersOf, pay, prepare, register, registerFails, rworld, type Prepared } from '../registration/helpers.js';
import { CENTRE, T, TENANT_A, TENANT_B, U1, fire, fresh, icd, ownerRows, req, seed, superTx, uid, upper } from './helpers.js';

const money = (n: number) => ({ amount_paisa: n, currency: 'NPR' });
const code = () => `RG${upper()}`;
const FAR = { valid_from: '2000-01-01', valid_to: '2099-12-31' };
async function mkCoupon(o: Record<string, unknown> = {}, tenant = TENANT_A): Promise<string> {
  const c = (o['code'] as string) ?? code();
  await seed('frontdesk.coupons', { id: uid(), tenant_id: tenant, code: c, percent: 10, ...FAR, usage_limit: 100, used_count: 0, is_active: true, ...o });
  return c;
}
const couponRow = async (c: string) => (await ownerRows('frontdesk.coupons', 'tenant_id = $1 AND code = $2', [TENANT_A, c]))[0];
const setCoupon = (c: string, set: string, v: unknown[] = []) => superTx(async (tx) => { await tx.query(`UPDATE frontdesk.coupons SET ${set} WHERE tenant_id = $1 AND code = $${v.length + 2}`, [TENANT_A, ...v, c]); });
async function mkIcd(o: Record<string, unknown> = {}): Promise<string> {
  const c = (o['code'] as string) ?? icd();
  await seed('frontdesk.icd_codes', { id: uid(), tenant_id: TENANT_A, code: c, description: 'Synthetic ICD', is_active: true, ...o });
  return c;
}
const ledger = (patientId: string) => ownerRows('frontdesk.reward_points_ledger', 'patient_id = $1 ORDER BY created_at, id', [patientId]);
const balanceOf = async (patientId: string) => (await ledger(patientId)).reduce((a, r) => a + (r.entry_kind === 'earned' ? 1 : -1) * Number(r.points), 0);
async function givePoints(patientId: string, points: number): Promise<void> {
  const prior = await seedOrder('a', patientId, { registered_at: '2026-10-01T04:00:00Z' });
  await seed('frontdesk.reward_points_ledger', { id: uid(), tenant_id: TENANT_A, patient_id: patientId, order_id: prior.id, entry_kind: 'earned', points });
}
const quoteOf = (d: Record<string, unknown>, w = rworld()) => quote(draft(d), { w });
const rewards = (patientId: string, who = U1, query: object = {}) => fire('getPatientRewards', req({ params: { patient_id: patientId }, query }), who);
const NEW_ORDER_KEYS = ['collection_at', 'collected_by_membership_id', 'collected_by_name', 'sample_not_collected', 'sample_remark', 'remark_description', 'clinical_history', 'patient_history',
  'mr_number', 'external_reference', 'insurance_code', 'insurance_claim_amount_paisa', 'visiting_charge_paisa', 'coupon_code', 'coupon_amount_paisa', 'reward_points_earned', 'reward_points_redeemed'];

describe('quoteRegistration: coupon, visiting charge, redeem points, ICD (read only, totals computed on the server)', () => {
  // LD-327 (founder, 2026-11-17 12:59 NPT: "in this field there is no vat", "no vat in this medical field"), option A1 VAT EXEMPT, replaces the earlier pin NET - 7260 (it took 10 percent
  // of a net that included 13 percent VAT of the taxable GLU line): a coupon is a bill level discount applied BEFORE tax (passed to billing as a discount, VAT recomputed from the lines after it);
  // the visiting charge is a separate invoice line, VAT exempt, included in totals.net. The exempt-only CBC order (50000, VAT 0) is the lab tenant case: the numbers carry NO VAT.
  const CBC_ONLY = [{ orderable_id: O.cbc }];
  const CBC = 50000;
  it('LD-327: visiting charge (exempt line) adds exactly its paisa to totals.net; coupon (amount, percent) is a pre tax discount that subtracts exactly its value; nothing is written or consumed', { timeout: T }, async () => {
    const base = await quoteOf({ items: CBC_ONLY });
    expect(base.body.totals.net).toEqual(money(CBC));
    const v = await quoteOf({ items: CBC_ONLY, visiting_charge_paisa: 1500 });
    expect(v.body.totals.net).toEqual(money(CBC + 1500));
    const amt = await mkCoupon({ percent: null, amount_paisa: 5000 }); const pct = await mkCoupon({ percent: 10 });
    const a = await quoteOf({ items: CBC_ONLY, coupon_code: amt }); const p = await quoteOf({ items: CBC_ONLY, coupon_code: pct });
    expect(a.body.totals.net).toEqual(money(CBC - 5000));
    expect(p.body.totals.net).toEqual(money(CBC - 5000));                                   // 10 percent of the 50000 bill, no VAT in the base
    const both = await quoteOf({ items: CBC_ONLY, coupon_code: pct, visiting_charge_paisa: 1500 });
    expect(both.body.totals.net).toEqual(money(CBC - 5000 + 1500));                         // the percent is taken on the bill WITHOUT the visiting charge
    for (const r of [a, p, both, v]) { expect(r.wrote, 'a quote writes nothing').toBe(false); expect(schemaErrors('Quote', r.body)).toEqual([]); }
    expect((await couponRow(pct)).used_count).toBe(0);
    expect((await couponRow(amt)).used_count).toBe(0);
  });
  it('LD-327 (a): the coupon is a discount BEFORE tax: on a taxable line VAT is recomputed from the line after the discount (GLU 20000 at 13 percent: 22600 -> coupon 5000 -> 15000 + 1950)', { timeout: T }, async () => {
    const GLU = [{ orderable_id: O.glu }];
    expect((await quoteOf({ items: GLU })).body.totals.net).toEqual(money(22600));
    const amt = await mkCoupon({ percent: null, amount_paisa: 5000 });
    const q = await quoteOf({ items: GLU, coupon_code: amt });
    expect(q.body.totals.net).toEqual(money(16950));
    expect(q.body.totals.vat).toEqual(money(1950));
  });
  it('a coupon larger than the bill is capped at the bill (the cap rule): the net is 0, never negative; the visiting charge is not discounted by it', { timeout: T }, async () => {
    const big = await mkCoupon({ percent: null, amount_paisa: 9_000_000 });
    expect((await quoteOf({ items: CBC_ONLY, coupon_code: big })).body.totals.net).toEqual(money(0));
    expect((await quoteOf({ items: CBC_ONLY, coupon_code: big, visiting_charge_paisa: 1500 })).body.totals.net).toEqual(money(1500));
    expect((await quoteOf({ coupon_code: big })).body.totals.net).toEqual(money(0));
  });
  it('every invalid coupon is the SAME 400 at /coupon_code: unknown, other tenant, inactive, expired, not yet valid, exhausted, lower case', { timeout: T }, async () => {
    const other = await mkCoupon({}, TENANT_B);
    const cases = [`NOPE${upper()}`, other, await mkCoupon({ is_active: false }), await mkCoupon({ valid_from: '2000-01-01', valid_to: '2000-01-02' }), await mkCoupon({ valid_from: '2099-01-01', valid_to: '2099-12-31' }),
      await mkCoupon({ usage_limit: 1, used_count: 1 }), (await mkCoupon()).toLowerCase()];
    const answers = new Set<string>();
    for (const c of cases) {
      const e: any = await quoteOf({ coupon_code: c }).then(() => { throw new Error(`coupon ${c} must be refused`); }, (x) => x);
      expect(e.code, c).toBe('common.validation_failed');
      expect(JSON.stringify(e.errors ?? []), c).toContain('/coupon_code');
      answers.add(`${e.code}|${e.message}|${JSON.stringify((e.errors ?? []).map((x: any) => x.path ?? x.pointer))}`);
    }
    expect(answers.size, 'indistinguishable answers').toBe(1);
  });
  it('visiting_charge_paisa: 0 ok; negative, fractional, above the integer limit => 400 /visiting_charge_paisa', { timeout: T }, async () => {
    expect((await quoteOf({ visiting_charge_paisa: 0 })).body.totals.net).toEqual(money(NET));
    for (const bad of [-1, 1.5, 9007199254740992, '100']) {
      const e: any = await quoteOf({ visiting_charge_paisa: bad }).then(() => { throw new Error(`${bad} must be refused`); }, (x) => x);
      expect(e.code).toBe('common.validation_failed'); expect(JSON.stringify(e.errors ?? [])).toContain('/visiting_charge_paisa');
    }
  });
  it('redeem_reward_points: needs a balance (400 /redeem_reward_points beyond it or negative); within the balance the quote is 200 and burns nothing', { timeout: T }, async () => {
    const p = await prepare({}); await givePoints(p.patient.id, 300);
    const q = (n: number) => quote(draft({ patient: { patient_id: p.patient.id }, redeem_reward_points: n }), { w: p.w });
    expect((await q(300)).status).toBe(200);
    for (const bad of [301, -1, 1.5]) {
      const e: any = await q(bad).then(() => { throw new Error(`${bad} must be refused`); }, (x) => x);
      expect(e.code).toBe('common.validation_failed'); expect(JSON.stringify(e.errors ?? [])).toContain('/redeem_reward_points');
    }
    expect(await balanceOf(p.patient.id)).toBe(300);
  });
  it('icd_code per line must be an ACTIVE code of the tenant ICD master (400 /items/0/icd_code otherwise)', { timeout: T }, async () => {
    const good = await mkIcd(); const off = await mkIcd({ is_active: false });
    expect((await quoteOf({ items: [{ orderable_id: O.cbc, icd_code: good }] })).status).toBe(200);
    for (const bad of [icd(), off]) {
      const e: any = await quoteOf({ items: [{ orderable_id: O.cbc, icd_code: bad }] }).then(() => { throw new Error('must be refused'); }, (x) => x);
      expect(e.code).toBe('common.validation_failed'); expect(JSON.stringify(e.errors ?? [])).toContain('/items/0/icd_code');
    }
  });
});

describe('createRegistration: every new field is stored and returned', () => {
  it('all order fields round trip (response OrderDto schema valid + DB columns); ICD stored on the line; card holder + remark reach the billing port', { timeout: T }, async () => {
    const cbcIcd = await mkIcd(); const when = new Date(NOW.getTime() - 3_600_000).toISOString();
    const t = { collection_at: when, collected_by_name: 'Synthetic Courier', sample_not_collected: false, sample_remark: 'Synthetic sample remark', remark_description: 'Synthetic order remark',
      clinical_history: 'SYN-CLINICAL-HISTORY', patient_history: 'SYN-PATIENT-HISTORY', mr_number: 'MR-SYN-1', external_reference: 'EXT-SYN-1', insurance_code: 'INS-SYN-1', insurance_claim_amount_paisa: 5000 };
    const p = await prepare({ d: { items: [{ orderable_id: O.cbc, icd_code: cbcIcd }, { orderable_id: O.glu }] }, payments: [pay(1000, { card_holder_name: 'Synthetic Card Holder', payment_remark: 'SYN-PAY-REMARK' })], extra: t });
    const r = await register(p.body, { w: p.w });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(schemaErrors('OrderDto', r.body.order)).toEqual([]);
    expect(r.body.order).toMatchObject({ ...t, collection_at: when });
    const row = await orderRow(r.body.order.id);
    expect(row).toMatchObject({ collected_by_name: t.collected_by_name, sample_not_collected: false, sample_remark: t.sample_remark, remark_description: t.remark_description, clinical_history: t.clinical_history,
      patient_history: t.patient_history, mr_number: t.mr_number, external_reference: t.external_reference, insurance_code: t.insurance_code });
    expect(Number(row.insurance_claim_amount_paisa)).toBe(5000);
    expect(new Date(row.collection_at).toISOString()).toBe(when);
    expect((await itemRows(r.body.order.id)).find((i) => i.code === 'CBC')?.icd_code).toBe(cbcIcd);
    const sent = JSON.stringify(p.w.billingFake.calls('recordPayment').map((c: any) => c.input));
    expect(sent).toContain('Synthetic Card Holder'); expect(sent).toContain('SYN-PAY-REMARK');
  });
  it('without any new field the order carries none of them (no nulls) and the registration is unchanged', { timeout: T }, async () => {
    const p = await prepare({});
    const r = await register(p.body, { w: p.w });
    expect(r.status).toBe(201);
    expect(schemaErrors('OrderDto', r.body.order)).toEqual([]);
    for (const k of NEW_ORDER_KEYS) expect(r.body.order, k).not.toHaveProperty(k);
    expect(r.body.balance).toMatchObject({ invoiced: money(NET), paid: money(NET), balance_due: money(0) });
  });
  it('collected_by_membership_id: a membership of the tenant is accepted; unknown, another tenant, or together with collected_by_name => 400', { timeout: T }, async () => {
    const mine = (await superTx(async (tx) => (await tx.query('SELECT id FROM core.memberships WHERE tenant_id = $1 LIMIT 1', [TENANT_A])).rows))[0].id as string;
    const theirs = (await superTx(async (tx) => (await tx.query('SELECT id FROM core.memberships WHERE tenant_id = $1 LIMIT 1', [TENANT_B])).rows))[0].id as string;
    const okp = await prepare({ extra: { collected_by_membership_id: mine } });
    const r = await register(okp.body, { w: okp.w });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.order.collected_by_membership_id).toBe(mine);
    for (const extra of [{ collected_by_membership_id: uid() }, { collected_by_membership_id: theirs }, { collected_by_membership_id: mine, collected_by_name: 'Both Given' }]) {
      const p = await prepare({ extra });
      const e = await registerFails(p.body, { w: p.w });
      expect(e.code).toBe('common.validation_failed');
      expect(await ordersOf(p.patient.id)).toHaveLength(0);
    }
  });
});

describe('createRegistration: validation (400 common.validation_failed, field path in errors[], nothing stored, value never echoed)', () => {
  const refuse = async (extra: Record<string, unknown>, path: string, d: Record<string, unknown> = {}, o: Parameters<typeof prepare>[0] = {}) => {
    const p = await prepare({ d, extra, ...o });
    const e = await registerFails(p.body, { w: p.w });
    expect(e.code, JSON.stringify(extra)).toBe('common.validation_failed');
    expect(JSON.stringify(e.errors ?? []), JSON.stringify(extra)).toContain(path);
    expect(await ordersOf(p.patient.id), 'nothing stored').toHaveLength(0);
    expect(p.w.billingFake.calls('issueOrderInvoice'), 'no invoice number consumed').toHaveLength(0);
    return e;
  };
  it('collection_at: not more than 5 minutes after the request time (4 min ok, 6 min refused; the past is ok)', { timeout: T }, async () => {
    const at = (min: number) => new Date(NOW.getTime() + min * 60_000).toISOString();
    for (const min of [4, 0, -60 * 24 * 30]) { const p = await prepare({ extra: { collection_at: at(min) } }); expect((await register(p.body, { w: p.w })).status, `${min} min`).toBe(201); }
    await refuse({ collection_at: at(6) }, '/collection_at'); await refuse({ collection_at: at(60 * 24) }, '/collection_at'); await refuse({ collection_at: 'yesterday' }, '/collection_at');
  });
  it('insurance_claim_amount_paisa: not above the net, not negative, integer', { timeout: T }, async () => {
    await refuse({ insurance_claim_amount_paisa: NET + 1 }, '/insurance_claim_amount_paisa');
    await refuse({ insurance_claim_amount_paisa: -1 }, '/insurance_claim_amount_paisa');
    await refuse({ insurance_claim_amount_paisa: 10.5 }, '/insurance_claim_amount_paisa');
    const p = await prepare({ extra: { insurance_claim_amount_paisa: 0 }, payments: [pay(1000)] });
    expect((await register(p.body, { w: p.w })).status).toBe(201);
  });
  it('field limits: clinical_history / patient_history 4000, remark_description 1000, sample_remark 500, mr_number / external_reference / insurance_code 64, collected_by_name 200, empty strings', { timeout: T }, async () => {
    for (const [k, max] of [['clinical_history', 4000], ['patient_history', 4000], ['remark_description', 1000], ['sample_remark', 500], ['mr_number', 64], ['external_reference', 64], ['insurance_code', 64], ['collected_by_name', 200]] as const) {
      await refuse({ [k]: 'x'.repeat(max + 1) }, `/${k}`); await refuse({ [k]: '' }, `/${k}`);
    }
    const p = await prepare({ extra: { clinical_history: 'x'.repeat(4000), mr_number: 'm'.repeat(64) } });
    expect((await register(p.body, { w: p.w })).status).toBe(201);
  });
  it('unknown / inactive ICD code on a line => 400 /items/<i>/icd_code and no order', { timeout: T }, async () => {
    const good = await mkIcd(); const off = await mkIcd({ is_active: false });
    const p = await prepare({ d: { items: [{ orderable_id: O.cbc, icd_code: good }, { orderable_id: O.glu }] } });
    for (const bad of [icd(), off]) {
      const body = { ...p.body, items: [{ orderable_id: O.cbc, icd_code: good }, { orderable_id: O.glu, icd_code: bad }] };
      const e = await registerFails(body, { w: p.w });
      expect(['common.validation_failed', 'common.version_conflict']).toContain(e.code);   // the quote fingerprint may cover the lines; both refuse before anything is stored
    }
    expect(await ordersOf(p.patient.id)).toHaveLength(0);
    await superTx(async (tx) => { await tx.query('UPDATE frontdesk.icd_codes SET is_active = false WHERE tenant_id = $1 AND code = $2', [TENANT_A, good]); });
    const e = await registerFails(p.body, { w: p.w });                                    // the code was deactivated AFTER the quote: still refused at save
    expect(e.code).toBe('common.validation_failed'); expect(JSON.stringify(e.errors ?? [])).toContain('/items/0/icd_code');
    expect(await ordersOf(p.patient.id)).toHaveLength(0);
  });
});

describe('coupons at save: applied once per order, usage limit, tenant, rollback', () => {
  it('apply: order carries coupon_code and the server derived coupon_amount_paisa, the invoice is for the reduced total, used_count + 1 exactly once (3 quotes before it changed nothing)', { timeout: T }, async () => {
    const c = await mkCoupon({ percent: 10 });
    // LD-327: CBC only (50000, VAT exempt): 10 percent coupon = 5000 before tax, visiting charge 1500 an exempt line: invoice = 50000 - 5000 + 1500, no VAT anywhere.
    const items = [{ orderable_id: O.cbc }];
    const p = await prepare({ d: { items, coupon_code: c, visiting_charge_paisa: 1500 }, payments: [pay(10000)] });
    await quoteOf({ items, coupon_code: c }, p.w); await quoteOf({ items, coupon_code: c }, p.w);
    expect((await couponRow(c)).used_count).toBe(0);
    const r = await register(p.body, { w: p.w });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.order).toMatchObject({ coupon_code: c, coupon_amount_paisa: 5000, visiting_charge_paisa: 1500 });
    const total = 50000 - 5000 + 1500;
    expect(r.body.balance).toMatchObject({ invoiced: money(total), paid: money(10000), balance_due: money(total - 10000) });
    expect((await couponRow(c)).used_count).toBe(1);
    expect(Number((await orderRow(r.body.order.id)).coupon_amount_paisa)).toBe(5000);
    const inv = p.w.billingFake.calls('issueOrderInvoice')[0]?.input as any;
    expect(JSON.stringify(inv?.discounts ?? []), 'the coupon reaches billing as a discount (existing discount path, LD-327 a)').toContain('5000');
    expect(JSON.stringify(inv?.lines ?? [])).toContain('1500');                                     // the visiting charge is a separate invoice line
    for (const l of inv?.lines ?? []) if (JSON.stringify(l).includes('1500')) expect(l.tax?.vat ?? 'exempt', 'visiting charge line is VAT exempt (LD-327 b)').not.toBe('taxable');
  });
  it('a client cannot set coupon_amount_paisa (unknown key => 400); a coupon_code naming nothing stores nothing', { timeout: T }, async () => {
    const p = await prepare({ extra: { coupon_amount_paisa: 99999 } });
    expect((await registerFails(p.body, { w: p.w })).code).toBe('common.validation_failed');
    expect(await ordersOf(p.patient.id)).toHaveLength(0);
  });
  it('a coupon that became unusable between quote and save (inactive, expired, exhausted, other tenant) is refused at /coupon_code: no order, no invoice number, used_count untouched', { timeout: T }, async () => {
    for (const break_ of ['is_active = false', "valid_to = '2000-01-02'", 'used_count = usage_limit']) {
      const c = await mkCoupon({ usage_limit: 3 });
      const p = await prepare({ d: { coupon_code: c } });
      await setCoupon(c, break_);
      const e = await registerFails(p.body, { w: p.w });
      expect(e.code, break_).toBe('common.validation_failed'); expect(JSON.stringify(e.errors ?? []), break_).toContain('/coupon_code');
      expect(await ordersOf(p.patient.id)).toHaveLength(0);
      expect(p.w.billingFake.calls('issueOrderInvoice')).toHaveLength(0);
      expect((await couponRow(c)).used_count).toBe(break_ === 'used_count = usage_limit' ? 3 : 0);
    }
  });
  it('a failing save (event publish refuses) rolls the coupon use back with everything else', { timeout: T }, async () => {
    const c = await mkCoupon({ usage_limit: 5 });
    const p = await prepare({ d: { coupon_code: c }, payments: [pay(1000)] });
    await expect(register(p.body, { w: p.w, failEvent: 'frontdesk.order.created.v1' })).rejects.toBeTruthy();
    expect((await couponRow(c)).used_count).toBe(0);
    expect(await ordersOf(p.patient.id)).toHaveLength(0);
  });
  it('CONCURRENCY: usage_limit 2, six simultaneous saves => exactly 2 succeed, 4 are refused at /coupon_code, used_count = 2, never above the limit', { timeout: T * 2 }, async () => {
    const c = await mkCoupon({ usage_limit: 2 });
    const preps: Prepared[] = [];
    for (let i = 0; i < 6; i++) preps.push(await prepare({ d: { coupon_code: c }, payments: [pay(1000)] }));
    const outs = await Promise.allSettled(preps.map((p) => register(p.body, { w: p.w })));
    const won = outs.filter((o) => o.status === 'fulfilled' && (o.value as any).status === 201);
    const lost = outs.filter((o) => o.status === 'rejected') as PromiseRejectedResult[];
    expect(won, JSON.stringify(outs.map((o) => (o.status === 'fulfilled' ? o.value.status : (o.reason as any)?.code)))).toHaveLength(2);
    expect(lost).toHaveLength(4);
    for (const l of lost) { expect(l.reason.code).toBe('common.validation_failed'); expect(JSON.stringify(l.reason.errors ?? [])).toContain('/coupon_code'); }
    expect((await couponRow(c)).used_count).toBe(2);
    const stored = (await Promise.all(preps.map((p) => ordersOf(p.patient.id)))).flat().filter((o) => o.coupon_code === c);
    expect(stored).toHaveLength(2);
  });
});

describe('reward points: redeem, ledger entry per change, never below zero', () => {
  it('redeem 200 of 500: one ledger row kind redeemed (points 200, order_id = the new order), order shows reward_points_redeemed, balance 300', { timeout: T }, async () => {
    const p = await prepare({}); await givePoints(p.patient.id, 500);
    const x = await prepareFor(p.patient.id, { redeem_reward_points: 200 });
    const r = await register(x.body, { w: x.w });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.order.reward_points_redeemed).toBe(200);
    const rows = (await ledger(p.patient.id)).filter((x) => x.entry_kind === 'redeemed');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ order_id: r.body.order.id, points: 200, tenant_id: TENANT_A });
    const g = await rewards(p.patient.id);
    expect(g.error, `${(g.error as any)?.code}`).toBeUndefined();
    expect(schemaErrors('PatientRewards', g.reply!.body)).toEqual([]);
    expect(g.reply!.body.redeemed_points).toBeGreaterThanOrEqual(200);
    expect(g.reply!.body.balance_points).toBe(g.reply!.body.earned_points - g.reply!.body.redeemed_points);
    expect(g.reply!.body.balance_points).toBeGreaterThanOrEqual(0);
    expect(g.reply!.body.data.find((e: any) => e.order_id === r.body.order.id && e.entry_kind === 'redeemed')).toMatchObject({ points: 200 });
  });
  it('points that were spent between quote and save: 400 /redeem_reward_points, no order, no ledger row, no invoice number, balance untouched', { timeout: T }, async () => {
    const p = await prepare({}); await givePoints(p.patient.id, 100);
    const x = await prepareFor(p.patient.id, { redeem_reward_points: 100 });                       // quoted while the balance was 100
    const prior = await seedOrder('a', p.patient.id, { registered_at: '2026-10-02T04:00:00Z' });
    await seed('frontdesk.reward_points_ledger', { id: uid(), tenant_id: TENANT_A, patient_id: p.patient.id, order_id: prior.id, entry_kind: 'redeemed', points: 50 });   // balance is now 50
    const before = (await ledger(p.patient.id)).length;
    const e = await registerFails(x.body, { w: x.w });
    expect(e.code).toBe('common.validation_failed'); expect(JSON.stringify(e.errors ?? [])).toContain('/redeem_reward_points');
    expect((await ledger(p.patient.id)).length).toBe(before);
    expect(await ordersOf(p.patient.id)).toHaveLength(2);                                             // only the two seeded prior orders (givePoints + the one above), no new order (LD-326 item 5)
    expect(x.w.billingFake.calls('issueOrderInvoice')).toHaveLength(0);
    expect(await balanceOf(p.patient.id)).toBe(50);
  });
  it('redeem 0 writes no ledger row; the order does not claim a redemption', { timeout: T }, async () => {
    const p = await prepare({ d: { redeem_reward_points: 0 } });
    const r = await register(p.body, { w: p.w });
    expect(r.status).toBe(201);
    expect((await ledger(p.patient.id)).filter((x) => x.entry_kind === 'redeemed')).toHaveLength(0);
    expect(r.body.order.reward_points_redeemed ?? 0).toBe(0);
  });
  it('CONCURRENCY: balance 100, five simultaneous saves of 60 => exactly one succeeds, balance 40, never below zero', { timeout: T * 2 }, async () => {
    const p = await prepare({}); await givePoints(p.patient.id, 100);
    const preps: Prepared[] = [];
    for (let i = 0; i < 5; i++) preps.push(await prepareFor(p.patient.id, { redeem_reward_points: 60 }));
    const outs = await Promise.allSettled(preps.map((x) => register(x.body, { w: x.w })));
    const won = outs.filter((o) => o.status === 'fulfilled' && (o.value as any).status === 201);
    expect(won, JSON.stringify(outs.map((o) => (o.status === 'fulfilled' ? o.value.status : (o.reason as any)?.code)))).toHaveLength(1);
    expect(await balanceOf(p.patient.id)).toBe(40);
    expect((await ledger(p.patient.id)).filter((x) => x.entry_kind === 'redeemed')).toHaveLength(1);
  });
});

describe('getPatientRewards', () => {
  it('balance = earned - redeemed from the ledger, entries newest first, paged; a patient without points has 0 and []', { timeout: T }, async () => {
    const p = await prepare({}); await givePoints(p.patient.id, 30); await new Promise((r) => setTimeout(r, 15)); await givePoints(p.patient.id, 70);
    const g = await rewards(p.patient.id);
    expect(g.reply?.status, `${(g.error as any)?.code}`).toBe(200);
    expect(g.reply!.body).toMatchObject({ patient_id: p.patient.id, balance_points: 100, earned_points: 100, redeemed_points: 0 });
    expect(g.reply!.body.data.map((e: any) => e.points)).toEqual([70, 30]);
    const p1 = await rewards(p.patient.id, U1, { limit: '1' });
    expect(p1.reply!.body.data).toHaveLength(1);
    const p2 = await rewards(p.patient.id, U1, { limit: '1', cursor: p1.reply!.body.page.next_cursor });
    expect(p2.reply!.body.data.map((e: any) => e.points)).toEqual([30]);
    const empty = await rewards((await prepare({})).patient.id);
    expect(empty.reply!.body).toMatchObject({ balance_points: 0, earned_points: 0, redeemed_points: 0, data: [] });
  });
  it('unknown patient => 404; needs frontdesk.patient.read', { timeout: T }, async () => {
    expect((await rewards(uid())).error).toMatchObject({ code: 'common.not_found' });
    const p = await prepare({});
    const f = await rewards(p.patient.id, { ...fresh(), grants: fresh().grants.filter((g) => g !== 'frontdesk.patient.read') });
    expect((f.error as any)?.code).toBe('auth.forbidden');
  });
});

describe('cancelOrder reverses coupon, reward and claim effects (LD-310 (7))', () => {
  async function labFor(p: Prepared, orderId: string) {
    const items = await itemRows(orderId);
    return createFakeLabPort({ seed: 1, fixtures: { orders: [{ id: orderId, tenantId: TENANT_A, patientId: p.patient.id, centreId: CENTRE.a, priority: 'routine', patient: { sex: 'female', ageDays: 15000 } }],
      items: items.map((i) => ({ id: i.id, tenantId: TENANT_A, orderId, testId: i.test_ids[0], departmentId: uid(), workflowType: 'standard' })), specimens: [], results: [] } as any }) as any;
  }
  const ctxOf = async (p: Prepared, orderId: string) => ({ tenant: TENANT_A, centre: CENTRE.a, w: p.w as any, billing: p.w.billing, lab: await labFor(p, orderId) }) as any;

  it('coupon use, redeemed points and the insurance claim of a cancelled order are reversed once: used_count - 1, balance restored by ONE earned ledger row, claim 0', { timeout: T }, async () => {
    const c = await mkCoupon({ usage_limit: 5 });
    const seedP = await prepare({}); await givePoints(seedP.patient.id, 400);
    const p = await prepareFor(seedP.patient.id, { coupon_code: c, redeem_reward_points: 150 }, { insurance_claim_amount_paisa: 4000, insurance_code: 'INS-SYN-2' }, [pay(1000)]);
    const r = await register(p.body, { w: p.w });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const orderId = r.body.order.id as string;
    expect((await couponRow(c)).used_count).toBe(1);
    expect(await balanceOf(seedP.patient.id)).toBe(250);
    const e = await ctxOf(p, orderId);
    const done = await cancel(e, { reason_code: 'patient_left' }, {}, orderId);
    expect(done.body.status).toBe('cancelled');
    expect((await couponRow(c)).used_count, 'coupon use given back').toBe(0);
    expect(await balanceOf(seedP.patient.id), 'points given back').toBe(400);
    const back = (await ledger(seedP.patient.id)).filter((x) => x.order_id === orderId);
    expect(back.map((x) => [x.entry_kind, Number(x.points)]), 'one row per change: the redemption and its reversal').toEqual([['redeemed', 150], ['earned', 150]]);
    expect(Number((await orderRow(orderId)).insurance_claim_amount_paisa ?? 0), 'claim reversed').toBe(0);
    expect(await cancelFails(e, { reason_code: 'patient_left' }, {}, orderId)).toBeTruthy();
    expect((await couponRow(c)).used_count, 'a second cancel reverses nothing').toBe(0);
    expect(await balanceOf(seedP.patient.id)).toBe(400);
  });
  it('cancelling an order without coupon, points or claim touches no coupon and writes no ledger row', { timeout: T }, async () => {
    const c = await mkCoupon({ usage_limit: 5, used_count: 2 });
    const p = await prepare({});
    const r = await register(p.body, { w: p.w });
    const before = (await ledger(p.patient.id)).length;
    await cancel(await ctxOf(p, r.body.order.id), { reason_code: 'patient_left' }, {}, r.body.order.id);
    expect((await couponRow(c)).used_count).toBe(2);
    expect((await ledger(p.patient.id)).length).toBe(before);
  });
});

describe('sensitive values: clinical_history, patient_history, card_holder_name (07-SECURITY D-27a)', () => {
  it('never in ctx.log, the access log, audit.audit_log of the order, or an error message', { timeout: T }, async () => {
    const S = { clin: `SYN-CLIN-${uid()}`, pat: `SYN-PATH-${uid()}`, card: `SYN-CARD-${uid()}` };
    const p = await prepare({ payments: [pay(NET, { card_holder_name: S.card })], extra: { clinical_history: S.clin, patient_history: S.pat } });
    const r = await register(p.body, { w: p.w });
    expect(r.status).toBe(201);
    const noisy = JSON.stringify({ logs: r.probe.logs, access: r.probe.accessCalls });
    for (const v of Object.values(S)) expect(noisy, v).not.toContain(v);
    const audit = JSON.stringify(await ownerRows('audit.audit_log', "tenant_id = $1 AND schema_name = 'frontdesk' AND table_name = 'orders' AND row_id = $2", [TENANT_A, r.body.order.id]));
    for (const v of [S.clin, S.pat]) expect(audit, v).not.toContain(v);
    const bad = await prepare({ payments: [pay(NET, { card_holder_name: S.card })], extra: { clinical_history: S.clin, collection_at: 'not a date' } });
    const e = await registerFails(bad.body, { w: bad.w });
    expect(`${e.message} ${e.detail ?? ''} ${JSON.stringify(e.errors ?? [])}`).not.toMatch(new RegExp(`${S.clin}|${S.card}`));
  });
});

/** A registration body for an EXISTING patient (prepare() always seeds a new one): quote with the same world so the fingerprint matches. `d` = quote input fields, `extra` = register-only fields. */
async function prepareFor(patientId: string, d: Record<string, unknown> = {}, extra: Record<string, unknown> = {}, payments: unknown[] = [pay(NET)]): Promise<Prepared> {
  const w = rworld();
  const dd = draft({ patient: { patient_id: patientId }, centre_id: CENTRE.a, ...d });
  const q = await quote(dd, { w });
  return { patient: { id: patientId }, w, fp: q.body.quote_fingerprint, body: { ...dd, quote_fingerprint: q.body.quote_fingerprint, payments, ...extra } };
}
