import { DatePicker } from './DatePicker';

export default { title: 'Fields/DatePicker', component: DatePicker, args: { label: 'Collected on', name: 'collected_on' } };

export const AD = { args: { calendar: 'AD', value: '2025-07-17' } };
export const BS = { args: { calendar: 'BS', value: '2025-07-17' } };
export const WithError = { args: { calendar: 'AD', error: 'Choose the collection date', isRequired: true } };
export const PickOnly = { args: { calendar: 'BS', value: '2025-07-17', allowManualEntry: false } };
