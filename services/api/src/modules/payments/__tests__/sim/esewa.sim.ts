// PG-T05 eSewa status-check simulator (LD-104). Contract: ./esewa.sim.test.ts; bodies per TRD §7.2.4, V5, 04 P3.
// Local HTTP server on 127.0.0.1:0. Replies are scripted per test; HTTP 200 unless stated; body.status is the signal.
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export type SimReply = {
  status?: number;
  body?: object | string;
  delayMs?: number;
  hang?: boolean;
  drop?: boolean;
};
type ReplyOrFn = SimReply | ((query: Record<string, string>) => SimReply);

export interface EsewaSim {
  statusUrl: string;
  requests: { method: string; query: Record<string, string> }[];
  script(...replies: ReplyOrFn[]): void;
  reset(): void;
  close(): Promise<void>;
}

const AMOUNT_RE = /^-?\d+(\.\d+)?$/;

export const esewaReplies = {
  // totalAmount is spliced into the JSON text raw so "2250.0" stays "2250.0" (adapter regex-extracts it).
  complete: (o: { totalAmount: string; refId?: string; scd?: string; pid?: string }): ReplyOrFn => {
    if (!AMOUNT_RE.test(o.totalAmount)) throw new Error(`sim: bad totalAmount ${o.totalAmount}`);
    return (q): SimReply => ({
      body:
        `{"pid":${JSON.stringify(o.pid ?? q.transaction_uuid ?? '')},"scd":${JSON.stringify(o.scd ?? q.product_code ?? '')},` +
        `"totalAmount":${o.totalAmount},"status":"COMPLETE","refId":${JSON.stringify(o.refId ?? '0001SIM')}}`,
    });
  },
  pending: (): SimReply => ({ body: { status: 'PENDING' } }),
  ambiguous: (): SimReply => ({ body: { status: 'AMBIGUOUS' } }),
  ambigious: (): SimReply => ({ body: { status: 'AMBIGIOUS' } }), // vendor misspelling, verbatim (04 P3)
  fullRefund: (): SimReply => ({ body: { status: 'FULL_REFUND' } }),
  partialRefund: (): SimReply => ({ body: { status: 'PARTIAL_REFUND' } }),
  notFound: (): SimReply => ({ body: { status: 'NOT_FOUND' } }),
  canceled: (): SimReply => ({ body: { status: 'CANCELED' } }),
  codeZero: (): SimReply => ({ body: { code: 0, error_message: 'Service is currently unavailable' } }),
  unknownStatus: (s: string): SimReply => ({ body: { status: s } }),
  serverError: (st = 500): SimReply => ({ status: st, body: { error: 'sim server error' } }),
  malformed: (): SimReply => ({ body: '<html>not json{' }),
  hang: (): SimReply => ({ hang: true }),
  drop: (): SimReply => ({ drop: true }),
};

export async function startEsewaSim(): Promise<EsewaSim> {
  let queue: ReplyOrFn[] = [];
  const requests: EsewaSim['requests'] = [];

  const next = (): ReplyOrFn =>
    (queue.length > 1 ? queue.shift() : queue[0]) ?? { status: 500, body: 'sim: no reply scripted' };

  const server: Server = createServer((req: IncomingMessage, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const query = Object.fromEntries(url.searchParams);
    req.resume();
    if (url.pathname !== '/api/epay/transaction/status/') {
      res.writeHead(404).end();
      return;
    }
    requests.push({ method: req.method ?? '', query });
    const r0 = next();
    const r = typeof r0 === 'function' ? r0(query) : r0;
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
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const port = (server.address() as AddressInfo).port;

  return {
    statusUrl: `http://127.0.0.1:${port}/api/epay/transaction/status/`,
    requests,
    script: (...replies) => {
      queue = replies;
    },
    reset: () => {
      queue = [];
      requests.length = 0;
    },
    close: () =>
      new Promise<void>((ok) => {
        server.close(() => ok());
        server.closeAllConnections(); // hung sockets must not block close
      }),
  };
}
