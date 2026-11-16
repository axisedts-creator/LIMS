// T0D-02 — ctx.clientIp / app.client_ip, AC-0D-2.5, AB-26, 08 A25 P-61 (02-TRD §6.4). Expected API (core/auth/client-ip.ts):
//   createClientIpResolver(trustedProxyCidrs: readonly string[]): (i: { peer: string; forwardedFor?: string; bffKind?: BffKind }) => string
//   `bffKind` is set by the caller ONLY when X-Lims-Bff-Key was verified. Throws at construction on an invalid CIDR.
//   Rule: X-Forwarded-For is used only if bffKind is set OR the TCP peer is inside a trusted CIDR; otherwise the peer address.
import { describe, expect, it } from 'vitest';
import { createClientIpResolver } from '../client-ip.js';

const PEER = '203.0.113.9';
const VICTIM = '198.51.100.7';
const NGINX = '172.20.0.2';
const resolve = createClientIpResolver(['172.20.0.0/16', 'fd00:20::/64']);

describe('AC-0D-2.5 / AB-26', () => {
  it('no BFF key, peer outside the CIDRs, XFF = victim -> the peer address (header ignored)', () => {
    expect(resolve({ peer: PEER, forwardedFor: VICTIM })).toBe(PEER);
  });
  it.each(['staff_web', 'partner', 'portal'] as const)('valid BFF key of kind %s -> XFF is used even from an untrusted peer', (bffKind) => {
    expect(resolve({ peer: PEER, forwardedFor: VICTIM, bffKind })).toBe(VICTIM);
  });
  it('peer inside LIMS_CORE_TRUSTED_PROXY_CIDRS (nginx) without a BFF key -> XFF is used', () => {
    expect(resolve({ peer: NGINX, forwardedFor: VICTIM })).toBe(VICTIM);
  });
  it('trusted peer + BFF key -> XFF', () => {
    expect(resolve({ peer: NGINX, forwardedFor: VICTIM, bffKind: 'portal' })).toBe(VICTIM);
  });
  it('no XFF header: always the peer (trusted or not, BFF or not)', () => {
    expect(resolve({ peer: PEER })).toBe(PEER);
    expect(resolve({ peer: NGINX })).toBe(NGINX);
    expect(resolve({ peer: PEER, bffKind: 'staff_web' })).toBe(PEER);
  });
  it('CIDR boundaries: first and last address in range are trusted, the neighbours are not', () => {
    const r = createClientIpResolver(['10.1.2.0/24']);
    expect(r({ peer: '10.1.2.0', forwardedFor: VICTIM })).toBe(VICTIM);
    expect(r({ peer: '10.1.2.255', forwardedFor: VICTIM })).toBe(VICTIM);
    expect(r({ peer: '10.1.3.0', forwardedFor: VICTIM })).toBe('10.1.3.0');
    expect(r({ peer: '10.1.1.255', forwardedFor: VICTIM })).toBe('10.1.1.255');
  });
  it('/32 trusts exactly one host', () => {
    const r = createClientIpResolver([`${NGINX}/32`]);
    expect(r({ peer: NGINX, forwardedFor: VICTIM })).toBe(VICTIM);
    expect(r({ peer: '172.20.0.3', forwardedFor: VICTIM })).toBe('172.20.0.3');
  });
  it('empty CIDR list trusts nobody (default: only a BFF key lifts the header)', () => {
    const r = createClientIpResolver([]);
    expect(r({ peer: NGINX, forwardedFor: VICTIM })).toBe(NGINX);
    expect(r({ peer: NGINX, forwardedFor: VICTIM, bffKind: 'partner' })).toBe(VICTIM);
  });
  it('several CIDRs: any match trusts', () => {
    const r = createClientIpResolver(['192.0.2.0/24', '172.20.0.0/16']);
    expect(r({ peer: '192.0.2.77', forwardedFor: VICTIM })).toBe(VICTIM);
    expect(r({ peer: NGINX, forwardedFor: VICTIM })).toBe(VICTIM);
  });
});

describe('IPv6 and IPv4-mapped peers', () => {
  it('IPv6 peer inside an IPv6 CIDR is trusted', () => {
    expect(resolve({ peer: 'fd00:20::5', forwardedFor: VICTIM })).toBe(VICTIM);
  });
  it('IPv6 peer outside it is not', () => {
    expect(resolve({ peer: 'fd00:21::5', forwardedFor: VICTIM })).toBe('fd00:21::5');
  });
  it('IPv4-mapped IPv6 peer (::ffff:172.20.0.2, what dual-stack sockets report) matches the IPv4 CIDR', () => {
    expect(resolve({ peer: `::ffff:${NGINX}`, forwardedFor: VICTIM })).toBe(VICTIM);
  });
  it('IPv4-mapped peer outside the CIDR is not trusted', () => {
    const out = resolve({ peer: `::ffff:${PEER}`, forwardedFor: VICTIM });
    expect(out === `::ffff:${PEER}` || out === PEER).toBe(true);
  });
  it('an IPv6 XFF value is returned when trusted', () => {
    expect(resolve({ peer: NGINX, forwardedFor: '2001:db8::1' })).toBe('2001:db8::1');
  });
});

describe('malformed X-Forwarded-For never reaches app.client_ip (log forging, inet cast errors)', () => {
  const junk = ['not-an-ip', '', ' ', '999.1.1.1', '1.2.3', '1.2.3.4.5', '1.2.3.4; DROP TABLE x', "1.2.3.4'--", '<script>', '1.2.3.4\r\nX-Evil: 1', 'a'.repeat(5000), '::g', '1.2.3.4/24'];
  it.each(junk)('trusted peer + XFF %j -> falls back to the peer', (h) => {
    expect(resolve({ peer: NGINX, forwardedFor: h })).toBe(NGINX);
  });
  it.each(junk)('BFF key + XFF %j -> falls back to the peer', (h) => {
    expect(resolve({ peer: PEER, forwardedFor: h, bffKind: 'staff_web' })).toBe(PEER);
  });
});

// T0A-CLIENTIP-1 / LD-296 (founder yes 2026-11-16 22:32 NPT). A hosting proxy (Render) APPENDS its peer to X-Forwarded-For, so the header is a
// comma list. With a VERIFIED BFF key (bffKind set) the leftmost entry was written by the web (Vercel overwrites the header it hands to the web),
// so it is used when it is a bare IP literal. Everything else is unchanged: no key + untrusted peer -> peer; trusted-CIDR peer keeps the single literal rule.
describe('LD-296: comma list + verified BFF key -> leftmost bare IP literal', () => {
  const PROXY_PEER = '10.20.30.40'; // what the hosting proxy appends
  it.each(['staff_web', 'partner', 'portal'] as const)('kind %s: "client, proxy" -> the leftmost entry', (bffKind) => {
    expect(resolve({ peer: PEER, forwardedFor: `${VICTIM}, ${PROXY_PEER}`, bffKind })).toBe(VICTIM);
  });
  it.each([
    [`${VICTIM},${PROXY_PEER}`, VICTIM],
    [`  ${VICTIM}  ,  ${PROXY_PEER}  `, VICTIM],
    [`${VICTIM}, 1.1.1.1, ${PROXY_PEER}`, VICTIM],
    ['1.1.1.1, 2.2.2.2, 3.3.3.3', '1.1.1.1'], // only the leftmost, never the rightmost or a later valid one
    [`${VICTIM}, not-an-ip`, VICTIM], // the tail is not inspected
    [`${VICTIM}, `, VICTIM],
  ])('XFF %j -> %s', (h, want) => {
    expect(resolve({ peer: PEER, forwardedFor: h, bffKind: 'staff_web' })).toBe(want);
  });
  it('IPv6 leftmost literal', () => {
    expect(resolve({ peer: PEER, forwardedFor: `2001:db8::1, ${PROXY_PEER}`, bffKind: 'staff_web' })).toBe('2001:db8::1');
  });
  it('IPv4-mapped IPv6 leftmost literal is returned as written', () => {
    expect(resolve({ peer: PEER, forwardedFor: `::ffff:${VICTIM}, ${PROXY_PEER}`, bffKind: 'staff_web' })).toBe(`::ffff:${VICTIM}`);
  });
  it('IPv4-mapped IPv6 TCP peer (dual-stack socket) + key + list -> leftmost', () => {
    expect(resolve({ peer: `::ffff:${PEER}`, forwardedFor: `${VICTIM}, ${PROXY_PEER}`, bffKind: 'staff_web' })).toBe(VICTIM);
  });
  it('trusted-CIDR peer AND key + list -> leftmost (the key path applies)', () => {
    expect(resolve({ peer: NGINX, forwardedFor: `${VICTIM}, ${PROXY_PEER}`, bffKind: 'portal' })).toBe(VICTIM);
  });
  it('a single literal still works with the key (existing rule)', () => {
    expect(resolve({ peer: PEER, forwardedFor: VICTIM, bffKind: 'staff_web' })).toBe(VICTIM);
  });

  const junkLeft = ['not-an-ip, 10.0.0.1', ', 10.0.0.1', ' , 10.0.0.1', '999.1.1.1, 10.0.0.1', '1.2.3.4:443, 10.0.0.1', '[2001:db8::1]:443, 10.0.0.1',
    '1.2.3.4/24, 10.0.0.1', 'fe80::1%eth0, 10.0.0.1', "1.2.3.4'--, 10.0.0.1", '1.2.3.4; DROP TABLE x, 10.0.0.1', '<script>, 10.0.0.1', '::g, 10.0.0.1',
    `${'a'.repeat(5000)}, 10.0.0.1`, 'a,'.repeat(2500)];
  it.each(junkLeft)('key + junk or empty leftmost %j -> the TCP peer', (h) => {
    expect(resolve({ peer: PEER, forwardedFor: h, bffKind: 'staff_web' })).toBe(PEER);
  });

  it('NO key, untrusted peer, list -> the TCP peer (a forged header is ignored)', () => {
    expect(resolve({ peer: PEER, forwardedFor: `${VICTIM}, ${PROXY_PEER}` })).toBe(PEER);
    expect(resolve({ peer: PEER, forwardedFor: `${VICTIM}, ${PEER}` })).toBe(PEER);
  });
  it('NO key, IPv4-mapped untrusted peer, list -> the peer, not the header', () => {
    const out = resolve({ peer: `::ffff:${PEER}`, forwardedFor: `${VICTIM}, ${PROXY_PEER}` });
    expect(out === `::ffff:${PEER}` || out === PEER).toBe(true);
  });
  it('trusted-CIDR peer without a key keeps the single-literal rule: a list falls back to the peer', () => {
    expect(resolve({ peer: NGINX, forwardedFor: `${VICTIM}, ${PROXY_PEER}` })).toBe(NGINX);
    expect(resolve({ peer: NGINX, forwardedFor: VICTIM })).toBe(VICTIM);
  });
  it('empty CIDR list + no key + list -> the peer', () => {
    expect(createClientIpResolver([])({ peer: PEER, forwardedFor: `${VICTIM}, ${PROXY_PEER}` })).toBe(PEER);
  });
  it('a list without XFF key material never leaks: result is always an IP literal', () => {
    for (const h of [`${VICTIM}, x`, `x, ${VICTIM}`, ',', ',,,']) {
      const out = resolve({ peer: PEER, forwardedFor: h, bffKind: 'partner' });
      expect(out === PEER || out === VICTIM).toBe(true);
    }
  });
});

describe('construction', () => {
  it.each(['not-a-cidr', '10.0.0.0/33', '10.0.0.0/-1', '10.0.0.0/', '::1/129', '300.0.0.0/8', '10.0.0.0/abc', ''])(
    'invalid CIDR %j throws at construction (a typo must not silently trust or distrust)', (c) => {
      expect(() => createClientIpResolver([c])).toThrow();
    });
});
