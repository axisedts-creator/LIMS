import { DateFieldBase } from '../_shared/DateFieldBase';
import type { FieldBase } from '../_shared/TextInputBase';
import { bsDisplay, displayDate, formatAd, parseDateText, type CalendarMode, type IsoDate } from '../_shared/dates';

export type { CalendarMode, IsoDate };

export interface DatePickerProps extends FieldBase {
  /** Always A.D. (04 D12); B.S. is display only. */
  value?: IsoDate | undefined;
  onChange?: ((v: IsoDate | undefined) => void) | undefined;
  /** [CONV] default 'AD' until a tenant calendarDisplay provider exists. */
  calendar?: CalendarMode;
  /** Default true: the other calendar as a hint under the field. */
  showAlternate?: boolean;
  min?: IsoDate;
  max?: IsoDate;
  /** Default true. */
  allowManualEntry?: boolean;
}

export function DatePicker({ value, onChange, calendar = 'AD', showAlternate = true, min, max, allowManualEntry = true, ...field }: DatePickerProps) {
  return (
    <DateFieldBase<IsoDate>
      {...field}
      value={value}
      onChange={onChange}
      placeholder={calendar === 'BS' ? 'YYYY-MM-DD' : 'DD/MM/YYYY'}
      format={(v) => displayDate(v, calendar)}
      parse={(t) => parseDateText(t, calendar, min, max)}
      hint={showAlternate ? (v) => (calendar === 'BS' ? formatAd(v) : bsDisplay(v)) : undefined}
      readOnlyText={!allowManualEntry}
      calendar={{ mode: calendar, min, max, toDate: (v) => v, fromPick: (iso) => iso }}
    />
  );
}
