// Segment loading for /payments/review (03-APP-FLOW §5: LoadingSkeleton variant='page').
import { LoadingSkeleton } from '@lims/ui/components/LoadingSkeleton';

export default function PaymentReviewLoading() {
  return <LoadingSkeleton variant="page" />;
}
