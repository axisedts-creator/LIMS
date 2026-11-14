// C6-T26 — email SMTP-relay transport (link-only), 06-PLAN row C6-T26, AC-08.5, 02-TRD §5.4, 07-SECURITY T10 / REQ-SEC-007 / REQ-SEC-101 / REQ-SEC-136.
// Integration against an in-process dev SMTP sink (helpers). Tests fail now because delivery/adapters/email.smtp-relay.ts does not exist.
// ASSUMED adapter API (no spec text pins it; the writer must match or raise a CR):
//   export const smtpRelayTransport: Transport   (providerKind 'email_smtp_relay'; named like `recordingTransport`)
//   creds (ResolvedSecret) = { host, port, from, security: 'none'|'starttls'|'tls' (default 'starttls'), username?, password?, timeoutMs? (default 10000), ca? (PEM, dev/test trust anchor passed to TLS options) }
//   security 'none' is for the dev sink only; the default must refuse to send in clear text.
// Failure codes not fixed by 02-TRD §5.4 are only checked for shape (/^[a-z][a-z0-9_]*$/) and retryable flag; 'provider_rejected' | 'invalid_destination' are the TRD examples.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TransportError } from '../delivery/transport.js';
import { creds, decodeWords, LINK, msg, rejection, startSink, testCert, type Sink } from './email-smtp.helpers.js';

const SRC = join(__dirname, '..', 'delivery', 'adapters', 'email.smtp-relay.ts');
const load = async () => ((await import('../delivery/adapters/email.smtp-relay.js')) as any).smtpRelayTransport;
const SHAPE = /^[a-z][a-z0-9_]*$/;
let sink: Sink | undefined;
const up = async (o = {}) => (sink = await startSink(o));
afterEach(async () => { await sink?.close(); sink = undefined; });

describe('AC-08.5 link-only email delivered to the SMTP sink', () => {
  it('identifies as email_smtp_relay', async () => { expect((await load()).providerKind).toBe('email_smtp_relay'); });

  it('submits one message: MAIL FROM relay sender, one RCPT TO the patient, subject and link in a text body', async () => {
    const s = await up(); const t = await load();
    const out = await t.send(msg(), creds(s));
    expect(s.cap.mailFrom).toContain('reports@lab.example.test');
    expect(s.cap.rcpts).toHaveLength(1); expect(s.cap.rcpts[0]).toContain('patient.0042@example.test');
    const m = s.message();
    expect(m.subject).toBe('Your report is ready'); expect(m.text).toContain(LINK);
    expect(m.headers.get('to')?.[0]).toContain('patient.0042@example.test'); expect(m.headers.get('from')?.[0]).toContain('reports@lab.example.test');
    expect(m.headers.get('content-type')?.[0]).toMatch(/^text\/plain/i);
    expect(Number.isNaN(Date.parse(out.acceptedAt))).toBe(false);
    expect(typeof out.providerMessageId === 'string' || out.providerMessageId === undefined).toBe(true);
  });

  it('has no attachment: single-part text/plain, no multipart, no Content-Disposition, no base64 file part', async () => {
    const s = await up(); await (await load()).send(msg(), creds(s));
    const m = s.message(); const all = (m.rawHeaders + '\r\n' + m.rawBody).toLowerCase();
    expect(all).not.toContain('multipart/'); expect(all).not.toContain('content-disposition'); expect(all).not.toContain('application/pdf'); expect(all).not.toContain('filename=');
    expect(m.headers.get('content-type')?.[0]).not.toMatch(/multipart|application\//i);
  });

  it('carries only what the message holds: no registration number, test name or result invented by the adapter', async () => {
    const s = await up(); await (await load()).send(msg(), creds(s));
    const m = s.message(); expect(m.text.trim()).toBe(msg().body.trim());
  });

  it('keeps unicode (Nepali) subject and body intact', async () => {
    const s = await up(); const subject = 'तपाईंको रिपोर्ट तयार छ'; const body = `नमस्ते — रिपोर्ट: ${LINK}`;
    await (await load()).send(msg({ subject, body, unicode: true }), creds(s));
    const m = s.message(); expect(m.subject).toBe(subject); expect(m.text.trim()).toBe(body);
  });

  it('dot-stuffs: a body line starting with "." survives; a lone "." line does not end the message early', async () => {
    const s = await up(); const body = `line one\r\n.hidden dot line\r\n.\r\nafter lone dot ${LINK}`;
    await (await load()).send(msg({ body }), creds(s));
    expect(s.message().text).toContain('.hidden dot line'); expect(s.message().text).toContain(`after lone dot ${LINK}`);
  });

  it('long lines are wrapped or encoded within 998 octets (RFC 5322)', async () => {
    const s = await up(); await (await load()).send(msg({ body: `${'a'.repeat(3000)} ${LINK}` }), creds(s));
    const m = s.message(); for (const l of (m.rawHeaders + '\r\n' + m.rawBody).split('\r\n')) expect(l.length).toBeLessThanOrEqual(998);
    expect(m.text.replace(/\s+/g, '')).toContain('a'.repeat(3000) + LINK);
  });
});

describe('credentials and transport security', () => {
  it('authenticates with AUTH when username/password are given (relay secret resolved by the worker)', async () => {
    const s = await up({ advertiseAuth: true }); await (await load()).send(msg(), creds(s, { username: 'relay-user', password: 'relay-pass-synthetic' }));
    expect(s.cap.auth.length).toBeGreaterThan(0);
    const joined = s.cap.auth.join(' '); const decoded = joined.split(' ').map((p) => Buffer.from(p, 'base64').toString('latin1')).join(' ');
    expect(decoded).toContain('relay-user'); expect(decoded).toContain('relay-pass-synthetic');
  });

  it('no credentials given: no AUTH command is issued', async () => {
    const s = await up({ advertiseAuth: true }); await (await load()).send(msg(), creds(s));
    expect(s.cap.auth).toHaveLength(0); expect(s.cap.commands.some((c) => /^AUTH/i.test(c))).toBe(false);
  });

  it('rejected AUTH (535) is non-retryable and the password is nowhere in the error', async () => {
    const s = await up({ advertiseAuth: true, authReply: '535 5.7.8 bad credentials' });
    const e = await rejection((await load()).send(msg(), creds(s, { username: 'relay-user', password: 'relay-pass-synthetic' })));
    expect(e).toBeInstanceOf(TransportError); expect(e.retryable).toBe(false); expect(e.failureCode).toMatch(SHAPE);
    expect(JSON.stringify({ m: e.message, c: e.failureCode, s: e.stack })).not.toContain('relay-pass-synthetic');
    expect(s.cap.mailFrom).toBeUndefined();
  });

  it('default security is TLS-required: a plain-text relay is refused before any credential, sender or recipient is sent', async () => {
    const s = await up({ advertiseAuth: true });
    const c: any = creds(s, { username: 'relay-user', password: 'relay-pass-synthetic' }); delete c.security;
    const e = await rejection((await load()).send(msg(), c));
    expect(e).toBeInstanceOf(TransportError); expect(e.retryable).toBe(false);
    expect(s.cap.auth).toHaveLength(0); expect(s.cap.mailFrom).toBeUndefined(); expect(s.cap.rcpts).toHaveLength(0); expect(s.cap.data).toBeUndefined();
  });

  it('security "starttls" against a relay that does not offer STARTTLS fails closed (no downgrade to clear text)', async () => {
    const s = await up({ advertiseAuth: true });
    const e = await rejection((await load()).send(msg(), creds(s, { security: 'starttls', username: 'u', password: 'p' })));
    expect(e).toBeInstanceOf(TransportError); expect(e.retryable).toBe(false);
    expect(s.cap.auth).toHaveLength(0); expect(s.cap.rcpts).toHaveLength(0);
  });

  // Real TLS against the sink's test-time self-signed cert (helpers testCert, in memory, nothing committed). `ca` = dev/test trust anchor.
  it('security "starttls" (the production default) upgrades first: AUTH and the message travel only over TLS', async () => {
    const s = await up({ tls: 'starttls', advertiseAuth: true });
    const out = await (await load()).send(msg(), creds(s, { security: 'starttls', ca: testCert().cert, username: 'relay-user', password: 'relay-pass-synthetic' }));
    expect(s.cap.tlsHandshakes).toBe(1);
    expect(s.cap.auth).toHaveLength(1); expect(s.cap.authSecure).toEqual([true]);
    expect(s.cap.rcpts).toHaveLength(1); expect(s.message().text).toContain(LINK);
    expect(Number.isNaN(Date.parse(out.acceptedAt))).toBe(false);
  });

  it('security "tls" (implicit TLS) delivers the message over the encrypted connection', async () => {
    const s = await up({ tls: 'implicit', advertiseAuth: true });
    await (await load()).send(msg(), creds(s, { security: 'tls', ca: testCert().cert, username: 'relay-user', password: 'relay-pass-synthetic' }));
    expect(s.cap.tlsHandshakes).toBe(1); expect(s.cap.authSecure).toEqual([true]);
    expect(s.cap.rcpts).toHaveLength(1); expect(s.message().text).toContain(LINK);
  });

  it('untrusted relay certificate (no ca) fails closed: non-retryable tls_failed, no AUTH, sender, recipient or body sent', async () => {
    for (const [mode, security] of [['starttls', 'starttls'], ['implicit', 'tls']] as const) {
      const s = await up({ tls: mode, advertiseAuth: true });
      const e = await rejection((await load()).send(msg(), creds(s, { security, username: 'relay-user', password: 'relay-pass-synthetic' })));
      expect(e).toBeInstanceOf(TransportError); expect(e.retryable).toBe(false); expect(e.failureCode).toBe('tls_failed');
      expect(s.cap.auth).toHaveLength(0); expect(s.cap.mailFrom).toBeUndefined(); expect(s.cap.rcpts).toHaveLength(0); expect(s.cap.data).toBeUndefined();
      expect(JSON.stringify({ m: e.message, s: e.stack })).not.toContain('relay-pass-synthetic');
      await s.close(); sink = undefined;
    }
  });
});

describe('failure mapping (02-TRD §5.4: network, timeout, 4xx = retryable; rejected recipient = non-retryable failed)', () => {
  it('550 on RCPT: non-retryable, nothing sent', async () => {
    const s = await up({ rcptReply: '550 5.1.1 no such user' });
    const e = await rejection((await load()).send(msg(), creds(s)));
    expect(e).toBeInstanceOf(TransportError); expect(e.retryable).toBe(false); expect(['invalid_destination', 'provider_rejected']).toContain(e.failureCode);
    expect(s.cap.data).toBeUndefined();
  });
  it('451 on RCPT (temporary): retryable', async () => {
    const s = await up({ rcptReply: '451 4.3.0 try later' });
    const e = await rejection((await load()).send(msg(), creds(s)));
    expect(e).toBeInstanceOf(TransportError); expect(e.retryable).toBe(true); expect(e.failureCode).toMatch(SHAPE);
  });
  it('421 at greeting (service unavailable): retryable', async () => {
    const s = await up({ greeting: '421 4.3.2 shutting down' });
    const e = await rejection((await load()).send(msg(), creds(s)));
    expect(e).toBeInstanceOf(TransportError); expect(e.retryable).toBe(true);
  });
  it('4xx after DATA: retryable; 5xx after DATA: non-retryable', async () => {
    let s = await up({ endReply: '452 4.2.2 mailbox full' });
    let e = await rejection((await load()).send(msg(), creds(s))); expect(e.retryable).toBe(true);
    await s.close();
    s = await up({ endReply: '554 5.6.0 message rejected' });
    e = await rejection((await load()).send(msg(), creds(s))); expect(e).toBeInstanceOf(TransportError); expect(e.retryable).toBe(false);
  });
  it('connection refused: retryable', async () => {
    const s = await up(); const c = creds(s); await s.close(); sink = undefined;
    const e = await rejection((await load()).send(msg(), c)); expect(e).toBeInstanceOf(TransportError); expect(e.retryable).toBe(true);
  });
  it('relay that accepts the connection and never speaks: retryable timeout within the configured timeoutMs', async () => {
    const s = await up({ silent: true }); const t0 = Date.now();
    const e = await rejection((await load()).send(msg(), creds(s, { timeoutMs: 300 })));
    expect(e).toBeInstanceOf(TransportError); expect(e.retryable).toBe(true); expect(Date.now() - t0).toBeLessThan(3000);
  });
  it('errors never leak the recipient, body, link or relay reply text (REQ-SEC-101, no PHI in logs)', async () => {
    const s = await up({ rcptReply: '550 5.1.1 patient.0042@example.test unknown' });
    const e = await rejection((await load()).send(msg(), creds(s)));
    const blob = JSON.stringify({ m: e.message, c: e.failureCode }); expect(e.message).toBe(e.failureCode);
    for (const bad of ['patient.0042', 'example.test', 'Zk3pQ9', 'Test Lab']) expect(blob).not.toContain(bad);
  });
});

describe('input safety (injection, wrong channel)', () => {
  it.each([
    ['CRLF in recipient', { to: 'a@example.test\r\nBcc: victim@example.test' }],
    ['SMTP command in recipient', { to: 'a@example.test>\r\nRCPT TO:<victim@example.test' }],
    ['two recipients', { to: 'a@example.test, b@example.test' }],
    ['not an address', { to: 'not-an-address' }],
    ['empty recipient', { to: '' }],
  ])('%s: rejected non-retryable before any recipient is sent', async (_n, over) => {
    const s = await up(); const e = await rejection((await load()).send(msg(over as any), creds(s)));
    expect(e).toBeInstanceOf(TransportError); expect(e.retryable).toBe(false); expect(e.failureCode).toMatch(SHAPE);
    expect(s.cap.rcpts).toHaveLength(0); expect(s.cap.data).toBeUndefined();
  });
  it('CRLF in subject cannot inject a header', async () => {
    const s = await up(); const t = await load(); let threw = false;
    try { await t.send(msg({ subject: 'Hi\r\nBcc: victim@example.test' }), creds(s)); } catch (e) { expect(e).toBeInstanceOf(TransportError); expect((e as TransportError).retryable).toBe(false); threw = true; }
    if (!threw) { const m = s.message(); expect(m.rawHeaders).toContain('Subject'); expect(m.headers.has('bcc')).toBe(false); expect(m.rawHeaders).not.toMatch(/\r\nBcc:/i); expect(decodeWords(m.rawHeaders)).not.toMatch(/\r\nBcc:/i); }
    expect(s.cap.rcpts.join(' ')).not.toContain('victim');
  });
  it('CRLF in sender (creds.from) is refused', async () => {
    const s = await up(); const e = await rejection((await load()).send(msg(), creds(s, { from: 'reports@lab.example.test\r\nBcc: victim@example.test' })));
    expect(e).toBeInstanceOf(TransportError); expect(e.retryable).toBe(false); expect(s.cap.mailFrom).toBeUndefined();
  });
  it.each(['sms', 'whatsapp'] as const)('channel %s is refused (non-retryable) and nothing is sent', async (channel) => {
    const s = await up(); const e = await rejection((await load()).send(msg({ channel }), creds(s)));
    expect(e).toBeInstanceOf(TransportError); expect(e.retryable).toBe(false); expect(s.cap.connections === 0 || s.cap.rcpts.length === 0).toBe(true);
  });
  it('malformed creds (missing host) are non-retryable and open no connection', async () => {
    const s = await up(); const c: any = creds(s); delete c.host;
    const e = await rejection((await load()).send(msg(), c)); expect(e).toBeInstanceOf(TransportError); expect(e.retryable).toBe(false); expect(s.cap.connections).toBe(0);
  });
});

describe('static: no attachment code path exists (06-PLAN C6-T26 done_when; 07-SECURITY T10)', () => {
  const code = () => readFileSync(SRC, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  it('source has no multipart / Content-Disposition / attachment / file-read / pdf code', () => {
    const t = code().toLowerCase();
    for (const bad of ['multipart', 'content-disposition', 'attachment', 'application/pdf', 'filename', 'readfile', 'createreadstream', 'openreleasedreportfile', 'pdf_object_key']) expect(t, bad).not.toContain(bad);
  });
  it('source reads no environment and logs nothing (secrets/PHI never printed)', () => {
    const t = code(); expect(t).not.toMatch(/process\.env/); expect(t).not.toMatch(/console\./);
  });
});
