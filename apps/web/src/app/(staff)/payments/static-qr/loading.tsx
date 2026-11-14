// Segment loading for /payments/static-qr (03-APP-FLOW §5: LoadingSkeleton variant='page').
import { LoadingSkeleton } from '@lims/ui/components/LoadingSkeleton';

export default function StaticQrLoading() {
  return <LoadingSkeleton variant="page" />;
}
