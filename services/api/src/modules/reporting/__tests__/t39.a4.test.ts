// C6-T39 — 02-TRD §14 row "08 Addendum A4" (b) + (c); 01-PRD AC-16.1; 08 Addendum A4.2 (CR-C6-018), A4.3.
// (b) scheduled_report_ready staff recipient: IdentityPort.getStaffNotificationContact called with the request's membershipId + requiredPermission as the system actor;
//     eligible false -> suppressed_no_contact; eligible true + email null -> suppressed_no_contact; eligible true + email -> queued; no requiredPermission -> suppressed_no_contact [CONV].
// (c) label_text (schedule_name): 80 accepted, 81 rejected, http:// HTTP:// www. rejected, `<b>` is plain text -> ACCEPTED and stored raw (escaped only when it is inserted into the e-mail;
//     the escape itself is asserted in services/worker .../t39.a4.escape.test.ts). short_text (ref, booking_no): 40 chars of [A-Za-z0-9 .,:/()-] accepted, 41 rejected, `<` / `_` rejected.
// NOTE: 02-TRD §7.2 step 3 text says label_text has "no markup [CONV]", but the §14 row (c) (the done_when) requires `<b>` "rendered escaped in the e-mail", and 08 A4.3 (higher precedence)
// only says "plain text, no URLs, HTML-escaped" -> markup characters are escaped, not rejected. Runs on the in-memory fake of notification.helpers.ts (no network, no real DB).
import { describe, expect, it } from 'vitest';
import { makeNotifWorld, rejection, idN, TENANT_A, STAFF_ORIGIN, DEFAULT_TEMPLATES, type NotifWorld } from './notification.helpers.js';
import { paramValueOk } from '../domain/messages.js';

const P_ALL = idN(0x101);
const M_OK = idN(0x211), M_NOEMAIL = idN(0x212), M_LOCKED = idN(0x213), M_OTHERPERM = idN(0x214), M_INACTIVE = idN(0x215), M_SERVICE = idN(0x216);
const PERM = 'analytics.dashboard.read';
const OTHER = 'analytics.collections.read';
const RUN_URL = `${STAFF_ORIGIN}/analytics/report-runs/${idN(0x777)}`;
const code = (e: any) => e?.code;
const contact = (id: string, o: Record<string, unknown> = {}) => ({ id, tenantId: TENANT_A, membershipId: id, email: `staff-${id.slice(-4)}@example.com`, status: 'active', actorType: 'user', locked: false, permissions: [PERM], ...o });

async function world(): Promise<NotifWorld> {
  const w = makeNotifWorld();
  await w.seed({
    recipients: [{ id: P_ALL, tenantId: TENANT_A, kind: 'patient', fullName: 'SYNTHETIC Patient', phoneE164: '+977980000001', email: 'p1@example.com', consent: { sms: true, whatsapp: true, email: true } }],
    staffContacts: [contact(M_OK), contact(M_NOEMAIL, { email: null }), contact(M_LOCKED, { locked: true }), contact(M_OTHERPERM, { permissions: [OTHER] }),
      contact(M_INACTIVE, { status: 'inactive' }), contact(M_SERVICE, { actorType: 'service' })],
    channels: { [TENANT_A]: { smsEnabled: true, whatsappEnabled: true, emailEnabled: true } },
  });
  return w;
}
const sched = (membershipId: string, key: string, over: Record<string, unknown> = {}, requiredPermission: string | null = PERM) =>
  ({ recipient: { kind: 'staff', membershipId, ...(requiredPermission ? { requiredPermission } : {}) }, templateCode: 'analytics.report_ready', purpose: 'scheduled_report_ready',
    params: { schedule_name: 'Weekly collections' }, idempotencyKey: key, linkUrl: RUN_URL, ...over });
const spy = (w: NotifWorld) => w.identityCalls.filter((c) => c.method === 'getStaffNotificationContact');

describe('A4(b) staff recipient: IdentityPort.getStaffNotificationContact + requiredPermission (08 A4.2)', () => {
  it('is asked once with the request membershipId AND requiredPermission, as the reporting system actor (the permission is passed through verbatim, not hard-coded)', async () => {
    const w = await world();
    expect((await w.impl.sendEmailLink(w.sys(), sched(M_OTHERPERM, 'a4-1', {}, OTHER) as any)).status).toBe('queued');
    expect(spy(w)).toHaveLength(1);
    expect(spy(w)[0]).toMatchObject({ actorType: 'system', input: { membershipId: M_OTHERPERM, requiredPermission: OTHER } });
    expect(Object.keys(spy(w)[0]!.input).sort()).toEqual(['membershipId', 'requiredPermission']);
  });
  it('the non-existent permission name of A2.6 is never sent or required (`analytics.report.read`)', async () => {
    const w = await world();
    await w.impl.sendEmailLink(w.sys(), sched(M_OK, 'a4-2') as any);
    expect(JSON.stringify(spy(w))).not.toContain('analytics.report.read');
    expect((await w.impl.sendEmailLink(w.sys(), sched(M_OK, 'a4-2b', {}, 'analytics.report.read') as any)).status).toBe('suppressed_no_contact');   // held by nobody
  });
  it('eligible false (membership does not hold requiredPermission) even though an e-mail exists -> suppressed_no_contact, no job, e-mail never stored', async () => {
    const w = await world();
    const r = await w.impl.sendEmailLink(w.sys(), sched(M_OTHERPERM, 'a4-3') as any);
    expect(r.status).toBe('suppressed_no_contact');
    expect(w.db.delivery(r.deliveryId)).toMatchObject({ status: 'suppressed', failure_code: 'no_contact', recipient_kind: 'staff', recipient_id: M_OTHERPERM });
    expect(w.db.jobsOf('reporting.send_delivery')).toHaveLength(0);
    expect(JSON.stringify(w.db.deliveries())).not.toContain('@example.com');
  });
  it.each([['locked', M_LOCKED], ['status != active', M_INACTIVE], ['actor_type != user', M_SERVICE]])('eligible false (%s) -> suppressed_no_contact, no job', async (_n, m) => {
    const w = await world();
    expect((await w.impl.sendEmailLink(w.sys(), sched(m, `a4-4-${m}`) as any)).status).toBe('suppressed_no_contact');
    expect(spy(w)).toHaveLength(1); expect(w.db.jobsOf('reporting.send_delivery')).toHaveLength(0);
  });
  it('eligible true + email null -> suppressed_no_contact; eligible true + email -> queued with exactly one send job', async () => {
    const w = await world();
    expect((await w.impl.sendEmailLink(w.sys(), sched(M_NOEMAIL, 'a4-5') as any)).status).toBe('suppressed_no_contact');
    expect((await w.impl.sendEmailLink(w.sys(), sched(M_OK, 'a4-6') as any)).status).toBe('queued');
    expect(w.db.jobsOf('reporting.send_delivery')).toHaveLength(1);
  });
  it('staff recipient WITHOUT requiredPermission (or an empty / non-string one) -> suppressed_no_contact [CONV]; the port is not asked to guess a permission', async () => {
    const w = await world();
    for (const [i, rp] of [null, '', 7 as unknown as string].entries()) {
      const input: any = sched(M_OK, `a4-7-${i}`, {}, null); if (rp !== null) input.recipient.requiredPermission = rp;
      expect((await w.impl.sendEmailLink(w.sys(), input)).status, String(rp)).toBe('suppressed_no_contact');
    }
    expect(spy(w).every((c) => typeof c.input.requiredPermission === 'string' && c.input.requiredPermission.length > 0)).toBe(true);
    expect(w.db.jobsOf('reporting.send_delivery')).toHaveLength(0);
  });
  it('requiredPermission never lifts the Phase-1 staff suppression for any other purpose, and is never asked for a patient recipient', async () => {
    const w = await world();
    const r = await w.impl.sendSms(w.sys(), { recipient: { kind: 'staff', membershipId: M_OK, requiredPermission: PERM }, templateCode: 'homecollection.visit_assigned', purpose: 'visit_assignment',
      params: { route_date: '2026-11-05', visit_count: '4' }, idempotencyKey: 'a4-8' } as any);
    expect(r.status).toBe('suppressed_no_contact');
    expect((await w.impl.sendSms(w.sys(), { recipient: { kind: 'patient', patientId: P_ALL }, templateCode: 'engagement.booking_cancelled', purpose: 'booking_cancelled',
      params: { lab_name: 'Synthetic Lab', datetime: '2026-11-07T09:00:00.000Z', booking_no: 'BK-1' }, idempotencyKey: 'a4-9' } as any)).status).toBe('queued');
    expect(spy(w)).toHaveLength(0);
  });
  it('a replay of the same idempotency key does not call IdentityPort again', async () => {
    const w = await world();
    const a = await w.impl.sendEmailLink(w.sys(), sched(M_OK, 'a4-10') as any); const b = await w.impl.sendEmailLink(w.sys(), sched(M_OK, 'a4-10') as any);
    expect(b).toMatchObject({ deliveryId: a.deliveryId, replayed: true }); expect(spy(w)).toHaveLength(1);
  });
});

describe('A4(c) label_text (schedule_name) — 08 A4.3', () => {
  const send = (w: NotifWorld, name: string, key: string) => w.impl.sendEmailLink(w.sys(), sched(M_OK, key, { params: { schedule_name: name } }) as any);
  it('80 characters accepted, 81 rejected (reporting.notification_params_invalid, nothing persisted)', async () => {
    const w = await world();
    await expect(send(w, 'x'.repeat(80), 'lt-80')).resolves.toMatchObject({ status: 'queued' });
    expect(code(await rejection(send(w, 'x'.repeat(81), 'lt-81')))).toBe('reporting.notification_params_invalid');
    expect(w.db.deliveries()).toHaveLength(1);
  });
  it.each(['http://x', 'HTTP://x', 'Https://x.invalid', 'ftp://x', 'www.x', 'WWW.x', 'see Www.lab.example', 'a://b'])('URL-like %j -> rejected', async (bad) => {
    const w = await world();
    expect(code(await rejection(send(w, bad, 'lt-url')))).toBe('reporting.notification_params_invalid');
    expect(w.db.deliveries()).toHaveLength(0); expect(w.db.jobs).toHaveLength(0);
  });
  it('`<b>` is plain text: accepted, queued, stored as given (escaping happens when the e-mail is rendered)', async () => {
    const w = await world();
    const r = await send(w, '<b>Weekly</b> & "co"', 'lt-b');
    expect(r.status).toBe('queued');
    expect(w.db.delivery(r.deliveryId)!['params']['schedule_name']).toBe('<b>Weekly</b> & "co"');
  });
  it('control characters rejected (kept from T19)', async () => {
    const w = await world();
    for (const [i, bad] of ['a\nb', 'a\u0000b', 'a\tb'].entries()) expect(code(await rejection(send(w, bad, `lt-c${i}`))), JSON.stringify(bad)).toBe('reporting.notification_params_invalid');
  });
  it('paramValueOk unit: label_text 80/81, URL forms, `<b>`; kind is independent of short_text', () => {
    const o = { portal: 'https://portal.lims.invalid', staffWeb: STAFF_ORIGIN } as any;
    const lt = { name: 'schedule_name', kind: 'label_text' } as any;
    expect(paramValueOk(lt, 'x'.repeat(80), o, true)).toBe(true); expect(paramValueOk(lt, 'x'.repeat(81), o, true)).toBe(false);
    for (const bad of ['http://x', 'HTTP://x', 'www.x', 'WWW.X']) expect(paramValueOk(lt, bad, o, true), bad).toBe(false);
    expect(paramValueOk(lt, '<b>', o, true)).toBe(true);
    expect(paramValueOk(lt, 'Weekly: collections (Kathmandu) & more_1', o, true)).toBe(true);   // wider than short_text: '&' '_' allowed
  });
});

describe('A4(c) short_text restored exactly (ref, booking_no) — 08 A4.3: not loosened by label_text', () => {
  const book = (w: NotifWorld, booking_no: string, key: string) => w.impl.sendSms(w.sys(), { recipient: { kind: 'patient', patientId: P_ALL }, templateCode: 'engagement.booking_cancelled', purpose: 'booking_cancelled',
    params: { lab_name: 'Synthetic Lab', datetime: '2026-11-07T09:00:00.000Z', booking_no }, idempotencyKey: key } as any);
  const CHARSET = 'AZaz09 .,:/()-';
  it('40 chars of [A-Za-z0-9 .,:/()-] accepted; 41 rejected', async () => {
    const w = await world(); const forty = (CHARSET.repeat(4)).slice(0, 40);
    expect(forty).toHaveLength(40);
    await expect(book(w, forty, 'st-40')).resolves.toMatchObject({ status: 'queued' });
    expect(code(await rejection(book(w, `${forty}x`, 'st-41')))).toBe('reporting.notification_params_invalid');
  });
  it.each(['<', '_', '&', '"', "'", '@', '#', '\n', 'ab<b>', 'x_y', 'http://x'.replace('x', '<')])('character outside the charset %j -> rejected', async (bad) => {
    const w = await world();
    expect(code(await rejection(book(w, `BK${bad}`, 'st-bad'))), JSON.stringify(bad)).toBe('reporting.notification_params_invalid');
  });
  it('paramValueOk unit: short_text stays <= 40 even when the template declares a larger max_length; label_text does not use the short charset', () => {
    const o = { portal: 'https://portal.lims.invalid', staffWeb: STAFF_ORIGIN } as any;
    const st = { name: 'ref', kind: 'short_text', max_length: 200 } as any;
    expect(paramValueOk(st, 'x'.repeat(40), o, false)).toBe(true); expect(paramValueOk(st, 'x'.repeat(41), o, false)).toBe(false);
    expect(paramValueOk(st, 'a<b', o, false)).toBe(false); expect(paramValueOk(st, 'a_b', o, false)).toBe(false);
    expect(paramValueOk(st, 'a/b (c): d, e.f-g', o, false)).toBe(true);
  });
  it('the registry keeps short_text for ref/booking_no and label_text for schedule_name only', () => {
    const byCode = new Map(DEFAULT_TEMPLATES.map((t: any) => [t.code, t]));
    const kind = (c: string, n: string) => (byCode.get(c) as any)?.params.find((p: any) => p.name === n)?.kind;
    expect(kind('engagement.booking_cancelled', 'booking_no')).toBe('short_text');
    expect(kind('analytics.report_ready', 'schedule_name')).toBe('label_text');
  });
});
