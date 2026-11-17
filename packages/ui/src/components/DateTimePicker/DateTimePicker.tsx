import { DateFieldBase, type ParseResult } from '../_shared/DateFieldBase';
import type { FieldBase } from '../_shared/TextInputBase';
import {
  DEFAULT_TZ,
  displayDate,
  example,
  localToUtc,
  msgDate,
  parseDateText,
  utcParts,
  type CalendarMode,
  type IsoDate,
  type IsoUtc,
} from '../_shared/dates';

export interface DateTimePickerProps extends FieldBase {
  /** UTC instant; shown and typed in `timezone`. */
  value?: IsoUtc;
  onChange?: (v: IsoUtc | undefined) => void;
  /** Default tenant timezone ([CONV] Asia/Kathmandu, CV §4.8). */
  timezone?: string;
  calendar?: CalendarMode;
  /** Accepted for API parity; minutes are typed freely (open point). */
  minuteStep?: 1 | 5 | 15;
}

const TIME = /^(.*\S)\s+(\d{1,2}):(\d{2})\s*([AP]M)$/i;

export function DateTimePicker({ value, onChange, timezone = DEFAULT_TZ, calendar = 'AD', minuteStep: _step, ...field }: DateTimePickerProps) {
  const format = (v: IsoUtc) => {
    const p = utcParts(v, timezone);
    return p ? `${displayDate(p.date, calendar)} ${p.time}` : '';
  };
  const toUtc = (date: IsoDate, h: number, m: number, ap: string) => localToUtc(date, (h % 12) + (ap.toUpperCase() === 'PM' ? 12 : 0), m, timezone);
  const parse = (raw: string): ParseResult<IsoUtc> => {
    const bad = { ok: false as const, error: msgDate.invalid(example(calendar, true)) };
    const t = TIME.exec(raw.trim().replace(/\s*B\.S\.?/i, ''));
    if (!t) return bad;
    const [h, m] = [+t[2]!, +t[3]!];
    if (h < 1 || h > 12 || m > 59) return bad;
    const d = parseDateText(t[1]!, calendar);
    if (!d.ok) return d.error.startsWith('Enter') ? bad : d;
    return { ok: true, value: toUtc(d.value, h, m, t[4]!) };
  };
  const fromPick = (iso: IsoDate, current: IsoUtc | undefined) => {
    // keep the time already entered, else the current wall-clock time
    const p = utcParts(current ?? new Date(Date.now()).toISOString(), timezone);
    const t = p && /^(\d{2}):(\d{2}) ([AP]M)$/.exec(p.time);
    return t ? toUtc(iso, +t[1]!, +t[2]!, t[3]!) : undefined;
  };
  return (
    <DateFieldBase<IsoUtc>
      {...field}
      value={value}
      onChange={onChange}
      placeholder={calendar === 'BS' ? 'YYYY-MM-DD hh:mm AM' : 'DD/MM/YYYY hh:mm AM'}
      format={format}
      parse={parse}
      calendar={{ mode: calendar, timezone, toDate: (v) => utcParts(v, timezone)?.date, fromPick }}
    />
  );
}
