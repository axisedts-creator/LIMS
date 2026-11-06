import { VisuallyHidden } from '../VisuallyHidden/VisuallyHidden';
import { msg } from '../_shared/messages';

export interface LoadingSkeletonProps {
  variant: 'page' | 'table' | 'form' | 'detail';
  rows?: number;
  'data-testid'?: string;
}

export function LoadingSkeleton({ variant, rows = 5, ...rest }: LoadingSkeletonProps) {
  const n = Math.max(1, Math.min(50, Math.floor(rows)));
  return (
    <div className={`lims-skeleton lims-skeleton-${variant}`} role="status" aria-busy="true" {...rest}>
      <VisuallyHidden>{msg.loading}</VisuallyHidden>
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="lims-skeleton-row" aria-hidden="true" />
      ))}
    </div>
  );
}
