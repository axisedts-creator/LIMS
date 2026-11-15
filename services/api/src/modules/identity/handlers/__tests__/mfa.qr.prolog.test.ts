// AUTH-MFA-COMPLETE-1 (LD-221 item 6, founder report 17:09 NPT: the authenticator screen showed only the key; LD-214 AUTH-MFA-QR-1; AUTH-SENSITIVE LD-189; E1: the QR carries the TOTP secret).
// CAUSE 3 (unproven): the real GoTrue qr_code may carry a comment or a DOCTYPE before <svg>; SVG_DOC accepted only an optional XML declaration. Required now:
//   handlers/mfaQr.ts  qrSvgToBase64(input)  accepts a PROLOG = XML declaration, comments, a DOCTYPE WITHOUT an internal subset (any order, whitespace between) and STRIPS it:
//                       the output is the clean <svg>... only; every UNSAFE check stays on the remaining body; anything doubtful -> undefined (never sanitised).
//   handlers/mfaQr.ts  qrOmitReason(input: unknown): QrOmitReason | undefined   (NEW pure fn; the name is this file's seam)
//                       undefined when the QR is usable, else ONE code: not_string | empty | too_long | bad_data_uri | bad_base64 | no_svg_root | unsafe_content | too_large; never any content.
//                       Invariant: qrSvgToBase64(x) === undefined  <=>  qrOmitReason(x) !== undefined, for every x.
//   startMfaEnrolment  when it omits the QR: ctx.log.warn({ event: 'mfa_qr_omitted', reason }, ...) (level warn; no SVG, no part of it, no secret; E1).
// The old "XML declaration kept verbatim" / "comment first is rejected" expectations in mfa.qr.test.ts were changed for this (see that file); everything else there still holds.
// Expected now: fail (no qrOmitReason export; a comment or DOCTYPE prolog -> undefined; nothing is logged when the QR is omitted).
import { describe, expect, it } from 'vitest';
import { createFakeGoTrueGateway } from '../../gotrue/gateway.fake.js';
import type { GoTrueGateway } from '../../gotrue/gateway.js';
import { createStartMfaEnrolment } from '../startMfaEnrolment.js';
import { makeMfaWorld } from './mfa.helpers.js';

type Reason = 'not_string' | 'empty' | 'too_long' | 'bad_data_uri' | 'bad_base64' | 'no_svg_root' | 'unsafe_content' | 'too_large';
const REASONS: Reason[] = ['not_string', 'empty', 'too_long', 'bad_data_uri', 'bad_base64', 'no_svg_root', 'unsafe_content', 'too_large'];
// dynamic import: a missing export fails each test that needs it instead of the whole file
const mod = async () => (await import('../mfaQr.js')) as { qrSvgToBase64: (i: any) => string | undefined; qrOmitReason?: (i: any) => Reason | undefined };
const qr = async (input: unknown) => (await mod()).qrSvgToBase64(input);
const reason = async (input: unknown) => { const f = (await mod()).qrOmitReason; if (typeof f !== 'function') throw new Error('handlers/mfaQr.ts does not export qrOmitReason'); return f(input); };

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const unb64 = (s: string) => Buffer.from(s, 'base64').toString('utf8');
const withBody = (inner: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 2">${inner}</svg>`;
const svgOfBytes = (n: number) => { const head = '<svg xmlns="http://www.w3.org/2000/svg"><!--'; const tail = '--></svg>'; return head + 'a'.repeat(n - head.length - tail.length) + tail; };
/** a GoTrue-looking QR: xlink namespace, crispEdges, one long path */
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="256" height="256" viewBox="0 0 29 29" shape-rendering="crispEdges">'
  + '<rect width="29" height="29" fill="#ffffff"/><path d="M0 0h7v1H0zM8 0h2v1H8zM12 0h1v1h-1zM0 1h1v6H0zM6 1h1v6H6z" fill="#000000"/></svg>';
const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="no"?>';
const COMMENT = '<!-- Created with a QR code generator -->';
const DOCTYPE = '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">';
const transports: Array<[string, (doc: string) => string]> = [
  ['bare', (d) => d],
  ['percent-encoded data URI (;utf-8)', (d) => `data:image/svg+xml;utf-8,${encodeURIComponent(d)}`],
  ['raw data URI (;utf-8,<svg...)', (d) => `data:image/svg+xml;utf-8,${d}`],
  ['base64 data URI', (d) => `data:image/svg+xml;base64,${b64(d)}`],
];

describe('prolog accepted and STRIPPED: the output is the clean <svg> only (LD-221 item 6)', () => {
  const prologs: Array<[string, string]> = [
    ['xml declaration + comment + DOCTYPE (the real-looking GoTrue prolog)', `${XML_DECL}\n${COMMENT}\n${DOCTYPE}\n`],
    ['xml declaration + DOCTYPE', `${XML_DECL}\n${DOCTYPE}\n`],
    ['comment + DOCTYPE', `${COMMENT}\n${DOCTYPE}\n`],
    ['DOCTYPE only', `${DOCTYPE}\n`],
    ['DOCTYPE without public id (<!DOCTYPE svg>)', '<!DOCTYPE svg>\n'],
    ['a comment only', `${COMMENT}\n`],
    ['two comments', `${COMMENT}<!-- second -->\n`],
    ['xml declaration + comment', `${XML_DECL}\n${COMMENT}\n`],
    ['xml declaration, comment, DOCTYPE, another comment, CRLF line ends', `${XML_DECL}\r\n${COMMENT}\r\n${DOCTYPE}\r\n<!-- end of prolog -->\r\n`],
    ['no whitespace at all between the parts', `${XML_DECL}${COMMENT}${DOCTYPE}`],
    ['leading whitespace, tabs and blank lines', `  \n\t${XML_DECL}\n\n  ${COMMENT}\n\t${DOCTYPE}\n\n`],
    ['a comment with a hyphen and a > inside', '<!-- a - b > c -->\n'],
  ];
  for (const [tn, wrap] of transports) {
    it.each(prologs)(`${tn}: %s -> base64 of the clean svg (no <?xml, no comment, no DOCTYPE left)`, async (_n, prolog) => {
      const out = await qr(wrap(prolog + SVG)); expect(out).toBeDefined();
      const doc = unb64(out!); expect(doc).toBe(SVG); expect(doc.startsWith('<svg')).toBe(true); expect(doc).not.toMatch(/<\?xml|<!--|<!doctype/i);
      expect(out).not.toMatch(/^data:/i); expect(out).toMatch(/^[A-Za-z0-9+/]+=*$/);
    });
  }
  it('trailing whitespace after </svg> is allowed; the output still starts at <svg', async () => {
    const out = await qr(`${XML_DECL}\n${COMMENT}\n${DOCTYPE}\n${SVG}\n`); expect(out).toBeDefined(); const doc = unb64(out!); expect(doc.startsWith('<svg')).toBe(true); expect(doc.trim()).toBe(SVG);
  });
  it('a stripped prolog does not count against the 20000-character cap: 5000 bytes of comment + a 15000-byte svg -> accepted, 20000 characters out', async () => {
    const out = await qr(`${XML_DECL}<!--${'p'.repeat(5000)}-->${svgOfBytes(15000)}`); expect(out).toBeDefined(); expect(out!.length).toBe(20000); expect(unb64(out!)).toBe(svgOfBytes(15000));
  });
  it('an <svg inside a prolog comment cannot smuggle itself out: the result is undefined or exactly the real svg, never the comment text', async () => {
    const out = await qr(`<!-- <svg onload="alert(1)"></svg> -->${SVG}`); if (out !== undefined) expect(unb64(out)).toBe(SVG);
  });
  it('a DOCTYPE with a SYSTEM identifier but no internal subset is stripped or refused, never echoed', async () => {
    const out = await qr(`<!DOCTYPE svg SYSTEM "file:///etc/passwd">\n${SVG}`); if (out !== undefined) { expect(unb64(out)).toBe(SVG); expect(out).not.toContain(b64('file:///etc/passwd')); }
  });
});

describe('prolog doubtful or hostile -> undefined (never sanitised); every UNSAFE check stays on the remaining body', () => {
  it.each([
    ['DOCTYPE with an internal subset holding an ENTITY', '<!DOCTYPE svg [ <!ENTITY x "y"> ]>'],
    ['DOCTYPE with an empty internal subset', '<!DOCTYPE svg [ ]>'],
    ['DOCTYPE with an internal subset (billion-laughs shape)', '<!DOCTYPE svg [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;&a;">]>'],
    ['DOCTYPE SYSTEM + internal subset', '<!DOCTYPE svg SYSTEM "x.dtd" [<!ENTITY e SYSTEM "file:///etc/passwd">]>'],
    ['a bare <!ENTITY declaration', '<!ENTITY x "y">'],
    ['an unterminated comment (the <svg is inside it)', '<!-- never closed '],
    ['an unterminated xml declaration', '<?xml version="1.0" '],
    ['an unterminated DOCTYPE', '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" '],
    ['a processing instruction other than xml', '<?xml-stylesheet href="x.css"?>'],
    ['an element before the svg', '<div></div>'],
    ['text before the svg', 'hello '],
    ['a CDATA section', '<![CDATA[ x ]]>'],
  ])('%s before the svg -> undefined (bare, percent-encoded, base64)', async (_n, bad) => {
    for (const [, wrap] of transports) expect(await qr(wrap(bad + SVG)), bad).toBeUndefined();
  });
  it('garbage BEFORE a valid prolog -> undefined; a non-svg root after a valid prolog -> undefined', async () => {
    expect(await qr(`x ${XML_DECL}${COMMENT}${SVG}`)).toBeUndefined(); expect(await qr(`<div></div>${COMMENT}${SVG}`)).toBeUndefined();
    expect(await qr(`${XML_DECL}${COMMENT}${DOCTYPE}<html>${SVG}</html>`)).toBeUndefined(); expect(await qr(`${XML_DECL}${COMMENT}<svgfoo xmlns="http://www.w3.org/2000/svg"></svgfoo>`)).toBeUndefined();
  });
  const GOOD_PROLOG = `${XML_DECL}\n${COMMENT}\n${DOCTYPE}\n`;
  const unsafeBodies: Array<[string, string]> = [
    ['<script>', withBody('<script>alert(1)</script>')],
    ['<foreignObject>', withBody('<foreignObject width="1" height="1"><div>x</div></foreignObject>')],
    ['<iframe>', withBody('<iframe src="about:blank"></iframe>')],
    ['onload= on the root', '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>'],
    ['onclick=', withBody('<rect onclick="alert(1)" width="1" height="1"/>')],
    ['javascript: link', withBody('<a href="javascript:alert(1)"><rect width="1" height="1"/></a>')],
    ['external href', withBody('<image href="https://evil.test/x.png"/>')],
    ['data: href', withBody('<image xlink:href="data:image/png;base64,AAAA"/>')],
    ['url(https://...)', withBody('<rect fill="url(https://evil.test/p)"/>')],
    ['a DOCTYPE INSIDE the body', withBody('<!DOCTYPE x>')],
    ['an <!ENTITY inside the body', withBody('<!ENTITY x "y">')],
    ['onload= hidden in a comment inside the body', withBody('<!-- x onload=1 --><rect width="1" height="1"/>')],
  ];
  for (const [tn, wrap] of transports) it.each(unsafeBodies)(`${tn}: a valid prolog does not excuse an unsafe body: %s -> undefined`, async (_n, body) => { expect(await qr(wrap(GOOD_PROLOG + body))).toBeUndefined(); });
  it('the 20000-character cap still applies to the stripped output: prolog + a 15001-byte svg -> undefined', async () => { expect(await qr(`${XML_DECL}<!--x-->${svgOfBytes(15001)}`)).toBeUndefined(); });
});

describe('qrOmitReason: a reason CODE only, consistent with qrSvgToBase64 (LD-221 item 6)', () => {
  const MARK = 'REASONMARK-31c9';
  const cases: Array<[Reason, string, unknown]> = [
    ['not_string', 'undefined', undefined], ['not_string', 'null', null], ['not_string', 'a number', 12345], ['not_string', 'an object', { svg: SVG }], ['not_string', 'an array', [SVG]], ['not_string', 'a Buffer', Buffer.from(SVG)],
    ['empty', 'the empty string', ''],
    ['too_long', 'a 100001-character string', 'x'.repeat(100_001)],
    ['too_long', 'a 200000-character svg-looking string', `<svg>${'a'.repeat(200_000)}</svg>`],
    ['bad_data_uri', 'image/png media type', `data:image/png;base64,${b64(SVG)}`], ['bad_data_uri', 'text/html media type', `data:text/html;base64,${b64(SVG)}`],
    ['bad_data_uri', 'no media type', `data:,${encodeURIComponent(SVG)}`], ['bad_data_uri', 'no comma', 'data:image/svg+xml'], ['bad_data_uri', 'just "data:"', 'data:'],
    ['bad_base64', 'invalid base64 characters', 'data:image/svg+xml;base64,@@@not base64@@@'], ['bad_base64', 'base64 length not a multiple of 4', 'data:image/svg+xml;base64,PHN2Zw'],
    ['no_svg_root', 'bare text', 'hello'], ['no_svg_root', 'an http URL', 'https://example.test/qr.svg'], ['no_svg_root', 'svg wrapped in a div', `<div>${SVG}</div>`],
    ['no_svg_root', 'text before the svg', `x ${SVG}`], ['no_svg_root', '<svgfoo>', '<svgfoo xmlns="http://www.w3.org/2000/svg"></svgfoo>'], ['no_svg_root', 'an html page in base64', `data:image/svg+xml;base64,${b64('<html><body>no</body></html>')}`],
    ['no_svg_root', 'an xml declaration and nothing else', '<?xml version="1.0"?>'], ['no_svg_root', 'an unterminated comment prolog', `<!-- open ${SVG}`], ['no_svg_root', 'an html root after a valid prolog', `${XML_DECL}${COMMENT}<html>${SVG}</html>`],
    ['unsafe_content', '<script>', withBody('<script>alert(1)</script>')], ['unsafe_content', 'onload=', '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>'],
    ['unsafe_content', 'an external href', withBody('<image href="https://evil.test/x.png"/>')], ['unsafe_content', '<foreignObject>', withBody('<foreignObject/>')],
    ['unsafe_content', 'a valid prolog plus <script> (percent-encoded)', `data:image/svg+xml;utf-8,${encodeURIComponent(`${XML_DECL}${COMMENT}${withBody('<script>1</script>')}`)}`],
    ['too_large', 'a 15001-byte svg (20004 base64 characters)', svgOfBytes(15001)], ['too_large', 'a 15001-byte svg in a base64 data URI', `data:image/svg+xml;base64,${b64(svgOfBytes(15001))}`],
  ];
  it.each(cases)('%s: %s', async (want, _n, input) => { expect(await reason(input)).toBe(want); });
  it('a DOCTYPE with an internal subset is refused with unsafe_content or no_svg_root (either is a defensible classification), never accepted', async () => {
    expect(['unsafe_content', 'no_svg_root']).toContain(await reason(`<!DOCTYPE svg [ <!ENTITY x "y"> ]>${SVG}`));
  });
  it('whitespace-only input is empty (or at worst no_svg_root): a code, not a throw', async () => { expect(['empty', 'no_svg_root']).toContain(await reason('   \n')); });
  it('usable input -> undefined: every accepted spelling and the whole prolog family', async () => {
    for (const [, wrap] of transports) for (const p of ['', `${XML_DECL}\n`, `${COMMENT}\n`, `${XML_DECL}\n${COMMENT}\n${DOCTYPE}\n`]) expect(await reason(wrap(p + SVG)), p).toBeUndefined();
  });
  it('INVARIANT over a mixed corpus: qrSvgToBase64 is undefined exactly when qrOmitReason is a code; the code is always one of the eight', async () => {
    const corpus: unknown[] = [...cases.map((c) => c[2]), SVG, `${XML_DECL}\n${COMMENT}\n${DOCTYPE}\n${SVG}`, `data:image/svg+xml;utf-8,${encodeURIComponent(SVG)}`, `data:image/svg+xml;base64,${b64(SVG)}`,
      `  \n${SVG}`, '%', '<svg', '<svg>', '\u0000\u0001', 'data:image/svg+xml;base64,', 'data:image/svg+xml,', `data:image/svg+xml,%E0%A4%A${SVG}`, 'data:image/svg+xml;base64,' + 'A'.repeat(30001), true, 0, {}, []];
    for (const x of corpus) { const out = await qr(x); const r = await reason(x); expect(out === undefined, String(x).slice(0, 50)).toBe(r !== undefined); if (r !== undefined) expect(REASONS).toContain(r); }
  });
  it('never throws, and a code never contains any part of the input (E1): marker text inside rejected input does not appear in the answer', async () => {
    const hostile: unknown[] = [withBody(`<title>${MARK}</title><script>1</script>`), `data:image/svg+xml;base64,${b64(withBody(`<title>${MARK}</title><script>1</script>`))}`, `${MARK} not svg`, `data:text/html,${MARK}`,
      `data:image/svg+xml;base64,${MARK}!!`, `<!--${MARK}-->`, { toString() { throw new Error(MARK); } }, Object.create(null)];
    for (const x of hostile) { const r = await reason(x); expect(r === undefined || REASONS.includes(r)).toBe(true); expect(String(r)).not.toContain(MARK); }
  });
});

// ---- handler: startMfaEnrolment logs the reason when it omits the QR ----------------------------------------------------------------------------------------
const gatewayWithQr = (qrSvg: unknown | 'omit'): GoTrueGateway => {
  const fake = createFakeGoTrueGateway() as unknown as GoTrueGateway;
  return { ...fake, mfaEnrollTotp: async (a: string, n?: string) => ({ ...(await fake.mfaEnrollTotp(a, n)), ...(qrSvg === 'omit' ? {} : { qrSvg }) }) } as GoTrueGateway;
};
const startWith = async (qrSvg: unknown | 'omit', state = 'mfa_enrolment_required') => {
  const w = await makeMfaWorld({ gateway: gatewayWithQr(qrSvg) }); const a = await w.addSession({ state });
  const { hctx } = w.makeHctx({ operationId: 'startMfaEnrolment' }); const r = await (createStartMfaEnrolment(w.deps as any) as any)(w.req({ token: a.token, body: {} }), hctx);
  return { w, a, r };
};
const qrLogs = (w: { log: { info: any; warn: any; error: any } }) => (w.log.warn.mock.calls as any[][]).filter((c) => c[0] && typeof c[0] === 'object' && c[0].event === 'mfa_qr_omitted');
const BASE_KEYS = ['factor_id', 'otpauth_uri', 'secret_base32'];
const MARK = 'QRLOGMARK-5be2';

describe('startMfaEnrolment: an omitted QR is logged as {event: mfa_qr_omitted, reason} at warn, and only that (LD-221 item 6; E1)', () => {
  it.each<[string, unknown, Reason]>([
    ['GoTrue sent no qr_code', 'omit', 'not_string'], ['qrSvg undefined', undefined, 'not_string'], ['qrSvg a number', 12345, 'not_string'], ['qrSvg an object', { svg: SVG }, 'not_string'],
    ['qrSvg empty', '', 'empty'], ['qrSvg with <script>', withBody('<script>alert(1)</script>'), 'unsafe_content'], ['qrSvg with an external href', withBody('<image href="https://evil.test/x.png"/>'), 'unsafe_content'],
    ['qrSvg a png data URI', 'data:image/png;base64,iVBORw0KGgo=', 'bad_data_uri'], ['qrSvg malformed base64', 'data:image/svg+xml;base64,@@@', 'bad_base64'],
    ['qrSvg not svg', 'hello', 'no_svg_root'], ['qrSvg 15001 bytes', svgOfBytes(15001), 'too_large'],
  ])('%s -> 200 without qr_svg_base64; exactly one warn {event, reason: %j}', async (_n, qrSvg, want) => {
    const { w, r } = await startWith(qrSvg as any);
    expect(r.status).toBe(200); expect(Object.keys(r.body).sort()).toEqual(BASE_KEYS); expect('qr_svg_base64' in r.body).toBe(false);
    const logs = qrLogs(w); expect(logs).toHaveLength(1); const o = logs[0]![0];
    expect(o).toMatchObject({ event: 'mfa_qr_omitted', reason: want }); expect(Object.keys(o).every((k) => ['event', 'reason', 'request_id'].includes(k))).toBe(true);
    if (logs[0]!.length > 1) expect(typeof logs[0]![1]).toBe('string');
    expect(w.log.info.mock.calls.concat(w.log.error.mock.calls).filter((c: any[]) => c[0]?.event === 'mfa_qr_omitted')).toHaveLength(0);   // warn only
  });
  it('a usable QR (plain and with the real-looking GoTrue prolog) is returned and NOT logged', async () => {
    for (const qrSvg of [SVG, `data:image/svg+xml;utf-8,${encodeURIComponent(`${XML_DECL}\n${COMMENT}\n${DOCTYPE}\n${SVG}`)}`, `${XML_DECL}\n${COMMENT}\n${DOCTYPE}\n${SVG}`]) {
      const { w, r } = await startWith(qrSvg); expect(r.body.qr_svg_base64).toBe(b64(SVG)); expect(qrLogs(w)).toHaveLength(0);
    }
  });
  it('the live-case QR (xml declaration + comment + DOCTYPE, percent-encoded data URI) gives a 200 body that carries qr_svg_base64 = base64 of the clean svg', async () => {
    const { r } = await startWith(`data:image/svg+xml;utf-8,${encodeURIComponent(`${XML_DECL}\n${COMMENT}\n${DOCTYPE}\n${SVG}`)}`);
    expect(Object.keys(r.body).sort()).toEqual([...BASE_KEYS, 'qr_svg_base64'].sort()); expect(unb64(r.body.qr_svg_base64)).toBe(SVG); expect(r.body.qr_svg_base64.length).toBeLessThanOrEqual(20000);
  });
  it('a QR works the same, and a refusal is logged the same, from an `active` (voluntary) session', async () => {
    const ok = await startWith(SVG, 'active'); expect(ok.r.body.qr_svg_base64).toBe(b64(SVG)); expect(qrLogs(ok.w)).toHaveLength(0);
    const bad = await startWith(withBody('<script>1</script>'), 'active'); expect(qrLogs(bad.w)).toHaveLength(1); expect(qrLogs(bad.w)[0]![0].reason).toBe('unsafe_content');
  });
  it('E1: no SVG, no part of it (title text, base64, percent-encoding), no secret, otpauth URI or session token in ANY log line, write or tx query - for refused and for accepted QRs', async () => {
    const refused = withBody(`<title>${MARK}</title><script>1</script>`);
    for (const qrSvg of [refused, `data:image/svg+xml;utf-8,${encodeURIComponent(refused)}`, `data:image/svg+xml;base64,${b64(refused)}`, `${XML_DECL}${COMMENT}${refused}`, withBody(`<title>${MARK}</title>`) + '<!--', `data:image/svg+xml;base64,${MARK}!!`]) {
      const { w, a, r } = await startWith(qrSvg); const hay = JSON.stringify([w.log.info.mock.calls, w.log.warn.mock.calls, w.log.error.mock.calls, w.store.writes.map((x) => x.arg), w.tx.query.mock.calls, w.txCalls]);
      for (const secret of [MARK, b64(refused), encodeURIComponent(refused), b64(MARK), r.body.secret_base32, r.body.otpauth_uri, a.token, a.row.accessToken, a.row.refreshToken]) expect(hay).not.toContain(secret);
      expect(qrLogs(w).every((c) => REASONS.includes(c[0].reason))).toBe(true);
    }
    const okSvg = withBody(`<title>${MARK}</title><path d="M0 0h1v1H0z"/>`);
    for (const qrSvg of [okSvg, `data:image/svg+xml;base64,${b64(okSvg)}`]) {
      const { w, r } = await startWith(qrSvg); const hay = JSON.stringify([w.log.info.mock.calls, w.log.warn.mock.calls, w.log.error.mock.calls, w.store.writes.map((x) => x.arg), w.tx.query.mock.calls, w.txCalls]);
      for (const secret of [MARK, b64(okSvg), r.body.qr_svg_base64, r.body.secret_base32, r.body.otpauth_uri]) expect(hay).not.toContain(secret);
    }
  });
  it('omitting the QR changes nothing else: the mirror row is inserted once, GoTrue enrolled once, status 200', async () => {
    const { w, r } = await startWith(withBody('<script>1</script>')); expect(w.store.committed('insertFactor')).toHaveLength(1); expect(w.calls.filter((c) => c.method === 'mfaEnrollTotp')).toHaveLength(1);
    expect(w.store.factors.find((f) => f.id === r.body.factor_id)!.status).toBe('unverified');
  });
});
