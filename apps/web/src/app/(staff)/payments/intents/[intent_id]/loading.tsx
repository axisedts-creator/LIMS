// Segment loading for /payments/intents/{intent_id} (03-APP-FLOW §5: LoadingSkeleton variant='page').
import { LoadingSkeleton } from '@lims/ui/components/LoadingSkeleton';

export default function PaymentIntentLoading() {
  return <LoadingSkeleton variant="page" />;
}
