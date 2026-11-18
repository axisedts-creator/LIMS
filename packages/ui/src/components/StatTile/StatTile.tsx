import type { ReactNode } from 'react';
import { FreshnessBadge, type FreshnessReason } from '../FreshnessBadge/FreshnessBadge';
import { Icon } from '../Icon/Icon';

export interface StatTileProps {
  label: string;
  value: string;
  delta?: { value: string; direction: 'up' | 'down' | 'flat'; isGood?: boolean };
  /** App-relative link (e.g. '/lab/reports?status=pending'); anything else is not rendered as a link (REQ-SEC-088). */
  href?: string;
  /** T0D-UIKIT-1, LD-353 rule 8: the "Data may be out of date" badge shows only when this is true (one freshness note per page). */
  isStale?: boolean;
  refreshedAt?: string;
  staleReason?: FreshnessReason;
  'data-testid'?: string;
}

const WORD = { up: 'Up', down: 'Down', flat: 'No change' } as const;
// One icon family: svg icons, no text glyphs (LD-140, 10-DESIGN-SYSTEM §6).
const ARROW = { up: 'arrow-up', down: 'arrow-down', flat: 'minus' } as const;
const safeHref = (h: string | undefined) => (h && /^\/(?!\/)/.test(h.trim()) ? h.trim() : undefined);

export function StatTile({ label, value, delta, href, isStale, refreshedAt, staleReason, ...rest }: StatTileProps) {
  const tone = !delta || delta.direction === 'flat' || delta.isGood === undefined ? 'neutral' : delta.isGood ? 'success' : 'danger';
  const link = safeHref(href);
  const body = (
    <>
      <span className="lims-stat-label">{label}</span>
      <span className="lims-stat-value">{value}</span>
      {delta ? (
        <span className={`lims-stat-delta lims-tone-${tone}`} data-tone={tone}>
          <Icon name={ARROW[delta.direction]} size={14} /> {WORD[delta.direction]} {delta.value}
          {delta.isGood !== undefined && delta.direction !== 'flat' ? <span className="lims-stat-judgement">{delta.isGood ? ' (better)' : ' (worse)'}</span> : null}
        </span>
      ) : null}
      {/* inside a link tile the reason tooltip (a focusable chip) is dropped so the tile stays one link */}
      {isStale === true ? <FreshnessBadge isStale {...(refreshedAt ? { refreshedAt } : {})} {...(staleReason && !link ? { reason: staleReason } : {})} /> : null}
    </>
  );
  return link ? (
    <a className="lims-stat lims-stat-link" href={link} {...rest}>
      {body}
    </a>
  ) : (
    <div className="lims-stat" {...rest}>
      {body}
    </div>
  );
}

/** T0D-UIKIT-1, LD-353 templates 1 and 5: one row of equal tiles; `lead` makes the first tile wider (kit.css). */
export function StatTileRow({ lead, children, ...rest }: { lead?: boolean; children: ReactNode; 'data-testid'?: string }) {
  return (
    <div className="lims-stat-row" {...(lead ? { 'data-lead': 'true' } : {})} {...rest}>
      {children}
    </div>
  );
}
