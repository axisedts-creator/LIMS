// Gateway refunds (C15 04-UI-UX §2.3; US-PG-09). Permission is checked before any API call; the URL is reduced to a whitelisted P6 query.
import { notFound } from 'next/navigation';
import { ApiError } from '@/core/api/server-fetch';
import { PermissionDenied } from '@/core/errors/PermissionDenied';
import { getShellSession } from '@/core/session/server';
import { RefundsList } from '@/features/payments/components/RefundsList';
import { refundsQuery } from '@/features/payments/query';
import { getPaymentSettings, listPaymentCodes, listPaymentRefunds } from '@/features/payments/server/read.server';

export default async function GatewayRefundsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await getShellSession();
  const permissions = session?.actor.permissions ?? [];
  if (!permissions.includes('payments.reconciliation.read')) notFound();
  const { query, filter } = refundsQuery(await searchParams);
  try {
    // Two-person threshold (P23) only when the actor may read settings; a 403 there leaves it unset and the server decides.
    const threshold = permissions.includes('payments.merchant_config.read')
      ? getPaymentSettings().then((s) => s.refund_two_person_threshold.amount_paisa, (e: unknown) => { if (e instanceof ApiError && e.status === 403) return undefined; throw e; })
      : Promise.resolve(undefined);
    const [list, refund_reject_reasons, refund_fail_reasons, refund_hold_reasons, thresholdPaisa] = await Promise.all([
      listPaymentRefunds(query), listPaymentCodes('refund_reject_reasons'), listPaymentCodes('refund_fail_reasons'), listPaymentCodes('refund_hold_reasons'), threshold,
    ]);
    return (
      <RefundsList
        refunds={list.rows.slice(0, 50)} permissions={permissions} currentMembershipId={session?.actor.membershipId}
        codes={{ refund_reject_reasons, refund_fail_reasons, refund_hold_reasons }} thresholdPaisa={thresholdPaisa} filter={filter} hasPrevious={query.has('cursor')} {...(list.next ? { nextCursor: list.next } : {})}
      />
    );
  } catch (e) {
    if (e instanceof ApiError && e.status === 403) return <PermissionDenied />;
    throw e; // 5xx and the rest render error.tsx
  }
}
