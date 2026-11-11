// C6-T39 — 02-TRD §14 row "08 Addendum A4" (c), render half: a `label_text` value containing markup (`<b>`) is HTML-escaped when it is inserted into an e-mail
// body / subject (08 A4.3 "HTML-escaped"). The validator half (accepted + stored raw) is in services/api .../t39.a4.test.ts.
// Uses the send_delivery harness (delivery.helpers.ts): the existing e-mail text row of `reporting.report_ready` is edited in the fake DB to carry {schedule_name}, and the delivery
// row's params carry the raw value (that is what NotificationPort stores). The sent message is what the recording transport receives.
import '../../../../../api/src/__tests__/setup-env.js';
import { describe, expect, it } from 'vitest';
import { D, deliveryWorld, dRow, LAB, makeTransport, type Row } from './delivery.helpers.js';

const EMAILROW = (id: number, params: Row) => dRow(id, { channel: 'email', destination_masked: 'p***@example.invalid', params, deferred_link: { report_id: LAB, version_no: 1, channel: 'email', recipient_kind: 'patient' } });

async function sendMail(name: string, extra: Row = {}) {
  // db.all() returns copies: take the stock text rows from a throwaway world, edit them, seed them into the real one.
  const texts = deliveryWorld().db.all('reporting.message_template_texts').map((t: Row) => (t['template_code'] === 'reporting.report_ready' && t['channel'] === 'email'
    ? { ...t, body_text: 'Schedule {schedule_name} for {lab_name}: {url}', subject_text: 'Report {schedule_name}' } : { ...t }));
  const w = deliveryWorld({ deliveries: [EMAILROW(1, { lab_name: 'Synthetic Lab', schedule_name: name, ...extra })], extraSeed: { 'reporting.message_template_texts': texts } });
  const rec = makeTransport('recording');
  const m: any = await import('../tasks/send_delivery.js');
  const task = m.createSendDelivery({ env: w.env, transports: { recording: rec } });
  expect(await w.run(task, { delivery_id: D(1) })).toBe('ok');
  expect(rec.sent).toHaveLength(1);
  return { msg: rec.sent[0]!.msg as { subject: string; body: string }, w };
}

describe('A4(c) label_text is HTML-escaped in the e-mail body and subject', () => {
  it('`<b>x</b>` -> `&lt;b&gt;x&lt;/b&gt;` in body and subject; the raw tag never appears', async () => {
    const { msg } = await sendMail('<b>x</b>');
    expect(msg.body).toContain('&lt;b&gt;x&lt;/b&gt;'); expect(msg.subject).toBe('Report &lt;b&gt;x&lt;/b&gt;');
    expect(msg.body).not.toContain('<b>'); expect(msg.subject).not.toContain('<');
  });
  it('script / attribute-breaking payloads are inert: & < > " \' all escaped, no raw angle bracket or quote survives', async () => {
    const { msg } = await sendMail(`<script>alert("x")</script> & 'q'`);
    expect(msg.body).not.toMatch(/<script|<\/script/i); expect(msg.body).toContain('&lt;script&gt;'); expect(msg.body).toContain('&amp;'); expect(msg.body).toContain('&quot;');
    expect(msg.body).toMatch(/&#0?39;|&apos;/);
    expect(msg.subject).not.toMatch(/[<>"]/);
  });
  it('an already-escaped value is escaped once more (no double-decoding path): `&lt;` -> `&amp;lt;`', async () => {
    const { msg } = await sendMail('&lt;i&gt;');
    expect(msg.body).toContain('&amp;lt;i&amp;gt;');
  });
  it('plain values pass through unchanged and the portal link is intact', async () => {
    const { msg } = await sendMail('Weekly collections');
    expect(msg.body).toMatch(/^Schedule Weekly collections for Synthetic Lab: https:\/\/\S+\/r\/[A-Za-z0-9_-]{22}$/);
    expect(msg.subject).toBe('Report Weekly collections');
  });
});
