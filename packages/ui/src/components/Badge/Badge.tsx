import type { ReactNode } from 'react';
import type { Tone } from '../_shared/messages';

export interface BadgeProps {
  /** Default 'neutral'. Colour is secondary; the text carries the meaning (04 §1.3). */
  tone?: Tone;
  children: ReactNode;
  'data-testid'?: string;
}

/** Small count/label pill. Status values use StatusChip; abnormal flags use FlagBadge. */
export function Badge({ tone = 'neutral', children, ...rest }: BadgeProps) {
  return (
    <span className={`lims-chip lims-chip-sm lims-tone-${tone}`} data-tone={tone} {...rest}>
      {children}
    </span>
  );
}
