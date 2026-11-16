// T0A-CLIENTIP-1 / LD-296: the real client address and browser user agent for server-to-server API calls (login, c2Resolver,
// serverFetch). Without them Node fetch sends no address (the API sees its proxy peer) and the user agent "node".
// Server only (next/headers + node:net; no 'server-only' marker because c2.ts, which the middleware imports, uses it); never logs;
// copies nothing else from the incoming request.
import { isIP } from 'node:net';
import { headers } from 'next/headers';

export interface ClientContext {
  ip?: string;
  userAgent?: string;
}

const UA_MAX = 512;
// A bare IP literal only: no list, port, CIDR or zone id (the API casts it to inet and writes it to auth_events).
const literal = (v: string | null | undefined): string | undefined => {
  const s = v?.trim();
  return s && isIP(s) && !s.includes('%') ? s : undefined;
};

export async function readClientContext(): Promise<ClientContext> {
  let h: Awaited<ReturnType<typeof headers>>;
  try {
    h = await headers();
  } catch {
    return {}; // outside a request scope (middleware, build): send nothing
  }
  const xff = h.get('x-forwarded-for')?.trim();
  const ip = literal(xff ? xff.split(',')[0] : h.get('x-real-ip')); // first entry = the client the edge saw
  const userAgent = h.get('user-agent')?.trim().slice(0, UA_MAX);
  return { ...(ip ? { ip } : {}), ...(userAgent ? { userAgent } : {}) };
}

/** The two outgoing headers; a missing value is simply not sent. */
export async function clientContextHeaders(): Promise<Record<string, string>> {
  const c = await readClientContext();
  return { ...(c.ip ? { 'x-forwarded-for': c.ip } : {}), ...(c.userAgent ? { 'user-agent': c.userAgent } : {}) };
}
