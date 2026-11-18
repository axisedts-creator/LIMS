// T0D-UNSLOP-1 (A), LD-353 rule 6: an operation that is not built yet (API 501 operation_pending) shows the calm NotAvailable state,
// never the red error page. T0D-UIKIT-1: the component itself now lives in the kit; this file keeps the import path and the helpers.
import type { ReactNode } from 'react';
import { NotAvailable } from '@lims/ui/components/NotAvailable';

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
