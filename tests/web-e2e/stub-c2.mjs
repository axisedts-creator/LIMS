// Stub of C2 identity for T0D-14 web tests (synthetic data only).
// POST /v1/identity/auth/session/resolve  (resolveSession, C2 TRD §5.1) keyed by the __Host-lims_sid cookie value.
// Control: GET /__health, GET /__requests, DELETE /__requests, POST /__control {sid, mode:'expired'|'ok'}.
import { createServer } from 'node:http';

export const FAKE_JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0LWFjdG9yIn0.c3R1Yi1zaWduYXR1cmU';
const PORT = Number(process.env.STUB_C2_PORT ?? 4100);
const ALL = ['lab.status_board.read', 'billing.cash_report.read'];
const log = [];
const forced = new Map();

function cookieSid(h) {
  const m = /(?:^|;\s*)__Host-lims_sid=([^;]+)/.exec(h ?? '');
  return m ? decodeURIComponent(m[1]) : undefined;
}
function resolved(sid, idleSeconds, permissions) {
  const now = Date.now();
  return {
    access_token: FAKE_JWT,
    access_expires_at: new Date(now + 600_000).toISOString(),
    session: {
      session_id: sid, kind: 'tenant_staff', state: 'active', aal: 'aal2',
      idle_expires_at: new Date(now + idleSeconds * 1000).toISOString(),
      absolute_expires_at: new Date(now + 12 * 3600_000).toISOString(),
      actor: { display_name: 'Test Actor', tenant_code: 'tenant_a', roles: ['lab_technologist'], permissions },
    },
  };
}
const expired = {
  type: 'urn:lims:error:auth.session_expired', title: 'Session expired', status: 401,
  code: 'auth.session_expired', request_id: '01900000-0000-7000-8000-000000000001',
};

createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const url = new URL(req.url, 'http://x');
    const send = (status, body, type = 'application/json') => {
      res.writeHead(status, { 'content-type': type });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/__health') return send(200, { ok: true });
    if (url.pathname === '/__requests') {
      if (req.method === 'DELETE') { log.length = 0; return send(200, {}); }
      return send(200, log);
    }
    if (url.pathname === '/__control' && req.method === 'POST') {
      const b = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      if (b.mode === 'expired') forced.set(b.sid, true); else forced.delete(b.sid);
      return send(200, {});
    }
    if (url.pathname === '/v1/identity/auth/session/resolve' && req.method === 'POST') {
      const raw = Buffer.concat(chunks).toString();
      const sid = cookieSid(req.headers.cookie);
      log.push({ path: url.pathname, sid, bffKey: req.headers['x-lims-bff-key'], body: raw ? JSON.parse(raw) : undefined, cookie: req.headers.cookie, auth: req.headers.authorization });
      if (!sid || sid === 'sid-expired' || forced.has(sid)) return send(401, expired, 'application/problem+json');
      if (sid === 'sid-limited') return send(200, resolved(sid, 1200, ['lab.status_board.read']));
      if (sid === 'sid-expiring') return send(200, resolved(sid, 90, ALL));
      if (sid.startsWith('sid-full') || sid === 'sid-flip') return send(200, resolved(sid, 1200, ALL));
      return send(401, expired, 'application/problem+json');
    }
    send(404, { code: 'common.not_found' });
  });
}).listen(PORT, '127.0.0.1');
