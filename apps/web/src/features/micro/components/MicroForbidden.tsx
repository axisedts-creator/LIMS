// 403 from a micro read (03-APP-FLOW §5): full-page message with a way back; no table.
export function MicroForbidden() {
  return (
    <section className="lims-state" aria-labelledby="micro-forbidden">
      <h1 id="micro-forbidden" className="lims-state-title">You don&apos;t have access to this part of microbiology</h1>
      <p className="lims-state-body">
        <a className="lims-link" href="/">Back to home</a>
      </p>
    </section>
  );
}
