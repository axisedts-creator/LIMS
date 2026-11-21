// Segment loading for /homecollection/devices (04-UI-UX §2.6: LoadingSkeleton).
import { LoadingSkeleton } from '@lims/ui/components/LoadingSkeleton';

export default function DevicesLoading() {
  return <LoadingSkeleton variant="page" />;
}
