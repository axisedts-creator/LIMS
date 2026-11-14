// Loading state for /inventory/counts (C0 04-UI-UX §7: LoadingSkeleton). LD-140: kit only.
import { LoadingSkeleton } from '@lims/ui/components/LoadingSkeleton';

export default function CountsLoading() {
  return <LoadingSkeleton variant="page" />;
}
