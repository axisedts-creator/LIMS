// C6-T36 test helpers (not a test file). Synthetic data only.
// ASSUMED API of the code under test (spec names no signatures; T36 files: ports/RenderPort.impl.ts):
//   ports/RenderPort.impl.ts exports  createRenderPort(o: { url: string; token: string; timeoutMs?: number /* default 60_000 */;
//                                                           schemas?: Record<string, object> /* JSON Schemas by templateKey; default = contracts/render/<key>.schema.json */ }): RenderPort
//   (url = renderer base URL; the impl POSTs `${url}/internal/render` with `Authorization: Bearer <token>` and the SECOND request shape
//    { template_id: <templateKey>, data, assets } — 02-TRD §5.1, §7.4). The schemas are injected here because contracts/render/*.schema.json
//    is a C0 deliverable that is not in the repo yet; the analytics schema below deliberately has NO maxItems on `rows`, so the 5,000-row cap
//    (IC §4.16) must be enforced by the impl itself.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { makeCtxFor, type ContractHarness } from '../../../../../../packages/fakes/src/harness.js';
import { createRenderPort } from '../ports/RenderPort.impl.js';

export const TOKEN = 'synthetic-renderer-token-0123456789abcdef';
export const sha256hex = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
export const rejection = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { return e; } throw new Error('expected rejection, got success'); };

const str = { type: 'string', maxLength: 200 };
const obj = (required: string[], properties: Record<string, object>) => ({ type: 'object', required, properties, additionalProperties: false });
export const SCHEMAS: Record<string, object> = {
  'partners.access_slip': obj(['tenantDisplayName', 'partnerName', 'patientDisplayName', 'orderRef', 'portalUrl', 'expiresAtLocal', 'issuedAtLocal'],
    Object.fromEntries(['tenantDisplayName', 'partnerName', 'patientDisplayName', 'orderRef', 'portalUrl', 'expiresAtLocal', 'issuedAtLocal'].map((k) => [k, str]))),
  'billing.invoice': obj(['invoiceNo', 'patientDisplayName', 'totalText'], { invoiceNo: str, patientDisplayName: str, totalText: str }),
  'billing.credit_note': obj(['creditNoteNo', 'totalText'], { creditNoteNo: str, totalText: str }),
  'billing.register': obj(['title'], { title: str }),
  'analytics.report': obj(['tenantDisplayName', 'reportTitle', 'columns', 'rows'], {
    tenantDisplayName: str, reportTitle: str,
    columns: { type: 'array', minItems: 1, maxItems: 40, items: obj(['key', 'label', 'kind'], { key: str, label: str, kind: str }) },
    rows: { type: 'array', items: { type: 'object' } },   // no maxItems on purpose (see header)
  }),
};
export const INVOICE = { invoiceNo: 'SYN-INV-0001', patientDisplayName: 'Test Patient 0042', totalText: 'NPR 1,500.00' };
export const SLIP = {
  tenantDisplayName: 'Synthetic Test Lab', partnerName: 'Test Partner Clinic', patientDisplayName: 'Test Patient 0042',
  orderRef: '0001SY000001', portalUrl: 'https://portal.invalid/r/tok0001', expiresAtLocal: '2026-12-05 10:00', issuedAtLocal: '2026-11-05 10:00',
};
export const analytics = (n: number) => ({
  tenantDisplayName: 'Synthetic Test Lab', reportTitle: 'Synthetic report', columns: [{ key: 'c1', label: 'Count', kind: 'count' }],
  rows: Array.from({ length: n }, (_, i) => ({ c1: i })),
});

export type Seen = { method?: string; url?: string; authorization?: string; body: any; raw: string };
export type StubMode = 'ok' | 'hang' | { status: number } | { bigPdfBytes: number };

/** Stand-in for the renderer's POST /internal/render (shape 2). Deterministic PDF bytes from the request body. */
export async function startRendererStub() {
  const seen: Seen[] = [];
  let mode: StubMode = 'ok';
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: any; try { body = JSON.parse(raw); } catch { body = undefined; }
      seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body, raw });
      if (mode === 'hang') return;   // never answers: the impl's own timeout must fire
      if (typeof mode === 'object' && 'status' in mode) { res.writeHead(mode.status).end(); return; }
      const pdf = typeof mode === 'object' && 'bigPdfBytes' in mode
        ? Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(mode.bigPdfBytes, 0x20), Buffer.from('\n%%EOF\n')])
        : Buffer.from(`%PDF-1.7\n%stub ${sha256hex(raw)}\n%%EOF\n`, 'utf8');
      res.writeHead(200, { 'content-type': 'application/pdf', 'x-page-count': '2', 'x-render-ms': '5' }).end(pdf);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`, seen, setMode: (m: StubMode) => { mode = m; },
    close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}

/** A URL where nothing listens (renderer down). */
export async function deadUrl(): Promise<string> {
  const s = http.createServer(); await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as AddressInfo).port; await new Promise<void>((r) => s.close(() => r()));
  return `http://127.0.0.1:${port}`;
}

/** ctx whose db/storage/bucket access throws: RenderPort must write nothing (AC-17.1 "C6 stores nothing"; 07-SECURITY 4b). */
export const touched: string[] = [];
const tripwire = (name: string) => new Proxy({}, { get: (_t, p) => { touched.push(`${name}.${String(p)}`); throw new Error(`RenderPort touched ctx.${name}`); } });

/** C6-T40: partners.access_slip checks portalUrl against LIMS_ORIGIN_PORTAL + '/r/' (02-TRD §7.4 case 8). ASSUMED: createRenderPort({ env }) reads it at call time
 *  (same as createNotificationPort({ env })). SLIP.portalUrl (and the C0 contract suite's SLIP) is under this origin. */
export const SLIP_ORIGIN = 'https://portal.invalid';

export async function makeRenderWorld(over: { timeoutMs?: number; env?: Record<string, string | undefined> } = {}) {
  const stub = await startRendererStub();
  const ctxFor = makeCtxFor();
  let url = stub.url;
  const build = () => createRenderPort({ url, token: TOKEN, schemas: SCHEMAS, env: { LIMS_ORIGIN_PORTAL: SLIP_ORIGIN }, ...over } as any);
  let real = build();
  const harness: ContractHarness = {
    impl: { renderPdf: (ctx: any, input: any) => real.renderPdf(ctx, input) },
    async seed(f: any) { if (f?.rendererDown) { url = await deadUrl(); real = build(); } },   // contract suite: `{ rendererDown: true }`
    ctxFor: (k, o) => ctxFor(k, { db: tripwire('db'), storage: tripwire('storage'), ...(o as object) } as any),
    events: { published: [], rollback() {} } as any,
    rollback() {},
  };
  return { stub, harness, port: { renderPdf: (ctx: any, input: any) => real.renderPdf(ctx, input) } };
}
