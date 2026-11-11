// PaymentProviderPort module implementation (08 A17 P-20, 02-TRD §5.3). PG-T01: every method is "not yet built" and returns exactly the phase
// stub result (packages/fakes/src/stubs/PaymentProviderPort.stub.ts): reject payments.gateway_not_available for any actor, tenant or input,
// with no validation, no network and no ledger/event side effect. Each later task replaces one method and adds that method's full contract cases.
import { LimsError } from '../../../core/errors.js';

const off = async (): Promise<never> => { throw new LimsError('payments.gateway_not_available'); };

export const paymentProviderPort = Object.freeze({ createIntent: off, verify: off, refund: off, getIntent: off, cancelIntent: off });
