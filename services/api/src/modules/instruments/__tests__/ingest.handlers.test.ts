// C7 API-T09 — HTTP wiring of E04 (02-TRD §7.2; contracts/openapi/instruments.yaml). The service is mocked (behaviour: ingest.service.test.ts).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { batch, message, makeWorld, makeIngestCtx } from './ingest.helpers.js';
import { rejection } from './agents.helpers.js';

const svc = { submitMessageBatch: vi.fn() };
vi.mock('../service/ingest.service.js', () => ({ createIngestService: () => svc }));
const { manifest } = await import('../index.js');
const h: any = (manifest.handlers as any)['submitMessageBatch'];
const hctx = () => ({ operationId: 'submitMessageBatch', ...makeIngestCtx(makeWorld()).ctx });
beforeEach(() => { svc.submitMessageBatch = vi.fn(async () => ({ status: 200, body: { server_time: '2026-11-07T12:00:00.000Z', results: [] } })); });

describe('submitMessageBatch handler', () => {
  it('is no longer the stub: without an authenticated device context it fails closed with auth.unauthenticated and never calls the service', async () => {
    const e = await rejection(h({ params: {}, query: {}, headers: {}, body: batch([message()]) }, { operationId: 'submitMessageBatch', clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} } }));
    expect(e?.code).toBe('auth.unauthenticated'); expect(svc.submitMessageBatch).not.toHaveBeenCalled();
  });
  it('passes the body through unchanged as { body } and returns the service result untouched', async () => {
    const body = batch([message({ n: 1 })]); const r = await h({ params: {}, query: {}, headers: {}, body }, hctx());
    expect(svc.submitMessageBatch).toHaveBeenCalledWith(expect.objectContaining({ actor: expect.objectContaining({ type: 'device' }) }), { body });
    expect(r).toEqual({ status: 200, body: { server_time: '2026-11-07T12:00:00.000Z', results: [] } });
  });
});
