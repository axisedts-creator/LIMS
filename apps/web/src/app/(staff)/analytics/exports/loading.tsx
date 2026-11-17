// Segment loading for /analytics/exports (03-APP-FLOW §5: LoadingSkeleton variant='page').
import { LoadingSkeleton } from '@lims/ui/components/LoadingSkeleton';

export default function ExportsLoading() {
  return <LoadingSkeleton variant="page" />;
}
