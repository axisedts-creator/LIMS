// `email_smtp_relay` transport (02-TRD §5.4; 06-PLAN C6-T26; AC-08.5; REQ-SEC-007, REQ-SEC-101): link-only e-mail over a tenant SMTP relay.
// The message is one single-part text/plain body (the link text the caller rendered); there is no other content path.
// INTERIM: protocol-level client on node:net / node:tls. CR-C6-019 + db/meta/decisions/T0-03-dependencies.md:54 pin nodemailer 10.3.1;
// task stays pending-cr (.orchestra/cr/C6-T26.md) until C0-0D adds it, then this file is rewritten on nodemailer.
// Creds (the resolved channel_accounts.secret_ref): { host, port, from, security?, username?, password?, timeoutMs?, ca? }; ca = PEM dev/test trust anchor.
// security: 'starttls' (default) | 'tls' | 'none'; 'none' is for a loopback dev sink only. Errors carry only a failureCode (no PHI, no relay text).
// No environment access, no logging.
import net from 'node:net';
import tls from 'node:tls';
import { TransportError } from '../transport.js';
import type { OutboundMessage, ResolvedSecret, SendOutcome, Transport } from '../transport.js';

interface Cfg { host: string; port: number; from: string; security: 'none' | 'starttls' | 'tls'; username?: string | undefined; password?: string | undefined; timeoutMs: number; ca?: string | undefined }
interface Reply { code: number; lines: string[] }

const ADDR = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const fail = (retryable: boolean, code: string) => new TransportError(retryable, code);

function address(v: unknown, code: string): string {
  if (typeof v !== 'string' || v.length > 254 || !ADDR.test(v) || v.includes('..')) throw fail(false, code);
  return v;
}

function parseCfg(c: unknown): Cfg {
  const o = (c && typeof c === 'object' ? c : {}) as Record<string, unknown>;
  const { host, port, security = 'starttls', username, password, timeoutMs = 10000 } = o;
  if (typeof host !== 'string' || !/^[A-Za-z0-9.:-]{1,253}$/.test(host)) throw fail(false, 'invalid_config');
  if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535) throw fail(false, 'invalid_config');
  if (security !== 'none' && security !== 'starttls' && security !== 'tls') throw fail(false, 'invalid_config');
  if (security === 'none' && !(host === 'localhost' || host === '::1' || /^127\./.test(host))) throw fail(false, 'invalid_config');
  if (!Number.isInteger(timeoutMs) || (timeoutMs as number) < 100 || (timeoutMs as number) > 120000) throw fail(false, 'invalid_config');
  if ((username === undefined) !== (password === undefined)) throw fail(false, 'invalid_config');
  if (o.ca !== undefined && (typeof o.ca !== 'string' || !o.ca.includes('-----BEGIN CERTIFICATE-----'))) throw fail(false, 'invalid_config');
  if (username !== undefined && (typeof username !== 'string' || typeof password !== 'string' || !username || !password)) throw fail(false, 'invalid_config');
  return { host, port: port as number, from: address(o.from, 'invalid_config'), security, username: username as string | undefined, password: password as string | undefined, timeoutMs: timeoutMs as number, ca: o.ca as string | undefined };
}

/** Subject header value: plain when short printable ASCII, else RFC 2047 UTF-8 B-words (<= 75 chars each), folded. */
function subjectHeader(s: string): string {
  if (/[\r\n\0]/.test(s)) throw fail(false, 'invalid_message');
  if (/^[\x20-\x7e]{0,60}$/.test(s)) return s;
  const words: string[] = []; let cur = '';
  for (const ch of s) {
    if (Buffer.byteLength(cur + ch) > 45) { words.push(cur); cur = ''; }
    cur += ch;
  }
  words.push(cur);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, 'utf8').toString('base64')}?=`).join('\r\n ');
}

function build(msg: OutboundMessage, from: string, to: string): { data: string; id: string } {
  if (typeof msg.body !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(msg.deliveryId)) throw fail(false, 'invalid_message');
  const id = `${msg.deliveryId}@${from.slice(from.indexOf('@') + 1)}`;
  const body = Buffer.from(msg.body, 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n');
  const head = [
    `From: <${from}>`, `To: <${to}>`, `Subject: ${subjectHeader(msg.subject ?? '')}`, `Date: ${new Date().toUTCString()}`, `Message-ID: <${id}>`,
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64',
  ].join('\r\n');
  return { data: `${head}\r\n\r\n${body}`, id };
}

/** Line-oriented SMTP wire with an idle timeout; the first failure wins and is thrown to the waiting step. */
class Wire {
  sock!: net.Socket;
  private buf = '';
  private lines: string[] = [];
  private up = false;
  private err?: TransportError;
  private wake?: () => void;

  constructor(private readonly ms: number) {}

  private onData = (d: Buffer) => {
    this.buf += d.toString('latin1');
    if (this.buf.length > 65536) return this.die(fail(false, 'protocol_error'));
    const parts = this.buf.split(/\r?\n/); this.buf = parts.pop() as string;
    this.lines.push(...parts); this.wake?.();
  };

  private die(e: TransportError) { this.err ??= e; this.sock.destroy(); this.wake?.(); }

  bind(s: net.Socket, readyEvent: string) {
    this.sock = s; this.up = false;
    s.setTimeout(this.ms);
    s.once(readyEvent, () => { this.up = true; this.wake?.(); });
    s.on('data', this.onData);
    s.on('timeout', () => this.die(fail(true, 'timeout')));
    s.on('error', (e: NodeJS.ErrnoException) => this.die(/CERT|TLS|SSL/.test(e.code ?? '') ? fail(false, 'tls_failed') : fail(true, 'network_error')));
    s.on('close', () => this.die(fail(true, 'connection_closed')));
  }

  private async wait<T>(ready: () => T | undefined): Promise<T> {
    for (;;) {
      const v = ready(); if (v !== undefined) return v;
      if (this.err) throw this.err;
      await new Promise<void>((r) => { this.wake = r; });
    }
  }

  opened() { return this.wait(() => (this.up ? true : undefined)); }

  reply(): Promise<Reply> {
    return this.wait(() => {
      const i = this.lines.findIndex((l) => /^\d{3}(?: |$)/.test(l));
      if (i < 0) return undefined;
      const lines = this.lines.splice(0, i + 1);
      return { code: Number((lines[i] ?? '').slice(0, 3)), lines };
    });
  }

  send(line: string) { this.sock.write(`${line}\r\n`); }

  async upgrade(host: string, ca?: string) {
    if (this.buf || this.lines.length) throw fail(false, 'protocol_error');   // data buffered before the handshake would be unauthenticated
    const raw = this.sock; raw.removeListener('data', this.onData);
    this.bind(tls.connect({ socket: raw, host, ca, servername: net.isIP(host) ? undefined : host }), 'secureConnect');
    await this.opened();
  }

  close() { this.sock.end('QUIT\r\n', () => this.sock.destroy()); }
}

/** Accept a reply of the given class (2 = ok, 3 = go ahead); 4xx is temporary (retry), anything else is final. */
function expect(r: Reply, digit: number, code5 = 'provider_rejected'): Reply {
  const d = Math.floor(r.code / 100);
  if (d === digit) return r;
  throw d === 4 ? fail(true, 'provider_temporary') : d === 5 ? fail(false, code5) : fail(false, 'protocol_error');
}

const exts = (r: Reply) => r.lines.slice(1).map((l) => l.slice(4).toUpperCase());

export const smtpRelayTransport: Transport = {
  providerKind: 'email_smtp_relay',
  async send(msg: OutboundMessage, creds: ResolvedSecret): Promise<SendOutcome> {
    if (msg.channel !== 'email') throw fail(false, 'unsupported_channel');
    const cfg = parseCfg(creds);
    const to = address(msg.to, 'invalid_destination');
    const { data, id } = build(msg, cfg.from, to);
    const helo = `EHLO ${cfg.from.slice(cfg.from.indexOf('@') + 1)}`;

    const w = new Wire(cfg.timeoutMs);
    w.bind(cfg.security === 'tls' ? tls.connect({ host: cfg.host, port: cfg.port, ca: cfg.ca, servername: net.isIP(cfg.host) ? undefined : cfg.host }) : net.connect({ host: cfg.host, port: cfg.port }),
      cfg.security === 'tls' ? 'secureConnect' : 'connect');
    try {
      await w.opened();
      expect(await w.reply(), 2);
      w.send(helo);
      let ext = exts(expect(await w.reply(), 2));
      if (cfg.security === 'starttls') {
        if (!ext.includes('STARTTLS')) throw fail(false, 'tls_unavailable');
        w.send('STARTTLS');
        expect(await w.reply(), 2, 'tls_unavailable');
        await w.upgrade(cfg.host, cfg.ca);
        w.send(helo);
        ext = exts(expect(await w.reply(), 2));
      }
      if (cfg.username !== undefined) {
        if (!ext.some((l) => l.startsWith('AUTH ') && l.split(' ').includes('PLAIN'))) throw fail(false, 'auth_unsupported');
        w.send(`AUTH PLAIN ${Buffer.from(`\0${cfg.username}\0${cfg.password}`, 'utf8').toString('base64')}`);
        expect(await w.reply(), 2, 'auth_failed');
      }
      w.send(`MAIL FROM:<${cfg.from}>`);
      expect(await w.reply(), 2);
      w.send(`RCPT TO:<${to}>`);
      expect(await w.reply(), 2, 'invalid_destination');
      w.send('DATA');
      expect(await w.reply(), 3);
      w.send(`${data.replace(/^\./gm, '..')}\r\n.`);
      expect(await w.reply(), 2);
      return { providerMessageId: id, acceptedAt: new Date().toISOString() };
    } finally {
      w.close();
    }
  },
};
