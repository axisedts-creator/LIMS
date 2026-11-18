// Gateway reconciliation (C15 04-UI-UX §2.4; US-PG-08). Permission is checked before any API call; the URL is reduced to whitelisted P15 filters.
import { notFound } from 'next/navigation';
import { ApiError } from '@/core/api/server-fetch';
import { PermissionDenied } from '@/core/errors/PermissionDenied';
import { getShellSession } from '@/core/session/server';
import { NotAvailable, isPending } from '@/core/shell/NotAvailable';
import { ReconciliationView } from '@/features/payments/components/ReconciliationView';
import { findingsQuery } from '@/features/payments/query';
import { listPaymentCodes, listPaymentIntents, listReconciliationFindings, listReconciliationRuns } from '@/features/payments/server/read.server';

export default async function GatewayReconciliationPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const permissions = (await getShellSession())?.actor.permissions ?? [];
  if (!permissions.includes('payments.reconciliation.read')) notFound();
  const { query, filter } = findingsQuery(await searchParams);
  try {
    const [runs, findings, finding_kinds, finding_resolutions, held] = await Promise.all([
      listReconciliationRuns(new URLSearchParams({ sort: '-business_date', limit: '20' })),
      listReconciliationFindings(query),
      listPaymentCodes('finding_kinds'),
      listPaymentCodes('finding_resolutions'),
      listPaymentIntents(new URLSearchParams({ status: 'held_for_review', limit: '50', sort: '-created_at' })),
    ]);
    // The tile counts ALL open critical findings: when the list is filtered / paged it cannot be derived from it, so ask for them (after the list, in order).
    const unfiltered = !filter.kind.length && !filter.severity && !query.has('cursor');
    const openCritical = unfiltered
      ? findings.rows.filter((f) => f.severity === 'critical').length
      : (await listReconciliationFindings(new URLSearchParams({ status: 'open', severity: 'critical', limit: '50' }))).rows.length;
    const lastSuccessfulRunAt = runs.rows.filter((r) => r.status === 'completed' && r.finished_at).map((r) => r.finished_at!).sort().at(-1);
    return (
      <ReconciliationView
        runs={runs.rows} findings={findings.rows.slice(0, 50)} codes={{ finding_kinds, finding_resolutions }} permissions={permissions} filter={filter}
        stats={{ openCritical, underReview: Array.isArray(held?.data) ? Math.min(held.data.length, 50) : 0, ...(lastSuccessfulRunAt ? { lastSuccessfulRunAt } : {}) }}
        hasPrevious={query.has('cursor')} {...(findings.next ? { nextCursor: findings.next } : {})}
      />
    );
  } catch (e) {
    if (e instanceof ApiError && e.status === 403) return <PermissionDenied />;
    // T0D-UILIST-2 (LD-353 rule 6): 501 operation_pending = NotAvailable with the header row; 500+ keeps title, filters and header rows with an ErrorState in the table
    if (isPending(e)) return <NotAvailable title="Gateway reconciliation" columns={['Business date', 'Trigger', 'Status', 'Checked', 'OK', 'Findings', 'Critical', 'Finished']} />;
    if (e instanceof ApiError && e.status >= 500) {
      return (
        <ReconciliationView
          runs={[]} findings={[]} codes={{ finding_kinds: [], finding_resolutions: [] }} permissions={permissions} filter={filter} stats={{ openCritical: 0, underReview: 0 }}
          failure={e.problem?.request_id ? { requestId: e.problem.request_id } : {}}
        />
      );
    }
    throw e; // 4xx render error.tsx
  }
}
