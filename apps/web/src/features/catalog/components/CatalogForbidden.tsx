// 403 from a catalog read (03-APP-FLOW §5): full-page message with a way back; no table.
export function CatalogForbidden() {
  return (
    <section className="lims-state" aria-labelledby="catalog-forbidden">
      <h1 id="catalog-forbidden" className="lims-state-title">You don&apos;t have access to this part of the catalog</h1>
      <p className="lims-state-body">
        <a className="lims-link" href="/">Back to home</a>
      </p>
    </section>
  );
}
