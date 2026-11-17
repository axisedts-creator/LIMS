// Segment-level loading for /admin/* (LoadingSkeleton variant='page', same as billing/analytics).
import { LoadingSkeleton } from '@lims/ui/components/LoadingSkeleton';

export default function AdminLoading() {
  return <LoadingSkeleton variant="page" />;
}
