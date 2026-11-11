// FD-T16 / 07-SECURITY §5 + §6.5 "PHI log-scan test with planted synthetic PHI through every C4 handler that takes PHI" (05-DoD §1.8).
// Planted: patient name, phone, email, address, TRF file name, discount reason text, cancel reason text, decision notes. Scanned surfaces per scenario: every ctx.log line, process stdout/stderr
// + console, the thrown error (code/message/detail/errors — NOT the structured `candidates` extension, which is allowed for authorised callers), audit.access_log rows written for the request
// (detail is whitelisted keys only, 07 §5.1/§5.5) and core.event_log payloads of the order (03-IC: no names/phones/registration no).
// 07 §5.2: error `detail` never echoes field values. Allowed ids in logs: patient_id, order_id, invoice_id, ledger_entry_id, invoice_no, credit_note_no.
// NOT covered here: browser storage / print iframe rules (§5.4, UI task), metrics labels (no metric is emitted by the handlers under test), billing.activity_log whitelist (billing, BL-T22).
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { anonymisable, anonymise } from '../admin/helpers.js';
import { edit } from '../orderchange/helpers.js';
import { consents, newPatient, seedPatient } from '../patients/helpers.js';
import { prepare } from '../registration/helpers.js';
import { makeWorld, pdfBytes } from '../trf/helpers.js';
import { FULL_A, T, TENANT_A, as, codeOf, fire, mid, objs, ownerRows, requestFor, req, uid, type Objs, type Outcome } from './kit.js';

const SENT = { name: 'Zphisent Nameone', email: 'phisent.email@example.invalid', address: 'PHISENT Address Lane 9', file: 'PHISENT-trf-scan.pdf', discount: 'PHISENT discount reason text',
  cancel: 'PHISENT cancel reason text', note: 'PHISENT decision note', query: 'Zphisent' };
const phoneSent = `+97798${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
const NEEDLES = [SENT.name, SENT.email, SENT.address, SENT.file, SENT.discount, SENT.cancel, SENT.note, phoneSent, phoneSent.replace('+977', ''), 'PHISENT', 'phisent.email', 'Zphisent'];

// ---- stdout / stderr / console capture ----
const sink: string[] = [];
const orig = { out: process.stdout.write.bind(process.stdout), err: process.stderr.write.bind(process.stderr), log: console.log, warn: console.warn, error: console.error, info: console.info, debug: console.debug };
const push = (...a: unknown[]) => { sink.push(a.map((x) => (typeof x === 'string' ? x : (() => { try { return JSON.stringify(x); } catch { return String(x); } })())).join(' ')); };
beforeAll(() => {
  process.stdout.write = ((c: any, ...r: any[]) => { push(String(c)); return orig.out(c, ...r); }) as never;
  process.stderr.write = ((c: any, ...r: any[]) => { push(String(c)); return orig.err(c, ...r); }) as never;
  console.log = console.warn = console.error = console.info = console.debug = ((...a: unknown[]) => { push(...a); }) as never;
});
afterEach(() => { sink.length = 0; });
afterAll(() => { process.stdout.write = orig.out as never; process.stderr.write = orig.err as never; Object.assign(console, { log: orig.log, warn: orig.warn, error: orig.error, info: orig.info, debug: orig.debug }); });

const errorText = (e: any): string => (e ? JSON.stringify({ code: e.code, message: e.message, detail: e.detail, errors: e.errors, title: e.title, name: e.name, stack: undefined }) : '');
async function surfaces(o: Outcome, extra: { orderIds?: string[] } = {}): Promise<string[]> {
  const access = await ownerRows('audit.access_log', 'request_id = $1', [o.probe.requestId]);
  const events = (await Promise.all((extra.orderIds ?? []).map((id) => ownerRows('core.event_log', 'aggregate_id = $1', [id])))).flat();
  return [...o.probe.logs, ...sink, errorText(o.error), ...access.map((r) => JSON.stringify(r)), ...events.map((r) => JSON.stringify(r))];
}
function expectClean(lines: string[], label: string) {
  const hit = lines.flatMap((l) => NEEDLES.filter((n) => l.includes(n)).map((n) => `${n} in: ${l.slice(0, 160)}`));
  expect(hit, label).toEqual([]);
}
const run = async (label: string, o: Outcome, extra?: { orderIds?: string[] }) => { expectClean(await surfaces(o, extra), label); return o; };

let S: Objs;
beforeAll(async () => { S = await objs('a'); }, T);

describe('planted PHI never reaches a log line, an error response detail, an access_log row or an event payload', () => {
  it('F2 createPatient (success, then duplicate_suspected)', { timeout: T }, async () => {
    const body = newPatient({ full_name: SENT.name, phone_e164: phoneSent, email: SENT.email, address_text: SENT.address, birth_on: '1984-03-21', age: undefined });
    const ok = await run('createPatient', await fire('createPatient', req({ headers: { 'idempotency-key': uid() }, body }), FULL_A));
    expect(ok.reply?.status, `${ok.error?.message}`).toBe(201);
    const dup = await run('createPatient duplicate', await fire('createPatient', req({ headers: { 'idempotency-key': uid() }, body }), FULL_A));
    expect(codeOf(dup), 'same person again').toBe('frontdesk.patient_duplicate_suspected');
    expect(errorText(dup.error)).not.toContain(SENT.name);                                                   // detail never echoes the value (07 §5.2)
  });
  it('F1 searchPatients by name (access_log detail has no query text), F3 getPatient, F4 updatePatient, F5 recordPatientConsent', { timeout: T }, async () => {
    const p = await seedPatient('a', { full_name: SENT.name, phone_e164: phoneSent, email: SENT.email, address_text: SENT.address });
    await run('searchPatients', await fire('searchPatients', req({ body: { query: SENT.query, mode: 'name', limit: 20 } }), FULL_A));
    await run('searchPatients by phone', await fire('searchPatients', req({ body: { query: phoneSent, mode: 'phone', limit: 20 } }), FULL_A));
    await run('getPatient', await fire('getPatient', req({ params: { patient_id: p.id } }), FULL_A));
    const upd = await run('updatePatient', await fire('updatePatient', req({ params: { patient_id: p.id }, headers: { 'if-match': '"1"' }, body: { address_text: `${SENT.address} Annex`, email: SENT.email } }), FULL_A));
    expect(upd.reply?.status, `${upd.error?.message}`).toBe(200);
    const acc = await ownerRows('audit.access_log', `request_id = $1 AND action = 'patient.update'`, [upd.probe.requestId]);
    expect(acc.length).toBe(1);
    expect(acc[0].detail).toHaveProperty('changed_fields');                                                   // column NAMES only (08 A13 D-27a); the value scan above proved no value is in it
    await run('recordPatientConsent', await fire('recordPatientConsent', req({ params: { patient_id: p.id }, headers: { 'idempotency-key': uid() }, body: consents() }), FULL_A));
    const bad = await run('updatePatient bad if-match', await fire('updatePatient', req({ params: { patient_id: p.id }, headers: { 'if-match': '"99"' }, body: { full_name: SENT.name } }), FULL_A));
    expect(bad.error, 'stale If-Match must be refused').toBeDefined();
  });
  it('F15-F19 discount approvals: reason_text and notes never leave the row', { timeout: T }, async () => {
    const mkReq = async () => run('requestDiscountApproval', await fire('requestDiscountApproval', req({ headers: { 'idempotency-key': uid() },
      body: { ...(requestFor('requestDiscountApproval', S).body as object), reason_text: SENT.discount } }), as(FULL_A, { membershipId: mid('a', 501) })));
    const a = await mkReq(); expect(a.reply?.status, `${a.error?.message}`).toBe(201);
    const ok = await run('approveDiscount', await fire('approveDiscount', req({ params: { approval_id: a.reply!.body.id }, headers: { 'idempotency-key': uid(), 'if-match': '"1"' }, body: { note: SENT.note } }), as(FULL_A, { membershipId: mid('a', 500) })));
    expect(ok.reply?.status, `${ok.error?.message}`).toBe(200);
    const b = await mkReq();
    await run('rejectDiscount', await fire('rejectDiscount', req({ params: { approval_id: b.reply!.body.id }, headers: { 'idempotency-key': uid(), 'if-match': '"1"' }, body: { note: SENT.note } }), as(FULL_A, { membershipId: mid('a', 500) })));
    await run('getDiscountApproval', await fire('getDiscountApproval', req({ params: { approval_id: a.reply!.body.id } }), FULL_A));
    await run('listDiscountApprovals', await fire('listDiscountApprovals', req({ query: { status: 'pending' } }), FULL_A));
  });
  it('F20 uploadTrf / F21 / F21a: the TRF file name never reaches a log, an error or the access log', { timeout: T }, async () => {
    const trf = makeWorld(TENANT_A);
    const up = await run('uploadTrf', await fire('uploadTrf', req({ headers: { 'idempotency-key': uid() }, body: { file: { filename: SENT.file, mimeType: 'application/pdf', bytes: pdfBytes('phi') }, centre_id: S.centre } }), FULL_A, { trf }));
    expect(up.reply?.status, `${up.error?.message}`).toBe(201);
    const id = up.reply!.body.id as string;
    await run('getTrfAttachment', await fire('getTrfAttachment', req({ params: { attachment_id: id } }), FULL_A, { trf }));
    await run('getTrfAttachmentContent (not yet scanned)', await fire('getTrfAttachmentContent', req({ params: { attachment_id: id } }), FULL_A, { trf }));
    const bad = await run('uploadTrf refused', await fire('uploadTrf', req({ headers: { 'idempotency-key': uid() }, body: { file: { filename: SENT.file, mimeType: 'application/x-msdownload', bytes: Buffer.from('MZ\x90\x00') }, centre_id: S.centre } }), FULL_A, { trf }));
    expect(bad.error, 'an executable must be refused').toBeDefined();
  });
  it('F14 cancelOrder: cancel reason text stays in the row; F23 resolveOrderFlag note likewise', { timeout: T }, async () => {
    const e = await edit({ side: 'a' });
    const v = Number((await ownerRows('frontdesk.orders', 'id = $1', [e.order.id]))[0].version);
    const c = await run('cancelOrder', await fire('cancelOrder', req({ params: { order_id: e.order.id }, headers: { 'idempotency-key': uid(), 'if-match': `"${v}"` }, body: { reason_code: 'patient_request', reason_text: SENT.cancel } }),
      FULL_A, { lab: e.lab, billing: e.billing, catalog: e.w.catalog }), { orderIds: [e.order.id] });
    expect(c.reply?.status, `${c.error?.message}`).toBe(200);
    await run('resolveOrderFlag', await fire('resolveOrderFlag', req({ params: { flag_id: S.flag.id }, headers: { 'idempotency-key': uid(), 'if-match': '"1"' }, body: { resolution_code: 'recollected', note: SENT.note } }), FULL_A));
  });
  it('F9 createRegistration: the registered patient\'s demographics stay out of logs, access_log and the order events', { timeout: T }, async () => {
    const p = await prepare({ side: 'a', patient: { full_name: SENT.name, phone_e164: phoneSent, email: SENT.email, address_text: SENT.address } });
    const r = await run('createRegistration', await fire('createRegistration', req({ headers: { 'idempotency-key': uid() }, body: p.body }), FULL_A, { w: p.w }));
    expect(r.reply?.status, `${r.error?.message}`).toBe(201);
    const orderId = r.reply!.body.order?.id ?? (await ownerRows('frontdesk.orders', 'patient_id = $1', [p.patient.id]))[0]?.id;
    expectClean(await surfaces(r, { orderIds: [orderId] }), 'createRegistration + events');
    // the notification port gets non-PHI params only (07 §5.5): no name / address / email in the SMS params
    for (const call of p.w.notif.calls?.('sendSms') ?? []) expectClean([JSON.stringify(call.input?.params ?? {})], 'notification params');
  });
  it('F7 anonymisePatient: success and retention_not_elapsed refusal leak no demographic value', { timeout: T }, async () => {
    const x = await anonymisable({ row: { full_name: SENT.name, phone_e164: phoneSent, email: SENT.email, address_text: SENT.address } });
    const ok = await anonymise(x.patient.id, '"1"', { reason_code: 'patient_request', reason_text: SENT.note }, undefined, { w: x.w });
    expect(ok.status).toBe(200);
    expectClean([...ok.probe.logs, ...sink, ...(await ownerRows('audit.access_log', 'request_id = $1', [ok.probe.requestId])).map((r) => JSON.stringify(r))], 'anonymisePatient');
    const recent = await seedPatient('a', { full_name: SENT.name, phone_e164: phoneSent, email: SENT.email, address_text: SENT.address });
    const o = await fire('anonymisePatient', req({ params: { patient_id: recent.id }, headers: { 'idempotency-key': uid(), 'if-match': '"1"' }, body: { reason_code: 'patient_request' } }), FULL_A);
    expectClean(await surfaces(o), 'anonymisePatient (any outcome)');
  });
  it('F10 / F11 / F6 order reads: no PHI in logs or access_log', { timeout: T }, async () => {
    await run('listOrders', await fire('listOrders', requestFor('listOrders', S), FULL_A));
    await run('listPatientOrders', await fire('listPatientOrders', requestFor('listPatientOrders', S), FULL_A));
  });
});
