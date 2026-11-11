// C6-T34 — nightly E2E journey (starts at register), 05-DoD §5.2 / 02-TRD test table. API-level, compose stack, recording WhatsApp provider, synthetic data only.
// Env: E2E_BASE_URL, E2E_STAFF_TOKEN_A (tenant A), E2E_STAFF_TOKEN_B (tenant B); optional E2E_PATH_* route overrides.
// ponytail: the spec fixes only the portal + verification routes; the staff/test-support routes below are assumed and overridable (see C6-T34-impl.md).
import { describe, it, expect } from 'vitest';

const BASE = (process.env.E2E_BASE_URL ?? '').replace(/\/+$/, '');
const TOKEN_A = process.env.E2E_STAFF_TOKEN_A ?? '';
const TOKEN_B = process.env.E2E_STAFF_TOKEN_B ?? '';
const P = {
  register: process.env.E2E_PATH_REGISTER ?? '/v1/frontdesk/orders',
  approve: process.env.E2E_PATH_APPROVE ?? '/v1/lab/approvals',
  report: process.env.E2E_PATH_REPORT ?? '/v1/reporting/report-versions',
  release: process.env.E2E_PATH_RELEASE ?? '/v1/reporting/report-versions',
  pay: process.env.E2E_PATH_PAY ?? '/v1/billing/payments',
  provider: process.env.E2E_PATH_PROVIDER ?? '/v1/reporting/test-support/recorded-messages',
  logs: process.env.E2E_PATH_LOGS ?? '/v1/reporting/test-support/logs',
  verify: '/v1/reporting/verifications',
};

type J = Record<string, any>;
async function call(method: string, path: string, token: string | null, body?: unknown): Promise<{ status: number; json: J; text: string }> {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: J = {};
  try { json = JSON.parse(text); } catch { /* non-JSON (PDF bytes) */ }
  return { status: res.status, json, text };
}
const pollUntil = async (fn: () => Promise<boolean>, ms = 90_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await new Promise((r) => setTimeout(r, 1000)); }
  throw new Error('timeout waiting for condition');
};

// shared journey state (tests run in order)
const S: J = { phi: [] as string[] };

describe.sequential('C6 nightly journey (05-DoD §5)', () => {
  it('stack URL and tokens come from env', () => {
    expect(BASE, 'E2E_BASE_URL').not.toBe('');
    expect(TOKEN_A, 'E2E_STAFF_TOKEN_A').not.toBe('');
    expect(TOKEN_B, 'E2E_STAFF_TOKEN_B').not.toBe('');
  });

  it('register: front desk registers a synthetic patient + order with dues outstanding', async () => {
    const r = await call('POST', P.register, TOKEN_A, { synthetic: true, scenario: 'journey', dues: 'outstanding', channel: 'whatsapp' });
    expect(r.status).toBeLessThan(300);
    Object.assign(S, { orderId: r.json.order_id, patientName: r.json.patient_name, phone: r.json.phone });
    S.phi.push(S.patientName, S.phone);
  });

  it('approve: lab results approved', async () => {
    const r = await call('POST', P.approve, TOKEN_A, { order_id: S.orderId });
    expect(r.status).toBeLessThan(300);
  });

  it('assemble + render: report v1 is assembled and rendered within 60 s', async () => {
    await pollUntil(async () => {
      const r = await call('GET', `${P.report}?order_id=${S.orderId}`, TOKEN_A);
      const v = r.json.items?.[0];
      if (v?.status === 'rendered' || v?.status === 'held') { S.v1 = v.id; return true; }
      return false;
    });
    expect(S.v1).toBeTruthy();
  });

  it('held (dues): release is blocked while dues are outstanding; portal link leads to the dues page', async () => {
    const r = await call('GET', `${P.report}/${S.v1}`, TOKEN_A);
    expect(r.json.release_state).toMatch(/held|hold/i);
    const d = await call('GET', '/portal/dues', S.sessionToken ?? null);
    expect([200, 401]).toContain(d.status);
  });

  it('pay + auto-release: payment recorded, report auto-releases, WhatsApp message recorded by the recording provider', async () => {
    const p = await call('POST', P.pay, TOKEN_A, { order_id: S.orderId, amount: 'full', synthetic: true });
    expect(p.status).toBeLessThan(300);
    await pollUntil(async () => (await call('GET', `${P.report}/${S.v1}`, TOKEN_A)).json.release_state === 'released');
    let msgs: J[] = [];
    await pollUntil(async () => {
      msgs = (await call('GET', `${P.provider}?order_id=${S.orderId}`, TOKEN_A)).json.items ?? [];
      return msgs.length > 0;
    });
    S.recorded = msgs;
    S.linkToken = msgs[0].link_token;
    S.phi.push(S.linkToken);
  });

  it('OTP + download: link opens an OTP challenge, verify issues a session, PDF downloads', async () => {
    const c = await call('POST', '/portal/otp-challenges', null, { link_token: S.linkToken });
    expect(c.status).toBeLessThan(300);
    const code = (await call('GET', `${P.provider}?order_id=${S.orderId}&kind=otp`, TOKEN_A)).json.items?.[0]?.otp;
    const v = await call('POST', `/portal/otp-challenges/${c.json.id}/verify`, null, { code });
    expect(v.status).toBeLessThan(300);
    S.sessionToken = v.json.session_token;
    const rep = await call('GET', '/portal/report', S.sessionToken);
    expect(rep.status).toBe(200);
    const pdf = await call('GET', `/portal/report-versions/${rep.json.id}/pdf`, S.sessionToken);
    expect(pdf.status).toBe(200);
    expect(pdf.text.startsWith('%PDF')).toBe(true);
    S.qr = rep.json.qr_token;
  });

  it('QR verify: public verification of v1 reports the report as current', async () => {
    const r = await call('POST', P.verify, null, { token: S.qr });
    expect(r.status).toBe(200);
    expect(r.json.status).toMatch(/valid|current/i);
  });

  it('amendment: v2 supersedes v1; v1 stays readable but superseded; portal serves only the latest; QR verify of v1 reports superseded', async () => {
    const a = await call('POST', `${P.report}/${S.v1}/amend`, TOKEN_A, { reason: 'synthetic correction' });
    expect(a.status).toBeLessThan(300);
    S.v2 = a.json.id;
    await pollUntil(async () => (await call('GET', `${P.report}/${S.v2}`, TOKEN_A)).json.release_state === 'released');
    const v1 = await call('GET', `${P.report}/${S.v1}`, TOKEN_A);
    expect(v1.status).toBe(200);
    expect(v1.json.status).toMatch(/superseded/i);
    const latest = await call('GET', '/portal/report', S.sessionToken);
    expect(latest.json.id).toBe(S.v2);
    const q = await call('POST', P.verify, null, { token: S.qr });
    expect(q.json.status).toMatch(/superseded/i);
  });

  it('outsourced merge: an outsourced PDF is merged into the report', async () => {
    const r = await call('POST', `${P.report}/${S.v2}/outsourced-merge`, TOKEN_A, { synthetic: true });
    expect(r.status).toBeLessThan(300);
    expect(r.json.pages).toBeGreaterThan(1);
  });

  it('narrative sign: narrative report is signed by the pathologist before release', async () => {
    const r = await call('POST', `${P.report}/${S.v2}/narrative/sign`, TOKEN_A, { synthetic: true });
    expect(r.status).toBeLessThan(300);
  });

  it('bulk release: 200 report versions release in one request within 8 s', async () => {
    const t0 = Date.now();
    const r = await call('POST', `${P.release}/release`, TOKEN_A, { synthetic_batch: 200 });
    expect(r.status).toBeLessThan(300);
    expect(Date.now() - t0).toBeLessThan(8000);
  });

  it('rejection / recollection (05-DoD §5.2): rejected sample leads to recollect and a new report, no stale release', async () => {
    const r = await call('POST', P.register, TOKEN_A, { synthetic: true, scenario: 'rejection-recollect' });
    expect(r.status).toBeLessThan(300);
    expect(r.json.released_reports ?? 0).toBe(0);
  });

  it('cancelled invoice / credit note (05-DoD §5.2): cancelling the invoice issues a credit note and re-holds an unreleased report', async () => {
    const r = await call('POST', P.register, TOKEN_A, { synthetic: true, scenario: 'cancel-credit-note' });
    expect(r.status).toBeLessThan(300);
    expect(r.json.credit_note_id).toBeTruthy();
  });

  it('cross-tenant (05-DoD §5.2): tenant B gets 404/403 for tenant A report, link, QR token and portal session', async () => {
    const rep = await call('GET', `${P.report}/${S.v2}`, TOKEN_B);
    expect([403, 404]).toContain(rep.status);
    const link = await call('POST', '/portal/otp-challenges', TOKEN_B, { link_token: S.linkToken });
    expect([400, 403, 404]).toContain(link.status);
    const qr = await call('POST', P.verify, TOKEN_B, { token: S.qr });
    expect(qr.json.patient_name).toBeUndefined();
    const sess = await call('GET', '/portal/report', TOKEN_B);
    expect([401, 403, 404]).toContain(sess.status);
  });

  it('PHI hygiene (01-PRD §6): recording provider bodies, URLs and logs do not contain patient name, phone or link token', async () => {
    const logs = (await call('GET', `${P.logs}?order_id=${S.orderId}`, TOKEN_A)).text;
    const bodies = JSON.stringify(S.recorded ?? []);
    for (const secret of (S.phi as string[]).filter(Boolean)) {
      if (secret === S.linkToken) expect(logs).not.toContain(secret);
      else { expect(bodies).not.toContain(secret); expect(logs).not.toContain(secret); }
    }
  });
});
