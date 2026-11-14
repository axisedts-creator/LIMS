// Stub of the C6 reporting API for the C6-T42 portal dues-payment E2E (synthetic data only; fake gateway: no real URL is ever contacted). Prefix /v1/reporting.
// Links (22-char tokens = name padded with '0'): all accept code 123456 and start session `sess-<name>`; report page data = P3 with a `dues` block:
//   pay2     balance 50000, online_gateways [esewa, khalti]          paynone  balance 50000, online_gateways []   (not 'pay0': name() strips trailing zeros)
//   payref   referrer link: no dues block (PP1 -> 404)               payopen  as pay2 + open_request {id: pr-open, status: queued}; PP1 -> 200 pr-open
//   paycf    as pay2; PP1 -> 409 version_conflict / payment_in_progress (open request through another link)
// PP1 answers 202 {id: pr-1, status: queued}. PP2 answers by the control mode (POST /__control {mode}): queued (default) | ready | review | completed | failed_unavail | failed_nothing | failed_payment | expired.
// Control: GET /__health, GET /__requests, DELETE /__requests, POST /__control {mode}.
import { createServer } from 'node:http';

const PORT = Number(process.env.STUB_REPORTING_PORT ?? 4127);
const log = []; let mode = 'queued';
const GATEWAY_URL = 'https://gateway.fake.invalid/pay/pr-1';
const problem = (status, code, title, extra = {}) => ({ type: `urn:lims:error:${code}`, title, status, code, request_id: '01900000-0000-7000-8000-000000000001', ...extra });
const name = (tok) => tok.replace(/0+$/, '');
const LINKS = new Set(['pay2', 'paynone', 'payref', 'payopen', 'paycf']);
const dues = (link) => link === 'payref' ? undefined : { balance_due_paisa: 50000, online_gateways: link === 'paynone' ? [] : ['esewa', 'khalti'], ...(link === 'payopen' ? { open_request: { id: 'pr-open', status: 'queued' } } : {}) };
const report = (link) => ({ lab_name: 'Test Diagnostics', patient_display: 'A.B.', report: { family: 'laboratory', report_kind: 'final', status_label: 'Final', issued_at: '2026-11-01T04:15:00.000Z', version_no: 1, panel_names: ['Complete Blood Count'] },
  download: { report_version_id: `ver-${link}-1` }, ...(dues(link) ? { dues: dues(link) } : {}) });
const pr = (id, gateway = 'esewa') => {
  const b = { id, gateway, review: false };
  switch (id === 'pr-open' ? 'queued' : mode) {
    case 'ready': return { ...b, status: 'ready', amount_paisa: 50000, action_url: GATEWAY_URL, intent_expires_at: '2026-11-05T04:30:00.000Z' };
    case 'review': return { ...b, status: 'ready', review: true, amount_paisa: 50000 };
    case 'completed': return { ...b, status: 'completed', amount_paisa: 50000 };
    case 'failed_unavail': return { ...b, status: 'failed', failure_code: 'gateway_not_available' };
    case 'failed_nothing': return { ...b, status: 'failed', failure_code: 'nothing_due' };
    case 'failed_payment': return { ...b, status: 'failed', failure_code: 'payment_failed' };
    case 'expired': return { ...b, status: 'expired' };
    default: return { ...b, status: 'queued' };
  }
};
const issued = new Map();   // session token -> link name

createServer((req, res) => {
  const chunks = []; req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const url = new URL(req.url, 'http://x'); const bodyText = Buffer.concat(chunks).toString();
    const send = (status, body, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
    if (url.pathname === '/__health') return send(200, { ok: true });
    if (url.pathname === '/__requests') { if (req.method === 'DELETE') { log.length = 0; return send(200, {}); } return send(200, log); }
    if (url.pathname === '/__control' && req.method === 'POST') { mode = JSON.parse(bodyText || '{}').mode === 'reset' ? 'queued' : JSON.parse(bodyText).mode; return send(200, {}); }
    let body; try { body = bodyText ? JSON.parse(bodyText) : undefined; } catch { body = bodyText; }
    const cred = String(req.headers['x-lims-portal-credential'] ?? '');
    log.push({ method: req.method, url: req.url, cred, bffKey: req.headers['x-lims-bff-key'], authorization: req.headers.authorization, idempotencyKey: req.headers['idempotency-key'], body });
    const p = url.pathname.replace(/^\/v1\/reporting/, '');
    const stage = cred.split('.')[0]; const token = cred.slice(cred.indexOf('.') + 1);
    const link = stage === 'link' ? name(token) : undefined; const sessionLink = stage === 'session' ? issued.get(token) : undefined;
    const invalid = () => send(404, problem(404, 'reporting.link_invalid', 'Link invalid'));
    const needSession = () => { if (stage === 'link') { send(401, problem(401, 'reporting.otp_required', 'OTP required')); return false; } if (!sessionLink) { invalid(); return false; } return true; };
    if (p === '/portal/otp-challenges' && req.method === 'POST') return LINKS.has(link) ? send(202, { challenge_id: `ch-${link}`, channel: 'sms' }) : invalid();
    const v = /^\/portal\/otp-challenges\/([^/]+)\/verify$/.exec(p);
    if (v && req.method === 'POST') {
      const lk = v[1].replace(/^ch-/, ''); if (stage !== 'link' || link !== lk) return invalid();
      if (body?.code !== '123456') return send(401, problem(401, 'auth.otp_invalid', 'Invalid code'));
      const st = `sess-${lk}`; issued.set(st, lk); const now = Date.now();
      return send(200, { session_token: st, idle_expires_at: new Date(now + 15 * 60_000).toISOString(), absolute_expires_at: new Date(now + 60 * 60_000).toISOString(), link_purpose: 'report' });
    }
    if (p === '/portal/report' && req.method === 'GET') return needSession() ? send(200, report(sessionLink), { 'cache-control': 'no-store' }) : undefined;
    if (p === '/portal/payment-requests' && req.method === 'POST') {
      if (!needSession()) return;
      if (sessionLink === 'payref') return send(404, problem(404, 'common.not_found', 'Not found'));
      if (!['esewa', 'khalti'].includes(body?.gateway) || Object.keys(body).length !== 1) return send(400, problem(400, 'common.validation_failed', 'Validation failed'));
      if (sessionLink === 'paycf') return send(409, problem(409, 'common.version_conflict', 'Conflict', { detail: 'payment_in_progress' }));
      if (sessionLink === 'payopen') return send(200, pr('pr-open', body.gateway));
      return send(202, { id: 'pr-1', status: 'queued', gateway: body.gateway, review: false });
    }
    const g = /^\/portal\/payment-requests\/([^/]+)$/.exec(p);
    if (g && req.method === 'GET') { if (!needSession()) return; return send(200, pr(g[1], 'esewa'), { 'cache-control': 'no-store' }); }
    if (p === '/portal/sessions/end' && req.method === 'POST') { if (!needSession()) return; issued.delete(token); res.writeHead(204); return res.end(); }
    return send(404, problem(404, 'common.not_found', 'Not found'));
  });
}).listen(PORT, '127.0.0.1');
