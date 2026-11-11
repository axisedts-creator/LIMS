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

describe('construction', () => {
  it.each(['not-a-cidr', '10.0.0.0/33', '10.0.0.0/-1', '10.0.0.0/', '::1/129', '300.0.0.0/8', '10.0.0.0/abc', ''])(
    'invalid CIDR %j throws at construction (a typo must not silently trust or distrust)', (c) => {
      expect(() => createClientIpResolver([c])).toThrow();
    });
});
