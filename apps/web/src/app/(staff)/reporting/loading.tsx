// Segment-level loading for every /reporting/* page (04-UI-UX §1: LoadingSkeleton; no PHI while loading).
import { LoadingSkeleton } from '@lims/ui/components/LoadingSkeleton';

export default function ReportingLoading() {
  return <LoadingSkeleton variant="page" />;
}
