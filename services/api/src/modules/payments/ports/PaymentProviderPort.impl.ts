// PaymentProviderPort module implementation (08 A17 P-20, 02-TRD §5.3).
// PG-T08: createIntent / verify / getIntent / cancelIntent are real (createPaymentProviderPort). PG-T14: `refund` is real too (service/refund.service.ts).
// The module-level `paymentProviderPort` (used by index.ts) stays all-stub until the runtime supplies PaymentsDeps (KEK, adapters, events, jobs).
import { LimsError } from '../../../core/errors.js';
import { createIntentService } from '../service/intent.service.js';
import { createOutcomeService, type PaymentsDeps } from '../service/outcome.service.js';
import { createRefundService } from '../service/refund.service.js';

export type { PaymentsDeps } from '../service/outcome.service.js';

const off = async (): Promise<never> => { throw new LimsError('payments.gateway_not_available'); };

export function createPaymentProviderPort(deps: PaymentsDeps) {
  const intents = createIntentService(deps);
  const outcomes = createOutcomeService(deps);
  return Object.freeze({
    createIntent: intents.createIntent, getIntent: intents.getIntent, cancelIntent: intents.cancelIntent,
    verify: outcomes.verify,
    refund: createRefundService(deps).refund,
  });
}

export const paymentProviderPort = Object.freeze({ createIntent: off, verify: off, refund: off, getIntent: off, cancelIntent: off });
