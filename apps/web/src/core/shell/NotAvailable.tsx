// T0D-UNSLOP-1 (A), LD-353 rule 6: an operation that is not built yet (API 501 operation_pending) shows the calm NotAvailable state,
// never the red error page. T0D-UIKIT-1: the component itself now lives in the kit; this file keeps the import path and the helpers.
import type { ReactNode } from 'react';
import { NotAvailable } from '@lims/ui/components/NotAvailable';
import { LoadError } from './LoadError';

export { NotAvailable };

/** The API answered 501 operation_pending (the operation is on the pending list, no handler yet). Duck typed so any feature's ApiError counts. */
export function isPending(e: unknown): boolean {
  const x = e as { status?: number; problem?: { code?: string } } | null;
  return x?.status === 501 && x.problem?.code === 'operation_pending';
}

/** Renders the page, or NotAvailable when an operation it needs is pending; every other failure still throws to error.tsx. */
export async function pendingOr(title: string, columns: readonly string[] | undefined, render: () => Promise<ReactNode> | ReactNode): Promise<ReactNode> {
  try {
    return await render();
  } catch (e) {
    if (isPending(e)) return <NotAvailable title={title} {...(columns ? { columns } : {})} />;
    throw e;
  }
}

/**
 * T0D-UILIST-1 (LD-353 rule 6): pendingOr, and any other API failure of 500 or above keeps the page title and shows ErrorState (reference + Retry) in the page.
 * 4xx (403 no access, 404, 400) still throw so each page's own gate or notFound() handles them. Duck typed like isPending.
 */
export async function loadOr(title: string, columns: readonly string[] | undefined, render: () => Promise<ReactNode> | ReactNode): Promise<ReactNode> {
  try {
    return await pendingOr(title, columns, render);
  } catch (e) {
    const x = e as { status?: number; problem?: { request_id?: string } } | null;
    if (typeof x?.status !== 'number' || x.status < 500) throw e;
    return <LoadError title={title} {...(x.problem?.request_id ? { requestId: x.problem.request_id } : {})} />;
  }
}
