// AN-T20: schedule copy catalogue (04-UI-UX §8, §13 analytics.schedule.*). Plain module shared by the server page builders and the client editor.
export const WEEKDAYS: readonly { value: string; label: string }[] = [
  { value: '7', label: 'Sunday' }, { value: '1', label: 'Monday' }, { value: '2', label: 'Tuesday' }, { value: '3', label: 'Wednesday' },
  { value: '4', label: 'Thursday' }, { value: '5', label: 'Friday' }, { value: '6', label: 'Saturday' }, // ISO weekday numbers
];
export const PERIODS: readonly { value: string; label: string }[] = [
  { value: 'previous_business_day', label: 'Previous day' }, { value: 'previous_7_days', label: 'Previous 7 days' },
  { value: 'month_to_date_ad', label: 'A.D. month to date' }, { value: 'previous_ad_month', label: 'Previous A.D. month' },
  { value: 'month_to_date_bs', label: 'B.S. month to date' }, { value: 'previous_bs_month', label: 'Previous B.S. month' },
  { value: 'fiscal_year_to_date', label: 'Fiscal year to date' },
];
export const FREQUENCIES: readonly { value: string; label: string }[] = [
  { value: 'daily', label: 'Daily' }, { value: 'weekly', label: 'Weekly' }, { value: 'monthly_ad', label: 'Monthly (A.D.)' }, { value: 'monthly_bs', label: 'Monthly (B.S.)' },
];
/** 96 quarter-hour values 00:00 … 23:45. */
export const TIMES: readonly { value: string; label: string }[] = Array.from({ length: 96 }, (_, i) => {
  const v = `${String(Math.floor(i / 4)).padStart(2, '0')}:${String((i % 4) * 15).padStart(2, '0')}`;
  return { value: v, label: v };
});

export const periodLabel = (rule: string) => PERIODS.find((p) => p.value === rule)?.label ?? rule.replace(/_/g, ' ');
export const weekdayLabel = (iso: number | undefined) => WEEKDAYS.find((w) => w.value === String(iso))?.label ?? '—';
export function frequencyText(frequency: string, time: string, weekday?: number): string {
  if (frequency === 'daily') return `Daily at ${time}`;
  if (frequency === 'weekly') return `Weekly on ${weekdayLabel(weekday)} at ${time}`;
  if (frequency === 'monthly_ad') return `Monthly (A.D.) on day 1 at ${time}`;
  if (frequency === 'monthly_bs') return `Monthly (B.S.) on day 1 at ${time}`;
  return `${frequency} at ${time}`;
}

export const NAME_INVALID = 'Names cannot contain email addresses, phone numbers or web addresses';
/** Server rule 08 A5.4 mirrored: no `@`, no run of 7+ digits, no `://`, no `www.`. */
export const nameIsValid = (s: string) => !/@|\d{7,}|:\/\/|www\./i.test(s);
