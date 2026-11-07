import { DateRangePicker } from './DateRangePicker';

export default { title: 'Fields/DateRangePicker', component: DateRangePicker, args: { label: 'Period', name: 'period' } };

export const AD = { args: { calendar: 'AD', value: { from: '2025-07-01', to: '2025-07-10' } } };
export const BS = { args: { calendar: 'BS', maxDays: 31 } };
