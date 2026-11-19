// T0D-UIKIT-1 (moved from apps/web core/shell, T0D-UNSLOP-1 (A)); LD-353 rule 6: an operation that is not built yet (API 501 operation_pending)
// shows this calm state, never the red error page. The page keeps its menu title (h1) and, for a list screen, the header row of its table.
// Not a failure: no alert, Retry or reference. No hooks and no handlers, so server pages (pendingOr) can render it.
import { PageHeader } from '../PageHeader/PageHeader';

export interface NotAvailableProps {
  /** The PAGE title (the menu label, LD-353 rule 8), rendered as the h1. */
  title: string;
  /** Header row of the list this page would show (LD-353 rule 5: the header row is always visible). */
  columns?: readonly string[];
  helpKey?: string;
  /** Replaces the default hint line. */
  body?: string;
}

const HINT = 'This part of the system is being built. It appears here once it is switched on.';

export function NotAvailable({ title, columns, helpKey = 'shell.not_available', body = HINT }: NotAvailableProps) {
  const calm = (
    <div className="lims-state">
      <p className="lims-state-title">Not available yet</p>
      <p className="lims-state-body">{body}</p>
    </div>
  );
  return (
    <>
      <PageHeader title={title} helpKey={helpKey} />
      {columns?.length ? (
        <div className="lims-data-table">
          <div className="lims-table-scroll">
            <table className="lims-table lims-table-compact">
              <thead>
                <tr>{columns.map((c) => <th key={c} scope="col" className="lims-col">{c}</th>)}</tr>
              </thead>
              <tbody>
                <tr className="lims-row-empty"><td className="lims-cell" colSpan={columns.length}>{calm}</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      ) : calm}
    </>
  );
}
