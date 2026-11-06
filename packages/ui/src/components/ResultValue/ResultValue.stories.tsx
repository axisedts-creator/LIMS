import { ResultValue } from './ResultValue';

export default { title: 'Data/ResultValue', component: ResultValue };

export const High = { args: { value: '12.4', unit: 'g/dL', flag: 'H' } };
export const Normal = { args: { value: '5.0', unit: 'mmol/L', flag: 'N', decimals: 2 } };
export const CriticalLow = { args: { value: '2.1', unit: 'mmol/L', flag: 'LL' } };
export const Text = { args: { value: 'Positive', flag: 'A' } };
