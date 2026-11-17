import { useEffect, useId, useRef, useState } from 'react';
import { DatePicker } from '../DatePicker/DatePicker';
import type { FieldBase } from '../_shared/TextInputBase';
import { dayDiff, type CalendarMode, type IsoDate } from '../_shared/dates';

export type DateRange = { from: IsoDate; to: IsoDate };

export interface DateRangePickerProps extends FieldBase {
  value?: DateRange;
  onChange?: (v: DateRange | undefined) => void;
  calendar?: CalendarMode;
  /** Longest allowed span, both ends inclusive. */
  maxDays?: number;
}

const rangeMsg = {
  order: 'The end date must be on or after the start date',
  maxDays: (n: number) => `Choose a period of at most ${n} days`,
};

export function DateRangePicker({ label, name, description, error, isRequired, isDisabled, isReadOnly, value, onChange, calendar, maxDays, ...rest }: DateRangePickerProps) {
  const id = useId();
  const [from, setFrom] = useState<IsoDate | undefined>(value?.from);
  const [to, setTo] = useState<IsoDate | undefined>(value?.to);
  const emitted = useRef<DateRange | undefined>(value);

  useEffect(() => {
    if (value?.from === emitted.current?.from && value?.to === emitted.current?.to) return;
    emitted.current = value;
    setFrom(value?.from);
    setTo(value?.to);
  }, [value?.from, value?.to]); // eslint-disable-line react-hooks/exhaustive-deps

  const problem = from && to ? (to < from ? rangeMsg.order : maxDays !== undefined && dayDiff(from, to) + 1 > maxDays ? rangeMsg.maxDays(maxDays) : undefined) : undefined;

  const update = (f: IsoDate | undefined, t: IsoDate | undefined) => {
    setFrom(f);
    setTo(t);
    const bad = !f || !t || t < f || (maxDays !== undefined && dayDiff(f, t) + 1 > maxDays);
    const next = bad ? undefined : { from: f, to: t };
    if (next?.from === emitted.current?.from && next?.to === emitted.current?.to) return;
    emitted.current = next;
    onChange?.(next);
  };

  const common = { ...(calendar ? { calendar } : {}), ...(isDisabled ? { isDisabled } : {}), ...(isReadOnly ? { isReadOnly } : {}), ...(isRequired ? { isRequired } : {}) };
  return (
    <div role="group" aria-labelledby={`${id}-l`} className="lims-field lims-date-range" {...(rest['data-testid'] ? { 'data-testid': rest['data-testid'] } : {})}>
      <span id={`${id}-l`} className="lims-label">
        {label}
      </span>
      <div className="lims-inline">
        <DatePicker {...common} label="From" name={`${name}_from`} value={from} onChange={(f) => update(f, to)} />
        <DatePicker
          {...common}
          label="To"
          name={`${name}_to`}
          value={to}
          onChange={(t) => update(from, t)}
          {...(problem || error ? { error: problem ?? error } : {})}
        />
      </div>
      {description ? <p className="lims-description">{description}</p> : null}
    </div>
  );
}
