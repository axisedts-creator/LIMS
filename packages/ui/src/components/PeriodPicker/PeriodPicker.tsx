import { useId } from 'react';
import { Select } from '../Select/Select';
import type { FieldBase } from '../_shared/TextInputBase';

export type PeriodPreset =
  | 'today' | 'yesterday' | 'this_bs_month' | 'last_bs_month' | 'this_fiscal_year' | 'last_fiscal_year' | 'this_ad_month' | 'last_ad_month' | 'custom';

export interface PeriodValue {
  preset: PeriodPreset;
  /** Custom only: A.D. calendar date `YYYY-MM-DD`, inclusive. */
  from?: string;
  to?: string;
}

/** C8 04-UI-UX:44 preset labels (verbatim). */
const LABELS: Record<PeriodPreset, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  this_bs_month: 'This B.S. month',
  last_bs_month: 'Last B.S. month',
  this_fiscal_year: 'This fiscal year',
  last_fiscal_year: 'Last fiscal year',
  this_ad_month: 'This A.D. month',
  last_ad_month: 'Last A.D. month',
  custom: 'Custom',
};
const ORDER = Object.keys(LABELS) as PeriodPreset[];
const MAX_DAYS = 366;

const day = (s: string | undefined) => {
  const m = s && /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return m ? Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!) / 86_400_000 : undefined;
};

/** Custom-range check: inclusive day count <= 366 (C8 04-UI-UX:44, copy :295); from must not be after to. */
export function periodError(v: PeriodValue): string | undefined {
  if (v.preset !== 'custom') return undefined;
  const f = day(v.from);
  const t = day(v.to);
  if (f === undefined || t === undefined) return undefined;
  if (f > t) return 'The start date must be on or before the end date.'; // [CONV] copy not in spec
  if (t - f + 1 > MAX_DAYS) return 'Choose 366 days or fewer.';
  return undefined;
}

export interface PeriodPickerProps extends FieldBase {
  value: PeriodValue;
  onChange: (v: PeriodValue) => void;
  /** Tenant primary calendar; resolution of presets to dates is the server's (period.label_ad / label_bs). */
  calendar: 'AD' | 'BS';
}

export function PeriodPicker({ label, name, description, error, isRequired, isDisabled, isReadOnly, value, onChange, calendar: _calendar, ...rest }: PeriodPickerProps) {
  const id = useId();
  const rangeError = periodError(value);
  const shown = error ?? rangeError;
  const date = (key: 'from' | 'to', text: string) => (
    <label className="lims-field">
      <span className="lims-label">{text}</span>
      <input
        type="date"
        className="lims-input"
        name={`${name}.${key}`}
        value={value[key] ?? ''}
        disabled={isDisabled}
        readOnly={isReadOnly}
        aria-invalid={shown ? true : undefined}
        aria-describedby={shown ? `${id}-e` : undefined}
        onChange={(e) => onChange({ ...value, [key]: e.target.value })}
      />
    </label>
  );
  return (
    <div className="lims-period" {...rest}>
      <Select<PeriodPreset>
        label={label}
        name={`${name}.preset`}
        value={value.preset}
        options={ORDER.map((p) => ({ value: p, label: LABELS[p] }))}
        onChange={(p) => onChange(p === 'custom' ? { preset: p, ...(value.from ? { from: value.from } : {}), ...(value.to ? { to: value.to } : {}) } : { preset: p })}
        {...(description ? { description } : {})}
        {...(isRequired ? { isRequired } : {})}
        {...(isDisabled ? { isDisabled } : {})}
        {...(isReadOnly ? { isReadOnly } : {})}
      />
      {value.preset === 'custom' ? (
        <div className="lims-period-custom">
          {date('from', 'From')}
          {date('to', 'To')}
        </div>
      ) : null}
      {shown ? (
        <span id={`${id}-e`} role="alert" className="lims-error">
          {shown}
        </span>
      ) : null}
    </div>
  );
}
