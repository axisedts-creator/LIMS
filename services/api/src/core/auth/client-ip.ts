// ctx.clientIp / app.client_ip (02-TRD §6.4, 08 A25 P-61, AB-26). X-Forwarded-For (single hop, nginx overwrites it) is used
// only with a verified X-Lims-Bff-Key or from a TCP peer inside LIMS_CORE_TRUSTED_PROXY_CIDRS; otherwise the peer address.
import { BlockList, isIP } from 'node:net';
import type { BffKind } from './bff-key.js';

export interface ClientIpInput {
  readonly peer: string;
  readonly forwardedFor?: string | undefined;
  /** Set by the caller only when X-Lims-Bff-Key was verified. */
  readonly bffKind?: BffKind | undefined;
}
export type ClientIpResolver = (i: ClientIpInput) => string;

const MAPPED = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;
const unmap = (ip: string): string => MAPPED.exec(ip)?.[1] ?? ip;
const family = (ip: string): 'ipv4' | 'ipv6' | undefined => ({ 4: 'ipv4', 6: 'ipv6' } as const)[isIP(ip) as 4 | 6];

function addCidr(list: BlockList, cidr: string): void {
  const m = /^([^/]+)\/(\d{1,3})$/.exec(cidr.trim());
  const fam = m ? family(m[1]!) : undefined;
  const prefix = m ? Number(m[2]) : NaN;
  if (!m || !fam || prefix > (fam === 'ipv4' ? 32 : 128)) throw new Error(`config: LIMS_CORE_TRUSTED_PROXY_CIDRS has an invalid CIDR: ${cidr}`);
  list.addSubnet(m[1]!, prefix, fam);
}

export function createClientIpResolver(trustedProxyCidrs: readonly string[]): ClientIpResolver {
  const trusted = new BlockList();
  for (const c of trustedProxyCidrs) addCidr(trusted, c);
  const isTrusted = (peer: string): boolean => {
    const ip = unmap(peer);
    const fam = family(ip);
    return fam !== undefined && trusted.check(ip, fam);
  };
  return ({ peer, forwardedFor, bffKind }) => {
    if (forwardedFor === undefined || !(bffKind || isTrusted(peer))) return peer;
    const xff = forwardedFor.trim();
    // Only a bare IP literal reaches app.client_ip (inet cast, log forging); lists/junk fall back to the peer [CONV].
    return family(xff) && !xff.includes('%') ? xff : peer;
  };
}
