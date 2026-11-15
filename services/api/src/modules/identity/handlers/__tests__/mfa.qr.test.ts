// AUTH-MFA-QR-1 (LD-214, founder yes 2026-11-15 15:04 NPT; AUTH-SENSITIVE LD-189, E1 secret shown once): startMfaEnrolment passes GoTrue's TOTP QR through as
// `qr_svg_base64` (contracts/openapi/identity.yaml MfaEnrolmentStart, optional, maxLength 20000; 02-TRD s5.1) via the pure helper handlers/mfaQr.ts
// `qrSvgToBase64(input: string | undefined): string | undefined`. Tolerant in what it accepts, strict in what it returns, never sanitises (reject -> undefined).
// Expected now: fail (handlers/mfaQr.ts does not exist; the handler body has no qr_svg_base64).
// Existing mfa.enrol / mfa.integration / mfa.wiring suites are untouched: the fake gateway returns no QR, so their bodies stay without qr_svg_base64.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { AJV_OPTIONS } from '../../../../core/openapi.js';
import { createFakeGoTrueGateway } from '../../gotrue/gateway.fake.js';
import type { GoTrueGateway } from '../../gotrue/gateway.js';
import { createStartMfaEnrolment } from '../startMfaEnrolment.js';
import { makeMfaWorld, SECRET_RE } from './mfa.helpers.js';

const requireAjv = createRequire(import.meta.url);
const Ajv2020 = requireAjv('ajv/dist/2020.js').default as new (o: object) => any;

// ---- helper under test (dynamic import: a missing module fails each helper test, not the handler tests) -------------------------------------------------
const qr = async (input: unknown): Promise<string | undefined> => ((await import('../mfaQr.js')) as { qrSvgToBase64: (i: any) => string | undefined }).qrSvgToBase64(input);

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 2" shape-rendering="crispEdges"><path d="M0 0h1v1H0z" fill="#000"/></svg>';
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const unb64 = (s: string) => Buffer.from(s, 'base64').toString('utf8');
const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n';
/** an SVG document of exactly `n` UTF-8 bytes (padding is an XML comment) */
const svgOfBytes = (n: number) => { const head = '<svg xmlns="http://www.w3.org/2000/svg"><!--'; const tail = '--></svg>'; return head + 'a'.repeat(n - head.length - tail.length) + tail; };
const withBody = (inner: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 2">${inner}</svg>`;

describe('qrSvgToBase64 - accepted spellings (LD-214 HELPER RULES)', () => {
  const forms: Array<[string, string]> = [
    ['percent-encoded data URI (;utf-8)', `data:image/svg+xml;utf-8,${encodeURIComponent(SVG)}`],
    ['percent-encoded data URI (;charset=utf-8)', `data:image/svg+xml;charset=utf-8,${encodeURIComponent(SVG)}`],
    ['percent-encoded data URI, no parameter', `data:image/svg+xml,${encodeURIComponent(SVG)}`],
    ['base64 data URI', `data:image/svg+xml;base64,${b64(SVG)}`],
    ['base64 data URI with ;utf-8 before ;base64', `data:image/svg+xml;utf-8;base64,${b64(SVG)}`],
    ['base64 data URI with ;charset=utf-8;base64', `data:image/svg+xml;charset=utf-8;base64,${b64(SVG)}`],
    ['raw SVG after the comma', `data:image/svg+xml,${SVG}`],
    ['raw SVG after ;utf-8,', `data:image/svg+xml;utf-8,${SVG}`],
    ['misspelt media type img/svg+xml (percent-encoded)', `data:img/svg+xml;utf-8,${encodeURIComponent(SVG)}`],
    ['misspelt media type img/svg+xml (raw)', `data:img/svg+xml,${SVG}`],
    ['misspelt media type img/svg+xml (base64)', `data:img/svg+xml;base64,${b64(SVG)}`],
    ['bare SVG, no data: prefix', SVG],
    ['upper-case scheme and media type', `DATA:IMAGE/SVG+XML;UTF-8,${encodeURIComponent(SVG)}`],
  ];
  it.each(forms)('%s -> base64 of the SVG, no data: prefix', async (_n, input) => {
    const out = await qr(input);
    expect(out).toBeDefined(); expect(out).not.toMatch(/^data:/i); expect(out).toMatch(/^[A-Za-z0-9+/]+=*$/); expect(unb64(out!)).toBe(SVG);
  });
  it('an XML declaration first is accepted (bare, percent-encoded and base64) and kept verbatim in the output', async () => {
    const doc = XML_DECL + SVG;
    for (const input of [doc, `data:image/svg+xml;utf-8,${encodeURIComponent(doc)}`, `data:image/svg+xml;base64,${b64(doc)}`]) expect(unb64((await qr(input))!)).toBe(doc);
  });
  it('whitespace before <svg> (and after the XML declaration) is accepted', async () => {
    expect(await qr(`  \n${SVG}`)).toBeDefined(); expect(await qr(`${XML_DECL}\n\n  ${SVG}`)).toBeDefined(); expect(await qr(`data:image/svg+xml,%20%0A${encodeURIComponent(SVG)}`)).toBeDefined();
  });
  it('raw SVG containing a literal % (width="100%") is not a percent-decoding error: it round-trips', async () => {
    const raw = '<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%"><rect width="1" height="1"/></svg>';
    expect(unb64((await qr(`data:image/svg+xml,${raw}`))!)).toBe(raw); expect(unb64((await qr(raw))!)).toBe(raw);
  });
  it('round trip is UTF-8 (non-ASCII text survives in every spelling)', async () => {
    const u = withBody('<title>QR für Rüpa – 検査</title><rect width="1" height="1"/>');
    for (const input of [u, `data:image/svg+xml;utf-8,${encodeURIComponent(u)}`, `data:image/svg+xml;base64,${b64(u)}`]) expect(unb64((await qr(input))!)).toBe(u);
  });
  it('the xmlns namespace URL and internal references (url(#id), href="#id") are NOT external references', async () => {
    const s = withBody('<defs><linearGradient id="g"><stop offset="0" stop-color="#000"/></linearGradient><path id="p" d="M0 0h1v1z"/></defs><use href="#p" fill="url(#g)"/><use xlink:href="#p" xmlns:xlink="http://www.w3.org/1999/xlink"/>');
    expect(unb64((await qr(s))!)).toBe(s);
  });
});

describe('qrSvgToBase64 - rejected (return undefined, never sanitise)', () => {
  it.each([
    ['text/html media type', `data:text/html;base64,${b64(SVG)}`],
    ['image/png media type', `data:image/png;base64,${b64(SVG)}`],
    ['application/octet-stream media type', `data:application/octet-stream,${encodeURIComponent(SVG)}`],
    ['no media type', `data:,${encodeURIComponent(SVG)}`],
    ['an http URL', 'https://example.test/qr.svg'],
    ['not-svg body (html page, base64)', `data:image/svg+xml;base64,${b64('<html><body>no</body></html>')}`],
    ['not-svg body (bare text)', 'hello'],
    ['not-svg body (png bytes as base64)', 'data:image/svg+xml;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB'],
    ['svg not first (wrapped in a div)', `<div>${SVG}</div>`],
    ['svg not first (text before it)', `x ${SVG}`],
    ['svg not first (a comment first)', `<!-- c -->${SVG}`],
    ['svg only inside an XML-declared html document', `${XML_DECL}<html>${SVG}</html>`],
    ['<svgfoo> is not <svg', '<svgfoo xmlns="http://www.w3.org/2000/svg"></svgfoo>'],
  ])('%s -> undefined', async (_n, input) => { expect(await qr(input)).toBeUndefined(); });

  const bad: Array<[string, string]> = [
    ['<script> element', withBody('<script>alert(1)</script>')],
    ['<SCRIPT> upper case', withBody('<SCRIPT>alert(1)</SCRIPT>')],
    ['<script/> self-closing', withBody('<script src="x"/>')],
    ['<foreignObject>', withBody('<foreignObject width="1" height="1"><div>x</div></foreignObject>')],
    ['<ForeignObject> mixed case', withBody('<ForeignObject/>')],
    ['<iframe>', withBody('<iframe src="about:blank"></iframe>')],
    ['<object>', withBody('<object data="x"></object>')],
    ['<embed>', withBody('<embed src="x"/>')],
    ['onload= on the root', '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>'],
    ['onclick = with spaces', withBody('<rect onclick = "alert(1)" width="1" height="1"/>')],
    ['ONERROR= upper case', withBody('<image ONERROR="alert(1)"/>')],
    ['onmouseover=\' single quote', withBody('<rect onmouseover=\'alert(1)\'/>')],
    ['javascript: in a link', withBody('<a href="javascript:alert(1)"><rect width="1" height="1"/></a>')],
    ['JavaScript: mixed case', withBody('<a xlink:href="JavaScript:alert(1)"/>')],
    ['href to http', withBody('<image href="http://evil.test/x.png"/>')],
    ['xlink:href to https', withBody('<image xlink:href="https://evil.test/x.png"/>')],
    ['href to protocol-relative //', withBody('<image href="//evil.test/x.png"/>')],
    ['href with single quotes to https', withBody("<image href='https://evil.test/x.png'/>")],
    ['href to data:', withBody('<image href="data:image/png;base64,AAAA"/>')],
    ['xlink:href to data:', withBody('<image xlink:href="data:image/svg+xml;base64,AAAA"/>')],
    ['url(http...)', withBody('<rect fill="url(http://evil.test/p)"/>')],
    ['url(https...) quoted', withBody('<rect style="fill:url(\'https://evil.test/p\')"/>')],
    ['url(//...)', withBody('<rect fill="url(//evil.test/p)"/>')],
    ['url(data:...)', withBody('<rect style="background:url(data:image/png;base64,AAAA)"/>')],
    ['HREF="HTTP://" upper case', withBody('<image HREF="HTTP://evil.test/x.png"/>')],
  ];
  it.each(bad)('%s -> undefined (bare)', async (_n, svg) => { expect(await qr(svg)).toBeUndefined(); });
  it.each(bad)('%s -> undefined (percent-encoded data URI, checked after decoding)', async (_n, svg) => { expect(await qr(`data:image/svg+xml;utf-8,${encodeURIComponent(svg)}`)).toBeUndefined(); });
  it.each(bad)('%s -> undefined (base64 data URI, checked after decoding)', async (_n, svg) => { expect(await qr(`data:image/svg+xml;base64,${b64(svg)}`)).toBeUndefined(); });
  it('a bad construct behind an XML declaration is still rejected', async () => { expect(await qr(XML_DECL + withBody('<script>1</script>'))).toBeUndefined(); });
});

describe('qrSvgToBase64 - size, type and malformed input', () => {
  it('output of exactly 20000 characters (15000-byte SVG) is accepted; 20004 characters (15001 bytes) -> undefined', async () => {
    const ok = await qr(svgOfBytes(15000)); expect(ok).toBeDefined(); expect(ok!.length).toBe(20000); expect(unb64(ok!)).toBe(svgOfBytes(15000));
    expect(await qr(svgOfBytes(15001))).toBeUndefined(); expect(await qr(svgOfBytes(40000))).toBeUndefined();
    expect(await qr(`data:image/svg+xml;base64,${b64(svgOfBytes(15001))}`)).toBeUndefined();
  });
  it('undefined, empty, whitespace-only and non-string input -> undefined (never throws)', async () => {
    for (const v of [undefined, null, '', '   ', '\n', 0, 123, true, {}, [], ['<svg/>'], Buffer.from(SVG)]) expect(await qr(v), String(v)).toBeUndefined();
  });
  it('malformed input -> undefined, never throws', async () => {
    for (const v of ['data:', 'data:image/svg+xml', 'data:image/svg+xml,', 'data:image/svg+xml;base64,', 'data:image/svg+xml;base64,@@@not base64@@@', 'data:image/svg+xml;base64,PHN2Zw', `data:image/svg+xml,%E0%A4%A${SVG}`, '%', '<svg', '<svg>', '<?xml version="1.0"?>', '\u0000\u0001', 'data:image/svg+xml;base64,' + 'A'.repeat(30001)])
      expect(await qr(v), v.slice(0, 40)).toBeUndefined();
  });
});

// ---- handler: startMfaEnrolment ------------------------------------------------------------------------------------------------------------------------
const CONTRACT = fileURLToPath(new URL('../../../../../../../contracts/openapi/identity.yaml', import.meta.url));
const mfaEnrolmentStartSchema = () => {
  const s = (parse(readFileSync(CONTRACT, 'utf8')) as any).components.schemas.MfaEnrolmentStart;
  expect(s.properties.qr_svg_base64).toEqual({ type: 'string', maxLength: 20000 });   // the contract already allows it (no contract change in this task)
  return { ...s, properties: { ...s.properties, factor_id: { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' } } };   // _common.yaml Uuid, inlined
};
/** the C0 response-validation AJV options (core/openapi.ts RESPONSE_AJV_OPTIONS = AJV_OPTIONS + coerceTypes false + useDefaults false) */
const validateStart = (body: unknown) => { const v = new Ajv2020({ ...AJV_OPTIONS, coerceTypes: false, useDefaults: false }).compile(mfaEnrolmentStartSchema()); const ok = v(body); return { ok, errors: v.errors }; };

/** the fake GoTrue plus a per-test QR: `qrSvg` (a value) is added to the mfaEnrollTotp result; `'omit'` leaves the fake's own answer (no qrSvg) */
const gatewayWithQr = (qrSvg: unknown | 'omit'): GoTrueGateway => {
  const fake = createFakeGoTrueGateway() as unknown as GoTrueGateway;
  return { ...fake, mfaEnrollTotp: async (a: string, n?: string) => ({ ...(await fake.mfaEnrollTotp(a, n)), ...(qrSvg === 'omit' ? {} : { qrSvg }) }) } as GoTrueGateway;
};
const startWith = async (qrSvg: unknown | 'omit', state = 'mfa_enrolment_required') => {
  const w = await makeMfaWorld({ gateway: gatewayWithQr(qrSvg) }); const a = await w.addSession({ state });
  const { hctx } = w.makeHctx({ operationId: 'startMfaEnrolment' }); const h: any = createStartMfaEnrolment(w.deps as any);
  const r = await h(w.req({ token: a.token, body: {} }), hctx);
  return { w, a, r };
};
const BASE_KEYS = ['factor_id', 'otpauth_uri', 'secret_base32'];
const MARK = 'QRMARK-7f3a91';
const MARKED_SVG = withBody(`<title>${MARK}</title><path d="M0 0h1v1H0z"/>`);

describe('startMfaEnrolment - qr_svg_base64 (AUTH-MFA-QR-1)', () => {
  it.each([
    ['percent-encoded data URI', `data:image/svg+xml;utf-8,${encodeURIComponent(SVG)}`],
    ['base64 data URI', `data:image/svg+xml;base64,${b64(SVG)}`],
    ['raw SVG data URI', `data:image/svg+xml;utf-8,${SVG}`],
    ['bare SVG', SVG],
  ])('GoTrue sends a usable QR (%s) -> 200 body = factor_id, otpauth_uri, secret_base32 + qr_svg_base64 (base64 of the SVG); validates against MfaEnrolmentStart', async (_n, qrSvg) => {
    const { r, a, w } = await startWith(qrSvg);
    expect(r.status).toBe(200); expect(Object.keys(r.body).sort()).toEqual([...BASE_KEYS, 'qr_svg_base64'].sort());
    expect(r.body.qr_svg_base64).toBe(b64(SVG)); expect(r.body.qr_svg_base64).not.toMatch(/^data:/); expect(r.body.qr_svg_base64.length).toBeLessThanOrEqual(20000);
    expect(r.body.otpauth_uri).toMatch(/^otpauth:\/\/totp\//); expect(r.body.secret_base32).toMatch(SECRET_RE);
    expect(w.store.factors.find((f) => f.id === r.body.factor_id)!.status).toBe('unverified');
    const v = validateStart(r.body); expect(v.errors ?? []).toEqual([]); expect(v.ok).toBe(true);
    expect(w.calls.filter((c) => c.method === 'mfaEnrollTotp')).toHaveLength(1); expect(w.calls.find((c) => c.method === 'mfaEnrollTotp')!.args[0]).toBe(a.row.accessToken);
  });
  it('a QR works the same from an `active` (voluntary) session', async () => {
    const { r } = await startWith(`data:image/svg+xml;base64,${b64(SVG)}`, 'active'); expect(r.status).toBe(200); expect(r.body.qr_svg_base64).toBe(b64(SVG));
  });
  it.each([
    ['no qrSvg from GoTrue (the fake)', 'omit'],
    ['qrSvg undefined', undefined],
    ['qrSvg empty', ''],
    ['qrSvg with <script>', `data:image/svg+xml;utf-8,${encodeURIComponent(withBody('<script>alert(1)</script>'))}`],
    ['qrSvg with an external href', withBody('<image href="https://evil.test/x.png"/>')],
    ['qrSvg with onload=', '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'],
    ['qrSvg not svg (png)', 'data:image/png;base64,iVBORw0KGgo='],
    ['qrSvg malformed base64', 'data:image/svg+xml;base64,@@@'],
    ['qrSvg too long (over 20000 base64 characters)', svgOfBytes(15001)],
    ['qrSvg not a string (number)', 12345],
    ['qrSvg not a string (object)', { svg: SVG }],
  ])('%s -> 200, qr_svg_base64 omitted, the rest as before, validates; the handler does not throw', async (_n, qrSvg) => {
    const { r, w } = await startWith(qrSvg as any);
    expect(r.status).toBe(200); expect(Object.keys(r.body).sort()).toEqual(BASE_KEYS); expect('qr_svg_base64' in r.body).toBe(false);
    expect(r.body.otpauth_uri).toMatch(/^otpauth:\/\/totp\//); expect(r.body.secret_base32).toMatch(SECRET_RE);
    expect(w.store.factors.find((f) => f.id === r.body.factor_id)!.status).toBe('unverified'); expect(w.store.committed('insertFactor')).toHaveLength(1);
    const v = validateStart(r.body); expect(v.errors ?? []).toEqual([]); expect(v.ok).toBe(true);
  });
  it('response validation would reject an over-long value: the contract caps qr_svg_base64 at 20000 (guards the schema loading in this file)', () => {
    expect(validateStart({ factor_id: '0190a000-0000-7000-8000-000000000001', otpauth_uri: 'otpauth://totp/x', secret_base32: 'ABCDEFGH', qr_svg_base64: 'A'.repeat(20001) }).ok).toBe(false);
    expect(validateStart({ factor_id: '0190a000-0000-7000-8000-000000000001', otpauth_uri: 'otpauth://totp/x', secret_base32: 'ABCDEFGH', qr_svg_base64: 'A'.repeat(20000) }).ok).toBe(true);
  });
  it('nothing else changes: stale `unverified` factor still deleted at GoTrue BEFORE the new enrolment, mirror row inserted once, errors unchanged (GoTrue outage -> 503)', async () => {
    const w = await makeMfaWorld({ gateway: gatewayWithQr(`data:image/svg+xml;base64,${b64(SVG)}`) }); const a = await w.addSession({ state: 'mfa_enrolment_required' });
    const call = async () => { const { hctx } = w.makeHctx({ operationId: 'startMfaEnrolment' }); return (createStartMfaEnrolment(w.deps as any) as any)(w.req({ token: a.token, body: {} }), hctx); };
    const first = await call(); const second = await call();
    expect(second.body.factor_id).not.toBe(first.body.factor_id); expect(second.body.qr_svg_base64).toBe(b64(SVG));
    const del = w.calls.findIndex((c) => c.method === 'adminDeleteFactor'); expect(del).toBeGreaterThan(-1); expect(del).toBeLessThan(w.calls.map((c) => c.method).lastIndexOf('mfaEnrollTotp'));
    expect(w.store.factors.filter((f) => !f.removedReason && f.status === 'unverified')).toHaveLength(1);
    (w.deps.gotrue as any).mfaEnrollTotp = async () => { throw new Error('ECONNRESET'); };
    await expect(call()).rejects.toMatchObject({ code: 'common.dependency_unavailable' });
  });
  it('E1 hygiene: the QR (raw, decoded, base64) and the secret appear in no log line, no write, no tx query; the rejected QR is not logged either', async () => {
    for (const qrSvg of [`data:image/svg+xml;utf-8,${encodeURIComponent(MARKED_SVG)}`, `data:image/svg+xml;base64,${b64(MARKED_SVG)}`, withBody(`<title>${MARK}</title><script>1</script>`)]) {
      const { w, r } = await startWith(qrSvg);
      const hay = JSON.stringify([w.log.info.mock.calls, w.log.warn.mock.calls, w.log.error.mock.calls, w.store.writes.map((x) => x.arg), w.tx.query.mock.calls, w.txCalls]);
      for (const secret of [MARK, qrSvg, b64(MARKED_SVG), encodeURIComponent(MARKED_SVG), r.body.secret_base32, r.body.otpauth_uri, r.body.qr_svg_base64 ?? '\u0000no-qr']) expect(hay).not.toContain(secret);
      expect(JSON.stringify(r.body)).not.toMatch(/access_token|refresh_token|session_token/);
    }
  });
  it('a bad QR is not echoed into an error or the body (no MARK in the 200 body when rejected)', async () => {
    const { r } = await startWith(withBody(`<title>${MARK}</title><script>1</script>`)); expect(JSON.stringify(r.body)).not.toContain(MARK);
  });
});
