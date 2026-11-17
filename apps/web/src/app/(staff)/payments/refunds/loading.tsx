// Segment loading for /payments/refunds (03-APP-FLOW §5: LoadingSkeleton variant='page').
import { LoadingSkeleton } from '@lims/ui/components/LoadingSkeleton';

export default function GatewayRefundsLoading() {
  return <LoadingSkeleton variant="page" />;
}
