import { DEFAULT_TZ, bsDisplay, formatAd, utcParts, type IsoDate, type IsoUtc } from '../_shared/dates';

export interface DateTextProps {
  value: IsoDate | IsoUtc;
  /** [CONV] default 'AD' until a tenant calendarDisplay provider exists. */
  mode?: 'AD' | 'BS' | 'AD_BS' | 'BS_AD';
  /** IsoUtc only: add 'hh:mm A' to the A.D. part. */
  withTime?: boolean;
  'data-testid'?: string;
}

/** A.D. 'DD/MM/YYYY [hh:mm A]', B.S. 'YYYY-MM-DD B.S.'; instants are read in Asia/Kathmandu (CV §4.8, §13). */
export function DateText({ value, mode = 'AD', withTime, ...rest }: DateTextProps) {
  const isDate = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const parts = isDate ? { date: value as IsoDate, time: '' } : utcParts(value, DEFAULT_TZ);
  let text = '—';
  if (parts) {
    let ad: string | undefined;
    try {
      ad = formatAd(parts.date) + (withTime && parts.time ? ` ${parts.time}` : '');
    } catch {
      ad = undefined;
    }
    const bs = bsDisplay(parts.date);
    if (ad) {
      if (mode === 'AD' || !bs) text = ad;
      else if (mode === 'BS') text = bs;
      else if (mode === 'AD_BS') text = `${ad} (${bs})`;
      else text = `${bs} (${ad})`;
    }
  }
  return (
    <time className="lims-date-text" dateTime={value} {...rest}>
      {text}
    </time>
  );
}
