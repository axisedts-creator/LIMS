// Stub of the C6 reporting API for the C6-T43 portal dues-page E2E (synthetic data only). Prefix /v1/reporting. Port STUB_REPORTING_PORT (default 4128).
// Links (22-char tokens = name padded with '0'; all accept code 123456 and start session `sess-<name>`):
//   dues2     dues link, balance 50000, gateways [esewa, khalti]     duesnone  dues link, balance 50000, gateways []
//   duesz     dues link, balance 0 (paid, report not released yet)   duesrep   REPORT link (control: P2 link_purpose 'report', P3 works)
// Dues sessions: P3 / P4 -> 404 common.not_found (08 A21.1); P7 -> 200. Report sessions: P3 -> 200, P7 -> 200 with report_follows false.
// Control: GET /__health, GET /__requests, DELETE /__requests.
import { createServer } from 'node:http';

const PORT = Number(process.env.STUB_REPORTING_PORT ?? 4128);
const log = [];
const problem = (status, code, title) => ({ type: `urn:lims:error:${code}`, title, status, code, request_id: '01900000-0000-7000-8000-000000000001' });
const name = (tok) => tok.replace(/0+$/, '');
const LINKS = { dues2: 'dues', duesnone: 'dues', duesz: 'dues', duesrep: 'report' };
const issued = new Map();
const dues = (l) => (l === 'duesz' ? undefined : { balance_due_paisa: 50000, online_gateways: l === 'duesnone' ? [] : ['esewa', 'khalti'] });

createServer((req, res) => {
  const chunks = []; req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const url = new URL(req.url, 'http://x'); const bodyText = Buffer.concat(chunks).toString();
    const send = (status, body, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
    if (url.pathname === '/__health') return send(200, { ok: true });
    if (url.pathname === '/__requests') { if (req.method === 'DELETE') { log.length = 0; return send(200, {}); } return send(200, log); }
    let body; try { body = bodyText ? JSON.parse(bodyText) : undefined; } catch { body = bodyText; }
    const cred = String(req.headers['x-lims-portal-credential'] ?? '');
    log.push({ method: req.method, url: req.url, cred, bffKey: req.headers['x-lims-bff-key'], idempotencyKey: req.headers['idempotency-key'], body });
    const p = url.pathname.replace(/^\/v1\/reporting/, '');
    const stage = cred.split('.')[0]; const token = cred.slice(cred.indexOf('.') + 1);
    const link = stage === 'link' ? name(token) : undefined; const sl = stage === 'session' ? issued.get(token) : undefined;
    const invalid = () => send(404, problem(404, 'reporting.link_invalid', 'Link invalid'));
    const need = () => { if (stage === 'link') { send(401, problem(401, 'reporting.otp_required', 'OTP required')); return false; } if (!sl) { invalid(); return false; } return true; };
    if (p === '/portal/otp-challenges' && req.method === 'POST') return link in LINKS ? send(202, { challenge_id: `ch-${link}`, channel: 'sms' }) : invalid();
    const v = /^\/portal\/otp-challenges\/([^/]+)\/verify$/.exec(p);
    if (v && req.method === 'POST') {
      const lk = v[1].replace(/^ch-/, ''); if (stage !== 'link' || link !== lk) return invalid();
      if (body?.code !== '123456') return send(401, problem(401, 'auth.otp_invalid', 'Invalid code'));
      const st = `sess-${lk}`; issued.set(st, lk); const now = Date.now();
      return send(200, { session_token: st, idle_expires_at: new Date(now + 15 * 60_000).toISOString(), absolute_expires_at: new Date(now + 60 * 60_000).toISOString(), link_purpose: LINKS[lk] });
    }
    if (p === '/portal/dues' && req.method === 'GET') {
      if (!need()) return;
      return send(200, { lab_name: 'Test Diagnostics', ...(dues(sl) ? { dues: dues(sl) } : {}), report_follows: LINKS[sl] === 'dues' }, { 'cache-control': 'no-store' });
    }
    if (p === '/portal/report' && req.method === 'GET') {
      if (!need()) return;
      if (LINKS[sl] === 'dues') return send(404, problem(404, 'common.not_found', 'Not found'));
      return send(200, { lab_name: 'Test Diagnostics', patient_display: 'A.B.', report: { family: 'laboratory', report_kind: 'final', status_label: 'Final', issued_at: '2026-11-01T04:15:00.000Z', version_no: 1, panel_names: ['Complete Blood Count'] }, download: { report_version_id: `ver-${sl}-1` } }, { 'cache-control': 'no-store' });
    }
    if (/^\/portal\/report-versions\/[^/]+\/pdf$/.test(p) && req.method === 'GET') { if (!need()) return; return send(404, problem(404, 'common.not_found', 'Not found')); }
    if (p === '/portal/payment-requests' && req.method === 'POST') { if (!need()) return; return send(202, { id: 'pr-1', status: 'queued', gateway: body?.gateway, review: false }); }
    if (p === '/portal/payment-requests/pr-1' && req.method === 'GET') { if (!need()) return; return send(200, { id: 'pr-1', status: 'queued', gateway: 'esewa', review: false }, { 'cache-control': 'no-store' }); }
    if (p === '/portal/sessions/end' && req.method === 'POST') { if (!need()) return; issued.delete(token); res.writeHead(204); return res.end(); }
    return send(404, problem(404, 'common.not_found', 'Not found'));
  });
}).listen(PORT, '127.0.0.1');
