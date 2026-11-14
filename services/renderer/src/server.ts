// Renderer HTTP server (02-TRD §5.1): POST /internal/render, GET /internal/health, GET /internal/metrics.
// Bearer token (constant-time) on render + metrics; health is open and returns only a status word.
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { pathToFileURL } from 'node:url';
import { createPool, RenderError, type Pool } from './pool.js';
import { render, type Assets } from './render.js';
import type { Registry } from './templates/registry.js';

const MAX_BODY = 20 * 1024 * 1024; // 02-TRD §5.1 "≤ 20 MB [CONV]"
const TEMPLATE_ID = /^[a-z][a-z0-9_.-]{0,63}$/;
const IMAGE_MIME = new Set(['image/png', 'image/jpeg']);
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

const digest = (s: string) => createHash('sha256').update(s).digest();

function parseBundle(raw: string): { templateId: string; data: unknown; hasData: boolean; assets: Assets } | undefined {
  let b: unknown;
  try {
    b = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!b || typeof b !== 'object' || Array.isArray(b)) return undefined;
  const { template_id, assets = {}, ...rest } = b as Record<string, unknown>;
  if (typeof template_id !== 'string' || !TEMPLATE_ID.test(template_id)) return undefined;
  if (!assets || typeof assets !== 'object' || Array.isArray(assets)) return undefined;
  for (const a of Object.values(assets as Record<string, unknown>)) {
    const { mime_type, base64 } = (a ?? {}) as Record<string, unknown>;
    if (typeof mime_type !== 'string' || !IMAGE_MIME.has(mime_type)) return undefined;
    if (typeof base64 !== 'string' || !BASE64.test(base64)) return undefined;
  }
  // Report shape carries document/config/variant; data-template shape carries data (§5.1). The template reads its part.
  const hasData = 'data' in rest;
  const data = hasData ? rest.data : rest;
  return { templateId: template_id, data, hasData, assets: assets as Assets };
}

/** `registry` (optional): ids it knows as DataTemplateModule use the second request shape (`data`); everything else is unchanged. */
export async function startServer(o: { pool: Pool; token: string; port?: number; host?: string; registry?: Registry }) {
  if (!o.token) throw new Error('renderer token is empty');
  const want = digest(o.token);
  const authed = (req: http.IncomingMessage) => {
    const h = req.headers.authorization ?? '';
    const tok = h.startsWith('Bearer ') ? h.slice(7) : '';
    return timingSafeEqual(digest(tok), want) && tok.length > 0;
  };
  const send = (res: http.ServerResponse, status: number, body = '', type = 'text/plain; charset=utf-8') =>
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' }).end(body);

  const server = http.createServer(async (req, res) => {
    try {
      const path = (req.url ?? '').split('?')[0];
      if (req.method === 'GET' && path === '/internal/health') return send(res, 200, 'ok');
      if (path !== '/internal/render' && path !== '/internal/metrics') return send(res, 404);
      if (!authed(req)) return send(res, 401);
      if (req.method === 'GET' && path === '/internal/metrics')
        return send(res, 200, await o.pool.registry.metrics(), o.pool.registry.contentType);
      if (req.method !== 'POST' || path !== '/internal/render') return send(res, 405);

      const tooBig = () => {
        // Answer, then drain and close; requestTimeout bounds how long a client can keep streaming.
        res.setHeader('connection', 'close');
        send(res, 413);
        req.resume();
      };
      if (Number(req.headers['content-length'] ?? 0) > MAX_BODY) return tooBig();
      // Event-based read: breaking out of for-await would destroy the socket before the 413 is sent.
      const raw = await new Promise<string | undefined>((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        const onData = (c: Buffer) => {
          size += c.length;
          if (size <= MAX_BODY) return void chunks.push(c);
          req.off('data', onData);
          resolve(undefined);
        };
        req.on('data', onData);
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
      });
      if (raw === undefined) return tooBig();
      const bundle = parseBundle(raw);
      if (!bundle) return send(res, 400);
      // Second shape needs an explicit `data` object (else the whole bundle would be mistaken for the data).
      const isData = typeof (o.registry?.get(bundle.templateId) as { templateKey?: unknown } | undefined)?.templateKey === 'string';
      if (isData && !bundle.hasData) return send(res, 400);
      const t0 = Date.now();
      const { pdf, pageCount } = await render(bundle.templateId, bundle.data, bundle.assets, o.pool, o.registry);
      res.writeHead(200, { 'content-type': 'application/pdf', 'x-page-count': String(pageCount), 'x-render-ms': String(Date.now() - t0) });
      res.end(pdf);
    } catch (e) {
      // Never a stack trace on the wire; status from the pool/render error table (400/408/422/503).
      if (!res.headersSent) send(res, e instanceof RenderError ? e.httpStatus : 500);
      else res.destroy();
    }
  });
  await new Promise<void>((r) => server.listen(o.port ?? 0, o.host ?? '127.0.0.1', r));
  const { address, port } = server.address() as AddressInfo;
  return {
    url: `http://${address.includes(':') ? `[${address}]` : address}:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

// Process entry: `node src/server.ts`. Token from LIMS_RENDERER_TOKEN_FILE (02-TRD §8); listens on render_net only.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const tokenFile = process.env.LIMS_RENDERER_TOKEN_FILE;
  if (!tokenFile) throw new Error('LIMS_RENDERER_TOKEN_FILE is required');
  const token = readFileSync(tokenFile, 'utf8').trim();
  const pool = await createPool();
  // ponytail: port 8080 fixed [CONV]; spec names no port key — C1 wires render_net to it.
  await startServer({ pool, token, port: 8080, host: '0.0.0.0' });
  const stop = async () => {
    await pool.close();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
