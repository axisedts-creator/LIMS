// 403 from a C11 read (03-APP-FLOW §4): full-page message with a way back; no table, no case data (REQ-SEC-081).
// LD-140 (2026-11-13): kit class names only.
export function AnatomicForbidden() {
  return (
    <section className="lims-state" aria-labelledby="anatomic-forbidden">
      <h1 id="anatomic-forbidden" className="lims-state-title">You don&apos;t have permission to view pathology cases</h1>
      <p className="lims-state-body">
        <a className="lims-link" href="/">Back to home</a>
      </p>
    </section>
  );
}
