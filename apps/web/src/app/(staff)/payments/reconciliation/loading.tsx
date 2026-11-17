// Segment loading for /payments/reconciliation (03-APP-FLOW §5: LoadingSkeleton variant='page').
import { LoadingSkeleton } from '@lims/ui/components/LoadingSkeleton';

export default function GatewayReconciliationLoading() {
  return <LoadingSkeleton variant="page" />;
}
