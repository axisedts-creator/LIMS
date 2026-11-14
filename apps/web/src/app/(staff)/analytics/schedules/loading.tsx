// Segment loading for /analytics/schedules (03-APP-FLOW §5: LoadingSkeleton variant='page').
import { LoadingSkeleton } from '@lims/ui/components/LoadingSkeleton';

export default function SchedulesLoading() {
  return <LoadingSkeleton variant="page" />;
}
