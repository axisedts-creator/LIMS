import { DurationText } from './DurationText';

export default { title: 'Data/DurationText', component: DurationText };

export const Minutes = { args: { seconds: 42 * 60 } };
export const Hours = { args: { seconds: 5 * 3600 + 12 * 60 } };
export const Days = { args: { seconds: 3 * 86400 + 4 * 3600 } };
