// Gateway refunds (C15 04-UI-UX §2.3; US-PG-09). Permission is checked before any API call; the URL is reduced to a whitelisted P6 query.
import { notFound } from 'next/navigation';
import { ApiError } from '@/core/api/server-fetch';
import { PermissionDenied } from '@/core/errors/PermissionDenied';
import { getShellSession } from '@/core/session/server';
import { RefundsList } from '@/features/payments/components/RefundsList';
import { refundsQuery } from '@/features/payments/query';
import { listPaymentCodes, listPaymentRefunds } from '@/features/payments/server/read.server';

export default async function GatewayRefundsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await getShellSession();
  const permissions = session?.actor.permissions ?? [];
  if (!permissions.includes('payments.reconciliation.read')) notFound();
  const { query, filter } = refundsQuery(await searchParams);
  try {
    const [list, refund_reject_reasons, refund_fail_reasons, refund_hold_reasons] = await Promise.all([
      listPaymentRefunds(query), listPaymentCodes('refund_reject_reasons'), listPaymentCodes('refund_fail_reasons'), listPaymentCodes('refund_hold_reasons'),
    ]);
    return (
      <RefundsList
        refunds={list.rows.slice(0, 50)} permissions={permissions} currentMembershipId={session?.actor.membershipId}
        codes={{ refund_reject_reasons, refund_fail_reasons, refund_hold_reasons }} filter={filter} hasPrevious={query.has('cursor')} {...(list.next ? { nextCursor: list.next } : {})}
      />
    );
  } catch (e) {
    if (e instanceof ApiError && e.status === 403) return <PermissionDenied />;
    throw e; // 5xx and the rest render error.tsx
  }
}
