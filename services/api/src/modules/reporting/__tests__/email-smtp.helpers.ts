// C6-T26 test helper: a tiny in-process dev SMTP sink (node:net/tls, no dependency) that records what a client sends, with switchable failure replies and optional real TLS.
import { generateKeyPairSync, sign, X509Certificate } from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';
import type { OutboundMessage } from '../delivery/transport.js';

export interface SinkOpts {
  greeting?: string;        // default '220 sink ready'
  advertiseAuth?: boolean;  // EHLO lists AUTH PLAIN LOGIN
  advertiseStartTls?: boolean; // EHLO lists STARTTLS but the sink cannot upgrade (proves the client insists)
  tls?: 'starttls' | 'implicit'; // real TLS with the test-time self-signed cert (testCert): STARTTLS upgrade, or TLS from the first byte
  authReply?: string;       // default '235 ok'
  mailReply?: string;       // default '250 ok'
  rcptReply?: string;       // default '250 ok'
  dataReply?: string;       // reply to DATA itself, default '354 go'
  endReply?: string;        // reply after <CRLF>.<CRLF>, default '250 2.0.0 queued as SINK0001'
  silent?: boolean;         // accept the TCP connection, never speak (timeout test)
}
export interface Parsed { headers: Map<string, string[]>; rawHeaders: string; rawBody: string; text: string; subject: string }
// authSecure[i] is true when auth[i] arrived over TLS; tlsHandshakes counts completed handshakes; tlsErrors counts failed ones (client refused the cert).
export interface Captured { commands: string[]; auth: string[]; authSecure: boolean[]; mailFrom?: string; rcpts: string[]; data?: string; connections: number; tlsHandshakes: number; tlsErrors: number }
export interface Sink { port: number; host: string; cap: Captured; close(): Promise<void>; message(): Parsed }

export async function startSink(o: SinkOpts = {}): Promise<Sink> {
  const cap: Captured = { commands: [], auth: [], authSecure: [], rcpts: [], connections: 0, tlsHandshakes: 0, tlsErrors: 0 };
  const sockets = new Set<net.Socket>();
  const { cert, key } = testCert();
  const ctx = tls.createSecureContext({ cert, key });
  const track = (s: net.Socket) => { sockets.add(s); s.on('close', () => sockets.delete(s)); s.on('error', () => {}); };

  // One SMTP session on `sock`; a STARTTLS upgrade starts a fresh session on the wrapped socket (state reset, RFC 3207).
  const session = (sock: net.Socket, secure: boolean, greet: boolean) => {
    let buf = Buffer.alloc(0); let inData = false; let awaitingAuth = false;
    const w = (l: string) => sock.write(`${l}\r\n`);
    if (greet) w(o.greeting ?? '220 sink ready');
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (inData) {
          const end = buf.indexOf('\r\n.\r\n');
          if (end < 0) return;
          const raw = buf.subarray(0, end + 2).toString('utf8');
          buf = buf.subarray(end + 5); inData = false;
          cap.data = raw.split('\r\n').map((l) => (l.startsWith('..') ? l.slice(1) : l)).join('\r\n');   // dot-unstuff
          w(o.endReply ?? '250 2.0.0 queued as SINK0001');
          continue;
        }
        const i = buf.indexOf('\r\n');
        if (i < 0) return;
        const line = buf.subarray(0, i).toString('utf8'); buf = buf.subarray(i + 2);
        if (awaitingAuth) { awaitingAuth = false; cap.auth.push(line); cap.authSecure.push(secure); w(o.authReply ?? '235 ok'); continue; }
        cap.commands.push(line);
        const u = line.toUpperCase();
        if (u.startsWith('EHLO') || u.startsWith('HELO')) {
          const offerTls = o.advertiseStartTls || (o.tls === 'starttls' && !secure);
          const ext = ['250-sink', ...(o.advertiseAuth ? ['250-AUTH PLAIN LOGIN'] : []), ...(offerTls ? ['250-STARTTLS'] : []), '250 8BITMIME'];
          sock.write(ext.join('\r\n') + '\r\n');
        } else if (u === 'STARTTLS' && o.tls === 'starttls' && !secure) {
          w('220 ready to start TLS');
          sock.removeListener('data', onData);
          const t = new tls.TLSSocket(sock, { isServer: true, secureContext: ctx });
          track(t); t.on('error', () => { cap.tlsErrors++; }); t.on('secure', () => { cap.tlsHandshakes++; });
          session(t, true, false);
          return;
        } else if (u.startsWith('AUTH')) {
          const parts = line.split(' ');
          if (parts.length >= 3) { cap.auth.push(line); cap.authSecure.push(secure); w(o.authReply ?? '235 ok'); } else { awaitingAuth = true; w('334 '); }
        } else if (u.startsWith('MAIL FROM')) { cap.mailFrom = line; w(o.mailReply ?? '250 ok'); }
        else if (u.startsWith('RCPT TO')) { if ((o.rcptReply ?? '250').startsWith('250')) cap.rcpts.push(line); w(o.rcptReply ?? '250 ok'); }
        else if (u === 'DATA') { const r = o.dataReply ?? '354 go'; w(r); if (r.startsWith('354')) inData = true; }
        else if (u === 'QUIT') { w('221 bye'); sock.end(); }
        else if (u === 'RSET' || u === 'NOOP') w('250 ok');
        else w('502 not implemented');
      }
    };
    sock.on('data', onData);
  };

  const onConn = (s: net.Socket, secure: boolean) => { track(s); cap.connections++; if (!o.silent) session(s, secure, true); };
  const server: net.Server = o.tls === 'implicit'
    ? tls.createServer({ cert, key }, (s) => { cap.tlsHandshakes++; onConn(s, true); }).on('tlsClientError', () => { cap.tlsErrors++; })
    : net.createServer((s) => onConn(s, false));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as net.AddressInfo).port;
  return {
    port, host: '127.0.0.1', cap,
    close: () => new Promise<void>((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }),
    message: () => parse(cap.data ?? ''),
  };
}

// ---- test-only self-signed certificate, generated in memory per run (no key or cert is committed) ----
const der = (tag: number, ...parts: Buffer[]) => {
  const body = Buffer.concat(parts); const n = body.length;
  const len = n < 0x80 ? Buffer.from([n]) : n < 0x100 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 0xff]);
  return Buffer.concat([Buffer.from([tag]), len, body]);
};
const hex = (h: string) => Buffer.from(h, 'hex');
const utc = (d: Date) => { const i = d.toISOString(); return der(0x17, Buffer.from(i.slice(2, 4) + i.slice(5, 7) + i.slice(8, 10) + i.slice(11, 13) + i.slice(14, 16) + i.slice(17, 19) + 'Z')); };
let cached: { cert: string; key: string } | undefined;
/** EC P-256 self-signed cert, CN smtp-sink.test, SAN IP 127.0.0.1, CA:TRUE so it can be handed to the client as the `ca` trust anchor. */
export function testCert(): { cert: string; key: string } {
  if (cached) return cached;
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const sigAlg = der(0x30, hex('06082a8648ce3d040302'));                                   // ecdsa-with-SHA256
  const name = der(0x30, der(0x31, der(0x30, hex('0603550403'), der(0x0c, Buffer.from('smtp-sink.test')))));
  const now = Date.now();
  const exts = der(0xa3, der(0x30,
    der(0x30, hex('0603551d13'), hex('0101ff'), der(0x04, der(0x30, hex('0101ff')))),      // basicConstraints CA:TRUE (critical)
    der(0x30, hex('0603551d11'), der(0x04, der(0x30, der(0x87, hex('7f000001')))))));     // subjectAltName iPAddress 127.0.0.1
  const tbs = der(0x30, hex('a003020102'), hex('020101'), sigAlg, name,
    der(0x30, utc(new Date(now - 86_400_000)), utc(new Date(now + 86_400_000))), name,
    publicKey.export({ type: 'spki', format: 'der' }) as Buffer, exts);
  const certDer = der(0x30, tbs, sigAlg, der(0x03, hex('00'), sign('sha256', tbs, privateKey)));
  const cert = `-----BEGIN CERTIFICATE-----\n${certDer.toString('base64').replace(/(.{64})/g, '$1\n')}\n-----END CERTIFICATE-----\n`;
  new X509Certificate(cert);   // fail loudly here if the DER is malformed
  return (cached = { cert, key: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string });
}

function b64(s: string) { return Buffer.from(s, 'base64').toString('utf8'); }
function qp(s: string) {
  return Buffer.from(s.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16))), 'latin1').toString('utf8');
}
/** RFC 2047 encoded-words -> text. */
export function decodeWords(v: string): string {
  return v.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=\s*/g, (_m, _cs, enc, t) => (enc.toUpperCase() === 'B' ? b64(t) : qp(t.replace(/_/g, ' '))));
}
function parse(data: string): Parsed {
  const i = data.indexOf('\r\n\r\n');
  const rawHeaders = i < 0 ? data : data.slice(0, i); const rawBody = i < 0 ? '' : data.slice(i + 4);
  const headers = new Map<string, string[]>();
  for (const l of rawHeaders.replace(/\r\n[ \t]+/g, ' ').split('\r\n')) {
    const k = l.indexOf(':'); if (k < 1) continue;
    const n = l.slice(0, k).toLowerCase(); headers.set(n, [...(headers.get(n) ?? []), l.slice(k + 1).trim()]);
  }
  const cte = (headers.get('content-transfer-encoding')?.[0] ?? '7bit').toLowerCase();
  const text = cte === 'base64' ? b64(rawBody.replace(/\s+/g, '')) : cte === 'quoted-printable' ? qp(rawBody) : rawBody;
  return { headers, rawHeaders, rawBody, text, subject: decodeWords(headers.get('subject')?.[0] ?? '') };
}

export const LINK = 'https://portal.example.test/r/Zk3pQ9synthetic';
export const msg = (over: Partial<OutboundMessage> = {}): OutboundMessage => ({
  deliveryId: '0d6f0c1e-0000-4000-8000-000000000026', channel: 'email', to: 'patient.0042@example.test',
  subject: 'Your report is ready', body: `Your report from Test Lab is ready: ${LINK}`, unicode: false, ...over,
});
// `ca` (optional PEM) is a dev/test trust anchor passed through to the TLS options; production relays use the system store.
export const creds = (s: Sink, over: Record<string, unknown> = {}) => ({
  host: s.host, port: s.port, security: 'none', from: 'reports@lab.example.test', timeoutMs: 2000, ...over,
});
export const rejection = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { return e; } throw new Error('expected rejection, got success'); };
