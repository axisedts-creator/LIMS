import { Tooltip } from '../Tooltip/Tooltip';

/** C8 04-UI-UX:51: < 1 h "42 min"; < 48 h "5 h 12 min"; else "3 d 4 h" (floored). Bad input -> "—". */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${m % 60} min`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}

const NUM = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

export interface DurationTextProps {
  seconds: number;
  'data-testid'?: string;
}

/** Focusable duration; the tooltip gives the exact seconds. */
export function DurationText({ seconds, ...rest }: DurationTextProps) {
  const text = formatDuration(seconds);
  if (text === '—') return <span className="lims-duration" {...rest}>—</span>;
  return (
    <Tooltip content={`${NUM.format(Math.floor(seconds))} seconds`}>
      <span className="lims-duration" tabIndex={0} {...rest}>
        {text}
      </span>
    </Tooltip>
  );
}
