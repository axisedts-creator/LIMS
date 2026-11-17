// Segment loading for /homecollection/visits/[visit_id] (04-UI-UX §2.6: LoadingSkeleton).
import { LoadingSkeleton } from '@lims/ui/components/LoadingSkeleton';

export default function VisitLoading() {
  return <LoadingSkeleton variant="detail" />;
}
