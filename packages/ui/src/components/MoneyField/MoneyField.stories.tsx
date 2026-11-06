import { MoneyField } from './MoneyField';

export default { title: 'Fields/MoneyField', component: MoneyField, args: { label: 'Amount', name: 'amount' } };

export const Default = {};
export const WithValue = { args: { value: { amount_paisa: 123456, currency: 'NPR' }, onChange: () => {} } };
