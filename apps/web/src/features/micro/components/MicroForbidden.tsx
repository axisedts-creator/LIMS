// 403 from a micro read (03-APP-FLOW §5): full-page message with a way back; no table.
// T0D-UIGUARD-1-MICRO (LD-436, LD-439): the title is the kit PageHeader (no raw h1) with the calling screen's help; the way back stays one link below it.
import { PageHeader } from '@lims/ui/components/PageHeader';

export function MicroForbidden({ helpKey }: { helpKey: string }) {
  return (
    <section aria-label="No access">
      <PageHeader title="You don't have access to this part of microbiology" helpKey={helpKey} />
      <p className="lims-state-body">
        <a className="lims-link" href="/">Back to home</a>
      </p>
    </section>
  );
}
