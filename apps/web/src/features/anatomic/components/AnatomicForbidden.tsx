// 403 from a C11 read (03-APP-FLOW §4): full-page message with a way back; no table, no case data (REQ-SEC-081).
// LD-140 (2026-11-13): kit class names only. LD-439 (a), LD-436 rule 7: PageHeader owns the h1 (no raw heading); the state keeps the header row.
import { PageHeader } from '@lims/ui/components/PageHeader';

export function AnatomicForbidden() {
  return (
    <section aria-label="No access">
      <PageHeader title="You don't have permission to view pathology cases" helpKey="anatomic.worklist" />
      <div className="lims-state">
        <p className="lims-state-body">
          <a className="lims-link" href="/">Back to home</a>
        </p>
      </div>
    </section>
  );
}
