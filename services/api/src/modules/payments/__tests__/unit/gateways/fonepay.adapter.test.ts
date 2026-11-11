// PG-T07 — Fonepay slot (US-PG-12 AC1; 03-IC §4.9; BLOCKED B8; PRD "nothing about the Fonepay API is invented").
// Assumed seam (tester; writer may dispute via notes) — gateways/fonepay.adapter.ts exports `createFonepayAdapter()`:
//   gateway === 'fonepay'; initiate/check reject, buildAction throws, all with LimsError 'payments.gateway_not_available' (HTTP 503);
//   no network I/O; no verifyCallbackSignature / refundViaApi members (no invented Fonepay API).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LimsError } from '../../../../../core/errors.js';
import { createFonepayAdapter } from '../../../gateways/fonepay.adapter.js';
import { SecretHandle } from '../../../service/credentials.js';

const CODE = 'payments.gateway_not_available';
const s = new SecretHandle('synthetic-fonepay-secret');
const i = { intentId: '11111111-1111-4111-8111-111111111111', amountPaisa: 225000, callbackToken: 'tok', websiteUrl: 'https://lab.example.test', purchaseOrderName: 'x' };
const st = { intentId: i.intentId, gatewayTxnRef: 'x', amountPaisa: 225000, paymentUrl: 'https://x.example.test/' };
afterEach(() => { vi.restoreAllMocks(); });

const caught = async (f: () => unknown): Promise<unknown> => { try { await f(); } catch (e) { return e; } return undefined; };

describe('fonepay adapter slot', () => {
  const a = createFonepayAdapter();

  it('AC1: identifies as fonepay', () => { expect(a.gateway).toBe('fonepay'); });

  it.each([
    ['initiate', () => a.initiate(i, s)],
    ['check', () => a.check(st, s)],
    ['buildAction', () => a.buildAction(st, s)],
  ])('AC1: %s -> LimsError payments.gateway_not_available (503)', async (_n, call) => {
    const e = await caught(call);
    expect(e).toBeInstanceOf(LimsError);
    expect((e as LimsError).code).toBe(CODE);
    expect((e as LimsError).statusCode).toBe(503);
  });

  it('initiate/check return rejected promises (never throw synchronously, never resolve)', () => {
    const p1 = a.initiate(i, s); const p2 = a.check(st, s);
    expect(p1).toBeInstanceOf(Promise); expect(p2).toBeInstanceOf(Promise);
    return Promise.allSettled([p1, p2]).then((r) => expect(r.map((x) => x.status)).toEqual(['rejected', 'rejected']));
  });

  it('makes no network call and exposes no callback-signature or refund API', async () => {
    const f = vi.spyOn(globalThis, 'fetch');
    await caught(() => a.initiate(i, s)); await caught(() => a.check(st, s)); await caught(() => a.buildAction(st, s));
    expect(f).not.toHaveBeenCalled();
    const bag = a as unknown as Record<string, unknown>;
    expect(bag['verifyCallbackSignature']).toBeUndefined();
    expect(bag['refundViaApi']).toBeUndefined();
  });

  it('error carries no secret', async () => {
    const e = (await caught(() => a.initiate(i, s))) as Error;
    expect(JSON.stringify([e.message, (e as LimsError).detail ?? ''])).not.toContain('synthetic-fonepay-secret');
  });
});
