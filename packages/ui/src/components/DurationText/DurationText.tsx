import { Tooltip } from '../Tooltip/Tooltip';

export type DurationStyle = 'short' | 'long';

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/**
 * short: C8 04-UI-UX:51: < 1 h "42 min"; < 48 h "5 h 12 min"; else "3 d 4 h" (floored).
 * long [CONV]: same thresholds in full words ("5 hours 12 minutes"). Bad input -> "—".
 */
export function formatDuration(seconds: number, style: DurationStyle = 'short'): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const m = Math.floor(seconds / 60);
  const h = Math.floor(m / 60);
  const long = style === 'long';
  if (m < 60) return long ? plural(m, 'minute') : `${m} min`;
  if (h < 48) return long ? `${plural(h, 'hour')} ${plural(m % 60, 'minute')}` : `${h} h ${m % 60} min`;
  const d = Math.floor(h / 24);
  return long ? `${plural(d, 'day')} ${plural(h % 24, 'hour')}` : `${d} d ${h % 24} h`;
}

const NUM = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/** C8 02-TRD:1094. */
export interface DurationTextProps {
  seconds: number;
  style: DurationStyle;
  'data-testid'?: string;
}

/** Focusable duration; the tooltip gives the exact seconds. */
export function DurationText({ seconds, style, ...rest }: DurationTextProps) {
  const text = formatDuration(seconds, style);
  if (text === '—') return <span className="lims-duration" {...rest}>—</span>;
  return (
    <Tooltip content={`${NUM.format(Math.floor(seconds))} seconds`}>
      <span className="lims-duration" tabIndex={0} {...rest}>
        {text}
      </span>
    </Tooltip>
  );
}
