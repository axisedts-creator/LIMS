// packages/fakes/src/stubs/PaymentProviderPort.stub.ts — phase stub (C0 TRD §9; 08 R9): no gateway is available.
import { LimsError } from "@lims/contracts/ports/common";
import type { PaymentProviderPort } from "@lims/contracts/ports/PaymentProviderPort";

const off = async (): Promise<never> => { throw new LimsError("payments.gateway_not_available"); };

export function createPaymentProviderPortStub(): PaymentProviderPort {
  return { createIntent: off, verify: off, refund: off, getIntent: off, cancelIntent: off };
}
