// T0B-REGAPI-2 done_when (5), LD-323 (b)(c)(e), LD-326 (TESTS_WRONG 1,2,7), LD-331: previewRegistrationNumbers returns the next lab (registration) number and the next BILL number of a
// centre WITHOUT consuming a sequence value; the real numbers are still assigned inside the save transaction.
// Counter truth: frontdesk.number_counters (counter_kind 'registration_no', scope_key = branch id) for the lab number (read, never the nextCounterValue upsert);
// the bill number comes ONLY from BillingCommandPortV1.previewInvoiceNo (the INV series, tenant invoiceNoPattern '{fy}-{seq:6}'), never an RC number, never a frontdesk read of billing.*.
// PINNED PICKS: next_registration_no = tenant pattern rendered with (live counter last_value + 1) (the counter is READ, never rewound: other files own the same branch);
// next_receipt_no = the invoiceNo of the port (equal to the previewInvoiceNo of the same fake), or the EMPTY STRING when the port call fails or the method is absent (LD-323 (c), LD-331);
// next_receipt_no_label is always present and says "assigned when saved"; is_preview true; two previews with no save in between are equal; a preview performs no INSERT / UPDATE / DELETE.
// The real BillingCommandPortV1.previewInvoiceNo (50 previews consume nothing, concurrency, tenant isolation, fake == real) is tested in billing/__tests__/preview.
import { describe, expect, it } from 'vitest';
import { createFakeBillingCommandPort } from '../../../../../../../packages/fakes/src/BillingCommandPort.fake';
import { LimsError } from '../../../../core/errors.js';
import { BRANCH_A2, BRANCH_CODE, CENTRE_A2 as REG_A2, REG_PATTERN, counterValue, prepare, regNo, register } from '../registration/helpers.js';
import { TENANT_SETTINGS } from '../patients/helpers.js';
import { CENTRE, T, TENANT_A, TENANT_B, as, fire, forbidden, fresh, notFound, ok, rejected, req, schemaErrors, superTx, uid, without, writesOf } from './helpers.js';

const SETTINGS = { numbering: { ...TENANT_SETTINGS.numbering, registrationNoPattern: REG_PATTERN } };
const AT = new Date('2026-11-17T06:00:00.000Z');
const INV_SHAPE = /^\d{4}\/\d{2}-\d{6}$/;
const LABEL = /assigned when saved/i;
const newFake = () => createFakeBillingCommandPort({ seed: 1 } as never) as any;
const preview = (who = fresh(), centre: string = REG_A2, o: object = {}) => fire('previewRegistrationNumbers', req({ query: { centre_id: centre } }), who, { settings: SETTINGS, now: AT, billing: newFake(), ...o });
const counterRow = async () => superTx(async (tx) => (await tx.query(`SELECT last_value, version, updated_at FROM frontdesk.number_counters WHERE tenant_id = $1 AND counter_kind = 'registration_no' AND scope_key = $2`, [TENANT_A, BRANCH_A2])).rows[0] as { last_value: string | number; version: number; updated_at: Date } | undefined);
/** the live counter, as a number (bigint columns arrive as strings): TESTS_WRONG 1 */
const live = async () => Number((await counterRow())?.last_value ?? 0);
const seqOf = (no: string) => Number(no.slice(-6));
const brokenBilling = (err: unknown) => ({ ...newFake(), previewInvoiceNo: async () => { throw err; } });

describe('previewRegistrationNumbers', () => {
  it('returns next lab number = live counter + 1 rendered with the tenant pattern, the INV preview of the billing port as the bill number, the label, is_preview true (schema valid)', { timeout: T }, async () => {
    const lo = await live();
    const o = await preview();
    const b = ok(o);
    const hi = await live();
    expect(schemaErrors('RegistrationNumberPreview', b)).toEqual([]);
    expect(b).toMatchObject({ centre_id: REG_A2, is_preview: true });
    expect(b.next_registration_no).toMatch(new RegExp(`^${BRANCH_CODE}R\\d{6}$`));
    expect(seqOf(b.next_registration_no)).toBeGreaterThanOrEqual(lo + 1);
    expect(seqOf(b.next_registration_no)).toBeLessThanOrEqual(hi + 1);
    expect(b.next_registration_no).toBe(regNo(seqOf(b.next_registration_no)));
    expect(b.next_receipt_no).toMatch(INV_SHAPE);
    expect(b.next_receipt_no, 'the bill number is the invoice number (issueReceiptNo is false), never an RC number').not.toMatch(/^RC-/);
    expect(b.next_receipt_no_label).toMatch(LABEL);
  });

  it('the bill number is exactly what BillingCommandPortV1.previewInvoiceNo of the same port gives (no number is computed in frontdesk)', { timeout: T }, async () => {
    const fake = newFake();
    const want = await fake.previewInvoiceNo({ tenantId: TENANT_A, now: () => AT, actor: { type: 'system', id: uid() } }, {});
    const b = ok(await preview(fresh(), REG_A2, { billing: fake }));
    expect(b.next_receipt_no).toBe(want.invoiceNo);
    expect(fake.calls('previewInvoiceNo').length).toBeGreaterThanOrEqual(1);
  });

  it('does not consume: counter row (value, version, updated_at) is unchanged after 50 previews, every answer is the same, no write statement is issued and the billing port allocates nothing', { timeout: T }, async () => {
    const fake = newFake();
    const c0 = await counterRow();
    const outs = [];
    for (let i = 0; i < 50; i++) outs.push(await preview(fresh(), REG_A2, { billing: fake }));
    for (const o of outs) { ok(o); expect(writesOf(o), 'a preview must not write').toEqual([]); }
    expect(new Set(outs.map((o) => JSON.stringify(o.reply!.body))).size).toBe(1);
    expect(await counterRow()).toEqual(c0);
    for (const m of ['issueOrderInvoice', 'recordPayment', 'recordCreditCharges']) expect(fake.calls(m), `${m} must not be called by a preview`).toHaveLength(0);
    const after = await fake.previewInvoiceNo({ tenantId: TENANT_A, now: () => AT, actor: { type: 'system', id: uid() } }, {});
    expect(after.invoiceNo, 'the fake counter was not consumed by 50 previews').toBe(ok(outs[0]!).next_receipt_no);
  });

  it('is a read of the counter, not a reservation: two users previewing get the same numbers; 10 parallel previews do not move the counter', { timeout: T }, async () => {
    const c0 = await counterRow();
    const [a, b] = [ok(await preview(fresh())), ok(await preview(fresh()))];
    expect(a).toEqual(b);
    const outs = await Promise.all(Array.from({ length: 10 }, () => preview()));
    for (const o of outs) expect(ok(o).next_registration_no).toBe(a.next_registration_no);
    expect(await counterRow()).toEqual(c0);
  });

  it('the real save assigns exactly the previewed lab number inside its own transaction; the next preview moves on by one', { timeout: T }, async () => {
    const before = ok(await preview());
    const p = await prepare({ centreId: REG_A2 });
    const saved = await register(p.body, { w: p.w, centreId: REG_A2, centreIds: [REG_A2] });
    expect(saved.status).toBe(201);
    expect(saved.body.order.registration_no).toBe(before.next_registration_no);
    expect(await counterValue(TENANT_A, 'registration_no', BRANCH_A2)).toBe(seqOf(before.next_registration_no));
    expect(ok(await preview()).next_registration_no).toBe(regNo(seqOf(before.next_registration_no) + 1));
  });

  it('LD-323 (c): when the billing port call fails the bill number is the EMPTY STRING with the label (never null, never a seq 1 guess, never RC); the lab number is still returned and the answer is schema valid', { timeout: T }, async () => {
    for (const err of [new LimsError('billing.fiscal_year_closed'), new LimsError('billing.numbering_pattern_invalid'), new Error('boom')]) {
      const b = ok(await preview(fresh(), REG_A2, { billing: brokenBilling(err) }));
      expect(schemaErrors('RegistrationNumberPreview', b)).toEqual([]);
      expect(b.next_receipt_no).toBe('');
      expect(b.next_receipt_no_label).toMatch(LABEL);
      expect(b.next_registration_no).toMatch(new RegExp(`^${BRANCH_CODE}R\\d{6}$`));
      expect(b.is_preview).toBe(true);
    }
  });

  it('LD-323 (c): a billing port WITHOUT previewInvoiceNo (the removed interim) gives the empty string, not a rendered seq 1', { timeout: T }, async () => {
    const legacy = { ...newFake() }; delete legacy.previewInvoiceNo;
    const b = ok(await preview(fresh(), REG_A2, { billing: legacy }));
    expect(b.next_receipt_no).toBe('');
    expect(b.next_receipt_no_label).toMatch(LABEL);
  });

  it('a centre of another tenant, an unknown centre => 404 common.not_found; missing / malformed centre_id => 400; nothing consumed', { timeout: T }, async () => {
    const c0 = await counterRow();
    notFound(await preview(fresh(), CENTRE.b));
    notFound(await preview(fresh(), uid()));
    rejected(await fire('previewRegistrationNumbers', req({ query: {} }), fresh(), { settings: SETTINGS, now: AT, billing: newFake() }), 'common.validation_failed');
    rejected(await preview(fresh(), 'nope'), 'common.validation_failed');
    expect(await counterRow()).toEqual(c0);
  });

  it('tenant B previews its own centre; its numbers never come from tenant A\'s counter and the bill number is asked of the port as tenant B', { timeout: T }, async () => {
    const fake = newFake();
    const ub = as(fresh(), { tenant: TENANT_B, centreIds: [CENTRE.b], allCentres: true });
    const b = ok(await fire('previewRegistrationNumbers', req({ query: { centre_id: CENTRE.b } }), ub, { settings: SETTINGS, now: AT, billing: fake }));
    expect(b.centre_id).toBe(CENTRE.b);
    expect(b.next_registration_no).not.toMatch(new RegExp(`^${BRANCH_CODE}R`));
    const asked = fake.calls('previewInvoiceNo').map((c: any) => c.ctx?.tenantId ?? c.tenantId).filter(Boolean);
    for (const t of asked) expect(t).toBe(TENANT_B);
  });

  it('requires frontdesk.registration.create; a user whose centre scope excludes the centre is refused', { timeout: T }, async () => {
    forbidden(await preview(without(fresh(), 'frontdesk.registration.create')));
    const scoped = as(fresh(), { allCentres: false, centreIds: [CENTRE.a] });
    const o = await preview(scoped, REG_A2);
    expect(['common.not_found', 'auth.forbidden']).toContain((o.error as any)?.code);
  });
});
