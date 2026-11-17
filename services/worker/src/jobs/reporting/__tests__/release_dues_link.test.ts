// C6-T43 — release rule 8, the dues link under hold-till-paid (02-TRD §4.6 rule 8, §14 row "Second fix pass" (a); 08 Addendum A21.1; 01-PRD AC-18.8, AC-18.10, AC-18.11; 07-SECURITY T23).
// World = delivery.helpers.deliveryWorld (T23: deliveries / portal_links / templates / settings / qr_tokens, consents + channels ports) + a programmable BillingPort (T13).
// ASSUMED (spec leaves the code location open): rule 8 runs inside the task `reporting.release_if_eligible` (tasks/release_if_eligible.ts) when the version is held with basis
// `due_outstanding`; it reads BillingPort.getReleaseEligibility ONLY (balanceDue.amountPaisa -> "NPR 500.00") and creates the delivery through the internal delivery service
// (startDelivery, like dispatch). Channel = first usable of patient_mobile_channel_order (whatsapp/sms; e-mail never). A patient without consent gets ONE `suppressed` row (AC-18.11).
import '../../../../../api/src/__tests__/setup-env.js';
import { describe, expect, it } from 'vitest';
import { deliveryWorld, dRow, linkRow, LAB, LAB_NAME, makeTransport, NOW, rendered, released, SEND, tokenIn, V, TENANT_A, FULL_NAME, REG_NO, PHONE, I, type DW, type DWorldOpts, type Row } from './delivery.helpers.js';
import { DISPATCH_TASK, DUE_500, ELIGIBLE, makeBilling, money, RELEASE_TASK, type Eligibility } from './release.helpers.js';

const PAYLOAD = (n = 1) => ({ tenant_id: TENANT_A, report_id: LAB, report_version_id: V(n) });
type Task = (p: any, c: any) => Promise<void>;

async function setup(o: DWorldOpts & { billing?: Eligibility | ((orderId: string, n: number) => Eligibility) } = {}) {
  const { billing: b, ...rest } = o;
  const w = deliveryWorld({ versions: [rendered(1)], consent: { email: false, ...rest.consent }, ...rest });
  const bill = makeBilling(b ?? DUE_500);
  const mod: any = await import('../tasks/release_if_eligible.js'); const task: Task = mod.releaseIfEligible ?? mod.createReleaseIfEligible?.();
  // release.service reads ctx.ports.billing / ctx.ports.frontdesk; the delivery service reads ctx.ports.FrontdeskPort / IdentityPort: serve both, billing = the programmable spy
  const ports = { ...w.ports, billing: bill.port, BillingPort: bill.port };
  const release = (n = 1) => w.run(task, PAYLOAD(n), { ports });
  return { w, bill, release, ports };
}
const dues = (w: DW) => w.deliveries().filter((d) => d['purpose'] === 'dues_reminder');
const reportReady = (w: DW) => w.deliveries().filter((d) => d['purpose'] === 'report_ready');
const ok = (r: 'ok' | Error) => expect(r instanceof Error ? r.stack : r).toBe('ok');

describe('AC-18.8 held for dues -> one dues_reminder per held version (rule 8)', () => {
  it('whatsapp+sms consent, default channel order -> ONE queued WhatsApp dues_reminder: template reporting.dues_due, params {lab_name, amount_text "NPR 500.00"} only, deferred link purpose dues, key <version>:dues:<channel>', async () => {
    const { w, release } = await setup(); ok(await release());
    expect(dues(w)).toHaveLength(1); const d = dues(w)[0]!;
    expect(d).toMatchObject({ tenant_id: TENANT_A, channel: 'whatsapp', purpose: 'dues_reminder', template_code: 'reporting.dues_due', recipient_kind: 'patient', recipient_id: I.patient, status: 'queued',
      report_id: LAB, report_version_no: 1, idempotency_key: `${V(1)}:dues:whatsapp`, link_id: null });
    expect(d['params']).toEqual({ lab_name: LAB_NAME, amount_text: 'NPR 500.00' });       // no url (added at send time), no report content, no patient name
    expect(d['deferred_link']).toEqual({ report_id: LAB, version_no: 1, channel: 'whatsapp', recipient_kind: 'patient', purpose: 'dues' });
    expect(w.sendJobs()).toHaveLength(1); expect(w.sendJobs()[0]!.payload).toEqual({ delivery_id: d['id'] });
  });
  it('the version itself stays held (rendered, held_basis due_outstanding): no release event, no dispatch job, no report_ready delivery', async () => {
    const { w, release } = await setup(); ok(await release());
    expect(w.version(1)).toMatchObject({ status: 'rendered', held_basis: 'due_outstanding' }); expect(w.published.filter((p) => p.type === 'reporting.report.released.v1')).toHaveLength(0);
    expect(w.jobs(DISPATCH_TASK)).toHaveLength(0); expect(reportReady(w)).toHaveLength(0);
  });
  it('WhatsApp without consent -> SMS (patient_mobile_channel_order, same consent rules as report_ready); e-mail is never used for dues even when consented', async () => {
    const { w, release } = await setup({ consent: { whatsapp: false, sms: true, email: true } }); ok(await release());
    expect(dues(w).map((d) => d['channel'])).toEqual(['sms']); expect(dues(w)[0]!['idempotency_key']).toBe(`${V(1)}:dues:sms`); expect(dues(w)[0]!['status']).toBe('queued');
  });
  it('patient_mobile_channel_order [sms, whatsapp] is honoured', async () => {
    const { w, release } = await setup({ settings: { patient_mobile_channel_order: ['sms', 'whatsapp'] } }); ok(await release()); expect(dues(w).map((d) => d['channel'])).toEqual(['sms']);
  });
  it('amount_text is "NPR " + balanceDue.amountPaisa as rupees with two decimals', async () => {
    for (const [paisa, text] of [[50_001, 'NPR 500.01'], [5_000, 'NPR 50.00'], [99, 'NPR 0.99']] as const) {
      const { w, release } = await setup({ billing: { eligible: false, basis: 'due_outstanding', balanceDue: money(paisa) } }); ok(await release());
      expect(dues(w)[0]!['params']['amount_text'], String(paisa)).toBe(text);
    }
  });
  it('re-evaluating the SAME held version queues nothing more (deterministic key): 3 runs -> 1 delivery, 1 send job', async () => {
    const { w, release } = await setup(); ok(await release()); ok(await release()); ok(await release());
    expect(dues(w)).toHaveLength(1); expect(w.sendJobs()).toHaveLength(1); expect(w.statusEvents().filter((e) => e.input.payload.purpose === 'dues_reminder')).toHaveLength(1);
  });
  it('held again on a LATER version (v1 discarded, v2 rendered and held) -> a NEW dues delivery with the new key; v1\'s delivery stays', async () => {
    const { w, release } = await setup(); ok(await release());
    w.version(1)['status'] = 'discarded'; w.db.store['reporting.report_versions']!.push(rendered(2)); ok(await release(2));
    expect(dues(w).map((d) => d['idempotency_key']).sort()).toEqual([`${V(1)}:dues:whatsapp`, `${V(2)}:dues:whatsapp`].sort());
    expect(dues(w).find((d) => d['report_version_no'] === 2)!['deferred_link']).toMatchObject({ version_no: 2, purpose: 'dues' });
  });
  it('only basis due_outstanding triggers it: no_invoice (held, nothing to pay) sends no dues message', async () => {
    const { w, release } = await setup({ billing: { eligible: false, basis: 'no_invoice', balanceDue: money(0) } }); ok(await release());
    expect(dues(w)).toHaveLength(0); expect(w.version(1)['held_basis']).toBe('no_invoice');
  });
  it('an eligible order sends no dues message (it is released instead)', async () => {
    const { w, release } = await setup({ billing: ELIGIBLE }); ok(await release()); expect(dues(w)).toHaveLength(0); expect(w.version(1)['status']).toBe('released');
  });
  it('auto_release = manual: the task skips before eligibility, so no dues message either', async () => {
    const { w, release } = await setup({ settings: { auto_release: 'manual' } }); ok(await release()); expect(dues(w)).toHaveLength(0);
  });
  it('BillingPort: only getReleaseEligibility (no getOrderBalance / writes); the delivery carries no name, registration number, phone or report content', async () => {
    const { w, bill, release } = await setup(); ok(await release());
    expect(bill.other).toEqual([]); expect(bill.calls).toHaveLength(1); expect(w.portCalls.forbidden).toEqual([]);
    const text = JSON.stringify(dues(w)); for (const s of [FULL_NAME, REG_NO, PHONE, 'pdf_', 'panel']) expect(text).not.toContain(s);
  });
  it('a transient eligibility failure throws (queue retry) and leaves no delivery behind', async () => {
    const { w, release } = await setup({ billing: ((): never => { throw Object.assign(new Error('billing down'), { code: 'common.unavailable' }); }) as any });
    expect(await release()).toBeInstanceOf(Error); expect(dues(w)).toHaveLength(0);
  });
});

describe('AC-18.11 no dues message without the switch or the consent', () => {
  it('dues_link_enabled = false -> no delivery row at all (not even suppressed); the version is still held', async () => {
    const { w, release } = await setup({ settings: { dues_link_enabled: false } }); ok(await release());
    expect(dues(w)).toHaveLength(0); expect(w.sendJobs()).toHaveLength(0); expect(w.version(1)['held_basis']).toBe('due_outstanding');
  });
  it('no whatsapp / sms consent -> exactly ONE `suppressed` dues_reminder row (failure_code no_consent), no send job; re-running adds nothing', async () => {
    const { w, release } = await setup({ consent: { whatsapp: false, sms: false, email: true } }); ok(await release()); ok(await release());
    expect(dues(w)).toHaveLength(1); const d = dues(w)[0]!;
    expect(d).toMatchObject({ status: 'suppressed', failure_code: 'no_consent', purpose: 'dues_reminder', template_code: 'reporting.dues_due', recipient_kind: 'patient', report_id: LAB, report_version_no: 1 });
    expect(['whatsapp', 'sms']).toContain(d['channel']); expect(w.sendJobs()).toHaveLength(0);
  });
  it('mobile channels switched off for the tenant -> suppressed (channel_disabled), never queued', async () => {
    const { w, release } = await setup({ channels: { whatsappEnabled: false, smsEnabled: false } }); ok(await release());
    expect(dues(w).every((d) => d['status'] === 'suppressed')).toBe(true); expect(w.sendJobs()).toHaveLength(0);
  });
});

describe('send task + AC-18.10: the dues link, then release after the balance event', () => {
  async function flow() {
    const s = await setup({ settings: {} }); ok(await s.release());
    const rec = makeTransport('recording'); const m: any = await import('../tasks/send_delivery.js');
    const send: Task = m.createSendDelivery ? m.createSendDelivery({ env: { ...s.w.env }, transports: { recording: rec } }) : m.sendDelivery;
    const d = dues(s.w)[0]!; ok(await s.w.run(send, { delivery_id: d['id'] }));
    return { ...s, rec, d, send };
  }
  it('sending the dues_reminder issues a portal_links row purpose dues bound to the held version; the message carries lab, amount and the link only', async () => {
    const { w, rec, d } = await flow();
    const l = w.linksOf(d['id'])[0]!; expect(l).toMatchObject({ purpose: 'dues', bound_version_no: 1, recipient_kind: 'patient', revoked_at: null });
    const body = rec.sent[0]!.msg.body as string; expect(body).toContain('NPR 500.00'); expect(body).toContain(LAB_NAME); expect(tokenIn(body)).toBeTruthy();
    for (const s of [FULL_NAME, REG_NO, 'CBC', 'glucose']) expect(body).not.toContain(s);
  });
  it('balance paid -> the same task releases the version (basis paid_in_full), queues the normal report_ready delivery and revokes every unrevoked dues link with dues_settled', async () => {
    const paid = { v: false }; const s = await setup({ billing: () => (paid.v ? ELIGIBLE : DUE_500) }); const { w } = s; ok(await s.release());
    const rec = makeTransport('recording'); const m: any = await import('../tasks/send_delivery.js');
    ok(await w.run(m.createSendDelivery ? m.createSendDelivery({ env: { ...w.env }, transports: { recording: rec } }) : m.sendDelivery, { delivery_id: dues(w)[0]!['id'] }));
    (w.db.store['reporting.portal_links'] ??= []).push(linkRow(7, { purpose: 'report', delivery_id: null }));                  // a report link of the same report must stay untouched
    paid.v = true; ok(await s.release());
    expect(w.version(1)).toMatchObject({ status: 'released', release_basis: 'paid_in_full' });
    const dl = w.portalLinks().filter((l) => l['purpose'] === 'dues'); expect(dl).toHaveLength(1);
    expect(dl[0]).toMatchObject({ revoke_reason_code: 'dues_settled' }); expect(dl[0]!['revoked_at']).toBeTruthy();
    expect(w.portalLinks().find((l) => l['purpose'] === 'report')!['revoked_at']).toBeNull();
    const d = await import('../tasks/dispatch_release_deliveries.js'); const dispatch: Task = (d as any).dispatchReleaseDeliveries ?? (d as any).createDispatchReleaseDeliveries?.();
    ok(await w.run(dispatch, { tenant_id: TENANT_A, report_version_id: V(1) }, { ports: s.ports }));
    expect(reportReady(w).filter((x) => x['recipient_kind'] === 'patient' && x['status'] === 'queued')).toHaveLength(1);
    expect(dues(w)).toHaveLength(1);                                                                // no second dues message after the release
  });
  it('a held run never revokes anything (links stay valid until the release)', async () => {
    const { w, release } = await flow(); ok(await release()); expect(w.portalLinks().filter((l) => l['purpose'] === 'dues').every((l) => l['revoked_at'] == null)).toBe(true);
  });
});

describe('plumbing', () => {
  it('release_if_eligible stays registered (10 attempts) — rule 8 is part of the real task, not a new task id', async () => {
    const m: any = (await import('../index.js')).manifest; expect(typeof m.tasks[RELEASE_TASK]).toBe('function'); expect(m.maxAttempts[RELEASE_TASK]).toBe(10); expect(SEND).toBe('reporting.send_delivery');
  });
});
void released; void dRow; void ({} as Row);
