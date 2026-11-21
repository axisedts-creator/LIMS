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
  // LD-325 (T0B-BOOTGATE-1): T0B-ACCT-2 implemented its 12 operations and removed them; no billing operation is pending.
  pendingOperations: [
    'listAccountSummaries', // LD-358 (T0C-ACCTLIST-1): until T0B-ACCTLIST-1 writes its handler.
    // LD-321 / LD-325(b): T0B-FINCTRL-1 implemented the 16 T0C-FINCTRL-1 operations and removed them.
  ], // 501 operation_pending until the handler task removes the id
};
