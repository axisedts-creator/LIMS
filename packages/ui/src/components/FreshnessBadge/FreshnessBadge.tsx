import { Tooltip } from '../Tooltip/Tooltip';
import { formatDateTime } from '../_shared/time';

export type FreshnessReason = 'refresh_lagging' | 'refresh_failed' | 'never_refreshed';

/** C8 04-UI-UX:47 (verbatim). */
const REASON: Record<FreshnessReason, string> = {
  refresh_lagging: 'Recent changes are still being processed',
  refresh_failed: 'Last update failed — the team has been alerted',
  never_refreshed: 'Not yet calculated',
};

export interface FreshnessBadgeProps {
  /** IsoUtc of the last successful refresh. */
  refreshedAt?: string;
  isStale: boolean;
  reason?: FreshnessReason;
  'data-testid'?: string;
}

/** "Updated {time}" or, when stale, warning-toned "Data may be out of date" with the reason as a focusable tooltip. */
export function FreshnessBadge({ refreshedAt, isStale, reason, ...rest }: FreshnessBadgeProps) {
  if (!isStale) {
    return (
      <span className="lims-chip lims-chip-sm lims-tone-neutral" data-tone="neutral" {...rest}>
        {refreshedAt ? `Updated ${formatDateTime(refreshedAt)}` : REASON.never_refreshed}
      </span>
    );
  }
  const chip = (
    <span className="lims-chip lims-chip-sm lims-tone-warning" data-tone="warning" {...(reason ? { tabIndex: 0 } : {})} {...rest}>
      Data may be out of date
    </span>
  );
  return reason && Object.hasOwn(REASON, reason) ? <Tooltip content={REASON[reason]}>{chip}</Tooltip> : chip;
}
