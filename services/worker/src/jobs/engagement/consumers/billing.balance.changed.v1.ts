// billing.balance.changed.v1 -> engagement (02-TRD §4.4, §7.2 row 4; 02-CV §7.4; 03-IC §3.5). Updates the balance columns + payment_due of an order that is ALREADY projected (the payload has no patient_id: an order of an
// unlinked patient / filtered partner order is simply not there = committed no-op; the balance at first sight of an order is read by projection.service). balance_version is the seq guard. No notification.
import type { ConsumerHandler } from '../../../core/manifest.js';
import { UUID, createProjectionService, projectionCtx } from '../../../../../api/src/modules/engagement/service/projection.service.js';

const projection = createProjectionService();
const paisa = (m: any): number | undefined => (Number.isSafeInteger(m?.amount_paisa) ? m.amount_paisa : undefined);

export const handle: ConsumerHandler = async (event, ctx) => {
  const p = event?.payload ?? {};
  if (typeof ctx.tenantId !== 'string' || !ctx.tenantId || event.tenant_id !== ctx.tenantId) return;
  const [invoiced, paid, due] = [paisa(p.invoiced), paisa(p.paid), paisa(p.balance_due)];
  if (typeof p.order_id !== 'string' || !UUID.test(p.order_id) || !Number.isInteger(p.balance_version) || p.balance_version < 0 || (p.release_basis != null && typeof p.release_basis !== 'string')
    || invoiced === undefined || paid === undefined || due === undefined) return;
  await projection.applyBalance(projectionCtx(ctx), { orderId: p.order_id, invoicedPaisa: invoiced, paidPaisa: paid, balanceDuePaisa: due, balanceVersion: p.balance_version, releaseBasis: p.release_basis ?? null }); // release_basis optional (03-IC §3.5): absent = keep stored basis
};
