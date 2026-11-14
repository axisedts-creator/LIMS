// PG-T01: `phase1Stub` subset of the shared PaymentProviderPort contract (packages/fakes/contract-tests/PaymentProviderPort.contract.ts) run on the
// module's OWN port implementation (manifest.ports.PaymentProviderPort), plus "returns exactly the stub results for every method not yet built"
// (06-PLAN PG-T01 done_when; 08 A17 P-20; C0 TRD §9 / CR-C0-010; 03-IC §4.9 case 10). Reference = packages/fakes/src/stubs/PaymentProviderPort.stub.ts.
// "Exactly the stub results": every method rejects with LimsError code payments.gateway_not_available for ANY actor type and tenant (no auth.forbidden,
// no validation error, no other code), with no gateway network call and no ledger/event side effect.
// Fails now: ../../index.js does not exist.
import { describe, expect, it, vi } from 'vitest';
import { runPaymentProviderPortContract } from '../../../../../../../packages/fakes/contract-tests/PaymentProviderPort.contract';
import { createPaymentProviderPortStub } from '../../../../../../../packages/fakes/src/stubs/PaymentProviderPort.stub';
import { makeCtxFor, type ContractHarness } from '../../../../../../../packages/fakes/src/harness';
import { createEventSpy } from '../../../../../../../packages/fakes/src/event-spy';
import { manifest } from '../../index.js';

const impl = (): any => (manifest.ports as any).PaymentProviderPort;

// Harness over the real module port (phase-stub mode: seed is a no-op, like stubHarness).
const moduleHarness = (): (() => Promise<ContractHarness>) => async () => {
  const events = createEventSpy();
  return { impl: impl(), events, ctxFor: makeCtxFor(), async seed() {}, rollback(tx: unknown) { events.rollback(tx); } };
};

// PG-T08 (06-PLAN "each later task replaces one method"): createIntent / verify / getIntent / cancelIntent are real now and are covered by
// PaymentProviderPort.real.contract.test.ts (shared suite cases 1-18) and integration/intent.service.test.ts, so the shared phase-stub subset
// (case 10 through the module harness, which has no DB) and the stub-equality cases for those four methods are retired. `refund` stays the stub until PG-T14.
void runPaymentProviderPortContract;

const U = '01900000-0000-7000-8000-0000000c1501';
const money = { amountPaisa: 1000, currency: 'NPR' } as const;
const INPUTS: Record<string, unknown> = {
  refund: { intentId: U, amount: money, reasonCode: 'duplicate_payment', idempotencyKey: 'rf-1', approvalId: U },   // PG-T14 replaces this one
};
const code = async (p: Promise<unknown>): Promise<string> => p.then(() => 'resolved', (e: any) => e?.code ?? `non_lims_error:${e?.message}`);

describe('exactly the stub results for every method not yet built', () => {
  it('exposes the same method set as the phase stub', () => {
    expect(Object.keys(impl()).sort()).toEqual(Object.keys(createPaymentProviderPortStub()).sort());
  });

  const h = moduleHarness();
  it.each(Object.keys(INPUTS))('%s -> payments.gateway_not_available, same as the stub, for every actor type and both tenants', async (method) => {
    const harness = await h();
    const stub: any = createPaymentProviderPortStub();
    for (const key of ['A', 'B', 'A:system', 'A:user:finance', 'B:system', 'A:patient', 'A:portal', 'A:device']) {
      const ctx = harness.ctxFor(key);
      const want = await code(stub[method](ctx, INPUTS[method]));
      expect(want).toBe('payments.gateway_not_available');
      expect(await code(impl()[method](ctx, INPUTS[method])), `${method} as ${key}`).toBe(want);
    }
  });

  it('garbage input does not change the answer (no validation before the stub result)', async () => {
    const harness = await h();
    for (const method of Object.keys(INPUTS)) {
      expect(await code(impl()[method](harness.ctxFor('A'), { nonsense: true })), method).toBe('payments.gateway_not_available');
    }
  });

  it('never calls the network, never publishes an event, never touches BillingPort', async () => {
    const harness = await h();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('network must not be used'); });
    const billing = { getOrderBalance: vi.fn(), recordGatewayPayment: vi.fn(), recordGatewayRefund: vi.fn() };
    try {
      const ctx = harness.ctxFor('A:system', { ports: { BillingPort: billing } as any });
      for (const method of Object.keys(INPUTS)) await code(impl()[method](ctx, INPUTS[method]));
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(billing.getOrderBalance).not.toHaveBeenCalled();
      expect(billing.recordGatewayPayment).not.toHaveBeenCalled();
      expect(billing.recordGatewayRefund).not.toHaveBeenCalled();
    } finally { fetchSpy.mockRestore(); }
  });
});
