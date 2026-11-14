// 04-UI-UX §9.2 WeekdayTimeRangeEditor (CR-C16-016, LD-146): ISO weekdays 1 = Monday … 7 = Sunday + a start/end time range.
// [CONV] LD-146: onChange gets the whole new value; minuteStep defaults to 15. The editor does not validate; the owning form does.
import { useId } from 'react';
import { Icon } from '../Icon/Icon';

export interface WeekdayTimeRangeValue {
  weekdays: number[];
  /** 'HH:MM' 24-hour. */
  start: string;
  /** 'HH:MM' 24-hour. */
  end: string;
}

export interface WeekdayTimeRangeEditorProps {
  value: WeekdayTimeRangeValue;
  onChange: (next: WeekdayTimeRangeValue) => void;
  minuteStep?: 5 | 15;
}

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

export function WeekdayTimeRangeEditor({ value, onChange, minuteStep = 15 }: WeekdayTimeRangeEditorProps) {
  const id = useId();
  const toggle = (day: number) => {
    const next = value.weekdays.includes(day) ? value.weekdays.filter((d) => d !== day) : [...value.weekdays, day].sort((a, b) => a - b);
    onChange({ ...value, weekdays: next });
  };
  return (
    <fieldset className="lims-fieldset lims-weekday-range">
      <legend>Days</legend>
      <div className="lims-inline">
        {DAYS.map((label, i) => {
          const on = value.weekdays.includes(i + 1);
          // Selected = pressed + check icon + class, so the state is never colour-only.
          return (
            <button key={label} type="button" aria-pressed={on} className={`lims-btn lims-btn-sm ${on ? 'lims-btn-secondary lims-selected' : 'lims-btn-ghost'}`} onClick={() => toggle(i + 1)}>
              {on ? <Icon name="check" size={12} /> : null}
              <span className="lims-btn-label">{label}</span>
            </button>
          );
        })}
      </div>
      <div className="lims-inline">
        <div className="lims-field">
          <label className="lims-label" htmlFor={`${id}-start`}>Start</label>
          <input id={`${id}-start`} className="lims-input" type="time" step={minuteStep * 60} value={value.start} onChange={(e) => onChange({ ...value, start: e.target.value })} />
        </div>
        <div className="lims-field">
          <label className="lims-label" htmlFor={`${id}-end`}>End</label>
          <input id={`${id}-end`} className="lims-input" type="time" step={minuteStep * 60} value={value.end} onChange={(e) => onChange({ ...value, end: e.target.value })} />
        </div>
      </div>
    </fieldset>
  );
}
