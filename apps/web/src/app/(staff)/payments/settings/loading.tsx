// Segment loading for /payments/settings (03-APP-FLOW §5: LoadingSkeleton variant='page').
import { LoadingSkeleton } from '@lims/ui/components/LoadingSkeleton';

export default function PaymentSettingsLoading() {
  return <LoadingSkeleton variant="page" />;
}
