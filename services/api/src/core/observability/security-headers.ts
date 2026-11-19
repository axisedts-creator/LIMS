// SEC-HDR-1 (LD-238, audit 10.1): one onSend hook. nosniff + Referrer-Policy no-referrer on every response;
// Cache-Control no-store on authenticated JSON only (non-public operation, 2xx, JSON body) and only when the handler sent none.
// HSTS stays at the edge (infra/edge/nginx/snippets/headers.conf). No CSP here (the API serves no documents).
import type { FastifyInstance } from 'fastify';

const JSON_TYPE = /^application\/(?:[\w.+-]*\+)?json\b/i;

export function installSecurityHeaders(app: FastifyInstance): void {
  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    const schema = req.routeOptions?.schema as Record<string, unknown> | undefined;
    const authenticated = typeof schema?.operationId === 'string' && schema['x-public'] === undefined;
    if (authenticated && reply.statusCode >= 200 && reply.statusCode < 300 && !reply.hasHeader('cache-control')
      && JSON_TYPE.test(String(reply.getHeader('content-type') ?? ''))) reply.header('cache-control', 'no-store');
    return payload;
  });
}
