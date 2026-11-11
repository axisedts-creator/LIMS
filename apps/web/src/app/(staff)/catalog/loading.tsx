// Segment-level loading for every /catalog/* page (C0 04-UI-UX §7: LoadingSkeleton).
import { LoadingSkeleton } from '@lims/ui/components/LoadingSkeleton';

export default function CatalogLoading() {
  return <LoadingSkeleton variant="page" />;
}
