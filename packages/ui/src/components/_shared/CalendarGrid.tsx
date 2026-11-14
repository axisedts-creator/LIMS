// A.D./B.S. month grid (04-UI-UX §2.3 keyboard): arrows = days, PageUp/PageDown = months, Shift+PageUp/PageDown = years,
// Home/End = week start/end, Enter = select, Esc = close, T = today, C = toggle A.D./B.S.
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import {
  AD_MONTHS,
  BS_MONTHS,
  addDays,
  adDaysInMonth,
  adToBs,
  adWindow,
  bsDisplay,
  bsToAd,
  daysInBsMonth,
  formatAd,
  isoOf,
  todayIn,
  weekday,
  ymd,
  type CalendarMode,
  type IsoDate,
} from './dates';

const WEEK = [['Su', 'Sunday'], ['Mo', 'Monday'], ['Tu', 'Tuesday'], ['We', 'Wednesday'], ['Th', 'Thursday'], ['Fr', 'Friday'], ['Sa', 'Saturday']] as const;

type Ym = { year: number; month: number; day: number };
const toCal = (iso: IsoDate, cal: CalendarMode): Ym => (cal === 'BS' ? adToBs(iso) : ymd(iso));
const monthLen = (y: number, m: number, cal: CalendarMode) => (cal === 'BS' ? daysInBsMonth(y, m) : adDaysInMonth(y, m));
const fromCal = (d: Ym, cal: CalendarMode): IsoDate => (cal === 'BS' ? bsToAd(d) : isoOf(d.year, d.month, d.day));

function shiftMonths(iso: IsoDate, n: number, cal: CalendarMode): IsoDate {
  const c = toCal(iso, cal);
  const idx = c.year * 12 + (c.month - 1) + n;
  const year = Math.floor(idx / 12);
  const month = (idx % 12) + 1;
  return fromCal({ year, month, day: Math.min(c.day, monthLen(year, month, cal)) }, cal);
}

export interface CalendarGridProps {
  calendar: CalendarMode;
  selected?: IsoDate | undefined;
  min?: IsoDate | undefined;
  max?: IsoDate | undefined;
  timezone?: string;
  onPick: (iso: IsoDate) => void;
  onClose: () => void;
}

export function CalendarGrid({ calendar, selected, min, max, timezone, onPick, onClose }: CalendarGridProps) {
  const w = adWindow();
  const lo = min && min > w.min ? min : w.min;
  const hi = max && max < w.max ? max : w.max;
  const clamp = (d: IsoDate) => (d < lo ? lo : d > hi ? hi : d);
  const [cal, setCal] = useState<CalendarMode>(calendar);
  const [focus, setFocus] = useState<IsoDate>(() => clamp(selected ?? todayIn(timezone)));
  const gridRef = useRef<HTMLTableElement>(null);

  useEffect(() => {
    gridRef.current?.querySelector<HTMLElement>('[data-focused]')?.focus();
  }, [focus, cal]);

  const c = toCal(focus, cal);
  const len = monthLen(c.year, c.month, cal);
  const first = fromCal({ year: c.year, month: c.month, day: 1 }, cal);
  const last = addDays(first, len - 1);
  const lead = weekday(first);
  const cells: (IsoDate | null)[] = [...Array<null>(lead).fill(null), ...Array.from({ length: len }, (_, i) => addDays(first, i))];
  while (cells.length % 7) cells.push(null);
  const weeks = Array.from({ length: cells.length / 7 }, (_, i) => cells.slice(i * 7, i * 7 + 7));

  const title = cal === 'BS' ? `${c.year} ${BS_MONTHS[c.month - 1]}` : `${AD_MONTHS[c.month - 1]} ${c.year}`;
  const range = cal === 'BS' ? `${formatAd(first)} – ${formatAd(last)}` : `${bsDisplay(first) ?? ''} – ${bsDisplay(last) ?? ''}`;

  const move = (f: () => IsoDate) => {
    try {
      setFocus(clamp(f()));
    } catch {
      /* outside the supported B.S. table: stay */
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const k = e.key;
    if (k === 'ArrowRight') move(() => addDays(focus, 1));
    else if (k === 'ArrowLeft') move(() => addDays(focus, -1));
    else if (k === 'ArrowDown') move(() => addDays(focus, 7));
    else if (k === 'ArrowUp') move(() => addDays(focus, -7));
    else if (k === 'Home') move(() => addDays(focus, -weekday(focus)));
    else if (k === 'End') move(() => addDays(focus, 6 - weekday(focus)));
    else if (k === 'PageDown') move(() => shiftMonths(focus, e.shiftKey ? 12 : 1, cal));
    else if (k === 'PageUp') move(() => shiftMonths(focus, e.shiftKey ? -12 : -1, cal));
    else if (k === 'Enter' || k === ' ') onPick(focus);
    else if (k === 'Escape') onClose();
    else if (k === 't' || k === 'T') move(() => todayIn(timezone));
    else if (k === 'c' || k === 'C') setCal((x) => (x === 'BS' ? 'AD' : 'BS'));
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  const label = (d: IsoDate) => (cal === 'BS' ? `${bsDisplay(d)} (${formatAd(d)})` : `${formatAd(d)} (${bsDisplay(d) ?? ''})`);

  return (
    <div className="lims-calendar">
      <div className="lims-calendar-header">
        <p className="lims-calendar-title">{title}</p>
        <p className="lims-calendar-range">{range}</p>
      </div>
      <table ref={gridRef} role="grid" aria-label={title} className="lims-calendar-grid" onKeyDown={onKeyDown}>
        <thead>
          <tr>
            {WEEK.map(([s, l]) => (
              <th key={s} scope="col" abbr={l}>
                {s}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((wk, i) => (
            <tr key={i}>
              {wk.map((d, j) => {
                if (!d) return <td key={j} role="gridcell" data-outside-month="" aria-disabled="true" />;
                const off = d < lo || d > hi;
                const isFocus = d === focus;
                return (
                  <td
                    key={j}
                    role="gridcell"
                    tabIndex={isFocus ? 0 : -1}
                    aria-label={label(d)}
                    aria-selected={d === selected}
                    {...(off ? { 'aria-disabled': true } : {})}
                    {...(isFocus ? { 'data-focused': '' } : {})}
                    className="lims-calendar-day"
                    onClick={() => !off && onPick(d)}
                  >
                    {toCal(d, cal).day}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
