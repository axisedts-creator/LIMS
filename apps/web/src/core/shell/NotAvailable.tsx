// T0D-UNSLOP-1 (A), LD-353 rule 6: an operation that is not built yet (API 501 operation_pending) shows this calm state, never the red
// error page. The page keeps its menu title (h1) and, for a list screen, the header row of its table. Not a failure: no alert, Retry or reference.
import type { ReactNode } from 'react';
import { PageHeader } from '@lims/ui/components/PageHeader';

export function NotAvailable({ title, columns, helpKey = 'shell.not_available' }: { title: string; columns?: readonly string[]; helpKey?: string }) {
  return (
    <>
      <PageHeader title={title} helpKey={helpKey} />
      {columns?.length ? (
        <div className="lims-table-scroll">
          <table className="lims-table lims-table-compact">
            <thead>
              <tr>{columns.map((c) => <th key={c} scope="col" className="lims-col">{c}</th>)}</tr>
            </thead>
            <tbody>
              <tr className="lims-row-empty"><td className="lims-cell" colSpan={columns.length}><Calm /></td></tr>
            </tbody>
          </table>
        </div>
      ) : <Calm />}
    </>
  );
}

const Calm = () => (
  <div className="lims-state">
    <p className="lims-state-title">Not available yet</p>
    <p className="lims-state-body">This part of the system is being built. It appears here once it is switched on.</p>
  </div>
);

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
