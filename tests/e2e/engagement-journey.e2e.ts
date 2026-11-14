// C16 T-E2E1 nightly journeys (02-TRD §14 "E2E (nightly)", 06-PLAN §3 rows "Events from C5/C6/C4" + "Consumers of booking events").
// Journey 1: staff issues link code (L1) -> app redeems (E2/E3/E14) -> C5/C6 fake events (lab.specimen.status_changed.v1, reporting.report.released.v1)
//            -> order stage + report visible -> download (E23: bytes + sha256) -> cross-account / revoked / unauthenticated attempts.
// Journey 2: booking (E30-E33) -> engagement.booking.confirmed.v1 -> C4 fake consumer pre-registers the order -> engagement.reconcile_bookings
//            -> booking `completed` with order_id; last place taken once only (409 engagement.slot_unavailable).
// Synthetic data only. Routes: 02-TRD §5 under /v1/engagement. Pre-auth credential `t.<tenant_code>` (E2), challenge credential `c.<challenge_token>` (E3),
// patient access token as Bearer afterwards (assumption: Authorization header carries all three; T-E2E1 CR notes it).
// Event injection, recorded OTP read, fake-C4 consumer run, job run and log read use the non-production test-support routes proposed in
// .orchestra/cr/T-E2E1.md (mounted only when TARGET_ENV/APP_ENV in {compose, ci, staging}); the real nightly run is blocked until they exist.
// Run: docker compose up -d --wait; E2E_BASE_URL=<stack url> E2E_TENANT_CODE=<code> E2E_STAFF_TOKEN_A=<token> pnpm exec vitest run tests/e2e/engagement-journey.e2e.ts
import { createHash } from 'node:crypto';
import { describe, it, expect, beforeAll } from 'vitest';

const BASE = (process.env.E2E_BASE_URL ?? '').replace(/\/+$/, '');
const TENANT = process.env.E2E_TENANT_CODE ?? '';
const STAFF = process.env.E2E_STAFF_TOKEN_A ?? '';
const API = '/v1/engagement';
const TS = `${API}/test-support`;

type J = Record<string, any>;
type Res = { status: number; json: J; text: string; headers: Headers; bytes: Buffer };
type Auth = { bearer?: string; idem?: boolean; ifMatch?: string; ifNoneMatch?: string };

let seq = 0;
const idemKey = () => `c16-e2e1-${Date.now().toString(36)}-${(seq += 1)}-${Math.random().toString(36).slice(2, 10)}`;

async function call(method: string, path: string, auth: Auth, body?: unknown): Promise<Res> {
  const headers: Record<string, string> = {};
  if (auth.bearer) headers.Authorization = `Bearer ${auth.bearer}`;
  if (auth.idem) headers['Idempotency-Key'] = idemKey();
  if (auth.ifMatch) headers['If-Match'] = auth.ifMatch;
  if (auth.ifNoneMatch) headers['If-None-Match'] = auth.ifNoneMatch;
  let payload: BodyInit | undefined;
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(BASE + path, { method, headers, body: payload });
  const bytes = Buffer.from(await res.arrayBuffer());
  const text = bytes.toString('utf8');
  let json: J = {};
  try { json = JSON.parse(text); } catch { json = {}; }
  return { status: res.status, json, text, headers: res.headers, bytes };
}
const staff = (extra: Auth = {}): Auth => ({ bearer: STAFF, ...extra });
const etagOf = (r: Res) => r.headers.get('etag') ?? `"${r.json.version}"`;
const pollUntil = async (fn: () => Promise<boolean>, ms = 90_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await new Promise((r) => setTimeout(r, 1000)); }
  throw new Error('timeout waiting for condition');
};
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

interface Patient { session: string; access: string; phone: string }
/** E2 -> recorded OTP (test-support) -> E3. Returns the patient bearer. The OTP code is kept for the PHI scan of the logs. */
async function signIn(phone: string, phi: string[]): Promise<Patient> {
  const ch = await call('POST', `${API}/auth/otp-challenges`, { bearer: `t.${TENANT}` }, { phone_e164: phone, app_instance_id: '0d6b1f0e-5c1e-4f5e-9d53-000000000e2e', app_platform: 'android' });
  expect(ch.status).toBe(202);
  expect(ch.json.challenge_token).toHaveLength(43);
  expect(ch.json.code_length).toBe(6);
  const rec = await call('GET', `${TS}/recorded-messages?kind=sms&purpose=otp&phone_e164=${encodeURIComponent(phone)}`, staff());
  const code = String(rec.json.data?.[0]?.otp_code ?? '');
  expect(code).toMatch(/^[0-9]{6}$/);
  const ver = await call('POST', `${API}/auth/otp-challenges/verify`, { bearer: `c.${ch.json.challenge_token}` }, { code });
  expect(ver.status).toBe(200);
  expect(ver.json.session_token).toHaveLength(43);
  expect(ver.json.access_token.length).toBeLessThanOrEqual(4096);
  phi.push(phone, code, ch.json.challenge_token, ver.json.session_token, ver.json.access_token);
  return { session: ver.json.session_token, access: ver.json.access_token, phone };
}
const P = (p: Patient, extra: Auth = {}): Auth => ({ bearer: p.access, ...extra });
const scenario = async (name: string, phi: string[], extra: J = {}) => {
  const r = await call('POST', `${TS}/scenarios`, staff({ idem: true }), { scenario: name, ...extra });
  expect(r.status).toBe(201);
  phi.push(r.json.patient_display_name, r.json.patient_phone);
  return r.json;
};
const publish = async (event_type: string, payload: J) => {
  const r = await call('POST', `${TS}/events`, staff({ idem: true }), { event_type, payload });
  expect(r.status).toBe(202);
  return r;
};

const S = { phi: [] as string[], orderIds: [] as string[] };

describe('C16 nightly E2E (compose stack)', () => {
  beforeAll(() => {
    // No silent skip: a missing stack/env is a broken nightly (the workflow step sets all three).
    expect({ E2E_BASE_URL: !!BASE, E2E_TENANT_CODE: !!TENANT, E2E_STAFF_TOKEN_A: !!STAFF }).toEqual({ E2E_BASE_URL: true, E2E_TENANT_CODE: true, E2E_STAFF_TOKEN_A: true });
  });

  describe('journey 1: issue code -> redeem -> C5/C6 fake events -> release -> download', () => {
    const j: J = {};
    let me: Patient; let other: Patient;

    it('staff issues a link code bound to the record phone (L1, no-store, plaintext once)', async () => {
      Object.assign(j, await scenario('report-journey', S.phi));
      expect(j.patient_id && j.order_id && j.report_id).toBeTruthy();
      const r = await call('POST', `${API}/link-codes`, staff(), { patient_id: j.patient_id, relationship: 'self', consented_by: 'patient', identity_check_method: 'photo_id', bind_phone: 'record' });
      expect(r.status).toBe(201);
      expect(r.headers.get('cache-control') ?? '').toContain('no-store');
      expect(r.json.code).toMatch(/^[0-9A-Za-z -]{10,13}$/);
      expect(r.json.bound_phone_masked).not.toContain(j.patient_phone);
      expect(new Date(r.json.expires_at).getTime()).toBeGreaterThan(Date.now());
      j.code = r.json.code; j.link_code_id = r.json.link_code_id; S.phi.push(r.json.code);
    });

    it('app signs in by OTP and redeems the code (E2, E3, E14); a second redeem is idempotent (200, same profile)', async () => {
      me = await signIn(j.patient_phone, S.phi);
      const a = await call('POST', `${API}/me/profiles/redeem-code`, P(me, { idem: true }), { code: j.code });
      expect(a.status).toBe(201);
      expect(a.json.patient_id ?? a.json.id).toBeTruthy();
      j.profile_id = a.json.id;
      const b = await call('POST', `${API}/me/profiles/redeem-code`, P(me, { idem: true }), { code: j.code });
      expect([200, 422]).toContain(b.status); // already linked -> 200; a spent code never creates a second link
      const list = await call('GET', `${API}/me/profiles`, P(me));
      expect(list.status).toBe(200);
      expect(list.json.data).toHaveLength(1);
    });

    it('C5 fake events move the order stage; a stale seq never moves it back (consumer: inbox + seq)', async () => {
      await publish('lab.specimen.status_changed.v1', { order_id: j.order_id, patient_id: j.patient_id, specimen_id: j.specimen_id, status: 'received', seq: 2 });
      let stage = '';
      await pollUntil(async () => { const o = await call('GET', `${API}/me/orders/${j.order_id}`, P(me)); stage = o.json.stage ?? ''; return o.status === 200 && stage !== '' && stage !== 'registered'; });
      const before = stage;
      await publish('lab.specimen.status_changed.v1', { order_id: j.order_id, patient_id: j.patient_id, specimen_id: j.specimen_id, status: 'collected', seq: 1 });
      await new Promise((r) => setTimeout(r, 3000));
      const after = await call('GET', `${API}/me/orders/${j.order_id}`, P(me));
      expect(after.json.stage).toBe(before);
      const list = await call('GET', `${API}/me/orders?profile_id=${j.profile_id}`, P(me));
      expect(list.json.data.map((o: J) => o.id)).toContain(j.order_id);
    });

    it('C6 fake reporting.report.released.v1 (audiences incl. patient) -> report listed + report_ready notification (E22, E45)', async () => {
      await publish('reporting.report.released.v1', { order_id: j.order_id, patient_id: j.patient_id, report_id: j.report_id, version_no: 1, audiences: ['patient'], released_at: new Date().toISOString() });
      await pollUntil(async () => (await call('GET', `${API}/me/reports?order_id=${j.order_id}`, P(me))).json.data?.length > 0);
      const reps = await call('GET', `${API}/me/reports?order_id=${j.order_id}`, P(me));
      expect(reps.json.data[0].id ?? reps.json.data[0].report_id).toBe(j.report_id);
      const notes = await call('GET', `${API}/me/notifications?unread_only=true`, P(me));
      expect(JSON.stringify(notes.json.data)).toContain('report_ready');
      const order = await call('GET', `${API}/me/orders/${j.order_id}`, P(me));
      expect(order.json.stage).toBe('report_ready');
    });

    it('download returns the exact released bytes: application/pdf, attachment, sha256 equal (E23)', async () => {
      const r = await call('GET', `${API}/me/reports/${j.report_id}/versions/1/file`, P(me));
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toContain('application/pdf');
      expect(r.headers.get('content-disposition')).toMatch(/^attachment; filename="report-1\.pdf"/);
      expect(r.bytes.subarray(0, 4).toString('latin1')).toBe('%PDF');
      expect(sha256(r.bytes)).toBe(j.report_sha256);
    });

    it('security: no token 401; another account 404 common.not_found; staff bearer on /me refused; revoked link 404', async () => {
      const anon = await call('GET', `${API}/me/reports/${j.report_id}/versions/1/file`, {});
      expect(anon.status).toBe(401);
      const b = await scenario('report-journey', S.phi, { distinct_from: j.patient_id });
      other = await signIn(b.patient_phone, S.phi);
      const cross = await call('GET', `${API}/me/reports/${j.report_id}/versions/1/file`, P(other));
      expect(cross.status).toBe(404);
      expect(cross.json.error?.code ?? cross.json.code).toBe('common.not_found');
      expect((await call('GET', `${API}/me/reports/${j.report_id}`, P(other))).status).toBe(404);
      expect([401, 403]).toContain((await call('GET', `${API}/me`, staff())).status);
      const links = await call('GET', `${API}/patients/${j.patient_id}/app-links`, staff());
      const link = links.json.data[0];
      const rev = await call('POST', `${API}/app-links/${link.id}/revoke`, staff({ ifMatch: `"${link.version}"` }), { reason_code: 'patient_request' });
      expect(rev.status).toBe(200);
      expect((await call('GET', `${API}/me/reports/${j.report_id}/versions/1/file`, P(me))).status).toBe(404);
    });
  });

  describe('journey 2: booking -> C4 fake consumer -> completion', () => {
    const j: J = {};
    let me: Patient; let rival: Patient;

    it('patient lists items, centres and slots, then books (E30-E33); the same Idempotency-Key returns the same booking', async () => {
      Object.assign(j, await scenario('booking-journey', S.phi));
      me = await signIn(j.patient_phone, S.phi);
      const link = await call('POST', `${API}/link-codes`, staff(), { patient_id: j.patient_id, relationship: 'self', consented_by: 'patient', identity_check_method: 'photo_id', bind_phone: 'record' });
      S.phi.push(link.json.code);
      const prof = await call('POST', `${API}/me/profiles/redeem-code`, P(me, { idem: true }), { code: link.json.code });
      expect(prof.status).toBe(201);
      const items = await call('GET', `${API}/me/bookable-items?booking_kind=centre_visit`, P(me));
      expect(items.status).toBe(200);
      const centres = await call('GET', `${API}/me/booking-centres?booking_kind=centre_visit`, P(me));
      const centre = centres.json.data.find((c: J) => c.id === j.centre_id) ?? centres.json.data[0];
      expect(centre).toBeTruthy();
      const day = j.slot_start.slice(0, 10);
      const slots = await call('GET', `${API}/me/slots?booking_kind=centre_visit&centre_id=${centre.id}&date_from=${day}&date_to=${day}`, P(me));
      expect(slots.status).toBe(200);
      expect(slots.json.data.map((s: J) => s.slot_start ?? s.start)).toContain(j.slot_start);
      const body = { profile_id: prof.json.id, booking_kind: 'centre_visit', centre_id: centre.id, slot_start: j.slot_start, orderable_ids: j.orderable_ids };
      const key = idemKey();
      const send = () => fetch(`${BASE}${API}/me/bookings`, { method: 'POST', headers: { Authorization: `Bearer ${me.access}`, 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(body) });
      const first = await send(); const firstJson = await first.json() as J;
      expect(first.status).toBe(201);
      expect(firstJson.status).toBe('confirmed');
      const replay = await send();
      expect(replay.status).toBeLessThan(300);
      expect(((await replay.json()) as J).id).toBe(firstJson.id);
      j.booking_id = firstJson.id;
    });

    it('last place goes to one patient only: the rival gets 409 engagement.slot_unavailable', async () => {
      const r = await scenario('booking-journey', S.phi, { same_slot_as: j.booking_id });
      rival = await signIn(r.patient_phone, S.phi);
      const code = await call('POST', `${API}/link-codes`, staff(), { patient_id: r.patient_id, relationship: 'self', consented_by: 'patient', identity_check_method: 'photo_id', bind_phone: 'record' });
      S.phi.push(code.json.code);
      const prof = await call('POST', `${API}/me/profiles/redeem-code`, P(rival, { idem: true }), { code: code.json.code });
      const res = await call('POST', `${API}/me/bookings`, P(rival, { idem: true }), { profile_id: prof.json.id, booking_kind: 'centre_visit', centre_id: j.centre_id, slot_start: j.slot_start, orderable_ids: j.orderable_ids });
      expect(res.status).toBe(409);
      expect(res.json.error?.code ?? res.json.code).toBe('engagement.slot_unavailable');
    });

    it('C4 fake consumer of engagement.booking.confirmed.v1 pre-registers the order; reconcile completes the booking with order_id', async () => {
      const c4 = await call('POST', `${TS}/consumers/c4/run`, staff({ idem: true }), { booking_id: j.booking_id });
      expect(c4.status).toBe(200);
      expect(c4.json.order_id).toBeTruthy();
      S.orderIds.push(c4.json.order_id);
      const job = await call('POST', `${TS}/jobs/run`, staff({ idem: true }), { job: 'engagement.reconcile_bookings' });
      expect(job.status).toBe(200);
      await pollUntil(async () => (await call('GET', `${API}/me/bookings/${j.booking_id}`, P(me))).json.status === 'completed', 30_000);
      const done = await call('GET', `${API}/me/bookings/${j.booking_id}`, P(me));
      expect(done.json.order_id).toBe(c4.json.order_id);
      const sb = await call('GET', `${API}/bookings/${j.booking_id}`, staff());
      expect(sb.json.transitions.map((t: J) => t.to)).toEqual(expect.arrayContaining(['confirmed', 'completed']));
      expect(sb.json.transitions.at(-1).actor_type).toBe('system');
      const cancel = await call('POST', `${API}/me/bookings/${j.booking_id}/cancel`, P(me, { ifMatch: etagOf(done) }), {});
      expect(cancel.status).toBe(409); // completed booking is not cancellable
      expect(cancel.json.error?.code ?? cancel.json.code).toMatch(/^engagement\.booking_(not_cancellable|invalid_transition)$/);
    });
  });

  describe('PHI hygiene', () => {
    it('logs of both journeys hold no phone, OTP, link code, token or name (02-TRD §13)', async () => {
      const logs = await call('GET', `${TS}/logs`, staff());
      expect(logs.status).toBe(200);
      for (const secret of S.phi.filter((s) => s && s.length >= 6)) expect(logs.text.includes(secret), `log leaks a ${secret.length}-char value`).toBe(false);
    });
  });
});
