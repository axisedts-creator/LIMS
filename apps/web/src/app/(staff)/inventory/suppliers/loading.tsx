// Loading state for /inventory/suppliers (C0 04-UI-UX §7: LoadingSkeleton). LD-140: kit only.
import { LoadingSkeleton } from '@lims/ui/components/LoadingSkeleton';

export default function SuppliersLoading() {
  return <LoadingSkeleton variant="page" />;
}
