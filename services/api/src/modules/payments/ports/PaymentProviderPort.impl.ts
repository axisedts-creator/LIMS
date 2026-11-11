// PaymentProviderPort module implementation (08 A17 P-20, 02-TRD §5.3).
// PG-T08: createIntent / verify / getIntent / cancelIntent are real (createPaymentProviderPort). `refund` stays the PG-T01 stub until PG-T14:
// it rejects payments.gateway_not_available for any actor, tenant or input, with no validation, network, ledger or event side effect.
// The module-level `paymentProviderPort` (used by index.ts) stays all-stub until the runtime supplies PaymentsDeps (KEK, adapters, events, jobs).
import { LimsError } from '../../../core/errors.js';
import { createIntentService } from '../service/intent.service.js';
import { createOutcomeService, type PaymentsDeps } from '../service/outcome.service.js';

export type { PaymentsDeps } from '../service/outcome.service.js';

const off = async (): Promise<never> => { throw new LimsError('payments.gateway_not_available'); };

export function createPaymentProviderPort(deps: PaymentsDeps) {
  const intents = createIntentService(deps);
  const outcomes = createOutcomeService(deps);
  return Object.freeze({
    createIntent: intents.createIntent, getIntent: intents.getIntent, cancelIntent: intents.cancelIntent,
    verify: outcomes.verify,
    refund: off as (ctx: unknown, input: unknown) => Promise<never>, // PG-T14
  });
}

export const paymentProviderPort = Object.freeze({ createIntent: off, verify: off, refund: off, getIntent: off, cancelIntent: off });
