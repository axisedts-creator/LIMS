// Payment intent detail (C15 04-UI-UX §2.2; US-PG-07). The resolve coded sets are only fetched for sessions that can resolve.
import { notFound } from 'next/navigation';
import { ApiError } from '@/core/api/server-fetch';
import { PermissionDenied } from '@/core/errors/PermissionDenied';
import { getShellSession } from '@/core/session/server';
import { IntentDetailView } from '@/features/payments/components/IntentDetailView';
import { getPaymentIntent, listPaymentCodes } from '@/features/payments/server/read.server';

export default async function PaymentIntentPage({ params }: { params: Promise<{ intent_id: string }> }) {
  const { intent_id } = await params;
  const permissions = (await getShellSession())?.actor.permissions ?? [];
  if (!permissions.includes('payments.reconciliation.read')) notFound();
  try {
    const canResolve = permissions.includes('payments.intent.resolve');
    const canRefund = permissions.includes('payments.refund.request');
    const [intent, resolution_reasons, cancel_reasons, refund_reasons] = await Promise.all([
      getPaymentIntent(intent_id),
      canResolve ? listPaymentCodes('resolution_reasons') : [],
      canResolve ? listPaymentCodes('cancel_reasons') : [],
      canRefund ? listPaymentCodes('refund_reasons') : [],
    ]);
    return <IntentDetailView intent={intent} permissions={permissions} codes={{ resolution_reasons, cancel_reasons, refund_reasons }} />;
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 400)) notFound();
    if (e instanceof ApiError && e.status === 403) return <PermissionDenied />;
    throw e;
  }
}
