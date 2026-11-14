// Segment-level loading for every /billing/* page (C0 04-UI-UX §7: LoadingSkeleton).
import { LoadingSkeleton } from '@lims/ui/components/LoadingSkeleton';

export default function BillingLoading() {
  return <LoadingSkeleton variant="page" />;
}
