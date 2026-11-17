// LD-140 (2026-11-13): kit skeleton only. Server component; no data is touched while loading.
import { LoadingSkeleton } from '@lims/ui/components/LoadingSkeleton';

export default function Loading() {
  return <LoadingSkeleton variant="table" />;
}
