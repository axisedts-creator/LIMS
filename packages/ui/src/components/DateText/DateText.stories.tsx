import { DateText } from './DateText';

export default { title: 'Data display/DateText', component: DateText, args: { value: '2025-04-14' } };

export const AD = { args: { mode: 'AD' } };
export const BS = { args: { mode: 'BS' } };
export const ADWithBS = { args: { mode: 'AD_BS' } };
export const InstantWithTime = { args: { value: '2025-04-14T06:15:00Z', mode: 'AD', withTime: true } };
