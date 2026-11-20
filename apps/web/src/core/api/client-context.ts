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
  // SEC-ABUSE-1 (LD-237 (4)): x-vercel-forwarded-for (set by the edge, not client-suppliable), else x-real-ip, else nothing (the API sees the
  // connection address). The incoming x-forwarded-for is never read: its first element is chosen by the client. A present but junk vercel
  // header is not replaced by a weaker source.
  const edge = h.get('x-vercel-forwarded-for')?.trim();
  const ip = literal(edge || h.get('x-real-ip'));
  const userAgent = h.get('user-agent')?.trim().slice(0, UA_MAX);
  return { ...(ip ? { ip } : {}), ...(userAgent ? { userAgent } : {}) };
}

/** The two outgoing headers; a missing value is simply not sent. */
export async function clientContextHeaders(): Promise<Record<string, string>> {
  const c = await readClientContext();
  return { ...(c.ip ? { 'x-forwarded-for': c.ip } : {}), ...(c.userAgent ? { 'user-agent': c.userAgent } : {}) };
}
