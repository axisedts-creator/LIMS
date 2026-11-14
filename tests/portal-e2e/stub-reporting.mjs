// Stub of the C6 reporting API for C6-T30 portal tests (synthetic data only). Prefix /v1/reporting (02-TRD §6.6, §6.7 Q1).
// Link tokens are 22 chars: `pad('ok')` = 'ok' + '0' x 20. The stub is keyed on the tail-trimmed name.
//   ok     valid link -> session 'sess-ok' (report, no smart summary)
//   upd    valid link, latest version is v2 (updated_notice, 08 AC-11.7)
//   smart  valid link, report carries smart_summary ; badsmart: smart_summary that cannot be rendered
//   ex5    valid link; 5 wrong codes exhaust the challenge (AC-11.3)
//   rl     P1 answers 429 common.rate_limited (AC-11.4)
//   dl     valid link; 21st PDF download answers 429 (AC-11.6)
//   exp    expired link: P1 404 reporting.link_invalid, P5 202   rev / unk: P1 404, P5 404   boom: P5 500
// Control: GET /__health, GET /__requests, DELETE /__requests, POST /__control {mode:'expire_sessions'|'reset'}.
import { createServer } from 'node:http';

const PORT = Number(process.env.STUB_REPORTING_PORT ?? 4126);
const pad = (n) => n.padEnd(22, '0');
const name = (tok) => tok.replace(/0+$/, '');
const VALID = new Set(['ok', 'upd', 'smart', 'badsmart', 'ex5', 'dl', 'rl']);
const log = [];
let expired = false;
const wrong = new Map(); // challenge_id -> count
const dls = new Map(); // session -> count
const issued = new Map(); // session token -> link name

const PDF = Buffer.from('%PDF-1.4\n% synthetic portal test pdf\n%%EOF\n');
const problem = (status, code, title, extra = {}) => ({ type: `urn:lims:error:${code}`, title, status, code, request_id: '01900000-0000-7000-8000-000000000001', ...extra });
const SMART = {
  summaryId: '01900000-0000-7000-8000-0000000000a1', orderId: '01900000-0000-7000-8000-0000000000a2', reportVersionNo: 1,
  templateLibraryVersion: 't1', status: 'approved', language: 'en',
  healthScore: { value: 82, band: 'good', formulaVersion: 'f1', panelsScored: 1 },
  panels: [{ panelCode: 'CBC', status: 'borderline', resultIds: [], displayName: 'Complete Blood Count' }],
  deranged: [{ resultId: '01900000-0000-7000-8000-0000000000a3', analyteId: '01900000-0000-7000-8000-0000000000a4', direction: 'low', severity: 'borderline', templateBlockId: '01900000-0000-7000-8000-0000000000a5', text: 'Haemoglobin is slightly low.', analyteName: 'Haemoglobin' }],
  advice: [{ templateBlockId: '01900000-0000-7000-8000-0000000000a6', text: 'Eat iron-rich food.' }],
  followUps: [{ ruleId: '01900000-0000-7000-8000-0000000000a7', suggestedTestCode: 'FERR', intervalDays: 90, text: 'Repeat in 3 months.', suggestedTestName: 'Serum Ferritin' }],
  trends: [], disclaimerBlockId: '01900000-0000-7000-8000-0000000000a8', disclaimerText: 'SYNTHETIC-DISCLAIMER-TEXT-FOR-TESTS',
};

function report(link, ver) {
  const base = {
    lab_name: 'Test Diagnostics', patient_display: 'A.B.',
    report: { family: 'laboratory', report_kind: 'final', status_label: 'Final', issued_at: '2026-11-01T04:15:00.000Z', version_no: ver, panel_names: ['Complete Blood Count', 'Lipid Profile'] },
    download: { report_version_id: `ver-${link}-${ver}` },
  };
  if (link === 'upd') base.report.updated_notice = { previous_version_no: 1, updated_at: '2026-11-03T05:00:00.000Z' };
  if (link === 'smart') base.smart_summary = SMART;
  if (link === 'badsmart') base.smart_summary = { broken: true };
  return base;
}

createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const url = new URL(req.url, 'http://x');
    const bodyText = Buffer.concat(chunks).toString();
    const send = (status, body, headers = {}, type = 'application/json') => {
      res.writeHead(status, { 'content-type': type, ...headers });
      res.end(Buffer.isBuffer(body) ? body : JSON.stringify(body));
    };
    if (url.pathname === '/__health') return send(200, { ok: true });
    if (url.pathname === '/__requests') {
      if (req.method === 'DELETE') { log.length = 0; wrong.clear(); dls.clear(); return send(200, {}); }
      return send(200, log);
    }
    if (url.pathname === '/__control' && req.method === 'POST') {
      const b = JSON.parse(bodyText || '{}');
      expired = b.mode === 'expire_sessions';
      return send(200, {});
    }
    let body; try { body = bodyText ? JSON.parse(bodyText) : undefined; } catch { body = bodyText; }
    const cred = String(req.headers['x-lims-portal-credential'] ?? '');
    log.push({ method: req.method, url: req.url, cred, bffKey: req.headers['x-lims-bff-key'], xff: req.headers['x-forwarded-for'], authorization: req.headers.authorization, headers: req.headers, body });
    const p = url.pathname.replace(/^\/v1\/reporting/, '');
    const invalid = () => send(404, problem(404, 'reporting.link_invalid', 'Link invalid'));
    const [stage, token = ''] = [cred.split('.')[0], cred.slice(cred.indexOf('.') + 1)];
    const link = stage === 'link' ? name(token) : undefined;
    const sessionLink = stage === 'session' ? issued.get(token) : undefined;

    if (p === '/verifications' && req.method === 'POST') {
      const t = name(String(body?.qr_token ?? ''));
      if (t === 'qrok') return send(200, { lab_name: 'Test Diagnostics', patient_display: 'A.B.', panel_names: ['Complete Blood Count'], issued_at: '2026-11-01T04:15:00.000Z', version_no: 1, status: 'valid' });
      if (t === 'qrsup') return send(200, { lab_name: 'Test Diagnostics', patient_display: 'A.B.', panel_names: ['Complete Blood Count'], issued_at: '2026-11-01T04:15:00.000Z', version_no: 1, status: 'superseded' });
      if (t === 'qrrl') return send(429, problem(429, 'common.rate_limited', 'Rate limited'), { 'retry-after': '3600' });
      if (t === 'qrboom') return send(500, problem(500, 'common.internal', 'Internal error'));
      return send(404, problem(404, 'reporting.verify_not_found', 'Not found')); // unknown/revoked/unreleased/discarded/malformed: identical
    }
    if (p === '/portal/otp-challenges' && req.method === 'POST') {
      if (link === 'rl') return send(429, problem(429, 'common.rate_limited', 'Rate limited'), { 'retry-after': '3600' });
      if (!VALID.has(link)) return invalid();
      return send(202, { challenge_id: `ch-${link}`, channel: 'sms' });
    }
    const v = /^\/portal\/otp-challenges\/([^/]+)\/verify$/.exec(p);
    if (v && req.method === 'POST') {
      const lk = v[1].replace(/^ch-/, '');
      if (stage !== 'link' || link !== lk) return invalid();
      const n = wrong.get(v[1]) ?? 0;
      if (n >= 5) return send(401, problem(401, 'auth.otp_attempts_exhausted', 'Attempts exhausted'));
      if (body?.code !== '123456') {
        wrong.set(v[1], n + 1);
        return n + 1 >= 5 && lk === 'ex5'
          ? send(401, problem(401, 'auth.otp_attempts_exhausted', 'Attempts exhausted'))
          : send(401, problem(401, 'auth.otp_invalid', 'Invalid code'));
      }
      const st = `sess-${lk}`; issued.set(st, lk);
      const now = Date.now();
      return send(200, { session_token: st, idle_expires_at: new Date(now + 15 * 60_000).toISOString(), absolute_expires_at: new Date(now + 60 * 60_000).toISOString(), link_purpose: 'report' });
    }
    if (p === '/portal/link-reissues' && req.method === 'POST') {
      if (link === 'boom') return send(500, problem(500, 'common.internal', 'Internal error'));
      if (link === 'exp') return send(202, {});
      return invalid();
    }
    const needSession = () => {
      if (stage === 'link' || stage === 'expired_link' || (stage === 'session' && expired)) { send(401, problem(401, 'reporting.otp_required', 'OTP required')); return false; }
      if (stage !== 'session' || !sessionLink) { invalid(); return false; }
      return true;
    };
    if (p === '/portal/report' && req.method === 'GET') {
      if (!needSession()) return;
      return send(200, report(sessionLink, sessionLink === 'upd' ? 2 : 1), { 'cache-control': 'no-store' });
    }
    const d = /^\/portal\/report-versions\/([^/]+)\/pdf$/.exec(p);
    if (d && req.method === 'GET') {
      if (!needSession()) return;
      const ver = sessionLink === 'upd' ? 2 : 1;
      if (d[1] !== `ver-${sessionLink}-${ver}`) return send(404, problem(404, 'common.not_found', 'Not found'));
      const n = (dls.get(token) ?? 0) + 1; dls.set(token, n);
      if (sessionLink === 'dl' && n > 20) return send(429, problem(429, 'common.rate_limited', 'Rate limited'), { 'retry-after': '3600' });
      return send(200, PDF, { 'content-disposition': 'attachment; filename="report.pdf"', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }, 'application/pdf');
    }
    if (p === '/portal/sessions/end' && req.method === 'POST') {
      if (!needSession()) return;
      issued.delete(token);
      res.writeHead(204); return res.end();
    }
    return send(404, problem(404, 'common.not_found', 'Not found'));
  });
}).listen(PORT, '127.0.0.1');
export { pad };
