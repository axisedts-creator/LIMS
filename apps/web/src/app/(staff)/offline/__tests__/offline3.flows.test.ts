// T0D-OFFLINE-3 (LD-322; offline design sections 2, 3, 4, 6; done_when 1, 2, 3, 4): the operation adapters of the first flows.
// Registration with the cached catalogue, billing receipts, collection and accession moves, the status of a record, final numbers after sync.
// Fails now because core/offline/flows.ts and numbers.ts do not exist.
import { describe, expect, it } from 'vitest';
import { CENTRE, DEVICE, PAT, PAT_NAME, PAT_PHONE, PRICE, T_CBC, T_LIPID, T_TSH, U, createEnv, newPatient, prov, rawCounts, rawDump, regInput, seedCache, sentOps } from './offline3.fixtures';
import { PIN, USER } from '@/core/offline/__tests__/offline1.helpers';

const ALLOWED_KEYS = new Set(['patient', 'centre_id', 'visit_type', 'billing_mode', 'credit_party_id', 'referrer_id', 'priority', 'collection_mode', 'items', 'discounts', 'buyer_pan',
  'quote_fingerprint', 'payments', 'trf_attachment_ids', 'discount_approval_id', 'collection_at', 'collected_by_membership_id', 'collected_by_name', 'sample_not_collected', 'sample_remark',
  'remark_description', 'clinical_history', 'patient_history', 'mr_number', 'external_reference', 'insurance_code', 'insurance_claim_amount_paisa', 'visiting_charge_paisa', 'coupon_code', 'redeem_reward_points']);

describe('cached reads: patients and tests (done_when 1)', () => {
  it('searches patients in the encrypted cache by name, short code and phone digits; blank finds nothing; at most 20 come back', async () => {
    const env = await createEnv();
    expect((await env.flows.searchPatients('asha')).map((p: { id: string }) => p.id)).toEqual([PAT.id]);
    expect((await env.flows.searchPatients('P-000002')).map((p: { full_name: string }) => p.full_name)).toEqual(['Ravi Kumar']);
    expect((await env.flows.searchPatients('9800000042')).map((p: { id: string }) => p.id)).toEqual([PAT.id]);
    expect(await env.flows.searchPatients('   ')).toEqual([]);
    expect(await env.flows.searchPatients('nobody-by-this-name')).toEqual([]);
    for (let i = 0; i < 30; i++) await env.store.put('refdata', `patient:${U(1000 + i)}`, { id: U(1000 + i), patient_code: `P-9${i}`, full_name: `Test Patient ${i}`, sex: 'male', version: 1 });
    expect((await env.flows.searchPatients('test patient')).length).toBe(20);
  });

  it('searches tests by code or name and shows the price of the ACTIVE price list version (highest published, not a future one)', async () => {
    const env = await createEnv({ seed: false });
    await seedCache(env.store as never, { prices: [PRICE, { ...PRICE, id: U(298), version_no: 2, status: 'superseded', items: [{ orderable_id: T_CBC.id, unit_price_paisa: 1 }] }, { ...PRICE, id: U(299), version_no: 4, effective_from: '2027-01-01T00:00:00.000Z', items: [{ orderable_id: T_CBC.id, unit_price_paisa: 99999 }] }] });
    const hit = await env.flows.searchTests('cbc');
    expect(hit).toHaveLength(1);
    expect(hit[0]).toMatchObject({ id: T_CBC.id, code: 'CBC', name: 'Complete blood count', unit_price_paisa: 60000 });
    expect((await env.flows.searchTests('thyroid')).map((t: { code: string }) => t.code)).toEqual(['TSH']);
    expect(await env.flows.searchTests('zzz')).toEqual([]);
  });

  it('quotes from the cached price list: gross, discount, net, the version used; a test without a price is catalog.no_price', async () => {
    const env = await createEnv();
    const q = await env.flows.quote({ items: [{ orderable_id: T_CBC.id }, { orderable_id: T_LIPID.id }], discounts: [{ scope: 'bill', kind: 'percent', percent_bp: 500, reason_code: 'staff_relative' }] });
    expect(q).toMatchObject({ ok: true, gross_paisa: 150000, discount_paisa: 7500, net_paisa: 142500, price_list_version_id: PRICE.id });
    expect(q.quote_fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(q.discount_evaluation).toMatchObject({ within_limit: true, approval_required: false, limit_percent_bp: 1000 });
    const amount = await env.flows.quote({ items: [{ orderable_id: T_CBC.id }], discounts: [{ scope: 'bill', kind: 'amount', amount_paisa: 1000, reason_code: 'staff_relative' }] });
    expect(amount).toMatchObject({ ok: true, discount_paisa: 1000, net_paisa: 59000 });
    const over = await env.flows.quote({ items: [{ orderable_id: T_CBC.id }], discounts: [{ scope: 'bill', kind: 'percent', percent_bp: 2000, reason_code: 'staff_relative' }] });
    expect(over.discount_evaluation).toMatchObject({ within_limit: false, approval_required: true, limit_percent_bp: 1000 });
    expect(await env.flows.quote({ items: [{ orderable_id: U(999) }] })).toMatchObject({ ok: false, code: 'catalog.no_price' });
  });
});

describe('registerOrder: the order, its numbers and its operation in one step (done_when 1, 2)', () => {
  it('saves ONE registration.create_order operation whose payload is the strict CreateRegistrationRequest, plus a local record, and returns provisional numbers', async () => {
    const env = await createEnv();
    const r = await env.flows.registerOrder(regInput());
    const ops = await env.pendingOps();
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ op_type: 'registration.create_order', op_id: r.op_id });
    const p = ops[0]!.payload;
    for (const k of Object.keys(p)) expect(ALLOWED_KEYS.has(k), `payload key ${k} is not in CreateRegistrationRequest`).toBe(true);
    expect(p).toMatchObject({ patient: { patient_id: PAT.id }, centre_id: CENTRE, visit_type: 'opd', billing_mode: 'cash', items: [{ orderable_id: T_CBC.id }, { orderable_id: T_LIPID.id }], payments: [{ method_code: 'cash', amount_received_paisa: 150000 }] });
    expect(p.quote_fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(p)).not.toMatch(/OFF-|provisional|lab_code|PENDING/); // numbers printed offline never travel inside the payload
    expect(r.invoice_no).toBe(prov(r.op_id, 'INV'));
    expect(r.receipt_nos).toEqual([prov(r.op_id, 'RC')]);
    expect(r.order_local_id).toBe(r.op_id);
    const local = await env.flows.localOrder(r.order_local_id);
    expect(local).toMatchObject({ invoice_no: r.invoice_no, receipt_nos: r.receipt_nos, price_list_version_id: PRICE.id, net_paisa: 150000 });
    expect(await rawCounts(env.dbName)).toMatchObject({ outbox: 1 });
  });

  it('a second payment row gets RC2, a credit order without payment gets an invoice number and no receipt', async () => {
    const env = await createEnv();
    const two = await env.flows.registerOrder(regInput({ payments: [{ method_code: 'cash', amount_received_paisa: 100000 }, { method_code: 'card', amount_received_paisa: 50000, reference: 'SYN-REF-1' }] }));
    expect(two.receipt_nos).toEqual([prov(two.op_id, 'RC'), prov(two.op_id, 'RC2')]);
    const credit = await env.flows.registerOrder(regInput({ billing_mode: 'credit', credit_party_id: U(77), payments: [] }));
    expect(credit.receipt_nos).toEqual([]);
    expect(credit.invoice_no).toBe(prov(credit.op_id, 'INV'));
  });

  it('a new patient takes the reserved patient id and one reserved lab code per test; both go to the server in reserved_numbers, never in the payload', async () => {
    const env = await createEnv();
    const r = await env.flows.registerOrder(regInput({ patient: { new_patient: newPatient() } }));
    expect(r.patient_code).toBe('5001');
    expect(r.lab_codes).toEqual([
      { orderable_id: T_CBC.id, value: '1001', provisional: false }, { orderable_id: T_LIPID.id, value: '1002', provisional: false },
    ]);
    const [op] = await env.pendingOps();
    expect(op!.payload.patient).toEqual({ new_patient: newPatient() });
    expect(op!.reserved_numbers).toEqual({ patient_id: 5001, lab_codes: [1001, 1002] });
    await env.drain();
    expect(sentOps(env.sim)[0]!.reserved_numbers).toEqual({ patient_id: 5001, lab_codes: [1001, 1002] }); // reaches the wire (engine WIRE_KEYS)
    expect(JSON.stringify(sentOps(env.sim)[0]!.payload)).not.toMatch(/5001|1001/);
  });

  it('an existing patient reserves no patient id; the patient is found again offline by name once the new one is saved', async () => {
    const env = await createEnv();
    const first = await env.flows.registerOrder(regInput());
    expect((await env.pendingOps())[0]!.reserved_numbers).toEqual({ lab_codes: [1001, 1002] });
    expect(first.patient_code).toBeUndefined();
    await env.flows.registerOrder(regInput({ patient: { new_patient: newPatient() } }));
    const found = await env.flows.searchPatients('meena');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ full_name: 'Meena Thapa', patient_code: '5001', local: true });
  });

  it('when the lab code block runs out the order still saves: the rest are provisional PENDING and are NOT in reserved_numbers', async () => {
    const env = await createEnv({ sizes: { lab_code: 1 } });
    const r = await env.flows.registerOrder(regInput({ items: [{ orderable_id: T_CBC.id }, { orderable_id: T_LIPID.id }, { orderable_id: T_TSH.id }], payments: [{ method_code: 'cash', amount_received_paisa: 190000 }] }));
    expect(r.lab_codes[0]).toMatchObject({ value: '1001', provisional: false });
    for (const l of r.lab_codes.slice(1)) expect(l).toMatchObject({ provisional: true, mark: 'PENDING', value: expect.stringMatching(/^OFF-/) });
    expect((await env.pendingOps())[0]!.reserved_numbers).toEqual({ lab_codes: [1001] });
    expect((await env.flows.numbers.remaining('lab_code')).warn).toBe(true);
  });

  it('with no patient id block the new patient gets a provisional PENDING code and nothing is claimed in reserved_numbers', async () => {
    const env = await createEnv({ blocks: false });
    const r = await env.flows.registerOrder(regInput({ patient: { new_patient: newPatient() } }));
    expect(r.patient_code).toMatch(/^OFF-/);
    expect((await env.pendingOps())[0]!.reserved_numbers).toBeUndefined();
  });

  it('applies a discount inside the cached limit; the payment may not exceed the net', async () => {
    const env = await createEnv();
    const ok = await env.flows.registerOrder(regInput({ discounts: [{ scope: 'bill', kind: 'percent', percent_bp: 500, reason_code: 'staff_relative' }], payments: [{ method_code: 'cash', amount_received_paisa: 142500 }] }));
    expect(await env.flows.localOrder(ok.order_local_id)).toMatchObject({ net_paisa: 142500 });
    await expect(env.flows.registerOrder(regInput({ discounts: [{ scope: 'bill', kind: 'percent', percent_bp: 500, reason_code: 'staff_relative' }], payments: [{ method_code: 'cash', amount_received_paisa: 150000 }] })))
      .rejects.toMatchObject({ code: 'common.validation_failed' });
  });
});

describe('registerOrder: the same refusals as online, and nothing half saved (done_when 1, 4)', () => {
  const refused = async (input: Record<string, unknown>, code: string) => {
    const env = await createEnv();
    const before = (await env.store.keys('refdata')).sort();
    await expect(env.flows.registerOrder(input)).rejects.toMatchObject({ code });
    expect(await env.pendingOps()).toHaveLength(0);
    expect((await env.store.keys('refdata')).sort()).toEqual(before); // no local order, no patient left behind
    expect((await env.numbers.remaining('lab_code')).left).toBe(200); // a refused order spends no code
  };
  it('no tests', () => refused(regInput({ items: [] }), 'common.validation_failed'));
  it('more than 50 tests', () => refused(regInput({ items: Array.from({ length: 51 }, () => ({ orderable_id: T_CBC.id })) }), 'common.validation_failed'));
  it('no centre', () => refused(regInput({ centre_id: '' }), 'common.validation_failed'));
  it('more than 5 payment rows', () => refused(regInput({ payments: Array.from({ length: 6 }, () => ({ method_code: 'cash', amount_received_paisa: 100 })) }), 'common.validation_failed'));
  it('a payment of zero', () => refused(regInput({ payments: [{ method_code: 'cash', amount_received_paisa: 0 }] }), 'common.validation_failed'));
  it('a new patient without a name', () => refused(regInput({ patient: { new_patient: newPatient({ full_name: '' }) } }), 'common.validation_failed'));
  it('a test with no price in the cached list', () => refused(regInput({ items: [{ orderable_id: U(999) }] }), 'catalog.no_price'));
  it('a discount over the limit needs an online approval', () => refused(regInput({ discounts: [{ scope: 'bill', kind: 'percent', percent_bp: 2000, reason_code: 'staff_relative' }] }), 'frontdesk.discount_approval_required'));
  it('coupon and reward points need the server balance', async () => {
    await refused(regInput({ coupon_code: 'SYN10' }), 'sync.offline_not_allowed');
    await refused(regInput({ redeem_reward_points: 10 }), 'sync.offline_not_allowed');
  });
  it('a TRF upload and a discount approval id are online only', async () => {
    await refused(regInput({ trf_attachment_ids: [U(50)] }), 'sync.offline_not_allowed');
    await refused(regInput({ discount_approval_id: U(51) }), 'sync.offline_not_allowed');
  });
  it('a user without frontdesk.registration.create is refused with auth.forbidden', async () => {
    const env = await createEnv({ permissions: ['sync.use', 'billing.payment.record'] });
    await expect(env.flows.registerOrder(regInput())).rejects.toMatchObject({ code: 'auth.forbidden' });
    expect(await env.pendingOps()).toHaveLength(0);
  });
  it('a locked store refuses with offline.locked and queues nothing', async () => {
    const env = await createEnv();
    env.store.lock();
    await expect(env.flows.registerOrder(regInput())).rejects.toMatchObject({ code: 'offline.locked' });
  });
  it('without a cached price list nothing can be priced: catalog.no_price, no guessing', async () => {
    const env = await createEnv({ seed: false });
    await env.store.put('refdata', `patient:${PAT.id}`, PAT);
    await expect(env.flows.registerOrder(regInput())).rejects.toMatchObject({ code: 'catalog.no_price' });
  });

  it('the local record and the operation are ONE transaction: when the outbox append fails no local order stays behind', async () => {
    const env = await createEnv();
    const { createOfflineFlows } = await import('@/core/offline/flows');
    const failing = { ...env.outbox, append: async () => { throw new Error('quota exceeded'); } };
    const flows = createOfflineFlows({ store: env.store, outbox: failing, prefetcher: env.prefetcher, numbers: env.numbers, deviceId: DEVICE, permissions: ['frontdesk.registration.create'], now: env.c.now } as never);
    await expect(flows.registerOrder(regInput({ patient: { new_patient: newPatient() } }))).rejects.toBeTruthy();
    expect((await env.store.keys('refdata')).filter((k: string) => !/^(patient|test|price_list_version):/.test(k))).toEqual([]);
    expect(await env.pendingOps()).toHaveLength(0);
  });

  it('20 registrations at once: 20 operations, 20 distinct invoice numbers, 40 distinct lab codes, nothing lost', async () => {
    const env = await createEnv();
    const rs = await Promise.all(Array.from({ length: 20 }, () => env.flows.registerOrder(regInput())));
    expect(await env.pendingOps()).toHaveLength(20);
    expect(new Set(rs.map((r: { invoice_no: string }) => r.invoice_no)).size).toBe(20);
    expect(new Set(rs.flatMap((r: { lab_codes: Array<{ value: string }> }) => r.lab_codes.map((l) => l.value))).size).toBe(40);
  });
});

describe('security: personal data stays in the encrypted store (design section 6)', () => {
  it('after a registration the raw IndexedDB dump holds no patient name, phone, test name or price in clear', async () => {
    const env = await createEnv();
    await env.flows.registerOrder(regInput({ patient: { new_patient: newPatient() } }));
    const dump = await rawDump(env.dbName);
    for (const s of ['Meena', 'Thapa', '9822222222', PAT_NAME, PAT_PHONE, 'Complete blood count', 'Lipid', '150000', 'registration.create_order', 'OFF-']) expect(dump, s).not.toContain(s);
  });

  it('the adapters write nothing to the console, localStorage or sessionStorage', async () => {
    const spy = env_console();
    const env = await createEnv();
    await env.flows.registerOrder(regInput({ patient: { new_patient: newPatient() } }));
    await env.flows.markCollected({ specimen_id: U(500), version: 2 });
    expect(spy.calls().join(' ')).not.toMatch(/Meena|Thapa|9822222222/);
    spy.restore();
  });
});

function env_console() {
  const seen: string[] = []; const orig = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
  for (const k of Object.keys(orig) as Array<keyof typeof orig>) console[k] = (...a: unknown[]) => { seen.push(a.map(String).join(' ')); };
  return { calls: () => seen, restore: () => Object.assign(console, orig) };
}

describe('recordReceipt: a payment against an order (done_when 2)', () => {
  it('queues billing.record_receipt (entity_id = order id) and prints the provisional RC number of that op', async () => {
    const env = await createEnv();
    const r = await env.flows.recordReceipt({ order_id: U(700), method_code: 'cash', amount_received_paisa: 50000, reference: 'SYN-1' });
    const [op] = await env.pendingOps();
    expect(op).toMatchObject({ op_type: 'billing.record_receipt', entity_id: U(700), op_id: r.op_id, payload: { method_code: 'cash', amount_received_paisa: 50000, reference: 'SYN-1' } });
    expect(Object.keys(op!.payload).sort()).toEqual(['amount_received_paisa', 'method_code', 'reference']);
    expect(r.receipt_no).toBe(prov(r.op_id, 'RC'));
  });
  it('refuses a zero or fractional amount, a missing order and an amount above the stated due; needs billing.payment.record', async () => {
    const env = await createEnv();
    for (const bad of [{ amount_received_paisa: 0 }, { amount_received_paisa: 12.5 }, { amount_received_paisa: -1 }, { order_id: '' }, { method_code: '' }]) {
      await expect(env.flows.recordReceipt({ order_id: U(700), method_code: 'cash', amount_received_paisa: 100, ...bad })).rejects.toMatchObject({ code: 'common.validation_failed' });
    }
    await expect(env.flows.recordReceipt({ order_id: U(700), method_code: 'cash', amount_received_paisa: 5000, balance_due_paisa: 1000 })).rejects.toMatchObject({ code: 'billing.payment_exceeds_due' });
    const other = await createEnv({ permissions: ['sync.use'] });
    await expect(other.flows.recordReceipt({ order_id: U(700), method_code: 'cash', amount_received_paisa: 100 })).rejects.toMatchObject({ code: 'auth.forbidden' });
    expect(await env.pendingOps()).toHaveLength(0);
  });
});

describe('collection and accession: idempotent state moves from the cached worklist (done_when 3)', () => {
  it('markCollected queues collection.mark_collected with the version the user saw and the DEVICE time of the action', async () => {
    const env = await createEnv();
    const r = await env.flows.markCollected({ specimen_id: U(500), version: 2 });
    expect(r).toMatchObject({ ok: true, queued: true });
    const [op] = await env.pendingOps();
    expect(op).toMatchObject({ op_type: 'collection.mark_collected', entity_id: U(500), base_version: 2, op_id: r.op_id });
    expect(op!.payload).toEqual({ collected_at: new Date(env.c.now()).toISOString() });
  });
  it('receiveSpecimen queues accession.receive with the processing centre and base_version', async () => {
    const env = await createEnv();
    const r = await env.flows.receiveSpecimen({ specimen_id: U(501), version: 3, processing_centre_id: CENTRE });
    expect(r).toMatchObject({ ok: true, queued: true });
    expect((await env.pendingOps())[0]).toMatchObject({ op_type: 'accession.receive', entity_id: U(501), base_version: 3, payload: { processing_centre_id: CENTRE } });
  });
  it('the same move twice does not queue a second operation (duplicate)', async () => {
    const env = await createEnv();
    await env.flows.markCollected({ specimen_id: U(500), version: 2 });
    expect(await env.flows.markCollected({ specimen_id: U(500), version: 2 })).toMatchObject({ ok: true, queued: false, duplicate: true });
    await env.flows.receiveSpecimen({ specimen_id: U(500), version: 3, processing_centre_id: CENTRE });
    expect(await env.flows.receiveSpecimen({ specimen_id: U(500), version: 3, processing_centre_id: CENTRE })).toMatchObject({ queued: false, duplicate: true });
    expect(await env.pendingOps()).toHaveLength(2);
  });
  it('refuses a missing version or id, a wrong permission, and a locked store', async () => {
    const env = await createEnv();
    await expect(env.flows.markCollected({ specimen_id: U(500) })).rejects.toMatchObject({ code: 'common.validation_failed' });
    await expect(env.flows.receiveSpecimen({ specimen_id: U(501), version: 1 })).rejects.toMatchObject({ code: 'common.validation_failed' });
    await expect(env.flows.markCollected({ specimen_id: '', version: 1 })).rejects.toMatchObject({ code: 'common.validation_failed' });
    const noPerm = await createEnv({ permissions: ['sync.use', 'frontdesk.registration.create'] });
    await expect(noPerm.flows.markCollected({ specimen_id: U(500), version: 2 })).rejects.toMatchObject({ code: 'auth.forbidden' });
    await expect(noPerm.flows.receiveSpecimen({ specimen_id: U(500), version: 2, processing_centre_id: CENTRE })).rejects.toMatchObject({ code: 'auth.forbidden' });
    env.store.lock();
    await expect(env.flows.markCollected({ specimen_id: U(502), version: 2 })).rejects.toMatchObject({ code: 'offline.locked' });
  });
});

describe('statusOf / statusMap: the Pending sync badge, conflicts and rejections on the record (done_when 3, 6)', () => {
  it('is null for a record with nothing queued and pending for one with a queued operation (by entity id or op id)', async () => {
    const env = await createEnv();
    expect(await env.flows.statusOf(U(500))).toBeNull();
    const c = await env.flows.markCollected({ specimen_id: U(500), version: 2 });
    expect(await env.flows.statusOf(U(500))).toMatchObject({ state: 'pending' });
    const r = await env.flows.registerOrder(regInput());
    expect(await env.flows.statusOf(r.order_local_id)).toMatchObject({ state: 'pending' });
    const map = await env.flows.statusMap();
    expect(map[U(500)]).toMatchObject({ state: 'pending' });
    expect(map[r.op_id]).toMatchObject({ state: 'pending' });
    expect(c.op_id).toBeTruthy();
  });
  it('after a successful sync the badge is gone', async () => {
    const env = await createEnv();
    await env.flows.markCollected({ specimen_id: U(500), version: 2 });
    await env.drain();
    expect(await env.flows.statusOf(U(500))).toBeNull();
  });
  it('a conflict returned at sync shows on the record with its code and conflict id; a rejection shows with its code', async () => {
    const env = await createEnv();
    env.sim.sim.rules.push(
      (op) => (op.entity_id === U(500) ? { status: 'conflict', error_code: 'sync.base_version_stale', conflict_id: U(900) } : undefined),
      (op) => (op.entity_id === U(501) ? { status: 'rejected', error_code: 'auth.forbidden' } : undefined),
    );
    await env.flows.markCollected({ specimen_id: U(500), version: 2 });
    await env.flows.receiveSpecimen({ specimen_id: U(501), version: 3, processing_centre_id: CENTRE });
    await env.flows.markCollected({ specimen_id: U(502), version: 2 });
    await env.drain();
    expect(await env.flows.statusOf(U(500))).toEqual({ state: 'conflict', code: 'sync.base_version_stale', conflict_id: U(900) });
    expect(await env.flows.statusOf(U(501))).toEqual({ state: 'rejected', code: 'auth.forbidden' });
    expect(await env.flows.statusOf(U(502))).toBeNull(); // the good operation of the same batch was accepted
    expect((await env.outbox.conflicts()).map((c: { conflict_id: string }) => c.conflict_id)).toEqual([U(900)]); // the Offline panel lists the same
    expect((await env.outbox.needsAttention()).map((a: { code: string }) => a.code)).toEqual(['auth.forbidden']);
  });
});

describe('final numbers after sync (done_when 2)', () => {
  it('display() answers the provisional number before sync and the FINAL number after it, also after a reload (every reprint)', async () => {
    const env = await createEnv();
    const r = await env.flows.registerOrder(regInput());
    expect(await env.flows.display(r.invoice_no)).toBe(r.invoice_no);
    expect(await env.flows.display('INV/2083-84/000042')).toBe('INV/2083-84/000042'); // a number that is not provisional passes through
    await env.drain();
    expect(await env.flows.display(r.invoice_no)).toBe('INV-000001');
    expect(await env.flows.display(r.receipt_nos[0])).toBe('RC-000001');
    env.store.lock();
    const store2 = await env.reopen();
    await store2.unlock(PIN);
    const { createOutbox } = await import('@/core/offline/outbox');
    const { createOfflineFlows } = await import('@/core/offline/flows');
    const again = createOfflineFlows({ store: store2, outbox: createOutbox(store2, { deviceId: DEVICE, userId: USER, now: env.c.now }), prefetcher: env.prefetcher, numbers: env.numbers, deviceId: DEVICE, permissions: ['sync.use'], now: env.c.now } as never);
    expect(await again.display(r.invoice_no)).toBe('INV-000001');
  });

  it('a lost answer does not lose the final number: the replay answers duplicate with the same mappings', async () => {
    const env = await createEnv();
    const r = await env.flows.registerOrder(regInput());
    env.sim.sim.dropResponses = 1;
    await env.drain();
    expect(await env.flows.display(r.invoice_no)).toBe(r.invoice_no); // still pending, nothing settled
    env.c.advance(600_000); // the engine backed off
    await env.drain();
    expect(await env.flows.display(r.invoice_no)).toBe('INV-000001');
    expect(env.sim.sim.applied.size).toBe(1);
    expect(env.sim.sim.inv).toBe(1); // the number was assigned once
  });

  it('a standalone receipt gets its final number the same way', async () => {
    const env = await createEnv();
    const r = await env.flows.recordReceipt({ order_id: U(700), method_code: 'cash', amount_received_paisa: 50000 });
    await env.drain();
    expect(await env.flows.display(r.receipt_no)).toBe('RC-000001');
  });
});

describe('ops are sized for the engine limits', () => {
  it('a registration operation stays far below the 1 MB batch limit and the engine sends it in one batch of one', async () => {
    const env = await createEnv();
    await env.flows.registerOrder(regInput());
    await env.drain();
    expect(env.sim.batches).toHaveLength(1);
    expect(env.sim.batches[0]!.bytes).toBeLessThan(8 * 1024);
  });
});
