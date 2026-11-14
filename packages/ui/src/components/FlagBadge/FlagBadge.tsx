import { StatusChip } from '../StatusChip/StatusChip';
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
  // Tone + icon + word (LD-140, 10-DESIGN-SYSTEM §6).
  return <StatusChip kind="generic" status={flag} tone={tone} label={text} size="sm" {...rest} />;
}
