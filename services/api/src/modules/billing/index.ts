// Billing ModuleManifest (02-TRD §6.3, 02-CONVENTIONS §2.2). Autoloaded from modules/billing/index.ts.
// ports (BillingPort, BillingCommandPort) and createServices are added by the tasks that implement them.
import type { ModuleManifest } from '../../core/module.js';
import { handlers } from './handlers/index.js';
import { billingCommandPort } from './ports/BillingCommandPort.impl.js';
import { billingPort } from './ports/BillingPort.impl.js';

export const manifest: ModuleManifest = {
  name: 'billing',
  openapi: 'contracts/openapi/billing.yaml',
  handlers,
  ports: { BillingPort: billingPort, BillingCommandPort: billingCommandPort },
  produces: ['billing.invoice.issued.v1', 'billing.invoice.cancelled.v1', 'billing.balance.changed.v1'],
};
