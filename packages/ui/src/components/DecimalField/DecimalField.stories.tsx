import { DecimalField } from './DecimalField';

export default { title: 'Fields/DecimalField', component: DecimalField, args: { label: 'Haemoglobin', name: 'hb', decimals: 1, suffix: 'g/dL' } };

export const Default = {};
export const WithValue = { args: { value: '12.5', onChange: () => {} } };
export const Negative = { args: { label: 'Base excess', name: 'be', suffix: 'mmol/L', allowNegative: true } };
