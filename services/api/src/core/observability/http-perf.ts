// T0B-PERF-1 (LD-310) done_when 1, 2, 5: per request stats scope, Server-Timing, JSON compression over 1 KB, no-store on
// health, keep-alive above a 60 s proxy idle time. Wire format of the bodies is unchanged (identity when not accepted).
import { promisify } from 'node:util';
import { brotliCompress, constants as Z, gzip } from 'node:zlib';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createRequestStats, withRequestStats, type RequestStats } from './request-stats.js';

const brotli = promisify(brotliCompress);
const gz = promisify(gzip);
const MIN_BYTES = 1024;
const JSON_TYPE = /^application\/(?:[\w.+-]*\+)?json\b/i;

const stats = new WeakMap<FastifyRequest, RequestStats>();
/** db count / ms of a request (0 / 0 when it never reached a handler). */
export const dbStatsOf = (req: FastifyRequest): { count: number; ms: number } => stats.get(req)?.snapshot() ?? { count: 0, ms: 0 };

const ms1 = (n: number): number => Math.round(n * 10) / 10;

/** q-value of a coding in Accept-Encoding; `*` covers codings not named. 0 = not acceptable. */
export function qOf(header: string, coding: string): number {
  let star: number | undefined;
  for (const part of header.toLowerCase().split(',')) {
    const [name, ...params] = part.trim().split(';').map((s) => s.trim());
    const qp = params.find((p) => p.startsWith('q='));
    const q = qp === undefined ? 1 : Number(qp.slice(2));
    const v = Number.isFinite(q) ? Math.min(Math.max(q, 0), 1) : 0;
    if (name === coding) return v;
    if (name === '*') star = v;
  }
  return star ?? 0;
}

export function pickEncoding(header: unknown): 'br' | 'gzip' | undefined {
  if (typeof header !== 'string' || header === '') return undefined;
  const br = qOf(header, 'br');
  const g = qOf(header, 'gzip');
  if (br <= 0 && g <= 0) return undefined;
  return br >= g ? 'br' : 'gzip';
}

export function installHttpPerf(app: FastifyInstance): void {
  // keep-alive above a 60 s load balancer idle time; headersTimeout above it (no 502 on a reused socket the server just closed).
  app.server.keepAliveTimeout = 72_000;
  app.server.headersTimeout = 75_000;

  app.addHook('onRequest', async (req) => { stats.set(req, createRequestStats()); });
  // Entered after body parsing so every await of the handler (and core/db/tx.ts) sees this request's stats.
  app.addHook('preHandler', (req, _reply, done) => {
    const s = stats.get(req);
    if (s) withRequestStats(s, done); else done();
  });

  app.addHook('onSend', async (req, reply, payload) => {
    const db = dbStatsOf(req);
    // rid = req.id: genReqId only echoes a valid UUIDv7, so the value is quote-free.
    reply.header('server-timing', `total;dur=${ms1(reply.elapsedTime)}, db;dur=${ms1(db.ms)}, rid;desc="${String(req.id)}"`);
    if (req.routeOptions.url?.startsWith('/v1/core/health')) reply.header('cache-control', 'no-store');

    if (typeof payload !== 'string' && !Buffer.isBuffer(payload)) return payload; // streams / empty bodies untouched
    if (reply.hasHeader('content-encoding') || !JSON_TYPE.test(String(reply.getHeader('content-type') ?? ''))) return payload;
    const buf = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
    if (buf.length <= MIN_BYTES) return payload;
    const enc = pickEncoding(req.headers['accept-encoding']);
    const vary = String(reply.getHeader('vary') ?? '');
    if (!/accept-encoding/i.test(vary)) reply.header('vary', vary ? `${vary}, Accept-Encoding` : 'Accept-Encoding');
    if (!enc) return payload;
    // [CONV] brotli quality 4: close to gzip speed with a smaller result; quality 11 costs tens of ms per response.
    const out = enc === 'br' ? await brotli(buf, { params: { [Z.BROTLI_PARAM_QUALITY]: 4, [Z.BROTLI_PARAM_SIZE_HINT]: buf.length } }) : await gz(buf, { level: 6 });
    reply.header('content-encoding', enc);
    reply.removeHeader('content-length');
    return out;
  });
}
