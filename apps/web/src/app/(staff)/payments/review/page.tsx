// Payment review queue (C15 04-UI-UX §2.1; US-PG-07). Permission is checked before any API call; the URL is reduced to a whitelisted P1 query.
import { notFound } from 'next/navigation';
import { ApiError } from '@/core/api/server-fetch';
import { PermissionDenied } from '@/core/errors/PermissionDenied';
import { getShellSession } from '@/core/session/server';
import { ReviewQueue } from '@/features/payments/components/ReviewQueue';
import { reviewQuery } from '@/features/payments/query';
import { listPaymentCodes, listPaymentIntents } from '@/features/payments/server/read.server';

export default async function PaymentReviewPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const permissions = (await getShellSession())?.actor.permissions ?? [];
  if (!permissions.includes('payments.reconciliation.read')) notFound();
  const { query, filter } = reviewQuery(await searchParams, Date.now());
  try {
    const [list, holdReasons] = await Promise.all([listPaymentIntents(query), listPaymentCodes('hold_reasons')]);
    const next = list?.page?.next_cursor;
    return (
      <ReviewQueue
        intents={(Array.isArray(list?.data) ? list.data : []).slice(0, 50)} permissions={permissions} centres={[]} holdReasons={holdReasons} filter={filter}
        hasPrevious={query.has('cursor')} {...(next ? { nextCursor: next } : {})}
      />
    );
  } catch (e) {
    if (e instanceof ApiError && e.status === 403) return <PermissionDenied />;
    throw e; // 5xx and the rest render error.tsx
  }
}
