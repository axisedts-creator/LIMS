// T0B-REGAPI-2 done_when (5): previewRegistrationNumbers returns the next lab (registration) number and the next bill receipt number of a centre WITHOUT consuming a
// sequence value (a read of the counter, never nextval / the upsert of nextCounterValue); the real numbers are still assigned inside the save transaction.
// Counter truth: frontdesk.number_counters (counter_kind 'registration_no', scope_key = branch id) for the lab number, billing.ledger_entries.receipt_seq (max per tenant) for the receipt.
// PINNED PICKS: next_registration_no = the pattern rendered with last_value + 1 (tenant pattern '{branch}R{seq:6}' as in the registration tests: A-B2R000042);
// next_receipt_no matches the contract example shape RC-<BS fiscal year like 2083/84>-<6 digits>; is_preview is true; two previews with no save in between are equal;
// a preview performs no INSERT / UPDATE / DELETE at all; the number a later save really assigns equals the preview when nobody saved in between.
import { beforeAll, describe, expect, it } from 'vitest';
import { BRANCH_A2, BRANCH_CODE, CENTRE_A2 as REG_A2, REG_PATTERN, counterValue, prepare, regNo, register } from '../registration/helpers.js';
import { TENANT_SETTINGS } from '../patients/helpers.js';
import { CENTRE, T, TENANT_A, TENANT_B, as, fire, forbidden, fresh, mid, notFound, ok, rejected, req, schemaErrors, superTx, uid, without, writesOf } from './helpers.js';

const SETTINGS = { numbering: { ...TENANT_SETTINGS.numbering, registrationNoPattern: REG_PATTERN } };
const preview = (who = fresh(), centre: string = REG_A2, o: object = {}) => fire('previewRegistrationNumbers', req({ query: { centre_id: centre } }), who, { settings: SETTINGS, ...o });
const setCounter = async (value: number) => superTx(async (tx) => {
  await tx.query(`INSERT INTO frontdesk.number_counters (tenant_id, counter_kind, scope_key, last_value, created_by, updated_by) VALUES ($1, 'registration_no', $2, $3, $4, $4)
    ON CONFLICT (tenant_id, counter_kind, scope_key) DO UPDATE SET last_value = $3`, [TENANT_A, BRANCH_A2, value, mid('a', 500)]);
});
const maxReceipt = async () => superTx(async (tx) => Number((await tx.query(`SELECT coalesce(max(receipt_seq), 0) AS m FROM billing.ledger_entries WHERE tenant_id = $1`, [TENANT_A])).rows[0].m));
const counterRow = async () => superTx(async (tx) => (await tx.query(`SELECT last_value, version, updated_at FROM frontdesk.number_counters WHERE tenant_id = $1 AND counter_kind = 'registration_no' AND scope_key = $2`, [TENANT_A, BRANCH_A2])).rows[0]);
beforeAll(async () => { await setCounter(41); }, T);

describe('previewRegistrationNumbers', () => {
  it('returns next lab number = counter + 1 rendered with the tenant pattern, a receipt number of the contract shape, is_preview true (schema valid)', { timeout: T }, async () => {
    await setCounter(41);
    const b = ok(await preview());
    expect(schemaErrors('RegistrationNumberPreview', b)).toEqual([]);
    expect(b).toMatchObject({ centre_id: REG_A2, next_registration_no: regNo(42, BRANCH_CODE), is_preview: true });
    expect(b.next_receipt_no).toMatch(/^RC-\d{4}\/\d{2}-\d{6}$/);
  });
  it('does not consume: counter row (value, version, updated_at) and the receipt sequence are unchanged after 5 previews, every preview answers the same, and no write statement is issued', { timeout: T }, async () => {
    await setCounter(41);
    const c0 = await counterRow(); const r0 = await maxReceipt();
    const outs = [];
    for (let i = 0; i < 5; i++) outs.push(await preview());
    for (const o of outs) { ok(o); expect(writesOf(o), 'a preview must not write').toEqual([]); }
    expect(new Set(outs.map((o) => JSON.stringify(o.reply!.body))).size).toBe(1);
    expect(await counterRow()).toEqual(c0);
    expect(await counterRow()).toMatchObject({ last_value: 41 });
    expect(await maxReceipt()).toBe(r0);
  });
  it('is a read of the counter, not a reservation: two users previewing get the same numbers; 10 parallel previews do not move the counter', { timeout: T }, async () => {
    await setCounter(41);
    const [a, b] = [ok(await preview(fresh())), ok(await preview(fresh()))];
    expect(a).toEqual(b);
    const outs = await Promise.all(Array.from({ length: 10 }, () => preview()));
    for (const o of outs) expect(ok(o).next_registration_no).toBe(regNo(42));
    expect(await counterRow()).toMatchObject({ last_value: 41 });
  });
  it('the real save assigns exactly the previewed lab number inside its own transaction; the next preview moves on by one', { timeout: T }, async () => {
    await setCounter(41);
    const before = ok(await preview());
    const p = await prepare({ centreId: REG_A2 });
    const saved = await register(p.body, { w: p.w, centreId: REG_A2, centreIds: [REG_A2] });
    expect(saved.status).toBe(201);
    expect(saved.body.order.registration_no).toBe(before.next_registration_no);
    expect(await counterValue(TENANT_A, 'registration_no', BRANCH_A2)).toBe(42);
    expect(ok(await preview()).next_registration_no).toBe(regNo(43));
  });
  it('a centre of another tenant, an unknown centre => 404 common.not_found; missing / malformed centre_id => 400; nothing consumed', { timeout: T }, async () => {
    await setCounter(41);
    notFound(await preview(fresh(), CENTRE.b));
    notFound(await preview(fresh(), uid()));
    rejected(await fire('previewRegistrationNumbers', req({ query: {} }), fresh(), { settings: SETTINGS }), 'common.validation_failed');
    rejected(await preview(fresh(), 'nope'), 'common.validation_failed');
    expect(await counterRow()).toMatchObject({ last_value: 41 });
  });
  it('tenant B previews its own centre; its numbers never come from tenant A\'s counter', { timeout: T }, async () => {
    await setCounter(41);
    const ub = as(fresh(), { tenant: TENANT_B, centreIds: [CENTRE.b], allCentres: true });
    const b = ok(await fire('previewRegistrationNumbers', req({ query: { centre_id: CENTRE.b } }), ub, { settings: SETTINGS }));
    expect(b.centre_id).toBe(CENTRE.b);
    expect(b.next_registration_no).not.toBe(regNo(42));
  });
  it('requires frontdesk.registration.create; a user whose centre scope excludes the centre is refused', { timeout: T }, async () => {
    forbidden(await preview(without(fresh(), 'frontdesk.registration.create')));
    const scoped = as(fresh(), { allCentres: false, centreIds: [CENTRE.a] });
    const o = await preview(scoped, REG_A2);
    expect(['common.not_found', 'auth.forbidden']).toContain((o.error as any)?.code);
  });
});
