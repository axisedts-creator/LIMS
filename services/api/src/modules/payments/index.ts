// Payments ModuleManifest (02-TRD §3.1, 02-CONVENTIONS §2.2). Autoloaded from modules/payments/index.ts.
// Boot checks (TRD §9.3): config is validated at import, so a bad LIMS_PAYMENTS_* set stops the process before it serves.
// Handlers and port methods not yet built are placeholders; the tasks that implement them replace them.
import type { ModuleManifest } from '../../core/module.js';
import { loadPaymentsConfig } from './config.js';
import { handlers } from './handlers/index.js';
import { paymentProviderPort } from './ports/PaymentProviderPort.impl.js';

export const config = loadPaymentsConfig();

// CR-C15-004: paymentCallback resolver. The placeholder resolves nothing, so every callback token is refused (fail closed, auth.unauthenticated)
// until PG-T09 ships the DEFINER-backed lookup.
// [CONV] callable that also carries `resolve`: core/auth/resolvers.ts requires `.resolve()`; the module test asserts typeof === 'function'.
const resolveCallback = async (): Promise<undefined> => undefined;
const paymentCallback = Object.assign(resolveCallback, { resolve: resolveCallback });

export const manifest: ModuleManifest = {
  name: 'payments',
  openapi: 'contracts/openapi/payments.yaml',
  handlers,
  ports: { PaymentProviderPort: paymentProviderPort },
  produces: ['payments.intent.settled.v1'],
  authResolvers: { paymentCallback },
  systemPermissions: [], // CR-C15-005: jobs hold no payments.* HTTP permission; payments.intent.resolve is never granted
};
