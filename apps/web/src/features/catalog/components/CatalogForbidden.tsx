// 403 from a catalog read (03-APP-FLOW §5): full-page message with a way back; no table.
// T0D-UIGUARD-1-CATALOG (LD-436 R7): the kit PageHeader draws the h1, no raw heading.
import { PageHeader } from '@lims/ui/components/PageHeader';

export function CatalogForbidden() {
  return (
    <section className="lims-state" aria-label="No access">
      <PageHeader title="You don't have access to this part of the catalog" helpKey="catalog.home" />
      <p className="lims-state-body">
        <a className="lims-link" href="/">Back to home</a>
      </p>
    </section>
  );
}
