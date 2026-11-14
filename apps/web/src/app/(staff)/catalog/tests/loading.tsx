// Segment-level loading for every /catalog/tests/* page (C0 04-UI-UX §7: LoadingSkeleton).
import { LoadingSkeleton } from '@lims/ui/components/LoadingSkeleton';

export default function CatalogTestsLoading() {
  return <LoadingSkeleton variant="page" />;
}
