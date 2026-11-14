// Loading state for /inventory/transfers (C0 04-UI-UX §7: LoadingSkeleton). LD-140: kit only.
import { LoadingSkeleton } from '@lims/ui/components/LoadingSkeleton';

export default function TransfersLoading() {
  return <LoadingSkeleton variant="page" />;
}
