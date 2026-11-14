// C13.T18 PH-1 loading state (03-APP-FLOW §6). LD-140: kit component only.
import { LoadingSkeleton } from '@lims/ui/components/LoadingSkeleton';

export default function Loading() {
  return <LoadingSkeleton variant="page" />;
}
