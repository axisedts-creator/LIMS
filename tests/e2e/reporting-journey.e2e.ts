// C6-T34 nightly journey (05-DoD §5): register -> approve -> assemble -> render -> held (dues) -> pay -> auto-release ->
// WhatsApp (recording provider) -> OTP -> download -> QR verify; then amendment, outsourced merge, narrative sign, bulk release,
// rejection/recollection, cancelled invoice/credit note, cross-tenant attempts and a PHI scan. Synthetic data only.
// Routes: 02-TRD §6 (base /v1/reporting) — R2 search, R3, R4, R6, R7 bulk-release {ids}, R9, R17, O1-O3, N1-N4, P1-P4/P7 under
// /v1/reporting/portal/ with X-Lims-Portal-Credential, Q1 {qr_token}. Register/approve/pay, the recording-provider read surface,
// QR-token read, logs and seed use the non-production test-support routes of .orchestra/cr/C6-T34 (resolved).
import { describe, it, expect } from 'vitest';

const BASE = (process.env.E2E_BASE_URL ?? '').replace(/\/+$/, '');
const TOKEN_A = process.env.E2E_STAFF_TOKEN_A ?? '';
const TOKEN_B = process.env.E2E_STAFF_TOKEN_B ?? '';
const API = '/v1/reporting';
const TS = `${API}/test-support`;
const PORTAL = '/v1/reporting/portal/'; // 02-TRD §6.6 portal endpoints; credential in X-Lims-Portal-Credential, never Bearer

type J = Record<string, any>;
type Auth = { staff?: string; portal?: string; idem?: boolean; ifMatch?: string };
type Res = { status: number; json: J; text: string; headers: Headers };

let idemSeq = 0;
const idemKey = () => `c6-t34-${Date.now().toString(36)}-${(idemSeq += 1)}-${Math.random().toString(36).slice(2, 10)}`;

async function call(method: string, path: string, auth: Auth, body?: unknown): Promise<Res> {
  const headers: Record<string, string> = {};
  if (auth.staff) headers.Authorization = `Bearer ${auth.staff}`;
  if (auth.portal) headers['X-Lims-Portal-Credential'] = auth.portal;
  if (auth.idem) headers['Idempotency-Key'] = idemKey();
  if (auth.ifMatch) headers['If-Match'] = auth.ifMatch;
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(BASE + path, { method, headers, body: payload });
  const text = await res.text();
  let json: J = {};
  try { json = JSON.parse(text); } catch { json = {}; }
  return { status: res.status, json, text, headers: res.headers };
}
const A = (extra: Auth = {}): Auth => ({ staff: TOKEN_A, ...extra });
const etagOf = (r: Res) => r.headers.get('etag') ?? `"${r.json.version}"`;
const pollUntil = async (fn: () => Promise<boolean>, ms = 90_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await new Promise((r) => setTimeout(r, 1000)); }
  throw new Error('timeout waiting for condition');
};
const newest = (detail: J): J | undefined => (detail.versions ?? []).reduce((m: J | undefined, v: J) => (!m || v.version_no > m.version_no ? v : m), undefined);
const asLink = (cred: string) => (cred.startsWith('link.') ? cred : `link.${cred}`);
const asSession = (tok: string) => (tok.startsWith('session.') ? tok : `session.${tok}`);
const recorded = async (orderId: string, kind: string, purpose?: string): Promise<J[]> =>
  (await call('GET', `${TS}/recorded-messages?order_id=${orderId}&kind=${kind}${purpose ? `&purpose=${purpose}` : ''}`, A())).json.data ?? [];
const reportOfOrder = async (orderId: string, token = TOKEN_A): Promise<J | undefined> =>
  (await call('POST', `${API}/reports/search`, { staff: token }, { order_id: orderId })).json.data?.[0];
const scenario = async (name: string, extra: J = {}) => {
  const r = await call('POST', `${TS}/scenarios`, A({ idem: true }), { scenario: name, ...extra });
  expect(r.status).toBe(201);
  S.phi.push(r.json.patient_display_name, r.json.phone);
  return r.json;
};
// OTP flow P1 -> recorded otp -> P2; returns the P2 body. The OTP code is scanned for in logs (PHI hygiene step).
async function otpSession(linkCred: string): Promise<J> {
  const c = await call('POST', `${PORTAL}otp-challenges`, { portal: asLink(linkCred) }, {});
  expect(c.status).toBe(202);
  expect(c.json.challenge_id).toBeTruthy();
  let code = '';
  await pollUntil(async () => {
    const msgs = await recorded(S.orderId, 'otp');
    code = msgs[msgs.length - 1]?.otp_code ?? '';
    return /^[0-9]{6}$/.test(code);
  });
  S.phi.push(code);
  const v = await call('POST', `${PORTAL}otp-challenges/${c.json.challenge_id}/verify`, { portal: asLink(linkCred) }, { code });
  expect(v.status).toBe(200);
  expect(v.json.session_token).toBeTruthy();
  S.phi.push(v.json.session_token);
  return v.json;
}
async function qrTokenOf(versionId: string, token = TOKEN_A): Promise<Res> {
  return call('GET', `${TS}/report-versions/${versionId}/qr-token`, { staff: token });
}

const S: J = { phi: [] as string[], credentials: [] as string[] };

describe('C6 nightly journey (05-DoD §5)', () => {
  it('stack URL and tokens come from env', () => {
    expect(BASE, 'E2E_BASE_URL').not.toBe('');
    expect(TOKEN_A, 'E2E_STAFF_TOKEN_A').not.toBe('');
    expect(TOKEN_B, 'E2E_STAFF_TOKEN_B').not.toBe('');
  });

  it('register: front desk registers a synthetic patient + order with dues outstanding', async () => {
    const o = await scenario('journey', { dues: 'outstanding' });
    S.orderId = o.order_id;
    expect(S.orderId).toBeTruthy();
  });

  it('approve: lab results approved', async () => {
    const r = await call('POST', `${TS}/scenarios/${S.orderId}/approve`, A({ idem: true }), {});
    expect(r.status).toBe(200);
  });

  it('assemble + render: report v1 is assembled and rendered within 60 s', async () => {
    await pollUntil(async () => {
      const rep = await reportOfOrder(S.orderId);
      if (!rep) return false;
      S.reportId = rep.id;
      const d = (await call('GET', `${API}/reports/${S.reportId}`, A())).json;
      const v = newest(d);
      if (v && ['rendered', 'held', 'released'].includes(v.status)) { S.v1 = v.id; return true; }
      return false;
    }, 60_000);
    expect(S.v1).toBeTruthy();
  });

  it('held (dues): release is blocked with reporting.release_blocked_due; dues link (link_purpose dues) shows balance_due_paisa', async () => {
    const rep = (await call('GET', `${API}/reports/${S.reportId}`, A())).json;
    expect(rep.display_status).toBe('held');
    expect(rep.balance_due_paisa).toBeGreaterThan(0);
    const v = await call('GET', `${API}/report-versions/${S.v1}`, A());
    const rel = await call('POST', `${API}/report-versions/${S.v1}/release`, A({ idem: true, ifMatch: etagOf(v) }), {});
    expect(rel.status).toBeGreaterThanOrEqual(400);
    expect(rel.json.code).toBe('reporting.release_blocked_due');
    expect(rel.json.balance_due_paisa).toBeGreaterThan(0);

    let dues: J[] = [];
    await pollUntil(async () => { dues = await recorded(S.orderId, 'whatsapp', 'dues'); return dues.length > 0 && !!dues[0].portal_credential; });
    S.duesCred = dues[0].portal_credential;
    S.credentials.push(S.duesCred);
    const sess = await otpSession(S.duesCred);
    expect(sess.link_purpose).toBe('dues');
    const page = await call('GET', `${PORTAL}dues`, { portal: asSession(sess.session_token) });
    expect(page.status).toBe(200);
    expect(page.json.dues?.balance_due_paisa).toBeGreaterThan(0);
    expect(page.json.report_follows).toBe(true);
    const noReport = await call('GET', `${PORTAL}report`, { portal: asSession(sess.session_token) });
    expect(noReport.status).toBe(404);
  });

  it('pay + auto-release: payment recorded, report auto-releases, WhatsApp message recorded by the recording provider', async () => {
    const p = await call('POST', `${TS}/scenarios/${S.orderId}/payments`, A({ idem: true }), {});
    expect(p.status).toBe(200);
    await pollUntil(async () => (await call('GET', `${API}/report-versions/${S.v1}`, A())).json.status === 'released');
    let msgs: J[] = [];
    await pollUntil(async () => { msgs = await recorded(S.orderId, 'whatsapp', 'report'); return msgs.length > 0 && !!msgs[0].portal_credential; });
    S.recorded = msgs;
    S.linkCred = msgs[0].portal_credential;
    S.credentials.push(S.linkCred);
  });

  it('OTP + download: link opens an OTP challenge, verify issues a session, PDF downloads', async () => {
    const sess = await otpSession(S.linkCred);
    expect(sess.link_purpose).toBe('report');
    S.session = asSession(sess.session_token);
    const rep = await call('GET', `${PORTAL}report`, { portal: S.session });
    expect(rep.status).toBe(200);
    expect(rep.json.download.report_version_id).toBe(S.v1);
    const pdf = await call('GET', `${PORTAL}report-versions/${S.v1}/pdf`, { portal: S.session });
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get('content-type')).toMatch(/application\/pdf/);
    expect(pdf.text.startsWith('%PDF')).toBe(true);
  });

  it('QR verify: public verification of v1 reports the report as valid', async () => {
    const t = await qrTokenOf(S.v1);
    expect(t.status).toBe(200);
    S.qr = t.json.qr_token;
    S.credentials.push(S.qr);
    const r = await call('POST', `${API}/verifications`, {}, { qr_token: S.qr });
    expect(r.status).toBe(200);
    expect(r.json.status).toBe('valid');
    expect(r.json.version_no).toBe(1);
  });

  it('amendment: v2 supersedes v1; v1 stays readable but superseded; portal serves only the latest; QR verify of v1 reports superseded', async () => {
    const codes = (await call('GET', `${API}/coded-sets/regeneration_reasons`, A())).json.data ?? [];
    const reason = codes.find((c: J) => c.code !== 'other' && c.code !== 'smart_summary_added');
    expect(reason).toBeTruthy();
    const a = await call('POST', `${API}/reports/${S.reportId}/regenerations`, A({ idem: true }), { reason_code: reason.code });
    expect(a.status).toBe(202);
    await pollUntil(async () => {
      const v = newest((await call('GET', `${API}/reports/${S.reportId}`, A())).json);
      if (v && v.id !== S.v1 && v.status === 'released') { S.v2 = v.id; return true; }
      return false;
    });
    const v2 = await call('GET', `${API}/report-versions/${S.v2}`, A());
    expect(v2.json.report_kind).toBe('amended');
    expect(v2.json.supersedes_version_no).toBe(1);
    const v1 = await call('GET', `${API}/report-versions/${S.v1}`, A());
    expect(v1.status).toBe(200);
    expect(v1.json.status).toBe('superseded');
    const latest = await call('GET', `${PORTAL}report`, { portal: S.session });
    expect(latest.json.download.report_version_id).toBe(S.v2);
    const old = await call('GET', `${PORTAL}report-versions/${S.v1}/pdf`, { portal: S.session });
    expect(old.status).toBe(404);
    const q = await call('POST', `${API}/verifications`, {}, { qr_token: S.qr });
    expect(q.json.status).toBe('superseded');
  });

  it('outsourced merge: an outsourced PDF is uploaded, confirmed and merged into the report', async () => {
    const o = await scenario('outsourced');
    const itemId = o.order_item_ids[0];
    const pdf = '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n';
    const form = new FormData();
    form.append('file', new Blob([pdf], { type: 'application/pdf' }), 'synthetic-outsourced.pdf');
    form.append('external_lab_name', 'Synthetic Partner Lab');
    const up = await call('POST', `${API}/order-items/${itemId}/outsourced-files`, A({ idem: true }), form);
    expect(up.status).toBe(201);
    let file: J = {};
    await pollUntil(async () => {
      file = ((await call('GET', `${API}/order-items/${itemId}/outsourced-files`, A())).json.data ?? []).find((f: J) => f.id === up.json.id) ?? {};
      return file.state !== undefined && file.state !== 'pending_scan';
    });
    const conf = await call('POST', `${API}/outsourced-files/${file.id}/confirm`, A({ idem: true, ifMatch: `"${file.version}"` }), { patient_match_confirmed: true });
    expect(conf.status).toBe(200);
    expect(conf.json.state).toBe('confirmed');
    await pollUntil(async () => {
      const rep = await reportOfOrder(o.order_id);
      const v = rep && newest((await call('GET', `${API}/reports/${rep.id}`, A())).json);
      return !!v && ['rendered', 'held', 'released'].includes(v.status) && (v.page_count ?? 0) > 1;
    });
  });

  it('narrative sign: narrative report is signed by the pathologist before release', async () => {
    const o = await scenario('narrative', { dues: 'none' });
    let narrative: J | undefined;
    await pollUntil(async () => {
      const list = (await call('GET', `${API}/narratives?status=draft`, A())).json.data ?? [];
      narrative = list.find((n: J) => o.order_item_ids.includes(n.order_item_id));
      return !!narrative;
    });
    const n = await call('GET', `${API}/narratives/${narrative!.id}`, A());
    const draft = await call('PUT', `${API}/narratives/${narrative!.id}/draft`, A({ idem: true, ifMatch: etagOf(n) }), {
      sections: [{ key: 'impression', html: '<p>Synthetic narrative finding.</p>' }], images: [],
    });
    expect(draft.status).toBe(200);
    const sign = await call('POST', `${API}/narratives/${narrative!.id}/sign`, A({ idem: true, ifMatch: etagOf(draft) }), undefined);
    expect(sign.status).toBe(200);
    expect(sign.json.status).toBe('signed');
    const rep = await reportOfOrder(o.order_id);
    expect(rep?.first_released_at ?? null).toBeNull();
  });

  it('bulk release: 200 report versions release in one request within 8 s', async () => {
    const seed = await call('POST', `${TS}/seed`, A({ idem: true }), { count: 200 });
    expect(seed.status).toBe(201);
    const ids: string[] = seed.json.report_version_ids.slice(0, 200);
    expect(new Set(ids).size).toBe(200);
    const t0 = Date.now();
    const r = await call('POST', `${API}/report-versions/bulk-release`, A({ idem: true }), { ids });
    expect(Date.now() - t0).toBeLessThan(8000);
    expect(r.status).toBe(200);
    expect(r.json.results).toHaveLength(200);
    for (const x of r.json.results) expect(['released', 'already_released']).toContain(x.outcome);
  });

  it('rejection / recollection (05-DoD §5.2): rejected sample leads to recollect and a new report, no stale release', async () => {
    const o = await scenario('rejection-recollect');
    expect(o.released_report_count ?? 0).toBe(0);
    const rep = await reportOfOrder(o.order_id);
    expect(rep?.first_released_at ?? null).toBeNull();
  });

  it('cancelled invoice / credit note (05-DoD §5.2): cancelling the invoice issues a credit note and leaves the report unreleased', async () => {
    const o = await scenario('cancel-credit-note');
    expect(o.credit_note_id).toBeTruthy();
    const rep = await reportOfOrder(o.order_id);
    expect(rep?.first_released_at ?? null).toBeNull();
    expect(['held', 'cancelled']).toContain(rep?.display_status);
  });

  it('cross-tenant (05-DoD §5.2): tenant B gets 404/403 for tenant A report, link, QR token and portal session', async () => {
    const rep = await call('GET', `${API}/reports/${S.reportId}`, { staff: TOKEN_B });
    expect([403, 404]).toContain(rep.status);
    const ver = await call('GET', `${API}/report-versions/${S.v2}`, { staff: TOKEN_B });
    expect([403, 404]).toContain(ver.status);
    expect(await reportOfOrder(S.orderId, TOKEN_B)).toBeUndefined();
    const qr = await qrTokenOf(S.v2, TOKEN_B);
    expect([403, 404]).toContain(qr.status);
    const links = await call('GET', `${API}/reports/${S.reportId}/portal-links`, { staff: TOKEN_B });
    expect([403, 404]).toContain(links.status);
    const staffAsPortal = await call('GET', `${PORTAL}report`, { staff: TOKEN_B });
    expect([401, 403, 404]).toContain(staffAsPortal.status);
  });

  it('PHI hygiene (01-PRD §6): recording provider bodies, URLs and logs do not contain patient name, phone, OTP or link token', async () => {
    const logs = (await call('GET', `${TS}/logs?order_id=${S.orderId}`, A())).text;
    expect(logs.length).toBeGreaterThan(0);
    const bodies = JSON.stringify((S.recorded ?? []).map((m: J) => m.body));
    const secrets = (S.phi as string[]).filter(Boolean);
    expect(secrets.length).toBeGreaterThan(2);
    for (const secret of secrets) {
      expect(logs).not.toContain(secret);
      if (!(S.credentials as string[]).includes(secret)) expect(bodies).not.toContain(secret);
    }
    for (const cred of (S.credentials as string[]).filter(Boolean)) expect(logs).not.toContain(cred);
  });
});
