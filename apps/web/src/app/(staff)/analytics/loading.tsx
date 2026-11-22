// Segment-level loading for /analytics/* (C8 03-APP-FLOW §5: LoadingSkeleton).
// T0D-DASHCARDS-1 (LD-447): dashboard shaped, in the same grid as DashboardView (pipeline card, Needs you + Money, the two charts), so nothing jumps on load.
import { LoadingSkeleton } from '@lims/ui/components/LoadingSkeleton';

export default function AnalyticsLoading() {
  return (
    <div className="lims-dash lims-dash-skeleton" aria-busy="true">
      <LoadingSkeleton variant="page" rows={2} />
      <div className="lims-dash-row">
        <LoadingSkeleton variant="detail" rows={4} />
        <LoadingSkeleton variant="detail" rows={4} />
      </div>
      <div className="lims-dash-charts">
        <LoadingSkeleton variant="detail" rows={6} />
        <LoadingSkeleton variant="detail" rows={6} />
      </div>
    </div>
  );
}
