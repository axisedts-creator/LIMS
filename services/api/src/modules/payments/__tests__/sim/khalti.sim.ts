// PG-T05 Khalti simulator (LD-104). Contract: ./khalti.sim.test.ts; bodies per TRD §7.3, V9–V11, 04 P4.
// Local HTTP server on 127.0.0.1:0. HTTP code is not the signal: body.status is (expired/canceled/failed come as 400).
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export type SimReply = {
  status?: number;
  body?: object | string;
  delayMs?: number;
  hang?: boolean;
  drop?: boolean;
};

export interface KhaltiEndpoint {
  script(...replies: SimReply[]): void;
}
export interface KhaltiSim {
  baseUrl: string;
  /** scheme + host of the sim, no path (refund API lives outside /api/v2/; PG-T15, LD-125). */
  origin: string;
  requests: { method: string; path: string; authorization: string | undefined; body: unknown }[];
  lookup: KhaltiEndpoint;
  initiate: KhaltiEndpoint;
  refund: KhaltiEndpoint;
  reset(): void;
  close(): Promise<void>;
}

type P = { pidx: string };
const lk = (status: string, http: number, { pidx }: P, extra: object = {}): SimReply => ({
  status: http,
  body: { pidx, total_amount: 225000, status, transaction_id: null, fee: 0, refunded: false, ...extra },
});

export const khaltiReplies = {
  completed: (o: P & { totalAmount: number; transactionId: string }): SimReply =>
    lk('Completed', 200, o, { total_amount: o.totalAmount, transaction_id: o.transactionId }),
  pending: (o: P): SimReply => lk('Pending', 200, o),
  initiated: (o: P): SimReply => lk('Initiated', 200, o),
  refunded: (o: P): SimReply => lk('Refunded', 200, o, { refunded: true }),
  partiallyRefunded: (o: P): SimReply => lk('Partially Refunded', 200, o),
  expired: (o: P): SimReply => lk('Expired', 400, o),
  userCanceled: (o: P): SimReply => lk('User canceled', 400, o),
  canceled: (o: P): SimReply => lk('Canceled', 400, o),
  failed: (o: P): SimReply => lk('Failed', 400, o),
  unknownStatus: (s: string, o: P): SimReply => lk(s, 200, o),
  notFound: (): SimReply => ({ status: 404, body: { detail: 'Not found.', error_key: 'validation_error' } }),
  invalidToken: (): SimReply => ({ status: 401, body: { detail: 'Invalid token.', status_code: 401 } }),
  initiateOk: ({ pidx }: P): SimReply => ({
    status: 200,
    body: {
      pidx,
      payment_url: `https://test-pay.khalti.com/?pidx=${pidx}`,
      expires_at: '2030-01-01T00:00:00.000000+05:45',
      expires_in: 1800,
    },
  }),
  initiateValidationError: (fields: Record<string, string[]>): SimReply => ({
    status: 400,
    body: { ...fields, error_key: 'validation_error' },
  }),
  refundOk: (): SimReply => ({ status: 200, body: { detail: 'Transaction refund successful.' } }),
  refundOther: (status: number, body: object | string): SimReply => ({ status, body }),
  serverError: (st = 500): SimReply => ({ status: st, body: { error: 'sim server error' } }),
  malformed: (): SimReply => ({ body: '<html>not json{' }),
  hang: (): SimReply => ({ hang: true }),
  drop: (): SimReply => ({ drop: true }),
};

const BASE = '/api/v2/';
type Route = 'lookup' | 'initiate' | 'refund';
// Refund API (V13, UNVERIFIED): POST /api/merchant-transaction/<transaction_id>/refund/
const REFUND_PATH = /^\/api\/merchant-transaction\/[^/]+\/refund\/$/;

export async function startKhaltiSim(opts: { apiKey?: string } = {}): Promise<KhaltiSim> {
  const queues: Record<Route, SimReply[]> = { lookup: [], initiate: [], refund: [] };
  const requests: KhaltiSim['requests'] = [];
  const routes: Record<string, Route> = {
    [`${BASE}epayment/lookup/`]: 'lookup',
    [`${BASE}epayment/initiate/`]: 'initiate',
  };

  const next = (k: Route): SimReply => {
    const q = queues[k];
    return (q.length > 1 ? q.shift() : q[0]) ?? { status: 500, body: 'sim: no reply scripted' };
  };

  const server: Server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      const route = routes[path] ?? (REFUND_PATH.test(path) ? 'refund' : undefined);
      if (!route) {
        res.writeHead(404).end();
        return;
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown = raw;
      try {
        body = raw === '' ? undefined : JSON.parse(raw);
      } catch {
        /* keep raw text */
      }
      const authorization = req.headers.authorization;
      requests.push({ method: req.method ?? '', path, authorization, body });
      // Key check precedes any scripted reply (V11, US-PG-12 AC2).
      const r =
        opts.apiKey !== undefined && authorization !== `Key ${opts.apiKey}` ? khaltiReplies.invalidToken() : next(route);
      const send = (): void => {
        if (r.hang) return;
        if (r.drop) {
          req.socket.destroy();
          return;
        }
        const b = r.body;
        res.writeHead(r.status ?? 200, { 'content-type': typeof b === 'string' ? 'text/plain' : 'application/json' });
        res.end(b === undefined ? '' : typeof b === 'string' ? b : JSON.stringify(b));
      };
      if (r.delayMs) setTimeout(send, r.delayMs);
      else send();
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const port = (server.address() as AddressInfo).port;

  return {
    baseUrl: `http://127.0.0.1:${port}${BASE}`,
    origin: `http://127.0.0.1:${port}`,
    requests,
    lookup: {
      script: (...r) => {
        queues.lookup = r;
      },
    },
    initiate: {
      script: (...r) => {
        queues.initiate = r;
      },
    },
    refund: {
      script: (...r) => {
        queues.refund = r;
      },
    },
    reset: () => {
      queues.refund = [];
      queues.lookup = [];
      queues.initiate = [];
      requests.length = 0;
    },
    close: () =>
      new Promise<void>((ok) => {
        server.close(() => ok());
        server.closeAllConnections();
      }),
  };
}
