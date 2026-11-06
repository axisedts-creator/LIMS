import { Icon } from '../Icon/Icon';
import type { Tone } from '../_shared/messages';

export type ResultFlag = 'N' | 'L' | 'H' | 'LL' | 'HH' | 'A';

export interface FlagBadgeProps {
  flag: ResultFlag;
  showNormal?: boolean;
  'data-testid'?: string;
}

/** 04-UI-UX §1.3 result-flag row. "Normal" for N is [CONV] (spec gives no label). */
export const FLAGS: Record<ResultFlag, readonly [Tone, string]> = {
  N: ['neutral', 'Normal'],
  L: ['danger', 'Low'],
  H: ['danger', 'High'],
  LL: ['critical', 'Critical low'],
  HH: ['critical', 'Critical high'],
  A: ['danger', 'Abnormal'],
};

export function FlagBadge({ flag, showNormal = false, ...rest }: FlagBadgeProps) {
  const row = Object.hasOwn(FLAGS, flag) ? FLAGS[flag] : undefined;
  if (!row || (flag === 'N' && !showNormal)) return null;
  const [tone, text] = row;
  return (
    <span className={`lims-chip lims-chip-sm lims-tone-${tone}`} data-tone={tone} {...rest}>
      {tone === 'critical' ? <Icon name="critical" size={12} /> : null}
      {text}
    </span>
  );
}
