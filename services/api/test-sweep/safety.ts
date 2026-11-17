// T0B-SWEEP-1 / LD-269 SAFETY: the sweep only ever talks to a local database (loopback or the Docker bridge range 172.16.0.0/12).
// It never reads cloud secrets or any cloud URL; this check runs before any connection is opened.
import { BlockList, isIP } from 'node:net';

const LOCAL = new BlockList();
LOCAL.addSubnet('127.0.0.0', 8, 'ipv4');
LOCAL.addSubnet('172.16.0.0', 12, 'ipv4');   // Docker networks
LOCAL.addAddress('::1', 'ipv6');

function hostOf(urlOrHost: string): string {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(urlOrHost)) return urlOrHost;
  const u = new URL(urlOrHost);   // throws on garbage
  return u.hostname.replace(/^\[|\]$/g, '');
}

export function assertLocalDatabase(urlOrHost: string): void {
  const host = hostOf(String(urlOrHost ?? '').trim());
  if (host === 'localhost') return;
  const fam = isIP(host);
  if (fam !== 0 && LOCAL.check(host, fam === 4 ? 'ipv4' : 'ipv6')) return;
  throw new Error(`sweep: refusing non-local database host "${host}" (LD-269: localhost, 127.0.0.1, ::1 or the Docker network only)`);
}
