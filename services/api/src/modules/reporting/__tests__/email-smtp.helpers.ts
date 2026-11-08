// C6-T26 test helper: a tiny in-process dev SMTP sink (node:net, no dependency) that records what a client sends, with switchable failure replies.
import net from 'node:net';
import type { OutboundMessage } from '../delivery/transport.js';

export interface SinkOpts {
  greeting?: string;        // default '220 sink ready'
  advertiseAuth?: boolean;  // EHLO lists AUTH PLAIN LOGIN
  advertiseStartTls?: boolean; // EHLO lists STARTTLS (sink cannot actually upgrade; used to prove the client tries/insists)
  authReply?: string;       // default '235 ok'
  mailReply?: string;       // default '250 ok'
  rcptReply?: string;       // default '250 ok'
  dataReply?: string;       // reply to DATA itself, default '354 go'
  endReply?: string;        // reply after <CRLF>.<CRLF>, default '250 2.0.0 queued as SINK0001'
  silent?: boolean;         // accept the TCP connection, never speak (timeout test)
}
export interface Parsed { headers: Map<string, string[]>; rawHeaders: string; rawBody: string; text: string; subject: string }
export interface Captured { commands: string[]; auth: string[]; mailFrom?: string; rcpts: string[]; data?: string; connections: number }
export interface Sink { port: number; host: string; cap: Captured; close(): Promise<void>; message(): Parsed }

export async function startSink(o: SinkOpts = {}): Promise<Sink> {
  const cap: Captured = { commands: [], auth: [], rcpts: [], connections: 0 };
  const sockets = new Set<net.Socket>();
  const server = net.createServer((s) => {
    sockets.add(s); s.on('close', () => sockets.delete(s)); s.on('error', () => {});
    cap.connections++;
    if (o.silent) return;
    let buf = Buffer.alloc(0); let inData = false; let awaitingAuth = false;
    const w = (l: string) => s.write(`${l}\r\n`);
    w(o.greeting ?? '220 sink ready');
    s.on('data', (chunk) => {
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
        if (awaitingAuth) { awaitingAuth = false; cap.auth.push(line); w(o.authReply ?? '235 ok'); continue; }
        cap.commands.push(line);
        const u = line.toUpperCase();
        if (u.startsWith('EHLO') || u.startsWith('HELO')) {
          const ext = ['250-sink', ...(o.advertiseAuth ? ['250-AUTH PLAIN LOGIN'] : []), ...(o.advertiseStartTls ? ['250-STARTTLS'] : []), '250 8BITMIME'];
          s.write(ext.join('\r\n') + '\r\n');
        } else if (u.startsWith('AUTH')) {
          const parts = line.split(' ');
          if (parts.length >= 3) { cap.auth.push(line); w(o.authReply ?? '235 ok'); } else { awaitingAuth = true; w('334 '); }
        } else if (u.startsWith('MAIL FROM')) { cap.mailFrom = line; w(o.mailReply ?? '250 ok'); }
        else if (u.startsWith('RCPT TO')) { if ((o.rcptReply ?? '250').startsWith('250')) cap.rcpts.push(line); w(o.rcptReply ?? '250 ok'); }
        else if (u === 'DATA') { const r = o.dataReply ?? '354 go'; w(r); if (r.startsWith('354')) inData = true; }
        else if (u === 'QUIT') { w('221 bye'); s.end(); }
        else if (u === 'RSET' || u === 'NOOP') w('250 ok');
        else w('502 not implemented');
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as net.AddressInfo).port;
  return {
    port, host: '127.0.0.1', cap,
    close: () => new Promise<void>((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }),
    message: () => parse(cap.data ?? ''),
  };
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
export const creds = (s: Sink, over: Record<string, unknown> = {}) => ({
  host: s.host, port: s.port, security: 'none', from: 'reports@lab.example.test', timeoutMs: 2000, ...over,
});
export const rejection = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { return e; } throw new Error('expected rejection, got success'); };
