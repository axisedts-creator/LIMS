// Segment-level loading for /analytics/* (C8 03-APP-FLOW §5: LoadingSkeleton variant='page').
import { LoadingSkeleton } from '@lims/ui/components/LoadingSkeleton';

export default function AnalyticsLoading() {
  return <LoadingSkeleton variant="page" />;
}
